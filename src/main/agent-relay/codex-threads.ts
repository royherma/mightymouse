import { execFile } from 'child_process'
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync, watch, type FSWatcher } from 'fs'
import { homedir } from 'os'
import { basename, dirname, join, relative } from 'path'
import type { AgentSession } from './mcp/http-listener'

// Codex Desktop runs ONE mightymouse-code shim for every chat, so its chats are read from disk.
const ACTIVE_MS = 6 * 60 * 60_000
const WEDGED_TURN_MS = 10 * 60_000
const DAYS_BACK = 14
const HEAD_BYTES = 512 * 1024
const TAIL_BYTES = 256 * 1024
const RESCAN_DEBOUNCE_MS = 400

interface ChatFile {
  mtimeMs: number
  size: number
  row: AgentSession | null
}

const files = new Map<string, ChatFile>()
let names = new Map<string, string>()
let namesMtime = -1
let rows: AgentSession[] = []
let watchers: FSWatcher[] = []

function codexHome(home = homedir()): string {
  return join(home, '.codex')
}

function readRange(path: string, from: number, length: number): string {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(Math.max(0, length))
    const n = readSync(fd, buf, 0, buf.length, Math.max(0, from))
    return buf.subarray(0, n).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

function records(blob: string): Array<{ timestamp?: string; type?: string; payload?: Record<string, unknown> }> {
  const out = []
  for (const line of blob.split('\n')) {
    if (!line.startsWith('{')) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      continue
    }
  }
  return out
}

function modelLabel(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined
  return raw
    .split(/[-_]/)
    .map((w) => (w.toLowerCase() === 'gpt' ? 'GPT' : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ')
}

function firstUserText(recs: ReturnType<typeof records>): string | undefined {
  for (const r of recs) {
    if (r.type === 'event_msg' && r.payload?.type === 'user_message') {
      const text = String(r.payload.message ?? '').trim().split('\n')[0]
      if (text) return text.slice(0, 80)
    }
  }
  return undefined
}

function loadNames(root: string): void {
  const path = join(root, 'session_index.jsonl')
  let mtime: number
  try {
    mtime = statSync(path).mtimeMs
  } catch {
    return
  }
  if (mtime === namesMtime) return
  namesMtime = mtime
  const next = new Map<string, string>()
  for (const r of records(readRange(path, 0, statSync(path).size)) as Array<Record<string, unknown>>) {
    if (typeof r.id === 'string' && typeof r.thread_name === 'string') next.set(r.id, r.thread_name)
  }
  names = next
}

export function mainCheckoutFor(cwd: string): string {
  for (let dir = cwd; dir !== dirname(dir); dir = dirname(dir)) {
    let text: string
    try {
      text = readFileSync(join(dir, '.git'), 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EISDIR') return cwd
      continue
    }
    const gitdir = text.match(/^gitdir:\s*(.+?)\s*$/m)?.[1]
    const main = gitdir?.match(/^(.*)\/\.git\/worktrees\/[^/]+$/)?.[1]
    if (!main) return cwd
    const rest = relative(dir, cwd)
    return rest ? join(main, rest) : main
  }
  return cwd
}

function parseChat(path: string, size: number, mtimeMs: number): AgentSession | null {
  const head = records(readRange(path, 0, Math.min(size, HEAD_BYTES)))
  const meta = head.find((r) => r.type === 'session_meta')?.payload
  if (!meta || typeof meta.id !== 'string') return null
  if (meta.thread_source !== 'user' || meta.source === 'exec') return null

  const tail = size > HEAD_BYTES ? records(readRange(path, size - TAIL_BYTES, TAIL_BYTES)) : head
  let openTurnAt: number | undefined
  let lastEndedAt: number | undefined
  let model: string | undefined
  let effort: string | undefined
  for (const r of tail) {
    const at = r.timestamp ? Date.parse(r.timestamp) : NaN
    if (r.type === 'turn_context') {
      model = modelLabel(r.payload?.model) ?? model
      effort = typeof r.payload?.effort === 'string' ? r.payload.effort : effort
    }
    if (r.type !== 'event_msg') continue
    if (r.payload?.type === 'task_started') openTurnAt = at
    if (r.payload?.type === 'task_complete' || r.payload?.type === 'turn_aborted') {
      openTurnAt = undefined
      lastEndedAt = at
    }
  }

  const cwd = typeof meta.cwd === 'string' ? mainCheckoutFor(meta.cwd) : undefined
  const busy = openTurnAt !== undefined && Date.now() - mtimeMs < WEDGED_TURN_MS
  const title = names.get(meta.id) ?? firstUserText(head) ?? 'Codex chat'
  return {
    label: title,
    stated: title,
    since: Date.parse(String(meta.timestamp)) || mtimeMs,
    cwd,
    sessionId: meta.id,
    facts: { repo: cwd ? basename(cwd) : undefined, agent: 'codex', model, effort },
    busySince: busy ? openTurnAt : undefined,
    lastActivityAt: busy ? mtimeMs : undefined,
    lastTurnEndedAt: lastEndedAt
  }
}

function chatPaths(root: string): string[] {
  const out: string[] = []
  for (let back = 0; back < DAYS_BACK; back++) {
    const day = new Date(Date.now() - back * 86_400_000)
    const dir = join(
      root,
      'sessions',
      String(day.getFullYear()),
      String(day.getMonth() + 1).padStart(2, '0'),
      String(day.getDate()).padStart(2, '0')
    )
    try {
      for (const name of readdirSync(dir)) {
        if (name.startsWith('rollout-') && name.endsWith('.jsonl')) out.push(join(dir, name))
      }
    } catch {
      continue
    }
  }
  return out
}

export function rescanCodexThreads(home = homedir()): AgentSession[] {
  const root = codexHome(home)
  loadNames(root)
  const now = Date.now()
  const seen = new Set<string>()
  const next: AgentSession[] = []
  for (const path of chatPaths(root)) {
    let st
    try {
      st = statSync(path)
    } catch {
      continue
    }
    if (now - st.mtimeMs > ACTIVE_MS) continue
    seen.add(path)
    let cached = files.get(path)
    if (!cached || cached.mtimeMs !== st.mtimeMs || cached.size !== st.size) {
      let row: AgentSession | null = null
      try {
        row = parseChat(path, st.size, st.mtimeMs)
      } catch {
        row = null
      }
      cached = { mtimeMs: st.mtimeMs, size: st.size, row }
      files.set(path, cached)
    }
    if (cached.row) {
      const name = names.get(cached.row.sessionId ?? '')
      next.push(name ? { ...cached.row, label: name, stated: name } : cached.row)
    }
  }
  for (const path of files.keys()) if (!seen.has(path)) files.delete(path)
  rows = next
  return rows
}

export function codexThreadRows(): AgentSession[] {
  const now = Date.now()
  return rows.filter((r) => now - (r.lastActivityAt ?? r.lastTurnEndedAt ?? r.since) < ACTIVE_MS)
}

export function codexThreadFor(ref: string): AgentSession | undefined {
  return rows.find((r) => r.sessionId === ref || r.label === ref)
}

const PANE_RETRY_MS = 5000
const paneThreads = new Map<string, { id: string; at: number }>()
let rowsChanged: () => void = () => undefined

function execText(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) =>
    execFile(cmd, args, { encoding: 'utf8', timeout: 2000 }, (err, stdout) => resolve(err ? '' : stdout))
  )
}

async function rolloutIdOpenBy(pid: number): Promise<string> {
  const open = await execText('lsof', ['-nP', '-a', '-p', String(pid), '-Fn'])
  const ids = new Set([...open.matchAll(/^n.*\/rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/gim)].map((m) => m[1]))
  return ids.size === 1 ? [...ids][0] : ''
}

// Shims before 0.2.8 report npm (from `npx -y mightymouse-code`) as the agent, so Codex is its parent.
export async function codexThreadIdForAgent(agentPid: number): Promise<string> {
  const id = await rolloutIdOpenBy(agentPid)
  if (id !== '') return id
  const parent = Number.parseInt(await execText('ps', ['-o', 'ppid=', '-p', String(agentPid)]), 10)
  return parent > 1 ? rolloutIdOpenBy(parent) : ''
}

async function resolvePaneThread(key: string, agentPid: number): Promise<void> {
  const id = await codexThreadIdForAgent(agentPid)
  paneThreads.set(key, { id, at: Date.now() })
  if (id !== '') rowsChanged()
}

function paneThreadId(s: AgentSession): string | undefined {
  const pane = s.origin?.tmuxPane
  const agentPid = Number(s.facts?.agentPid)
  if (s.facts?.agent !== 'codex' || s.sessionId || !pane || !(agentPid > 1)) return undefined
  const key = `${pane}:${agentPid}`
  const known = paneThreads.get(key)
  if (known?.id) return known.id
  if (!known || Date.now() - known.at > PANE_RETRY_MS) {
    paneThreads.set(key, { id: '', at: Date.now() })
    void resolvePaneThread(key, agentPid)
  }
  return undefined
}

// The shared Desktop shim carries no chat id: it is the host process, never a chat, chats or not.
export function withCodexThreads(listed: AgentSession[]): AgentSession[] {
  const chats = codexThreadRows()
  const resolved = listed.map((s) => {
    const id = paneThreadId(s)
    return id ? { ...s, sessionId: id } : s
  })
  const ids = new Set(resolved.map((s) => s.sessionId).filter(Boolean))
  const byId = new Map(chats.map((s) => [s.sessionId, s]))
  const kept = resolved
    .filter((s) => !(s.facts?.agent === 'codex' && !s.sessionId && !s.origin?.tmuxPane))
    .map((s) => {
      const chat = s.origin?.tmuxPane && s.sessionId ? byId.get(s.sessionId) : undefined
      return chat ? { ...s, ...chat, label: s.label, stated: s.stated ?? chat.stated, cwd: s.cwd, origin: s.origin, facts: { ...s.facts, ...chat.facts } } : s
    })
  return [...kept, ...chats.filter((c) => !ids.has(c.sessionId))]
}

export function watchCodexThreads(onChange: () => void, home = homedir()): void {
  const root = codexHome(home)
  rowsChanged = onChange
  let timer: NodeJS.Timeout | null = null
  const fire = (): void => {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      rescanCodexThreads(home)
      onChange()
    }, RESCAN_DEBOUNCE_MS)
  }
  rescanCodexThreads(home)
  for (const w of watchers) w.close()
  watchers = []
  for (const [dir, recursive] of [[join(root, 'sessions'), true], [root, false]] as const) {
    try {
      const w = watch(dir, { recursive, persistent: false }, (_e, name) => {
        if (!name || name.endsWith('.jsonl')) fire()
      })
      w.on('error', () => undefined)
      watchers.push(w)
    } catch {
      continue
    }
  }
}

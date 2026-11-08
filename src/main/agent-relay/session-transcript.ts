import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { splitAgentMessage } from '../../shared/attachments'
import {
  askedEnvs,
  commandPaths,
  DEPLOYS_KEPT,
  deploySegments,
  EDITS_KEPT,
  READS_KEPT,
  type SessionTouched
} from '../../shared/surfaces'
import type { AgentHelper, AgentSessionUsage, AgentToolUse, AgentTranscriptTurn } from '../../shared/types'

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/
// One screenshot read is ~350KB of base64, so a byte window alone loses the opening message.
const HEAD_BYTES = 256 * 1024
const FIRST_READ_BYTES = 8 * 1024 * 1024
const KEPT_TURNS = 400
const MAX_TURNS = 60
const TEXT_MAX = 4000
const CURSORS_MAX = 64
const TALLY_CHUNK_BYTES = 4 * 1024 * 1024
const LAST_DETAIL_MAX = 240

const CONFIG_ROOTS_TTL_MS = 30_000
const configRootsByHome = new Map<string, { at: number; roots: string[] }>()

// Another Claude account (CLAUDE_CONFIG_DIR) writes transcripts outside ~/.claude; the shim records each such dir.
export function claudeConfigRoots(home: string): string[] {
  const cached = configRootsByHome.get(home)
  if (cached && Date.now() - cached.at < CONFIG_ROOTS_TTL_MS) return cached.roots
  const roots = [join(home, '.claude')]
  try {
    for (const line of readFileSync(join(home, '.claude', '.mm-config-dirs'), 'utf8').split('\n')) {
      if (line.startsWith('/')) roots.push(line.trim())
    }
  } catch {
    // No shim has recorded a non-default account yet.
  }
  try {
    for (const name of readdirSync(home)) {
      if (name.startsWith('.claude-')) roots.push(join(home, name))
    }
  } catch {
    // Home unreadable: the default account is all there is.
  }
  const live = [...new Set(roots)].filter((root, i) => i === 0 || existsSync(join(root, 'projects')))
  configRootsByHome.set(home, { at: Date.now(), roots: live })
  return live
}

// Two cwd encodings are live on disk; trying one reads as "no transcript".
export function claudeTranscriptPaths(home: string, cwd: string, sessionId: string): string[] {
  if (!home || !cwd || !sessionId || !SAFE_ID.test(sessionId)) return []
  const slugs = [...new Set([cwd.replace(/[/_.]/g, '-'), cwd.replace(/\//g, '-')])]
  return claudeConfigRoots(home).flatMap((root) =>
    slugs.map((slug) => join(root, 'projects', slug, `${sessionId}.jsonl`))
  )
}

// Codex puts the id in the FILENAME under a date dir, so the day must be walked.
export function codexTranscriptPath(home: string, sessionId: string, days = 14): string {
  if (!home || !sessionId || !SAFE_ID.test(sessionId)) return ''
  const root = join(home, '.codex', 'sessions')
  const suffix = `-${sessionId}.jsonl`
  for (let back = 0; back < days; back++) {
    const day = new Date(Date.now() - back * 86_400_000)
    const dir = join(
      root,
      String(day.getFullYear()),
      String(day.getMonth() + 1).padStart(2, '0'),
      String(day.getDate()).padStart(2, '0')
    )
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    const hit = names.find((n) => n.endsWith(suffix))
    if (hit) return join(dir, hit)
  }
  return ''
}

function readRange(path: string, from: number, to: number): Buffer {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(Math.max(0, to - from))
    readSync(fd, buf, 0, buf.length, from)
    return buf
  } finally {
    closeSync(fd)
  }
}

// Complete records only: the writer may be mid-line, so an unfinished tail is read next time.
function completeLines(buf: Buffer): { text: string; used: number } {
  const nl = buf.lastIndexOf(0x0a)
  const rest = buf.subarray(nl + 1).toString('utf8')
  if (rest.trim() !== '') {
    try {
      JSON.parse(rest)
      return { text: buf.toString('utf8'), used: buf.length }
    } catch {
      // Half-written record.
    }
  }
  return { text: buf.subarray(0, nl + 1).toString('utf8'), used: nl + 1 }
}

function lines(blob: string): unknown[] {
  const out: unknown[] = []
  for (const line of blob.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      out.push(JSON.parse(t))
    } catch {
      // A tailed file starts mid-line; the first record is expected to be junk.
    }
  }
  return out
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    const b = block as { type?: string; text?: string }
    if ((b?.type === 'text' || b?.type === 'input_text' || b?.type === 'output_text') && b.text) {
      parts.push(b.text)
    }
  }
  return parts.join('\n')
}

const DETAIL_MAX = 800

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      return asRecord(JSON.parse(value))
    } catch {
      return null
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function str(input: Record<string, unknown> | null, key: string): string {
  const value = input?.[key]
  return typeof value === 'string' ? value.trim() : ''
}

// Longest a value may run before it stops reading as a label and starts being a payload.
const FALLBACK_MAX = 120

// Checked in order, so the argument naming the SUBJECT wins over one naming the mode.
const SUBJECT_KEYS = [
  'command',
  'file_path',
  'path',
  'appPath',
  'pattern',
  'query',
  'q',
  'url',
  'skill',
  'subject',
  'prompt',
  'plan'
]

// Keys that say HOW rather than WHAT; surfacing one reads as the wrong answer.
const SKIP_KEYS = new Set([
  'description',
  'status',
  'activeForm',
  'limit',
  'max_results',
  'offset',
  'timeout',
  'timeout_ms',
  'pageSize',
  'replace_all',
  'run_in_background',
  'returnFormat',
  'messageFormat',
  'taskId',
  'messageId',
  'threadId',
  'simulatorId',
  'bundleId',
  'configuration'
])

function firstSubject(input: Record<string, unknown>): string {
  for (const key of SUBJECT_KEYS) {
    const hit = str(input, key)
    if (hit) return hit
  }
  return ''
}

// Last resort so a tool we have never seen still says something: the first short
// string it was called with, which is nearly always the thing being acted on.
function anyValue(input: Record<string, unknown>): string {
  for (const [key, value] of Object.entries(input)) {
    if (SKIP_KEYS.has(key)) continue
    const flat = Array.isArray(value) ? value.find((v) => typeof v === 'string') : value
    if (typeof flat === 'string' && flat.trim() && flat.length <= FALLBACK_MAX) {
      return flat.trim()
    }
  }
  return ''
}

// The argument that says what the call was FOR; a bare tool name is not a step.
function toolDetail(name: string, rawInput: unknown): string {
  const input = asRecord(rawInput)
  if (!input) return ''
  const described = str(input, 'description')
  // A status flip carries no subject of its own once the task is named elsewhere.
  if (name === 'TaskUpdate' || name === 'TaskCreate') {
    const label = str(input, 'subject') || str(input, 'activeForm')
    // A flip with no subject in the payload: the status IS the whole story,
    // and `(completed)` alone reads as a fragment missing its noun.
    const status = str(input, 'status').replace(/_/g, ' ')
    const head = label && status ? `${label} (${status})` : label || status
    if (head) return head.slice(0, DETAIL_MAX)
  }
  const subject = firstSubject(input) || anyValue(input)
  const body = described && subject ? `${described}\n${subject}` : subject || described
  return body.trim().slice(0, DETAIL_MAX)
}

// What it DID between messages, so a long tool stretch is not a silent gap.
// `name` then the detail after a middot: the thread splits on it to show one
// readable line collapsed and the whole argument when opened.
function toolOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  for (const block of content) {
    const b = block as { type?: string; name?: string; input?: unknown }
    if (b?.type !== 'tool_use' || !b.name) continue
    const detail = toolDetail(b.name, b.input)
    return detail ? `${b.name} \u00b7 ${detail}` : b.name
  }
  return ''
}

function stamp(value: unknown): number {
  if (typeof value === 'number') return value
  const at = Date.parse(String(value ?? ''))
  return Number.isFinite(at) ? at : 0
}

// Harness-injected blobs: rendering them makes turn one a wall of CLAUDE.md.
function isInjected(text: string): boolean {
  return (
    text.startsWith('<user_instructions>') ||
    text.startsWith('<environment_context>') ||
    text.startsWith('<system-reminder>') ||
    text.startsWith('[Image:') ||
    text.startsWith('Caveat: The messages below')
  )
}

function push(turns: AgentTranscriptTurn[], turn: AgentTranscriptTurn): void {
  const text = turn.text.trim().slice(0, TEXT_MAX)
  if (!text && !turn.files?.length) return
  const last = turns[turns.length - 1]
  if (last && last.role === turn.role && last.text === text && !turn.files?.length) return
  turns.push({ ...turn, text })
}

const SAID_MEDIA_PATH = /(?:^|[\s`(\['"])((?:~|\/)[^\s`)\]'"]+\.(?:png|jpe?g|webp|gif|mp4|mov|m4v|webm))(?=$|[\s`)\]'"]|[.,:;](?:$|[\s`)\]'"]))/gim

function mediaNamedIn(body: string): string[] {
  const found = [...body.matchAll(SAID_MEDIA_PATH)].map((m) => (m[1].startsWith('~') ? join(homedir(), m[1].slice(1)) : m[1]))
  return [...new Set(found)].filter((p) => existsSync(p))
}

function pushSaid(turns: AgentTranscriptTurn[], role: 'you' | 'agent', at: number, body: string): void {
  if (role === 'agent') {
    const files = mediaNamedIn(body)
    return push(turns, files.length ? { role, at, text: body, files } : { role, at, text: body })
  }
  const { text, paths } = splitAgentMessage(body)
  push(turns, paths.length ? { role, at, text, files: paths } : { role, at, text })
}

type ToolTally = Map<string, AgentToolUse>
type Seen = { tally: ToolTally; touched: SessionTouched; usage: AgentSessionUsage; counted: Set<string> }
type Parse = (blob: string, turns: AgentTranscriptTurn[], seen: Seen) => void

const newSeen = (): Seen => ({
  tally: new Map(),
  touched: { edits: {}, reads: {}, deploys: [], asked: {} },
  usage: { output: 0 },
  counted: new Set()
})

type ClaudeUsage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }

// Claude writes one line per content block, each repeating the message's usage; count each message id once.
function noteClaudeUsage(seen: Seen, id: string | undefined, u: ClaudeUsage | undefined): void {
  if (!id || !u || seen.counted.has(id)) return
  seen.counted.add(id)
  seen.usage.output += u.output_tokens ?? 0
  seen.usage.context = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
}

type CodexTokens = {
  info?: { total_token_usage?: { output_tokens?: number }; last_token_usage?: { input_tokens?: number }; model_context_window?: number }
  rate_limits?: { primary?: { used_percent?: number } }
}

function noteCodexUsage(seen: Seen, p: CodexTokens): void {
  if (p.info?.total_token_usage) seen.usage.output = p.info.total_token_usage.output_tokens ?? seen.usage.output
  if (p.info?.last_token_usage) seen.usage.context = p.info.last_token_usage.input_tokens
  if (p.info?.model_context_window) seen.usage.contextWindow = p.info.model_context_window
  if (p.rate_limits?.primary?.used_percent !== undefined) seen.usage.planUsedPct = p.rate_limits.primary.used_percent
}

function toolKind(name: string, input: unknown, namespace?: string): Pick<AgentToolUse, 'kind' | 'name'> & { tool?: string } {
  const mcp = namespace?.startsWith('mcp__') ? [namespace.slice(5), name] : name.startsWith('mcp__') ? name.slice(5).split('__') : null
  if (mcp?.[0]) return { kind: 'app', name: mcp[0], tool: mcp.slice(1).join('__') || undefined }
  const args = asRecord(input)
  if (name === 'Skill' && str(args, 'skill')) return { kind: 'skill', name: str(args, 'skill') }
  if (name === 'Agent' || name === 'Task') return { kind: 'helper', name: str(args, 'subagent_type') || 'general-purpose' }
  return { kind: 'builtin', name }
}

function countTool({ tally, touched }: Seen, at: number, name: string, input: unknown, namespace?: string): void {
  noteTouched(touched, at, name, input)
  const found = toolKind(name, input, namespace)
  const key = `${found.kind}:${found.name}`
  const use = tally.get(key) ?? { kind: found.kind, name: found.name, calls: 0, lastAt: 0, lastDetail: '', tools: {} }
  use.calls++
  if (at >= use.lastAt) {
    use.lastAt = at
    use.lastDetail = toolDetail(name, input).split('\n')[0].slice(0, LAST_DETAIL_MAX)
  }
  if (found.tool) use.tools[found.tool] = (use.tools[found.tool] ?? 0) + 1
  tally.set(key, use)
}

const EDIT_PATH_KEY: Record<string, string> = {
  Edit: 'file_path',
  Write: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path'
}
const READ_PATH_KEY: Record<string, string> = { Read: 'file_path', Grep: 'path', Glob: 'path' }
const PATCHED_FILE = /^\*\*\* (?:Update|Add) File: (.+)$/gm

function keepLatest(seen: Record<string, number>, path: string, at: number, kept: number): void {
  if (!path || (!(path in seen) && Object.keys(seen).length >= kept)) return
  seen[path] = Math.max(seen[path] ?? 0, at)
}

function commandOf(args: Record<string, unknown> | null): string {
  const value = args?.command ?? args?.cmd
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string').join(' ')
  return typeof value === 'string' ? value : ''
}

function noteTouched(touched: SessionTouched, at: number, name: string, input: unknown): void {
  const args = asRecord(input)
  const command = commandOf(args)
  const patch = command || (typeof input === 'string' ? input : '')
  const edited = EDIT_PATH_KEY[name]
    ? [str(args, EDIT_PATH_KEY[name])]
    : [...patch.matchAll(PATCHED_FILE)].map((m) => m[1].trim())
  const read = READ_PATH_KEY[name] ? [str(args, READ_PATH_KEY[name])] : commandPaths(command)
  for (const path of edited) keepLatest(touched.edits, path, at, EDITS_KEPT)
  for (const path of read) keepLatest(touched.reads, path, at, READS_KEPT)
  for (const segment of deploySegments(command)) {
    const again = touched.deploys.findIndex((d) => d.command === segment)
    if (again >= 0) touched.deploys.splice(again, 1)
    touched.deploys.push({ at, command: segment })
  }
  if (touched.deploys.length > DEPLOYS_KEPT) touched.deploys.splice(0, touched.deploys.length - DEPLOYS_KEPT)
}

function attachRecap(turns: AgentTranscriptTurn[], content: unknown): void {
  const recap = String(content ?? '').replace(/\s*\(disable recaps in \/config\)\s*$/, '').trim()
  const reply = turns.findLast((t) => t.role !== 'tool')
  if (!recap || reply?.role !== 'agent') return
  for (const t of turns) delete t.recap
  reply.recap = recap
}

function noteAsked(touched: SessionTouched, at: number, said: string): void {
  for (const env of askedEnvs(said)) touched.asked[env] = at
}

function parseClaude(blob: string, turns: AgentTranscriptTurn[], seen: Seen): void {
  for (const record of lines(blob)) {
    const r = record as {
      type?: string
      subtype?: string
      content?: unknown
      isMeta?: boolean
      isCompactSummary?: boolean
      timestamp?: string
      message?: { role?: string; content?: unknown; id?: string; usage?: ClaudeUsage }
    }
    if (r.type === 'system' && r.subtype === 'away_summary') attachRecap(turns, r.content)
    if (r.type === 'assistant') noteClaudeUsage(seen, r.message?.id, r.message?.usage)
    if (r.type !== 'user' && r.type !== 'assistant') continue
    if (r.isMeta || r.isCompactSummary) continue
    const at = stamp(r.timestamp)
    if (r.type === 'assistant' && Array.isArray(r.message?.content)) {
      for (const block of r.message.content as { type?: string; name?: string; input?: unknown }[]) {
        if (block?.type === 'tool_use' && block.name) countTool(seen, at, block.name, block.input)
      }
    }
    const body = textOf(r.message?.content)
    if (body && !isInjected(body)) {
      if (r.type === 'user') noteAsked(seen.touched, at, body)
      pushSaid(turns, r.type === 'user' ? 'you' : 'agent', at, body)
      continue
    }
    const tool = r.type === 'assistant' ? toolOf(r.message?.content) : ''
    if (tool) push(turns, { role: 'tool', at, text: tool })
  }
}

function parseCodex(blob: string, turns: AgentTranscriptTurn[], seen: Seen): void {
  for (const record of lines(blob)) {
    const r = record as {
      type?: string
      timestamp?: string
      payload?: {
        type?: string
        role?: string
        content?: unknown
        name?: string
        namespace?: string
        arguments?: unknown
        input?: unknown
        action?: unknown
      }
    }
    if (r.type === 'event_msg' && r.payload?.type === 'token_count') noteCodexUsage(seen, r.payload as CodexTokens)
    if (r.type !== 'response_item') continue
    const p = r.payload
    const at = stamp(r.timestamp)
    if (p?.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
      const body = textOf(p.content)
      if (body && !isInjected(body)) {
        if (p.role === 'user') noteAsked(seen.touched, at, body)
        pushSaid(turns, p.role === 'user' ? 'you' : 'agent', at, body)
      }
      continue
    }
    if (p?.type === 'custom_tool_call' && p.name) countTool(seen, at, p.name, p.input)
    if (p?.type === 'function_call' || p?.type === 'local_shell_call') {
      const name = p.name || (p.type === 'local_shell_call' ? 'shell' : '')
      if (!name) continue
      countTool(seen, at, name, p.arguments ?? p.action, p.namespace)
      const detail = toolDetail(name, p.arguments ?? p.action)
      push(turns, { role: 'tool', at, text: detail ? `${name} \u00b7 ${detail}` : name })
    }
  }
}

interface Cursor {
  offset: number
  turns: AgentTranscriptTurn[]
  seen: Seen
  opening?: AgentTranscriptTurn
}

const cursors = new Map<string, Cursor>()
const TOOL_LINE = /"(tool_use|function_call|custom_tool_call|local_shell_call|output_tokens|token_count)"/

// The byte window skips the middle of a long session; its tool calls still count.
function tallyRange(path: string, from: number, to: number, parse: Parse, seen: Seen): void {
  while (from < to) {
    const chunk = completeLines(readRange(path, from, Math.min(to, from + TALLY_CHUNK_BYTES)))
    if (!chunk.used) return
    const hits = chunk.text.split('\n').filter((line) => TOOL_LINE.test(line))
    parse(hits.join('\n'), [], seen)
    from += chunk.used
  }
}

// Append-only JSONL: after the first read only the new bytes are parsed.
function readCursor(path: string, parse: Parse): Cursor | undefined {
  let size: number
  try {
    size = statSync(path).size
  } catch {
    return undefined
  }
  let cursor = cursors.get(path)
  try {
    let midLine = false
    if (!cursor || size < cursor.offset) {
      cursor = { offset: 0, turns: [], seen: newSeen() }
      if (size > FIRST_READ_BYTES) {
        const head: AgentTranscriptTurn[] = []
        parse(completeLines(readRange(path, 0, HEAD_BYTES)).text, head, newSeen())
        cursor.opening = head.find((t) => t.role === 'you')
        cursor.offset = size - FIRST_READ_BYTES
        midLine = true
      }
    }
    let buf = readRange(path, cursor.offset, size)
    if (midLine) {
      const skip = buf.indexOf(0x0a) + 1
      buf = buf.subarray(skip)
      cursor.offset += skip
      tallyRange(path, 0, cursor.offset, parse, cursor.seen)
    }
    const chunk = completeLines(buf)
    parse(chunk.text, cursor.turns, cursor.seen)
    cursor.offset += chunk.used
  } catch {
    return cursor
  }
  cursor.opening ??= cursor.turns.find((t) => t.role === 'you')
  if (cursor.turns.length > KEPT_TURNS) cursor.turns = cursor.turns.slice(-KEPT_TURNS)
  cursors.delete(path)
  cursors.set(path, cursor)
  if (cursors.size > CURSORS_MAX) cursors.delete(cursors.keys().next().value as string)
  return cursor
}

function withOpening(recent: AgentTranscriptTurn[], opening?: AgentTranscriptTurn): AgentTranscriptTurn[] {
  if (!opening || recent.includes(opening)) return recent
  return [opening, ...recent]
}

type TranscriptSession = { cwd?: string; sessionId?: string; facts?: { agent?: string } }

function sessionCursor(session: TranscriptSession, home: string): Cursor | undefined {
  return sessionSource(session, home)?.cursor
}

export function sessionAccountHome(session: TranscriptSession, home = homedir()): { backend: 'claude' | 'codex'; dir: string } | null {
  const path = sessionSource(session, home)?.path
  if (!path) return null
  if (path.startsWith(join(home, '.codex') + '/')) return { backend: 'codex', dir: join(home, '.codex') }
  return { backend: 'claude', dir: dirname(dirname(dirname(path))) }
}

function sessionSource(session: TranscriptSession, home: string): { cursor: Cursor; path: string } | undefined {
  const id = session.sessionId
  if (!id) return undefined
  const agent = (session.facts?.agent ?? '').toLowerCase()
  const codexFirst = agent.includes('codex')
  const claude = (session.cwd ? claudeTranscriptPaths(home, session.cwd, id) : []).map((path) => ({
    path,
    parse: parseClaude
  }))
  const codex = [{ path: codexTranscriptPath(home, id), parse: parseCodex }]
  for (const source of codexFirst ? [...codex, ...claude] : [...claude, ...codex]) {
    if (!source.path) continue
    const cursor = readCursor(source.path, source.parse)
    if (cursor?.turns.length) return { cursor, path: source.path }
  }
  return undefined
}

// Empty = no transcript found, i.e. a session that has not written one yet.
export function readSessionTranscript(session: TranscriptSession, home = homedir()): AgentTranscriptTurn[] {
  const cursor = sessionCursor(session, home)
  return cursor ? withOpening(cursor.turns.slice(-MAX_TURNS), cursor.opening) : []
}

export function readSessionTools(session: TranscriptSession, home = homedir()): AgentToolUse[] {
  return [...(sessionCursor(session, home)?.seen.tally.values() ?? [])].sort((a, b) => b.calls - a.calls)
}

export function readSessionUsage(session: TranscriptSession, home = homedir()): AgentSessionUsage | null {
  const usage = sessionCursor(session, home)?.seen.usage
  return usage && (usage.output > 0 || usage.context) ? usage : null
}

export function readSessionTouched(session: TranscriptSession, home = homedir()): SessionTouched {
  return sessionCursor(session, home)?.seen.touched ?? { edits: {}, reads: {}, deploys: [], asked: {} }
}

const HELPER_TAIL_BYTES = 256 * 1024
// A killed helper never writes `end_turn`; this drops it once it goes quiet.
const HELPER_STALE_MS = 30 * 60_000

function helperStep(path: string, size: number): { done: boolean; doing: string } {
  const records = lines(completeLines(readRange(path, Math.max(0, size - HELPER_TAIL_BYTES), size)).text)
  const replies = records.filter((r) => (r as { type?: string }).type === 'assistant') as {
    message?: { stop_reason?: string; content?: unknown }
  }[]
  if (replies.at(-1)?.message?.stop_reason === 'end_turn') return { done: true, doing: '' }
  const doing = replies.findLast((r) => toolOf(r.message?.content))
  return { done: false, doing: doing ? toolOf(doing.message?.content) : '' }
}

// Claude Code's own background agents, read off `<session>/subagents/*.meta.json`.
export function readRunningHelpers(
  session: { cwd?: string; sessionId?: string },
  home = homedir(),
  now = Date.now()
): AgentHelper[] {
  if (!session.cwd || !session.sessionId) return []
  const helpers: AgentHelper[] = []
  for (const transcript of claudeTranscriptPaths(home, session.cwd, session.sessionId)) {
    const dir = join(transcript.replace(/\.jsonl$/, ''), 'subagents')
    let names: string[]
    try {
      names = readdirSync(dir).filter((n) => n.endsWith('.meta.json'))
    } catch {
      continue
    }
    for (const name of names) {
      const log = join(dir, name.replace(/\.meta\.json$/, '.jsonl'))
      try {
        const stat = statSync(log)
        if (now - stat.mtimeMs > HELPER_STALE_MS) continue
        const step = helperStep(log, stat.size)
        if (step.done) continue
        const meta = JSON.parse(readFileSync(join(dir, name), 'utf8')) as { description?: string }
        helpers.push({ task: meta.description?.trim() || 'Background agent', doing: step.doing, since: stat.birthtimeMs })
      } catch {
        continue
      }
    }
  }
  return helpers.sort((a, b) => a.since - b.since)
}

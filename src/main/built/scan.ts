import { execFile, spawn } from 'child_process'
import { closeSync, existsSync, openSync } from 'fs'
import { mkdir, open, readdir, readFile, stat, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { basename, dirname, join } from 'path'
import { promisify } from 'util'
import type { BuiltRunResult, BuiltItem, BuiltKind } from '../../shared/built'
import type { MightyProject } from '../../shared/types'
import { mightyProjectForCwd } from '../../shared/relay-sessions'
import { MIGHTY } from '../store/mighty'
import { PATHS } from '../store/paths'

const run = promisify(execFile)
const INDEX_FILE = join(PATHS.MIGHTY_DIR, 'built-index.json')
const LOOKBACK_MS = 30 * 86_400_000
const STOPPED_KEEP_MS = 7 * 86_400_000
const MAX_LINE = 2_000_000
const MAX_TIMES = 20
const ARTIFACT_URL = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9-]{8,}/
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1):(\d{2,5})[^\s"'`)<>\]\\]*/g
const SKIP_FILE = /\/(node_modules|dist|out|build|src)\/|^\/(private\/)?tmp\//

interface Seen {
  firstSeen: string
  lastSeen: string
  sessionId?: string
  cwd?: string
  versions: number
  times?: string[]
  file?: string
  url?: string
  run?: { command: string; cwd: string }
}

interface BuiltIndex {
  version: 3
  offsets: Record<string, number>
  chats: Record<string, { title: string; ai: boolean }>
  online: Record<string, Seen>
  files: Record<string, Seen>
  ports: Record<string, Seen>
  hidden: string[]
  favorites?: string[]
}

const empty = (): BuiltIndex => ({ version: 3, offsets: {}, chats: {}, online: {}, files: {}, ports: {}, hidden: [] })
const pendingPublishes = new Map<string, { file: string }>()
let index: BuiltIndex | null = null

async function loadIndex(): Promise<BuiltIndex> {
  if (index) return index
  try {
    const parsed = JSON.parse(await readFile(INDEX_FILE, 'utf8')) as BuiltIndex
    index = parsed.version === 3 ? parsed : empty()
  } catch {
    index = empty()
  }
  return index
}

async function saveIndex(idx: BuiltIndex): Promise<void> {
  await mkdir(dirname(INDEX_FILE), { recursive: true })
  await writeFile(INDEX_FILE, JSON.stringify(idx))
}

function note(map: Record<string, Seen>, key: string, ts: string, row: TranscriptRow, extra: Partial<Seen> = {}): Seen {
  const prev = map[key]
  const next: Seen = prev
    ? { ...prev, ...extra, lastSeen: ts > prev.lastSeen ? ts : prev.lastSeen, versions: prev.versions + (extra.versions ?? 0) }
    : { firstSeen: ts, lastSeen: ts, versions: extra.versions ?? 0, ...extra }
  if (extra.versions) next.times = [...(prev?.times ?? []), ts].sort().slice(-MAX_TIMES)
  if (ts >= (prev?.lastSeen ?? '')) {
    next.sessionId = row.sessionId ?? next.sessionId
    next.cwd = row.cwd ?? next.cwd
  }
  map[key] = next
  return next
}

interface TranscriptRow {
  type?: string
  aiTitle?: string
  customTitle?: string
  timestamp?: string
  sessionId?: string
  cwd?: string
  message?: { content?: unknown }
  toolUseResult?: { artifact_id?: string }
}

interface ContentBlock {
  type?: string
  id?: string
  name?: string
  text?: string
  input?: { file_path?: string; action?: string; asset?: boolean }
  tool_use_id?: string
  content?: unknown
}

function readRow(idx: BuiltIndex, row: TranscriptRow): void {
  if (row.sessionId && (row.aiTitle || row.customTitle)) {
    const prev = idx.chats[row.sessionId]
    if (row.aiTitle) idx.chats[row.sessionId] = { title: row.aiTitle, ai: true }
    else if (!prev?.ai) idx.chats[row.sessionId] = { title: row.customTitle!, ai: false }
    return
  }
  const content = row.message?.content
  const ts = row.timestamp
  if (!Array.isArray(content) || !ts) return
  for (const block of content as ContentBlock[]) {
    if (row.type === 'assistant' && block.type === 'tool_use') {
      const file = block.input?.file_path
      if (block.name === 'Artifact' && file && !block.input?.asset && (block.input?.action ?? 'publish') === 'publish' && block.id)
        pendingPublishes.set(block.id, { file })
      if (block.name === 'Write' && file && /\.html?$/i.test(file) && !SKIP_FILE.test(file))
        note(idx.files, file, ts, row, { versions: 1 })
    } else if (row.type === 'assistant' && block.type === 'text' && block.text) {
      for (const m of block.text.matchAll(LOCAL_URL)) note(idx.ports, m[1], ts, row, { url: m[0] })
    } else if (row.type === 'user' && block.type === 'tool_result' && block.tool_use_id) {
      const pending = pendingPublishes.get(block.tool_use_id)
      if (!pending) continue
      pendingPublishes.delete(block.tool_use_id)
      const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
      const url = text.match(ARTIFACT_URL)?.[0]
      const uuid = row.toolUseResult?.artifact_id
      const open = uuid ? `https://claude.ai/code/artifact/${uuid}` : undefined
      if (url) note(idx.online, open ?? url, ts, row, { file: pending.file, versions: 1 })
    }
  }
}

function worthParsing(line: string): boolean {
  if (line.length > MAX_LINE || line.includes('"prompt_snapshot"')) return false
  return (
    line.includes('-title"') ||
    line.includes('"Artifact"') ||
    line.includes('claude.ai/') ||
    line.includes('.html') ||
    line.includes('localhost:') ||
    line.includes('127.0.0.1:')
  )
}

async function readNewLines(idx: BuiltIndex, path: string, size: number): Promise<void> {
  let from = idx.offsets[path] ?? 0
  if (from > size) from = 0
  if (from === size) return
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(size - from)
    await fh.read(buf, 0, buf.length, from)
    const end = buf.lastIndexOf(0x0a)
    if (end < 0) return
    for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
      if (!worthParsing(line)) continue
      try {
        readRow(idx, JSON.parse(line) as TranscriptRow)
      } catch {
        continue
      }
    }
    idx.offsets[path] = from + end + 1
  } finally {
    await fh.close()
  }
}

function transcriptDirsFor(projects: MightyProject[], dirs: string[]): string[] {
  const slugs = projects
    .flatMap((p) => (p.repoFolder ? [p.repoFolder.replace(/[/_.]/g, '-'), p.repoFolder.replace(/\//g, '-')] : []))
  return dirs.filter((d) => slugs.some((s) => d === s || d.startsWith(`${s}-`)))
}

async function scanTranscripts(idx: BuiltIndex, projects: MightyProject[]): Promise<void> {
  const root = join(homedir(), '.claude', 'projects')
  if (!existsSync(root)) return
  const since = Date.now() - LOOKBACK_MS
  for (const dir of transcriptDirsFor(projects, await readdir(root))) {
    const names = await readdir(join(root, dir)).catch(() => [] as string[])
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      const path = join(root, dir, name)
      const st = await stat(path).catch(() => null)
      if (!st || st.mtimeMs < since) continue
      await readNewLines(idx, path, st.size)
      await new Promise((r) => setImmediate(r))
    }
  }
}

async function projectPages(projects: MightyProject[]): Promise<Array<{ file: string; mtime: string }>> {
  const out: Array<{ file: string; mtime: string }> = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory() && depth < 3) await walk(p, depth + 1)
      else if (e.isFile() && /\.html?$/i.test(e.name)) {
        const st = await stat(p).catch(() => null)
        if (st) out.push({ file: p, mtime: st.mtime.toISOString() })
      }
    }
  }
  for (const p of projects) if (p.repoFolder) await walk(join(p.repoFolder, '.claude', 'artifacts'), 0)
  return out
}

interface Listener {
  pid: number
  port: number
  command: string
  full: string
  cwd: string
  ours: boolean
}

async function listeners(): Promise<Listener[]> {
  const { stdout } = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn']).catch(() => ({ stdout: '' }))
  const ports = new Map<number, number>()
  let pid = 0
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n')) {
      const port = Number(line.slice(line.lastIndexOf(':') + 1))
      if (pid && port && !ports.has(port)) ports.set(port, pid)
    }
  }
  const pids = [...new Set(ports.values())]
  if (pids.length === 0) return []
  const cwds = new Map<number, string>()
  const { stdout: cwdOut } = await run('lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', pids.join(',')]).catch(() => ({ stdout: '' }))
  for (const line of cwdOut.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n')) cwds.set(pid, line.slice(1))
  }
  const commands = new Map<number, string>()
  const parents = new Map<number, number>()
  const { stdout: psOut } = await run('ps', ['-axo', 'pid=,ppid=,command=']).catch(() => ({ stdout: '' }))
  for (const line of psOut.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)
    if (!m) continue
    parents.set(Number(m[1]), Number(m[2]))
    commands.set(Number(m[1]), m[3])
  }
  const ours = appProcesses(parents)
  return [...ports].flatMap(([port, pid]) => {
    const command = commands.get(pid) ?? ''
    const cwd = cwds.get(pid) ?? ''
    if (!cwd) return []
    const isApp = ours(pid) || /\/(Electron|MightyMouse)(\.app)?\b/.test(command)
    return [{ pid, port, command: shortCommand(command), full: command, cwd, ours: isApp }]
  })
}

function runTitle(command: string): string {
  return shortCommand(command).split(' ').filter((part) => !part.startsWith('-')).slice(0, 3).join(' ')
}

function appProcesses(parents: Map<number, number>): (pid: number) => boolean {
  const ancestors = new Set<number>()
  for (let p = process.pid; p > 1 && !ancestors.has(p); p = parents.get(p) ?? 0) ancestors.add(p)
  return (pid) => {
    if (ancestors.has(pid)) return true
    for (let p = parents.get(pid) ?? 0, hops = 0; p > 1 && hops < 32; p = parents.get(p) ?? 0, hops++) if (p === process.pid) return true
    return false
  }
}

function shortCommand(command: string): string {
  const parts = command.split(/\s+/).map((part) => (part.includes('/') ? basename(part) : part))
  const start = /^(node|bun|deno|python3?)$/.test(parts[0] ?? '') ? 1 : 0
  return parts.slice(start).join(' ').slice(0, 80)
}

const titleCache = new Map<string, { mtime: string; title: string }>()

async function fileTitle(file: string, mtime: string): Promise<string> {
  const hit = titleCache.get(file)
  if (hit?.mtime === mtime) return hit.title
  const fh = await open(file, 'r').catch(() => null)
  let title = ''
  if (fh) {
    const buf = Buffer.alloc(8192)
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    await fh.close()
    title = buf.subarray(0, bytesRead).toString('utf8').match(/<title[^>]*>([^<]{1,120})<\/title>/i)?.[1]?.trim() ?? ''
  }
  title ||= basename(file).replace(/\.html?$/i, '').replace(/[-_]+/g, ' ')
  titleCache.set(file, { mtime, title })
  return title
}

async function pageTitle(port: number): Promise<string> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(700) })
    if (!(res.headers.get('content-type') ?? '').includes('html')) return ''
    return (await res.text()).slice(0, 8192).match(/<title[^>]*>([^<]{1,120})<\/title>/i)?.[1]?.trim() ?? ''
  } catch {
    return ''
  }
}

function born(firstSeen: string, st: { birthtime: Date } | null): string {
  const made = st?.birthtime.toISOString()
  return made && made < firstSeen ? made : firstSeen
}

function idFor(kind: BuiltKind | 'port', key: string): string {
  return `${kind === 'online' ? 'online' : kind === 'file' ? 'file' : 'port'}:${key}`
}

async function toItems(idx: BuiltIndex, projects: MightyProject[], live: Listener[], pages: Array<{ file: string; mtime: string }>): Promise<BuiltItem[]> {
  const items: BuiltItem[] = []
  const projectOf = (cwd?: string): string => mightyProjectForCwd(cwd, projects)?.id ?? ''
  const publishedFiles = new Set<string>()
  const chatOf = (sessionId?: string): string | undefined => (sessionId ? idx.chats[sessionId]?.title : undefined)

  for (const [url, seen] of Object.entries(idx.online)) {
    const projectId = projectOf(seen.cwd)
    if (!projectId) continue
    const st = seen.file ? await stat(seen.file).catch(() => null) : null
    if (seen.file) publishedFiles.add(seen.file)
    items.push({
      id: idFor('online', url),
      kind: 'online',
      title: seen.file && st ? await fileTitle(seen.file, st.mtime.toISOString()) : basename(seen.file ?? url),
      projectId,
      url,
      file: st ? seen.file : undefined,
      sessionId: seen.sessionId,
      chat: chatOf(seen.sessionId),
      cwd: seen.cwd,
      madeBy: 'Claude',
      firstSeen: born(seen.firstSeen, st),
      lastSeen: seen.lastSeen,
      versions: seen.versions,
      history: seen.times
    })
  }

  const files = new Map<string, Seen>()
  for (const [file, seen] of Object.entries(idx.files)) files.set(file, seen)
  for (const page of pages) {
    const seen = files.get(page.file)
    files.set(page.file, seen ? { ...seen, lastSeen: page.mtime > seen.lastSeen ? page.mtime : seen.lastSeen } : { firstSeen: page.mtime, lastSeen: page.mtime, versions: 1, cwd: dirname(page.file) })
  }
  for (const [file, seen] of files) {
    if (publishedFiles.has(file)) continue
    const st = await stat(file).catch(() => null)
    const projectId = projectOf(file) || projectOf(seen.cwd)
    if (!st || !projectId) continue
    items.push({
      id: idFor('file', file),
      kind: 'file',
      title: await fileTitle(file, st.mtime.toISOString()),
      projectId,
      file,
      sessionId: seen.sessionId,
      chat: chatOf(seen.sessionId),
      cwd: seen.cwd,
      madeBy: 'Claude',
      firstSeen: born(seen.firstSeen, st),
      lastSeen: seen.lastSeen,
      versions: seen.versions,
      history: seen.times
    })
  }

  const livePorts = new Set<number>()
  for (const l of live) {
    const projectId = projectOf(l.cwd)
    if (!projectId) continue
    livePorts.add(l.port)
    const seen = idx.ports[String(l.port)]
    const now = new Date().toISOString()
    items.push({
      id: idFor('port', String(l.port)),
      kind: 'running',
      title: (await pageTitle(l.port)) || runTitle(l.full),
      projectId,
      url: seen?.url && projectOf(seen.cwd) === projectId ? seen.url : `http://localhost:${l.port}`,
      port: l.port,
      pid: l.pid,
      command: l.command,
      sessionId: projectOf(seen?.cwd) === projectId ? seen?.sessionId : undefined,
      chat: projectOf(seen?.cwd) === projectId ? chatOf(seen?.sessionId) : undefined,
      cwd: l.cwd,
      madeBy: 'Claude',
      firstSeen: seen?.firstSeen ?? now,
      lastSeen: now,
      versions: 0
    })
  }
  for (const [port, seen] of Object.entries(idx.ports)) {
    const projectId = projectOf(seen.cwd)
    const expired = Date.now() - Date.parse(seen.lastSeen) > STOPPED_KEEP_MS && !idx.favorites?.includes(idFor('port', port))
    if (livePorts.has(Number(port)) || !projectId || expired) continue
    items.push({
      id: idFor('port', port),
      kind: 'stopped',
      title: seen.run ? runTitle(seen.run.command) : `Local server :${port}`,
      projectId,
      url: seen.url ?? `http://localhost:${port}`,
      port: Number(port),
      command: seen.run ? shortCommand(seen.run.command) : undefined,
      canStart: Boolean(seen.run),
      sessionId: seen.sessionId,
      chat: chatOf(seen.sessionId),
      cwd: seen.cwd,
      madeBy: 'Claude',
      firstSeen: seen.firstSeen,
      lastSeen: seen.lastSeen,
      versions: 0
    })
  }
  const hidden = new Set(idx.hidden)
  const favorites = new Set(idx.favorites)
  return items.filter((i) => !hidden.has(i.id)).map((i) => (favorites.has(i.id) ? { ...i, favorite: true } : i))
}

let lastItems: BuiltItem[] = []
let scanning: Promise<BuiltItem[]> | null = null

export function cachedBuilt(): BuiltItem[] {
  return lastItems
}

export function scanBuilt(): Promise<BuiltItem[]> {
  scanning ??= (async () => {
    try {
      const idx = await loadIndex()
      const projects = MIGHTY.listProjects().filter((p) => !p.archived && p.repoFolder)
      await scanTranscripts(idx, projects)
      const [all, pages] = await Promise.all([listeners(), projectPages(projects)])
      const live = all.filter((l) => !l.ours)
      for (const l of all) if (l.ours) delete idx.ports[String(l.port)]
      rememberHowToStart(idx, live, projects)
      await saveIndex(idx)
      lastItems = await toItems(idx, projects, live, pages)
      return lastItems
    } finally {
      scanning = null
    }
  })()
  return scanning
}

export async function hideBuilt(id: string): Promise<BuiltItem[]> {
  const idx = await loadIndex()
  if (!idx.hidden.includes(id)) idx.hidden.push(id)
  await saveIndex(idx)
  lastItems = lastItems.filter((i) => i.id !== id)
  return lastItems
}

export async function favoriteBuilt(id: string, on: boolean): Promise<BuiltItem[]> {
  const idx = await loadIndex()
  idx.favorites = (idx.favorites ?? []).filter((f) => f !== id).concat(on ? [id] : [])
  await saveIndex(idx)
  lastItems = lastItems.map((i) => (i.id === id ? { ...i, favorite: on || undefined } : i))
  return lastItems
}

function rememberHowToStart(idx: BuiltIndex, live: Listener[], projects: MightyProject[]): void {
  const now = new Date().toISOString()
  for (const l of live) {
    if (!mightyProjectForCwd(l.cwd, projects)) continue
    const prev = idx.ports[String(l.port)]
    idx.ports[String(l.port)] = {
      ...(prev ?? { firstSeen: now, versions: 0, cwd: l.cwd }),
      lastSeen: now,
      run: { command: l.full, cwd: l.cwd }
    }
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function portOwner(port: number): Promise<number | undefined> {
  return (await listeners()).find((l) => l.port === port)?.pid
}

async function waitForPort(port: number, until: (owner: number | undefined) => boolean, ms: number): Promise<number | undefined> {
  let owner = await portOwner(port)
  for (const end = Date.now() + ms; !until(owner) && Date.now() < end; owner = await portOwner(port)) await sleep(400)
  return owner
}

export async function stopBuilt(id: string): Promise<BuiltRunResult> {
  const item = lastItems.find((i) => i.id === id)
  if (item?.kind !== 'running' || !item.pid || !item.port) return 'failed'
  if ((await portOwner(item.port)) !== item.pid) return 'failed'
  const kill = (signal: NodeJS.Signals): void => {
    try {
      process.kill(item.pid!, signal)
    } catch {
      return
    }
  }
  kill('SIGTERM')
  let owner = await waitForPort(item.port, (o) => o !== item.pid, 3_000)
  if (owner === item.pid) {
    kill('SIGKILL')
    owner = await waitForPort(item.port, (o) => o !== item.pid, 2_000)
  }
  if (owner === item.pid) return 'failed'
  if (owner === undefined) owner = await waitForPort(item.port, (o) => o !== undefined, 1_500)
  return owner === undefined ? 'stopped' : 'restarted'
}

export async function startBuilt(id: string): Promise<BuiltRunResult> {
  const item = lastItems.find((i) => i.id === id)
  const how = item?.port ? (await loadIndex()).ports[String(item.port)]?.run : undefined
  if (item?.kind !== 'stopped' || !item.port || !how || !existsSync(how.cwd)) return 'failed'
  const log = openSync(join(PATHS.MIGHTY_DIR, `built-start-${item.port}.log`), 'a')
  const child = spawn(process.env.SHELL || '/bin/zsh', ['-lc', `${how.command} &`], { cwd: how.cwd, detached: true, stdio: ['ignore', log, log] })
  closeSync(log)
  child.on('error', () => undefined)
  child.unref()
  return (await waitForPort(item.port, (o) => o !== undefined, 15_000)) === undefined ? 'failed' : 'started'
}

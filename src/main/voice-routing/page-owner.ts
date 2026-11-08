import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { open } from 'fs/promises'
import { homedir } from 'os'
import { dirname, join, sep } from 'path'
import type { AgentSink } from './agent-sinks'

export interface PageOwner {
  sinkId: string
  /** 'used': this agent's own replies or commands named the page. 'served': the page's local server runs in this agent's folder, nothing more. */
  strength: 'used' | 'served'
  phrase: string
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]'])
const isLocalHost = (host: string): boolean => LOCAL_HOSTS.has(host) || host.endsWith('.localhost')
// Every agent names these sites, so the host alone says nothing about which one owns the page.
const SHARED_HOSTS = new Set(['github.com', 'google.com', 'www.google.com', 'x.com', 'twitter.com', 'youtube.com', 'www.youtube.com', 'claude.ai', 'chatgpt.com'])
const LSOF_TIMEOUT_MS = 1200
const FOLDER_CACHE_MS = 60_000
const TRANSCRIPT_TAIL_BYTES = 1024 * 1024
const CLAUDE_TRANSCRIPTS = join(homedir(), '.claude', 'projects')

export function repoRootOf(cwd: string): string {
  for (let dir = cwd; dir !== dirname(dir); dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir
  }
  return cwd
}

function runLsof(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile('/usr/sbin/lsof', args, { timeout: LSOF_TIMEOUT_MS }, (_err, stdout) => resolve(stdout ?? ''))
  })
}

const folderByPort = new Map<string, { folder: string; until: number }>()

async function servingFolder(port: string): Promise<string> {
  const hit = folderByPort.get(port)
  if (hit && hit.until > Date.now()) return hit.folder
  const pid = (await runLsof(['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'])).split('\n')[0]?.trim() ?? ''
  if (!/^\d+$/.test(pid)) return ''
  const folder = /^n(.+)$/m.exec(await runLsof(['-a', '-p', pid, '-d', 'cwd', '-Fn']))?.[1] ?? ''
  if (folder !== '') folderByPort.set(port, { folder, until: Date.now() + FOLDER_CACHE_MS })
  return folder
}

function inside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + sep)
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function filePath(url: URL): string {
  return url.protocol === 'file:' ? decodeURIComponent(url.pathname) : ''
}

function needlesFor(url: URL): RegExp[] {
  const file = filePath(url)
  if (file !== '') return [new RegExp(escape(file))]
  const path = url.pathname.replace(/\/+$/, '')
  if (isLocalHost(url.hostname)) {
    if (url.port === '') return []
    const origin = `(?:localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0):${url.port}`
    return [...(path === '' ? [] : [new RegExp(origin + escape(path))]), new RegExp(`${origin}(?!\\d)`)]
  }
  const needles = path === '' ? [] : [new RegExp(escape(url.host + path))]
  if (!SHARED_HOSTS.has(url.hostname)) needles.push(new RegExp(`${escape(url.host)}(?![\\w.-])`))
  return needles
}

function transcriptPath(session: AgentSink['session']): string {
  if (!session.sessionId || !session.cwd) return ''
  return join(CLAUDE_TRANSCRIPTS, session.cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${session.sessionId}.jsonl`)
}

async function readTail(path: string): Promise<string> {
  const fh = await open(path, 'r').catch(() => null)
  if (!fh) return ''
  try {
    const size = (await fh.stat()).size
    const len = Math.min(size, TRANSCRIPT_TAIL_BYTES)
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, size - len)
    return buf.toString('utf8')
  } finally {
    await fh.close()
  }
}

// Only the agent's own turns count: system context repeats the same domains in every session.
function lastMentionAt(tail: string, needle: RegExp): number {
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.includes('"type":"assistant"') || !needle.test(line)) continue
    const at = Date.parse(/"timestamp":"([^"]+)"/.exec(line)?.[1] ?? '')
    return Number.isNaN(at) ? 0 : at
  }
  return -1
}

interface AgentTail {
  sink: AgentSink
  tail: string
}

function readTails(agents: readonly AgentSink[]): Promise<AgentTail[]> {
  return Promise.all(agents.map(async (sink) => {
    const path = transcriptPath(sink.session)
    return { sink, tail: path === '' ? '' : await readTail(path) }
  }))
}

function lastUser(tails: readonly AgentTail[], needles: RegExp[]): AgentSink | null {
  for (const needle of needles) {
    let best: { sink: AgentSink; at: number } | null = null
    for (const { sink, tail } of tails) {
      const at = tail === '' ? -1 : lastMentionAt(tail, needle)
      if (at >= 0 && (best === null || at > best.at)) best = { sink, at }
    }
    if (best) return best.sink
  }
  return null
}

function mostRecentlyActive(agents: readonly AgentSink[]): AgentSink | null {
  const when = (s: AgentSink): number =>
    s.session.busySince !== undefined ? Infinity : (s.session.lastActivityAt ?? s.session.lastTurnEndedAt ?? s.session.since)
  return agents.reduce<AgentSink | null>((best, s) => (best === null || when(s) > when(best) ? s : best), null)
}

/** Which agent the page on screen belongs to: the one that last named it, else the newest agent in the folder serving it. Never throws. */
export async function findPageOwner(rawUrl: string, agents: readonly AgentSink[]): Promise<PageOwner | null> {
  if (rawUrl === '' || agents.length === 0) return null
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  const isLocal = isLocalHost(url.hostname)
  const file = filePath(url)
  try {
    const [folder, tails] = await Promise.all([
      file !== '' ? Promise.resolve(dirname(file)) : isLocal && url.port !== '' ? servingFolder(url.port) : Promise.resolve(''),
      readTails(agents)
    ])
    const root = folder === '' ? '' : repoRootOf(folder)
    const inFolder = root === '' ? [] : agents.filter((s) => s.session.cwd && inside(repoRootOf(s.session.cwd), root))
    const candidates = inFolder.length > 0 ? tails.filter((t) => inFolder.includes(t.sink)) : tails
    const user = lastUser(candidates, needlesFor(url))
    const where = file !== '' ? file : isLocal ? url.host : url.hostname
    if (user) {
      return { sinkId: user.id, strength: 'used', phrase: `This agent was the last to open or run ${where}, the page on screen right now.` }
    }
    const newest = mostRecentlyActive(inFolder)
    if (newest) {
      return { sinkId: newest.id, strength: 'served', phrase: `The page on screen right now (${where}) comes from this agent's project folder.` }
    }
    return null
  } catch {
    return null
  }
}

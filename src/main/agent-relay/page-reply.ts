import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONFIG } from '../../shared/config'
import { PATHS } from '../store/paths'
import type { AgentSession } from './mcp/http-listener'
import { PAGE_REPLY_WIDGET } from './page-reply-widget'
import { readSessionTranscript } from './session-transcript'

const ROUTE = CONFIG.AGENT_RELAY.PAGE_ROUTE_PREFIX
const SECRET_FILE = join(PATHS.ROOT, 'page-reply-secret')
const IMAGE_DIR = join(PATHS.ROOT, 'page-reply-images')
const BODY_MAX_BYTES = 12_000_000
const IMAGES_MAX = 3
const TURNS_SHOWN = 6
const TURN_CHARS = 700
const PAGE_CHARS = 300
const IMAGE_DATA = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/
const LOCAL_ORIGIN = /^(null|file:\/\/|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/
const LOCAL_HOST = /^(localhost|127\.0\.0\.1)(:\d+)?$/

export interface PageReplyHost {
  find: (ref: string) => AgentSession | undefined
  send: (session: AgentSession, text: string, files: string[], context: string) => Promise<'tmux' | 'tty' | 'skipped'>
  start: (input: { project: string; cwd: string; message: string; paths: string[] }) => Promise<{ ok: true; pane: string } | { ok: false; reason: string }>
  byPane: (pane: string) => AgentSession | undefined
}

const startedFromPage = new Map<string, string>()
const ARTIFACTS_DIR = '/.claude/artifacts/'

let host: PageReplyHost | undefined
export function setPageReplyHost(next: PageReplyHost | undefined): void {
  host = next
}

let secret: Buffer | undefined
function loadSecret(): Buffer {
  if (secret) return secret
  if (!existsSync(SECRET_FILE)) writeFileSync(SECRET_FILE, randomBytes(32).toString('hex'), { mode: 0o600 })
  secret = Buffer.from(readFileSync(SECRET_FILE, 'utf8').trim(), 'hex')
  return secret
}

export function pageReplyKey(sessionId: string): string {
  return createHmac('sha256', loadSecret()).update(sessionId).digest('hex').slice(0, 32)
}

function keyMatches(sessionId: string, key: string): boolean {
  const want = Buffer.from(pageReplyKey(sessionId))
  const got = Buffer.from(key)
  return got.length === want.length && timingSafeEqual(got, want)
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  })
  res.end(JSON.stringify(body))
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()}…`
}

function context(session: AgentSession): unknown {
  const turns = readSessionTranscript(session)
    .filter((turn) => turn.role !== 'tool' && turn.text.trim() !== '')
    .slice(-TURNS_SHOWN)
    .map((turn) => ({ role: turn.role, at: turn.at, text: clip(turn.text.trim(), TURN_CHARS) }))
  return {
    name: session.label,
    workingOn: session.tldr ?? '',
    state: session.staleSince !== undefined ? 'ended' : session.busySince !== undefined ? 'working' : 'idle',
    turns
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > BODY_MAX_BYTES) {
        reject(new Error('too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function saveImages(images: unknown): string[] {
  if (!Array.isArray(images)) return []
  const paths: string[] = []
  for (const image of images.slice(0, IMAGES_MAX)) {
    const match = typeof image === 'string' ? IMAGE_DATA.exec(image) : null
    if (!match) continue
    mkdirSync(IMAGE_DIR, { recursive: true })
    const path = join(IMAGE_DIR, `${Date.now()}-${paths.length}.${match[1] === 'jpeg' ? 'jpg' : match[1]}`)
    writeFileSync(path, Buffer.from(match[2], 'base64'))
    paths.push(path)
  }
  return paths
}

async function reply(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // A sandboxed iframe on any site also sends `Origin: null`, so the key below is the gate, not this.
  const origin = req.headers.origin
  if (origin && !LOCAL_ORIGIN.test(origin)) return json(res, 403, { ok: false })
  let body: { session?: unknown; key?: unknown; text?: unknown; images?: unknown; page?: unknown }
  try {
    body = JSON.parse(await readBody(req))
  } catch {
    return json(res, 400, { ok: false })
  }
  if (typeof body.session !== 'string' || typeof body.key !== 'string' || !keyMatches(body.session, body.key))
    return json(res, 403, { ok: false })
  const session = host?.find(body.session)
  if (!session || session.staleSince !== undefined) return json(res, 410, { ok: false, reason: 'ended' })
  const text = typeof body.text === 'string' ? body.text.trim().slice(0, CONFIG.PHONE_REMOTE.CHAT_MESSAGE_MAX_CHARS) : ''
  const files = saveImages(body.images)
  if (!text && files.length === 0) return json(res, 400, { ok: false })
  const page = typeof body.page === 'string' ? body.page.replace(/\s+/g, ' ').slice(0, PAGE_CHARS) : ''
  const via = await host!.send(session, text, files, page ? `[sent from the page ${page}]\n` : '')
  json(res, via === 'skipped' ? 502 : 200, { ok: via !== 'skipped' })
}

function pageFile(href: unknown): string {
  if (typeof href !== 'string' || !href.startsWith('file://')) return ''
  try {
    return fileURLToPath(href)
  } catch {
    return ''
  }
}

async function startNew(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const origin = req.headers.origin
  if (origin && !LOCAL_ORIGIN.test(origin)) return json(res, 403, { ok: false })
  let body: { session?: unknown; key?: unknown; text?: unknown; images?: unknown; page?: unknown; href?: unknown }
  try {
    body = JSON.parse(await readBody(req))
  } catch {
    return json(res, 400, { ok: false })
  }
  if (typeof body.session !== 'string' || typeof body.key !== 'string' || !keyMatches(body.session, body.key))
    return json(res, 403, { ok: false })
  const text = typeof body.text === 'string' ? body.text.trim().slice(0, CONFIG.PHONE_REMOTE.CHAT_MESSAGE_MAX_CHARS) : ''
  const files = saveImages(body.images)
  if (!text && files.length === 0) return json(res, 400, { ok: false })
  const file = pageFile(body.href)
  const at = file.indexOf(ARTIFACTS_DIR)
  const cwd = host?.find(body.session)?.cwd ?? (at > 0 ? file.slice(0, at) : '')
  if (!host || !cwd) return json(res, 410, { ok: false, reason: 'no project' })
  const page = typeof body.page === 'string' ? body.page.replace(/\s+/g, ' ').slice(0, PAGE_CHARS) : ''
  const about = file ? `[about the page ${page} at ${file}]\n` : page ? `[about the page ${page}]\n` : ''
  const started = await host.start({ project: basename(cwd), cwd, message: about + text, paths: files })
  if (!started.ok) return json(res, 502, { ok: false, reason: started.reason })
  startedFromPage.set(started.pane, body.session)
  json(res, 200, { ok: true, pane: started.pane })
}

/** Handles every `/page/*` request; false means the URL is not ours. */
export function handlePageReply(req: IncomingMessage, res: ServerResponse): boolean {
  if (!req.url?.startsWith(ROUTE)) return false
  const url = new URL(req.url, 'http://x')
  const route = url.pathname.slice(ROUTE.length)
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '600'
    })
    res.end()
    return true
  }
  if (req.method === 'GET' && route === 'reply.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(PAGE_REPLY_WIDGET)
    return true
  }
  const sessionId = url.searchParams.get('session') ?? ''
  if (req.method === 'GET' && route === 'key') {
    // No CORS header and a pinned Host: a web page can neither read this nor reach it by DNS rebinding.
    if (req.headers.origin || !LOCAL_HOST.test(req.headers.host ?? '') || !sessionId) {
      res.writeHead(403).end()
      return true
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify({ key: pageReplyKey(sessionId) }))
    return true
  }
  if (req.method === 'GET' && route === 'context') {
    if (!keyMatches(sessionId, url.searchParams.get('key') ?? '')) json(res, 403, { ok: false })
    else {
      const session = host?.find(sessionId)
      json(res, 200, session ? context(session) : { state: 'ended', turns: [] })
    }
    return true
  }
  if (req.method === 'GET' && route === 'started') {
    const pane = url.searchParams.get('pane') ?? ''
    if (!keyMatches(sessionId, url.searchParams.get('key') ?? '') || startedFromPage.get(pane) !== sessionId)
      json(res, 403, { ok: false })
    else {
      const id = host?.byPane(pane)?.sessionId
      json(res, 200, id ? { session: id, key: pageReplyKey(id) } : {})
    }
    return true
  }
  if (req.method === 'POST' && route === 'new') {
    void startNew(req, res).catch(() => json(res, 500, { ok: false }))
    return true
  }
  if (req.method === 'POST' && route === 'reply') {
    void reply(req, res).catch(() => json(res, 500, { ok: false }))
    return true
  }
  res.writeHead(404).end()
  return true
}

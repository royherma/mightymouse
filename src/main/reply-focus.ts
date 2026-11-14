import { app, screen } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { context, resolveBinary } from './platform'
import { CONFIG } from '../shared/config'
import type { ReplyWindowApp } from '../shared/types'
import { liveAgentSessions, type AgentSession } from './agent-relay/mcp/http-listener'
import { claudeTranscriptPaths, codexTranscriptPath } from './agent-relay/session-transcript'
import { cmuxPath } from './agent-relay/origin-resolver'
import { SETTINGS } from './store/settings'
import { isOwnBundleId } from '../shared/app-context'
import { followFrontApp, switchReplyWindow, tellReplyWindow } from './reply-window'
import { devLog } from '../shared/env'
import { cachedBuilt } from './built/scan'

const POLL_MS = 2000
const READ_MS = 2000
const SHOT_MS = 1500
const MAX_ORDER = 30
const MIN_NAME_LENGTH = 6
const LOCAL_PAGE = /^https?:\/\/(localhost|127\.0\.0\.1|[\w-]+\.localhost)(:\d+)?\//
const CMUX_APP = 'com.cmuxterm.app'
const BROWSERS = [
  'com.google.Chrome',
  'com.apple.Safari',
  'company.thebrowser.Browser',
  'com.brave.Browser',
  'org.mozilla.firefox',
  'com.microsoft.edgemac'
]
const WATCHED_APPS = new Set([CMUX_APP, ...BROWSERS])
const PAGE_MATCH_MS = 60_000

let order: string[] = []
let frontBundle = ''
let appBehind = ''
let autoSwitched: string | undefined
let seenPage = ''
let seenUrl = ''
let toldPage: string | undefined
const pageOwners = new Map<string, { ref?: string; at: number }>()
let poll: NodeJS.Timeout | null = null
let polling = false

function pageFile(url: string): string {
  if (!url.startsWith('file://')) return ''
  try {
    return fileURLToPath(url.split(/[?#]/)[0])
  } catch {
    return ''
  }
}

function portOf(url: string): string {
  return LOCAL_PAGE.test(url) ? new URL(url).port : ''
}

function fromBuilt(url: string, live: AgentSession[]): string | undefined {
  const file = pageFile(url)
  const port = portOf(url)
  return cachedBuilt().find((item) => {
    if (!item.sessionId || !live.some((s) => s.sessionId === item.sessionId)) return false
    if (file) return item.file === file
    if (port) return String(item.port ?? '') === port
    return Boolean(item.url) && url.startsWith(item.url!)
  })?.sessionId
}

function fromFolder(url: string, live: AgentSession[]): string | undefined {
  const file = pageFile(url)
  const port = portOf(url)
  const served = cachedBuilt().find((item) => (file ? item.file === file : Boolean(port) && String(item.port ?? '') === port))
  const folder = served?.cwd ?? (file ? dirname(file) : '')
  if (!folder) return undefined
  const rank = (id = ''): number => (order.includes(id) ? order.indexOf(id) : MAX_ORDER)
  return live
    .filter((s) => s.cwd && (folder === s.cwd || folder.startsWith(`${s.cwd}/`)))
    .sort((a, b) => rank(a.sessionId) - rank(b.sessionId))[0]?.sessionId
}

function fromStamp(url: string, live: AgentSession[]): string | undefined {
  const file = pageFile(url)
  if (!file.includes('/.claude/artifacts/') || !existsSync(file)) return undefined
  const stamped = /data-sessions="([^"]*)"/.exec(readFileSync(file, 'utf8'))?.[1] ?? ''
  return stamped
    .split(',')
    .map((pair) => pair.split(':')[0])
    .find((id) => live.some((s) => s.sessionId === id))
}

function pageName(url: string): string {
  const file = pageFile(url)
  const named = (path: string): string => {
    const last = path.split('/').filter(Boolean).pop() ?? ''
    return last.includes('.') && last.length >= MIN_NAME_LENGTH ? last : ''
  }
  if (file) return named(file)
  if (!/^https?:\/\//.test(url)) return ''
  try {
    const { host, pathname } = new URL(url)
    if (LOCAL_PAGE.test(url)) return named(pathname) || host
    return `${host}${pathname.replace(/\/$/, '')}`
  } catch {
    return ''
  }
}

function output(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: READ_MS }, (err, stdout) => resolve(err ? '' : stdout))
  })
}

async function frontPane(): Promise<string> {
  const cli = cmuxPath()
  const tmux = resolveBinary('tmux')
  if (!cli || !tmux) return ''
  try {
    const listed = JSON.parse(await output(cli, ['rpc', 'surface.list', '{}'])) as {
      surfaces?: { focused?: boolean; title?: string; resume_binding?: { kind?: string; checkpoint_id?: string } }[]
    }
    const focused = listed.surfaces?.find((surface) => surface.focused)
    const name = (focused?.resume_binding?.kind === 'tmux' && focused.resume_binding.checkpoint_id) || focused?.title?.trim()
    if (!name) return ''
    return (await output(tmux, ['display-message', '-p', '-t', name, '#{pane_id}'])).trim()
  } catch {
    return ''
  }
}

function conversationFiles(session: AgentSession): string[] {
  if (!session.sessionId) return []
  const home = homedir()
  const claude = session.cwd ? claudeTranscriptPaths(home, session.cwd, session.sessionId) : []
  const codex = (session.facts?.agent ?? '').toLowerCase().includes('codex') ? [codexTranscriptPath(home, session.sessionId)] : []
  return [...claude, ...codex].filter((path) => path && existsSync(path))
}

function mentionCounts(needle: string, files: string[]): Promise<Map<string, number>> {
  return new Promise((resolve) => {
    execFile('grep', ['-c', '-H', '-F', '--', needle, ...files], { maxBuffer: 1024 * 1024 }, (_err, stdout) => {
      const counts = new Map<string, number>()
      for (const line of stdout.split('\n')) {
        const at = line.lastIndexOf(':')
        if (at > 0) counts.set(line.slice(0, at), Number(line.slice(at + 1)) || 0)
      }
      resolve(counts)
    })
  })
}

// by process, not app name: a second copy of the browser (a test run's) answers app-name AppleScript instead
async function frontWindowUrl(): Promise<string> {
  const read = `tell application "System Events" to return value of attribute "AXDocument" of window 1 of (first process whose frontmost is true)`
  return (await output('osascript', ['-e', read])).trim()
}

async function fromMentions(url: string, live: AgentSession[]): Promise<string | undefined> {
  const needle = pageName(url)
  if (!needle) return undefined
  const owner = new Map<string, string>()
  for (const session of live) for (const path of conversationFiles(session)) owner.set(path, session.sessionId!)
  if (owner.size === 0) return undefined
  let best: { id: string; count: number } | undefined
  for (const [path, count] of await mentionCounts(needle, [...owner.keys()])) {
    const id = owner.get(path)
    if (id && count > 0 && count >= (best?.count ?? 0)) best = { id, count }
  }
  return best?.id
}

async function agentInFront(searchConversations: boolean): Promise<string | undefined> {
  const live = liveAgentSessions().filter((s) => s.sessionId)
  if (live.length === 0) return undefined
  const bundleId = context.userFacingFrontmostBundleId()
  if (!bundleId) return undefined
  const front = { bundleId, url: BROWSERS.includes(bundleId) ? await frontWindowUrl() : '' }
  seenUrl = front.url
  seenPage = front.url ? pageName(front.url) || front.url.split(/[?#]/)[0] : ''
  if (front.bundleId === CMUX_APP) {
    const pane = await frontPane()
    return pane ? live.find((s) => s.origin?.tmuxPane === pane)?.sessionId : undefined
  }
  if (!front.url) return undefined
  const made = fromBuilt(front.url, live) ?? fromStamp(front.url, live)
  if (made) return made
  if (!searchConversations) return fromFolder(front.url, live)
  const page = front.url.split(/[?#]/)[0]
  const known = pageOwners.get(page)
  if (known && Date.now() - known.at < PAGE_MATCH_MS) return known.ref ?? fromFolder(front.url, live)
  const ref = await fromMentions(front.url, live)
  pageOwners.set(page, { ref, at: Date.now() })
  return ref ?? fromFolder(front.url, live)
}

function noteFocus(ref: string | undefined): void {
  if (!ref || order[0] === ref) return
  order = [ref, ...order.filter((r) => r !== ref)].slice(0, MAX_ORDER)
}

async function tick(): Promise<void> {
  if (polling || !WATCHED_APPS.has(frontBundle)) return
  polling = true
  const auto = autoSwitchOn()
  const found = await agentInFront(auto).finally(() => (polling = false))
  noteFocus(found)
  if (auto && seenPage && seenPage !== toldPage) {
    toldPage = seenPage
    devLog.log(`[reply-follow] page=${seenPage} agent=${found ?? 'none'}`)
    tellReplyWindow({ page: seenPage, url: seenUrl, ref: found })
  }
  if (!auto || !found || found === autoSwitched) return
  autoSwitched = found
  switchReplyWindow({ ref: found, order: focusOrder() })
}

export function autoSwitchOn(): boolean {
  return SETTINGS.get().replyWindowAutoSwitch ?? true
}

export function setAutoSwitch(on: boolean): void {
  autoSwitched = undefined
  toldPage = undefined
  SETTINGS.set({ replyWindowAutoSwitch: on })
}

export function startReplyFocusTracking(): void {
  if (poll) return
  context.onFrontmostAppChange((bundleId) => {
    frontBundle = bundleId
    if (!isOwnBundleId(bundleId)) {
      appBehind = bundleId
      followFrontApp(showsOver(bundleId), () => ({ ref: focusOrder()[0], order: focusOrder() }))
    }
    void tick()
  })
  poll = setInterval(() => void tick(), POLL_MS)
}

function showsOver(bundleId: string): boolean {
  return (SETTINGS.get().replyWindowShowOver ?? BROWSERS).includes(bundleId)
}

export async function appBehindReply(): Promise<ReplyWindowApp | null> {
  if (!appBehind) return null
  const path = (await output('mdfind', [`kMDItemCFBundleIdentifier == '${appBehind}'`])).split('\n')[0] ?? ''
  const name = path.split('/').pop()?.replace(/\.app$/, '') || appBehind.split('.').pop() || appBehind
  return { bundleId: appBehind, name, shows: showsOver(appBehind) }
}

export function setShowOver(bundleId: string, on: boolean): void {
  const now = (SETTINGS.get().replyWindowShowOver ?? BROWSERS).filter((id) => id !== bundleId)
  SETTINGS.set({ replyWindowShowOver: on ? [...now, bundleId] : now })
}

export function focusOrder(): string[] {
  const live = new Set(liveAgentSessions().map((s) => s.sessionId))
  return order.filter((ref) => live.has(ref))
}

export async function aimAtFront(waitMs: number): Promise<string | undefined> {
  const found = await Promise.race([agentInFront(true), new Promise<undefined>((done) => setTimeout(done, waitMs))])
  noteFocus(found)
  return found ?? focusOrder()[0]
}

export function captureScreenUnderCursor(): Promise<string | undefined> {
  const { bounds } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const folder = join(app.getPath('temp'), `${CONFIG.APP_NAME}-reply-screens`)
  mkdirSync(folder, { recursive: true })
  const path = join(folder, `screen-${Date.now()}.png`)
  const region = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`
  return new Promise((resolve) => {
    execFile(CONFIG.SCREENCAPTURE_PATH, ['-x', '-t', 'png', '-R', region, path], { timeout: SHOT_MS }, (err) =>
      resolve(err || !existsSync(path) ? undefined : path)
    )
  })
}

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { CONFIG } from '../../../shared/config'
import { devLog } from '../../../shared/env'
import { CHANNELS } from '../../../shared/ipc'
import type { VerbHandler, VerbToolResult } from './verbs'

const PAGE_TEXT_MAX = 30_000
const MEDIA_MAX = 12

const READ_MEDIA = `(() => {
  const seen = (el) => { const r = el.getBoundingClientRect(); return r.width >= 120 && r.height >= 90 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth }
  const abs = (u) => { try { return u ? new URL(u, location.href).href : '' } catch { return '' } }
  const post = (el) => { const a = el.closest('article,[role=article]')?.querySelector('a[href*="/status/"],a[href*="/p/"],a[href*="/reel/"],a[href*="/watch"]'); return a ? abs(a.getAttribute('href')) : '' }
  const vids = [...document.querySelectorAll('video')].filter(seen).map((v) => ({ kind: 'video', src: v.currentSrc || v.src || v.querySelector('source')?.src || '', poster: abs(v.poster), at: v.currentTime || 0, length: isFinite(v.duration) ? v.duration : 0, playing: !v.paused, post: post(v) }))
  const imgs = [...document.querySelectorAll('img')].filter((i) => seen(i) && i.naturalWidth >= 200).map((i) => ({ kind: 'image', src: abs(i.currentSrc || i.src), alt: (i.alt || '').slice(0, 80), post: post(i) }))
  return [...vids, ...imgs]
})()`

interface PageMedia {
  kind: 'video' | 'image'
  src: string
  poster?: string
  at?: number
  length?: number
  playing?: boolean
  alt?: string
  post: string
}

function mediaLine(m: PageMedia): string {
  const from = m.post ? ` - post: ${m.post}` : ''
  if (m.kind === 'image') return `- image${m.alt ? ` "${m.alt}"` : ''}: ${m.src}${from}`
  const time = `${m.playing ? 'playing' : 'paused'} at ${m.at?.toFixed(1)}s of ${m.length ? `${m.length.toFixed(1)}s` : 'a stream'}`
  const src = /^(blob:|$)/.test(m.src)
    ? 'streamed (no file address) - download it from the post or page address with yt-dlp'
    : m.src
  return `- video, ${time}: ${src}${m.poster ? ` (still: ${m.poster})` : ''}${from}`
}
const OPENING_WAIT_MS = 20_000
const PRESS_SETTLE_MS = 1_500

function textResult(text: string, isError = false): VerbToolResult {
  return { content: [{ type: 'text', text }], isError }
}

const browserOpenHandler: VerbHandler<{ url: z.ZodString }> = {
  description:
    "Open a web page in MightyMouse's own Browser tab, beside the chat, so the user sees it " +
    'without leaving the app. Use it when the user says to open or show something "here", ' +
    '"in MightyMouse" or "in the browser tab". For their normal browser, use `open <url>` instead. ' +
    'The Browser tab keeps its own logins, so after opening, `browser_read` can read pages ' +
    'your own fetch cannot reach.',
  inputSchema: { url: z.string().min(1).max(4000) },
  async run(args) {
    let url: URL
    try {
      url = new URL(/^[a-z]+:\/\//i.test(args.url) ? args.url : `https://${args.url}`)
    } catch {
      return textResult(`"${args.url}" is not a web address.`, true)
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return textResult('Only http and https pages open in the Browser tab.', true)
    }
    const { queueAgentUrl } = await import('../../side-browser')
    const { getMightyWindow, showMightyWindow } = await import('../../mighty/mighty-window')
    queueAgentUrl(url.href)
    showMightyWindow()
    getMightyWindow()?.webContents.send(CHANNELS.sideBrowserOpenUrl)
    return textResult(`Opened ${url.href} in the Browser tab.`)
  }
}

async function settled(wc: Electron.WebContents): Promise<void> {
  if (!wc.isLoading()) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 15_000)
    wc.once('did-stop-loading', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

async function openTab(): Promise<Electron.WebContents | null> {
  const { currentTab, agentUrlQueuedAt, tabOpenedSince } = await import('../../side-browser')
  const queuedAt = agentUrlQueuedAt()
  let wc: Electron.WebContents | null = null
  while (Date.now() - queuedAt < OPENING_WAIT_MS && !(wc = tabOpenedSince(queuedAt))) {
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  wc ??= currentTab()
  if (wc) await settled(wc)
  return wc
}

async function step(wc: Electron.WebContents, sessionId: string | undefined, doing: string): Promise<boolean> {
  return (await import('../../side-browser')).agentStep(wc, sessionId, doing)
}

const STOPPED = 'The user stopped this. Wait for them before touching the Browser tab again.'
const NOTHING_OPEN = 'Nothing is open in the Browser tab. Use `browser_open` first.'

const browserReadHandler: VerbHandler<Record<string, never>> = {
  description:
    "Read the page open in MightyMouse's Browser tab right now: its address, title, visible text, " +
    'the videos and pictures on screen (with where each is in its playback and the post it belongs to), ' +
    'and a numbered list of its fields, buttons and links. It uses the logins the user has there, ' +
    'so it works on pages that need them, and it runs quietly without moving anything on screen. ' +
    'Pass a number to `browser_press` to click it. Do the work itself in the background with your own ' +
    'tools (download with yt-dlp or curl, edit files, call other MCP servers); press or type on the page ' +
    'only when the job needs the page itself.',
  inputSchema: {},
  async run() {
    const wc = await openTab()
    if (!wc) return textResult(NOTHING_OPEN, true)
    const { readPage, controlLine } = await import('../../browser-task/page-driver')
    if (!(await (await import('../../side-browser')).untilResumed(wc))) return textResult(STOPPED, true)
    const [text, page, found] = await Promise.all([
      wc.executeJavaScript('document.body ? document.body.innerText : ""').catch(() => ''),
      readPage(wc).catch(() => null),
      wc.executeJavaScript(READ_MEDIA).catch(() => []) as Promise<PageMedia[]>
    ])
    const body = String(text)
    const clipped =
      body.length > PAGE_TEXT_MAX ? `${body.slice(0, PAGE_TEXT_MAX)}\n[cut at ${PAGE_TEXT_MAX} characters]` : body
    const media = found.length
      ? `\n\nOn screen now (what "this video" or "this picture" means):\n${found.slice(0, MEDIA_MAX).map(mediaLine).join('\n')}`
      : ''
    const controls = page?.controls.length ? `\n\nControls:\n${page.controls.map(controlLine).join('\n')}` : ''
    return textResult(`URL: ${wc.getURL()}\nTitle: ${wc.getTitle()}${media}\n\n${clipped}${controls}`)
  }
}

const browserPressHandler: VerbHandler<{ ref: z.ZodString; user_asked: z.ZodOptional<z.ZodBoolean> }> = {
  description:
    "Click a button or link in MightyMouse's Browser tab, by its number from `browser_read`. " +
    'Use it to move through a site: open a result, press "Apply", go to the next step. ' +
    'Buttons that post, send, reply, comment or submit need `user_asked: true`, which you pass only when ' +
    'the user told you in this chat to post or send it. Pay, buy and delete buttons are always the user\'s.',
  inputSchema: { ref: z.string().min(1).max(12), user_asked: z.boolean().optional() },
  async run(args) {
    const wc = await openTab()
    if (!wc) return textResult(NOTHING_OPEN, true)
    const { readPage, pressControl } = await import('../../browser-task/page-driver')
    const { needsOwner } = await import('../../actions/computer-use/loop')
    const target = (await readPage(wc)).controls.find((c) => c.ref === args.ref)
    if (!target) return textResult(`Nothing numbered ${args.ref} on the page. Call \`browser_read\` again.`, true)
    if (needsOwner(target.label, false)) {
      return textResult(`"${target.label}" is the user's to press. Tell them it is ready.`, true)
    }
    if (!args.user_asked && needsOwner(target.label, true)) {
      return textResult(
        `"${target.label}" posts or sends. Press it with \`user_asked: true\` only if the user told you to; otherwise tell them it is ready.`,
        true
      )
    }
    if (!(await step(wc, args.sessionId, `Clicking "${target.label}"`))) return textResult(STOPPED, true)
    if (!(await pressControl(wc, args.ref))) return textResult(`Could not click "${target.label}".`, true)
    await new Promise((resolve) => setTimeout(resolve, PRESS_SETTLE_MS))
    await settled(wc)
    return textResult(`Clicked "${target.label}". Now on ${wc.getURL()}`)
  }
}

const browserFillHandler: VerbHandler<{ instruction: z.ZodString; files: z.ZodOptional<z.ZodArray<z.ZodString>> }> = {
  description:
    "Fill in the form open in MightyMouse's Browser tab, all fields in one go. Put the values or " +
    'the text to use in `instruction` (for example the full cover letter, the bid, the answers), ' +
    'and any documents to fill from as absolute paths in `files`. Filled fields are outlined; ' +
    'fields to check are outlined in yellow. It never submits - the user presses Submit. ' +
    'For exact words in one box (a comment, a reply, a message), use `browser_type` instead.',
  inputSchema: {
    instruction: z.string().min(1).max(20_000),
    files: z.array(z.string().min(1)).max(10).optional()
  },
  async run(args) {
    const wc = await openTab()
    if (!wc) return textResult(NOTHING_OPEN, true)
    const { fillFromDocuments } = await import('../../browser-task/form-fill')
    const { holdCursor } = await import('../../browser-task/page-driver')
    if (!(await step(wc, args.sessionId, 'Filling in the form'))) return textResult(STOPPED, true)
    holdCursor(wc, 'Reading the form')
    const done = await fillFromDocuments(wc, { instruction: args.instruction, files: args.files ?? [] }, () => {})
    if (!done.ok) {
      const upload = /^Can't read/.test(done.reason) ? ' To put that file on the page, use `browser_attach`.' : ''
      return textResult(`Could not fill the form: ${done.reason}.${upload}`, true)
    }
    const list = (label: string, items: string[]): string => (items.length ? `\n${label}: ${items.join(', ')}` : '')
    return textResult(
      `Filled ${done.filled.length} fields in ${(done.ms / 1000).toFixed(1)} s. Nothing was submitted.` +
        list('Filled', done.filled) +
        list('Check these', done.unsure) +
        list('Could not fill', done.failed) +
        list('Required and still empty', done.missing)
    )
  }
}

const browserTypeHandler: VerbHandler<{ ref: z.ZodString; text: z.ZodString }> = {
  description:
    "Type exact text into one box in MightyMouse's Browser tab, by its number from `browser_read`: " +
    'a comment, a reply, a message, a search box. It replaces what the box holds, word for word, ' +
    'line breaks included. It never sends - the user presses Post or Send.',
  inputSchema: { ref: z.string().min(1).max(12), text: z.string().min(1).max(20_000) },
  async run(args) {
    const wc = await openTab()
    if (!wc) return textResult(NOTHING_OPEN, true)
    const { readPage, typeInto } = await import('../../browser-task/page-driver')
    const target = (await readPage(wc)).controls.find((c) => c.ref === args.ref)
    if (!target) return textResult(`Nothing numbered ${args.ref} on the page. Call \`browser_read\` again.`, true)
    if (target.secret) return textResult(`"${target.label}" is a password or card box - the user types that.`, true)
    const done = await typeInto(wc, args.ref, args.text)
    if (!done.ok) return textResult(`Could not type into "${target.label}": ${done.reason}`, true)
    return textResult(`Typed into "${target.label}". It now reads:\n${done.value}`)
  }
}

const browserAttachHandler: VerbHandler<{ files: z.ZodArray<z.ZodString>; ref: z.ZodOptional<z.ZodString> }> = {
  description:
    "Attach files from this Mac to the page in MightyMouse's Browser tab: an image on a comment, " +
    'a resume on an application. Give absolute paths in `files`, and in `ref` the number of the ' +
    'upload or add-image button from `browser_read` (leave it out when the page has one upload field). ' +
    'No file picker opens on screen. It never sends - the user presses Post or Submit.',
  inputSchema: {
    files: z.array(z.string().min(1)).min(1).max(10),
    ref: z.string().min(1).max(12).optional()
  },
  async run(args) {
    const { isAbsolute, basename } = await import('path')
    const { statSync } = await import('fs')
    for (const f of args.files) {
      if (!isAbsolute(f)) return textResult(`"${f}" is not an absolute path.`, true)
      if (!statSync(f, { throwIfNoEntry: false })?.isFile()) return textResult(`No file at ${f}.`, true)
    }
    const wc = await openTab()
    if (!wc) return textResult(NOTHING_OPEN, true)
    const { readPage, attachFiles } = await import('../../browser-task/page-driver')
    if (args.ref) {
      const { needsOwner } = await import('../../actions/computer-use/loop')
      const target = (await readPage(wc)).controls.find((c) => c.ref === args.ref)
      if (target && needsOwner(target.label, true)) {
        return textResult(`"${target.label}" is the user's to press. Pass the upload button's number.`, true)
      }
    }
    const done = await attachFiles(wc, args.ref, args.files)
    if (!done.ok) return textResult(`Could not attach: ${done.reason}`, true)
    return textResult(`Attached ${args.files.map((f) => basename(f)).join(', ')} through the ${done.via}. Nothing was sent.`)
  }
}

export const BROWSER_HANDLERS: Record<string, VerbHandler<z.ZodRawShape>> = {
  browser_open: browserOpenHandler as unknown as VerbHandler<z.ZodRawShape>,
  browser_read: browserReadHandler as unknown as VerbHandler<z.ZodRawShape>,
  browser_press: browserPressHandler as unknown as VerbHandler<z.ZodRawShape>,
  browser_fill: browserFillHandler as unknown as VerbHandler<z.ZodRawShape>,
  browser_type: browserTypeHandler as unknown as VerbHandler<z.ZodRawShape>,
  browser_attach: browserAttachHandler as unknown as VerbHandler<z.ZodRawShape>
}

const chatStops = new Set<() => void>()
let chatDoor: Promise<string | null> | null = null

function listenOn(server: Server, port: number): Promise<number | null> {
  return new Promise((resolve) => {
    server.once('error', () => resolve(null))
    server.listen(port, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

async function serveChatTools(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const mcp = new McpServer({ name: CONFIG.BRAND_SLUG, version: CONFIG.APP_VERSION })
  for (const [verb, handler] of Object.entries(BROWSER_HANDLERS)) {
    mcp.registerTool(verb, handler, (args) => handler.run({ ...args, sessionId: CONFIG.MIGHTY.BROWSER_DRIVER }))
  }
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  res.on('close', () => {
    void transport.close()
    void mcp.close()
  })
  await mcp.connect(transport)
  await transport.handleRequest(req, res)
}

async function openChatDoor(): Promise<string | null> {
  let port = 0
  const server = createServer((req, res) => {
    // A web page that points its own domain at 127.0.0.1 still sends that domain as Host.
    if (req.method !== 'POST' || req.url !== CONFIG.AGENT_RELAY.MCP_ROUTE || req.headers.host !== `127.0.0.1:${port}`) {
      res.writeHead(403).end()
      return
    }
    serveChatTools(req, res).catch((err) => {
      devLog.error('[chat-browser] tool request failed', err)
      if (!res.headersSent) res.writeHead(500).end()
    })
  })
  port = (await listenOn(server, CONFIG.MIGHTY.BROWSER_TOOLS_PORT)) ?? (await listenOn(server, 0)) ?? 0
  if (!port) return null
  const url = `http://127.0.0.1:${port}${CONFIG.AGENT_RELAY.MCP_ROUTE}`
  return JSON.stringify({ mcpServers: { [CONFIG.BRAND_SLUG]: { type: 'http', url } } })
}

export function chatBrowserTools(): Promise<string | null> {
  return (chatDoor ??= openChatDoor())
}

export function chatBrowserRun(stop: () => void): () => void {
  chatStops.add(stop)
  return () => {
    chatStops.delete(stop)
    if (chatStops.size === 0) void import('../../side-browser').then((m) => m.endAgentDriving(CONFIG.MIGHTY.BROWSER_DRIVER))
  }
}

export function stopChatBrowserRuns(): void {
  for (const stop of [...chatStops]) stop()
}

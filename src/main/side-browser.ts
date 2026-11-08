import {
  BrowserWindow,
  Menu,
  app,
  WebContentsView,
  clipboard,
  ipcMain,
  net,
  screen,
  session,
  shell,
  type IpcMainInvokeEvent
} from 'electron'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { CONFIG } from '../shared/config'
import { CHANNELS } from '../shared/ipc'
import type {
  SideBrowserBounds,
  SideBrowserCommand,
  SideBrowserPageAction,
  SideBrowserShortcut,
  SideBrowserTabState,
  SharedModRequest,
  SiteModAction
} from '../shared/types'
import { forgetSiteModPreview, sharedModAction, siteModAction, siteModState, watchSiteMods } from './browser-task/site-mods'
import { browserDir, importCookies, listImportSources } from './side-browser-import'
import { driveAgentCursor, hideAgentCursor, pauseAgentCursor } from './actions/computer-use/agent-cursor'
import { registerSideBrowserPasskeyHandlers } from './side-browser-passkeys'
import { getSupabase } from './supabase'
import { annotate, endAnnotate } from './side-browser-annotate'
import {
  decidePermission,
  dropStaleAsk,
  installPermissionHandlers,
  permissionState,
  siteLocation
} from './side-browser-permissions'
import {
  forgetPage,
  forgetSite,
  importHistory,
  inlineIcon,
  inlineIcons,
  recordFavicon,
  recordTitle,
  recent,
  recordVisit,
  suggest,
  topSites
} from './side-browser-history'

// Own persistent partition: logins survive restarts, and pages never share the app's default session.
const PARTITION = 'persist:mm-side-browser'
const SEARCH_URL = 'https://www.google.com/search?q='
const SESSION_COOKIE_KEEP_S = 30 * 24 * 3600

interface Tab {
  view: WebContentsView
  owner: BrowserWindow
  attached: boolean
  bounds: SideBrowserBounds | null
  favicon?: string
  error?: string
  findOpen: boolean
  findText: string
  found?: { active: number; matches: number }
  agent?: { sessionId?: string; doing: string; paused?: boolean; resume: Array<(go: boolean) => void> }
  agentOpened?: boolean
}

const tabs = new Map<string, Tab>()
const ownersWatched = new Set<number>()
const suspendedOwners = new Set<number>()
let sessionReady = false
let cookieFlush: NodeJS.Timeout | null = null
let agentUrl: string | null = null
let agentUrlTaken: string | null = null
let agentUrlAt = 0
let newestTab: { wc: Electron.WebContents; at: number } | null = null

function browserSession(): Electron.Session {
  const sess = session.fromPartition(PARTITION)
  if (!sessionReady) {
    sessionReady = true
    // Akamai/Cloudflare deny any UA carrying an "Electron/" or app-name token.
    sess.setUserAgent(
      sess.getUserAgent().replace(/ (Electron|\S+)\/\d+\.\d+\.\d+(?= Chrome| Safari)/g, ''),
      [...new Set([app.getLocale(), ...app.getPreferredSystemLanguages()])].join(',')
    )
    sendClientHints(sess)
    installPermissionHandlers(sess, pushTabOf)
    sess.cookies.on('changed', (_e, cookie, _cause, removed) => {
      if (!removed && cookie.session) void keepSessionCookie(sess, cookie)
    })
  }
  return sess
}

// Electron sends no sec-ch-ua headers while page JS still sees navigator.userAgentData; bot walls flag the gap.
function sendClientHints(sess: Electron.Session): void {
  const hints = clientHints()
  sess.webRequest.onBeforeSendHeaders({ urls: ['https://*/*'] }, (details, done) => {
    const requestHeaders = { ...hints, ...details.requestHeaders }
    if (!agentDriving(details.webContentsId)) return done({ requestHeaders })
    void agentSignature(new URL(details.url).host).then((signed) => done({ requestHeaders: { ...requestHeaders, ...signed } }))
  })
}

function agentDriving(webContentsId: number | undefined): boolean {
  for (const tab of tabs.values()) if ((tab.agent || tab.agentOpened) && tab.view.webContents.id === webContentsId) return true
  return false
}

const SIGN_TIMEOUT_MS = 1500
const STILL_JPEG_QUALITY = 80
// Worker signatures live 300s; refetch a minute early so a page load never straddles expiry.
const SIGN_REFRESH_EARLY_S = 60
const signatures = new Map<string, Promise<{ headers: Record<string, string>; expires: number } | null>>()

// Web Bot Auth: while the agent drives, every request carries MightyMouse's signed-agent badge for its host.
async function agentSignature(host: string): Promise<Record<string, string>> {
  const cached = await signatures.get(host)
  if (cached && cached.expires - SIGN_REFRESH_EARLY_S > Date.now() / 1000) return cached.headers
  const pending = fetchSignature(host)
  signatures.set(host, pending)
  return (await pending)?.headers ?? {}
}

async function fetchSignature(host: string): Promise<{ headers: Record<string, string>; expires: number } | null> {
  try {
    const { data } = await getSupabase().auth.getSession()
    const jwt = data.session?.access_token
    if (!jwt) return null
    const res = await net.fetch(`${CONFIG.BROWSER_TASK.AGENT_SIGN_URL}/sign`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ authority: host }),
      signal: AbortSignal.timeout(SIGN_TIMEOUT_MS)
    })
    if (!res.ok) return null
    return (await res.json()) as { headers: Record<string, string>; expires: number }
  } catch {
    return null
  }
}

// Chromium's GREASE brand recipe (user_agent_utils.cc), seeded by the major version; must equal navigator.userAgentData.brands.
function clientHints(): Record<string, string> {
  const major = Number(process.versions.chrome.split('.')[0])
  const chars = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_']
  const grease = `"Not${chars[major % 11]}A${chars[(major + 1) % 11]}Brand";v="${['8', '99', '24'][major % 3]}"`
  const chromium = `"Chromium";v="${major}"`
  return {
    'sec-ch-ua': major % 2 === 0 ? `${grease}, ${chromium}` : `${chromium}, ${grease}`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': process.platform === 'darwin' ? '"macOS"' : process.platform === 'win32' ? '"Windows"' : '"Linux"'
  }
}

// Electron drops expiry-less cookies on quit, so every restart logged the user out of sites like Upwork.
async function keepSessionCookie(sess: Electron.Session, c: Electron.Cookie): Promise<void> {
  const host = (c.domain ?? '').replace(/^\./, '')
  if (!host) return
  await sess.cookies
    .set({
      url: `${c.secure ? 'https' : 'http'}://${host}${c.path ?? '/'}`,
      name: c.name,
      value: c.value,
      domain: c.hostOnly ? undefined : c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite,
      expirationDate: Date.now() / 1000 + SESSION_COOKIE_KEEP_S
    })
    .catch(() => undefined)
  if (cookieFlush) clearTimeout(cookieFlush)
  cookieFlush = setTimeout(() => void sess.cookies.flushStore().catch(() => undefined), 1000)
}

export function normalizeAddress(raw: string): string {
  const input = raw.trim()
  if (!input) return 'about:blank'
  if (/^(https?:|about:)/i.test(input) || isLocalPage(input)) return input
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3}|\[::1\])(:\d+)?(\/|$)/i.test(input))
    return `http://${input}`
  if (!/\s/.test(input) && /^[^/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(input))
    return `https://${input}`
  return SEARCH_URL + encodeURIComponent(input)
}

function isLocalPage(url: string): boolean {
  return /^file:\/\/\/.+\.html?(?:[?#].*)?$/i.test(url)
}

const PORTAL_HOST = /(^|\.)getmightymouse\.com$|^mightymouse-portal-staging\.pages\.dev$|^localhost$/

function pageAction(url: string): SideBrowserPageAction | null {
  const link = URL.parse(url)
  if (!link || !PORTAL_HOST.test(link.hostname)) return null
  const asked = link.searchParams
  const text = asked.get('q')
  if (link.pathname === '/chat' && text && (asked.has('style') || asked.has('app'))) return { do: 'compose', text }
  const kind = asked.get('kind')
  if (link.pathname === '/playbooks' && kind && asked.has('save')) return { do: 'projectKind', kind }
  return null
}

function isWebUrl(url: string): boolean {
  return /^(https?:|about:blank)/i.test(url) || isLocalPage(url)
}

function stateOf(id: string, tab: Tab): SideBrowserTabState {
  const wc = tab.view.webContents
  return {
    id,
    url: wc.getURL(),
    title: wc.getTitle(),
    loading: wc.isLoading(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    favicon: tab.favicon,
    error: tab.error,
    findOpen: tab.findOpen,
    found: tab.found,
    agentDoing: tab.agent?.doing ?? '',
    agentPaused: tab.agent?.paused ?? false,
    ...permissionState(wc),
    ...siteModState(wc)
  }
}

function pushTabOf(wc: Electron.WebContents): void {
  for (const [id, t] of tabs) if (t.view.webContents === wc) push(id)
}

function push(id: string): void {
  const tab = tabs.get(id)
  if (!tab || tab.owner.isDestroyed() || tab.view.webContents.isDestroyed()) return
  tab.owner.webContents.send(CHANNELS.sideBrowserState, stateOf(id, tab))
}

function destroy(id: string): void {
  const tab = tabs.get(id)
  if (!tab) return
  tabs.delete(id)
  forgetSiteModPreview(tab.view.webContents)
  if (!tab.owner.isDestroyed() && tab.attached) tab.owner.contentView.removeChildView(tab.view)
  if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
}

function open(owner: BrowserWindow, address: string): SideBrowserTabState {
  const id = randomUUID()
  const view = new WebContentsView({
    webPreferences: {
      session: browserSession(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, '../preload/side-browser-tab.js'),
      additionalArguments: [
        `--mm-passkey-channel=${CHANNELS.sideBrowserPasskey}`,
        `--mm-location-channel=${CHANNELS.sideBrowserLocation}`,
        `--mm-mod-world=${CONFIG.BROWSER_TASK.MOD_WORLD_ID}`
      ]
    }
  })
  view.setBackgroundColor('#ffffff')
  const tab: Tab = { view, owner, attached: false, bounds: null, findOpen: false, findText: '', agentOpened: address === agentUrlTaken }
  if (tab.agentOpened) agentUrlTaken = null
  tabs.set(id, tab)
  newestTab = { wc: view.webContents, at: Date.now() }

  const wc = view.webContents
  const update = (): void => push(id)
  wc.on('did-start-loading', () => {
    tab.error = undefined
    update()
  })
  // -3 is ERR_ABORTED: a redirect or a new navigation replacing this one, not a failure.
  wc.on('did-fail-load', (_e, code, description, _url, isMainFrame) => {
    if (!isMainFrame || code === -3) return
    tab.error = description || `Error ${code}`
    update()
  })
  wc.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') return
    tab.error = 'This page stopped working'
    update()
  })
  wc.on('found-in-page', (_e, result) => {
    tab.found = { active: result.activeMatchOrdinal, matches: result.matches }
    update()
  })
  wc.on('context-menu', (_e, params) => showContextMenu(id, tab, params))
  wc.on('did-stop-loading', update)
  watchSiteMods(wc, update)
  wc.on('did-navigate', () => {
    dropStaleAsk(wc)
    recordVisit(wc.getURL(), wc.getTitle())
    update()
  })
  wc.on('did-navigate-in-page', update)
  wc.on('page-title-updated', (_e, title) => {
    recordTitle(wc.getURL(), title)
    update()
  })
  let faviconSeq = 0
  wc.on('page-favicon-updated', (_e, favicons) => {
    const seq = ++faviconSeq
    const pageUrl = wc.getURL()
    if (favicons[0]) recordFavicon(pageUrl, favicons[0])
    void inlineIcon(pageUrl, favicons[0]).then((icon) => {
      if (seq !== faviconSeq || wc.isDestroyed()) return
      tab.favicon = icon
      update()
    })
  })
  wc.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url) && !owner.isDestroyed())
      owner.webContents.send(CHANNELS.sideBrowserPopup, { openerId: id, url })
    else void shell.openExternal(url)
    return { action: 'deny' }
  })
  wc.on('will-navigate', (event, url) => {
    const action = pageAction(url)
    if (action && !owner.isDestroyed()) {
      event.preventDefault()
      owner.webContents.send(CHANNELS.sideBrowserPageAction, { viewId: id, url, action })
      return
    }
    if (isWebUrl(url)) return
    event.preventDefault()
    void shell.openExternal(url)
  })
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !input.meta) return
    const key = input.key.toLowerCase()
    const shortcut = tabShortcut(input)
    if (shortcut) {
      if (!owner.isDestroyed()) {
        if (shortcut === 'focusAddress') owner.webContents.focus()
        owner.webContents.send(CHANNELS.sideBrowserShortcut, { viewId: id, shortcut })
      }
    } else if (key === 'r') wc.reload()
    else if (key === '[' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
    else if (key === ']' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
    else if (key === 'f') find(id, '')
    else if (key === '=' || key === '+') wc.setZoomLevel(Math.min(wc.getZoomLevel() + 0.5, 5))
    else if (key === '-') wc.setZoomLevel(Math.max(wc.getZoomLevel() - 0.5, -5))
    else if (key === '0') wc.setZoomLevel(0)
    else return
    event.preventDefault()
  })

  if (!ownersWatched.has(owner.id)) watchOwner(owner)
  void wc.loadURL(normalizeAddress(address)).catch(() => undefined)
  return stateOf(id, tab)
}

function showContextMenu(id: string, tab: Tab, p: Electron.ContextMenuParams): void {
  const wc = tab.view.webContents
  const nav = wc.navigationHistory
  const sep = { type: 'separator' as const }
  const items: Electron.MenuItemConstructorOptions[] = []
  const openInTab = (url: string): void => {
    if (!tab.owner.isDestroyed())
      tab.owner.webContents.send(CHANNELS.sideBrowserPopup, { openerId: id, url })
  }
  if (p.misspelledWord) {
    for (const word of p.dictionarySuggestions.slice(0, 4))
      items.push({ label: word, click: () => wc.replaceMisspelling(word) })
    if (p.dictionarySuggestions.length) items.push(sep)
  }
  if (p.linkURL && isWebUrl(p.linkURL)) {
    items.push(
      { label: 'Open link in new tab', click: () => openInTab(p.linkURL) },
      { label: 'Open link in your browser', click: () => void shell.openExternal(p.linkURL) },
      { label: 'Copy link address', click: () => clipboard.writeText(p.linkURL) },
      sep
    )
  }
  if (p.mediaType === 'image' && p.srcURL) {
    items.push(
      { label: 'Copy image', click: () => wc.copyImageAt(p.x, p.y) },
      { label: 'Copy image address', click: () => clipboard.writeText(p.srcURL) },
      sep
    )
  }
  if (p.isEditable) {
    items.push(
      { role: 'undo', enabled: p.editFlags.canUndo },
      { role: 'redo', enabled: p.editFlags.canRedo },
      sep,
      { role: 'cut', enabled: p.editFlags.canCut },
      { role: 'copy', enabled: p.editFlags.canCopy },
      { role: 'paste', enabled: p.editFlags.canPaste },
      { role: 'selectAll', enabled: p.editFlags.canSelectAll },
      sep
    )
  } else if (p.selectionText.trim()) {
    const text = p.selectionText.trim()
    const short = text.length > 24 ? `${text.slice(0, 24)}…` : text
    items.push(
      { role: 'copy' },
      { label: `Search Google for "${short}"`, click: () => openInTab(SEARCH_URL + encodeURIComponent(text)) },
      sep
    )
  }
  items.push(
    { label: 'Back', enabled: nav.canGoBack(), click: () => nav.goBack() },
    { label: 'Forward', enabled: nav.canGoForward(), click: () => nav.goForward() },
    { label: 'Reload', click: () => wc.reload() },
    sep,
    { label: 'Find in page', accelerator: 'CmdOrCtrl+F', click: () => find(id, '') },
    { label: 'Inspect element', click: () => wc.inspectElement(p.x, p.y) }
  )
  if (!tab.owner.isDestroyed()) Menu.buildFromTemplate(items).popup({ window: tab.owner })
}

function tabShortcut(input: Electron.Input): SideBrowserShortcut | null {
  if (input.alt || input.control) return null
  if (input.shift) {
    if (input.code === 'BracketLeft') return 'prevTab'
    if (input.code === 'BracketRight') return 'nextTab'
    if (input.code === 'Period') return 'annotate'
    return input.code === 'KeyT' ? 'reopenTab' : null
  }
  if (input.code === 'KeyT') return 'newTab'
  if (input.code === 'KeyW') return 'closeTab'
  if (input.code === 'KeyP') return 'files'
  return input.code === 'KeyL' ? 'focusAddress' : null
}

// text null closes the find bar, '' opens it, anything else searches (same text again = next match).
function find(id: string, text: string | null, forward = true): void {
  const tab = tabs.get(id)
  if (!tab) return
  const wc = tab.view.webContents
  if (!text) {
    wc.stopFindInPage('clearSelection')
    tab.findOpen = text === ''
    tab.findText = ''
    tab.found = undefined
    if (tab.findOpen && !tab.owner.isDestroyed()) tab.owner.webContents.focus()
  } else {
    const newSearch = text !== tab.findText
    tab.findText = text
    tab.findOpen = true
    wc.findInPage(text, { forward, findNext: newSearch })
  }
  push(id)
}

function watchOwner(owner: BrowserWindow): void {
  ownersWatched.add(owner.id)
  const ownerId = owner.id
  // Electron also emits 'hide' when the window is merely covered by another app, while still visible.
  const suspend = (): void => {
    if (!owner.isVisible() || owner.isMinimized()) setOwnerSuspended(owner, true)
  }
  const resume = (): void => setOwnerSuspended(owner, false)
  owner.on('hide', suspend)
  owner.on('minimize', suspend)
  owner.on('show', resume)
  owner.on('restore', resume)
  owner.on('focus', resume)
  const dropTabs = (): void => {
    for (const [id, tab] of tabs) if (tab.owner === owner) destroy(id)
  }
  owner.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) dropTabs()
  })
  owner.webContents.on('render-process-gone', dropTabs)
  owner.once('closed', () => {
    ownersWatched.delete(ownerId)
    suspendedOwners.delete(ownerId)
    dropTabs()
  })
}

// Native views float above the window and don't hide with the React tree, so when the
// owner window is hidden/minimized we detach every tab and remember its bounds to restore.
function setOwnerSuspended(owner: BrowserWindow, suspended: boolean): void {
  if (owner.isDestroyed()) return
  if (suspended) suspendedOwners.add(owner.id)
  else suspendedOwners.delete(owner.id)
  for (const [, tab] of tabs) if (tab.owner === owner) applyPlacement(tab)
}

function applyPlacement(tab: Tab): void {
  if (tab.owner.isDestroyed()) return
  const bounds = tab.bounds
  const show = bounds && !suspendedOwners.has(tab.owner.id)
  if (!show) {
    if (tab.attached) {
      tab.owner.contentView.removeChildView(tab.view)
      hideAgentCursor()
    }
    tab.attached = false
    return
  }
  if (!tab.attached) tab.owner.contentView.addChildView(tab.view)
  tab.attached = true
  tab.view.setBounds({
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height)
  })
}

function place(id: string, bounds: SideBrowserBounds | null): void {
  const tab = tabs.get(id)
  if (!tab || tab.owner.isDestroyed()) return
  tab.bounds = bounds && bounds.width >= 1 && bounds.height >= 1 ? bounds : null
  applyPlacement(tab)
}

async function still(id: string): Promise<string | null> {
  const tab = tabs.get(id)
  if (!tab?.attached) return null
  const shot = await tab.view.webContents.capturePage().catch(() => null)
  if (!shot || shot.isEmpty()) return null
  return `data:image/jpeg;base64,${shot.toJPEG(STILL_JPEG_QUALITY).toString('base64')}`
}

function command(id: string, cmd: SideBrowserCommand): void {
  const tab = tabs.get(id)
  if (!tab) return
  const wc = tab.view.webContents
  const nav = wc.navigationHistory
  if (cmd === 'back' && nav.canGoBack()) nav.goBack()
  else if (cmd === 'forward' && nav.canGoForward()) nav.goForward()
  else if (cmd === 'reload') wc.reload()
  else if (cmd === 'stop') wc.stop()
  else if (cmd === 'devtools') wc.openDevTools({ mode: 'detach' })
  else if (cmd === 'external' && /^https?:/i.test(wc.getURL())) void shell.openExternal(wc.getURL())
}

export function isSideBrowserPage(wc: Electron.WebContents): boolean {
  for (const tab of tabs.values()) if (tab.view.webContents === wc) return true
  return false
}

export function tabUnderCursor(owner: BrowserWindow): string | null {
  const cursor = screen.getCursorScreenPoint()
  const content = owner.getContentBounds()
  const x = cursor.x - content.x
  const y = cursor.y - content.y
  for (const [id, tab] of tabs) {
    if (tab.owner !== owner || !tab.attached) continue
    const b = tab.view.getBounds()
    if (x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height) return id
  }
  return null
}

export function tabContents(id: string): Electron.WebContents | null {
  const wc = tabs.get(id)?.view.webContents
  return wc && !wc.isDestroyed() ? wc : null
}

export function siblingTabs(id: string): Array<{ id: string; wc: Electron.WebContents }> {
  const owner = tabs.get(id)?.owner
  return [...tabs.entries()]
    .filter(([, t]) => t.owner === owner && !t.view.webContents.isDestroyed())
    .map(([tabId, t]) => ({ id: tabId, wc: t.view.webContents }))
}

export function queueAgentUrl(url: string): void {
  agentUrl = url
  agentUrlAt = Date.now()
}

export function agentUrlQueuedAt(): number {
  return agentUrlAt
}

export function tabOpenedSince(at: number): Electron.WebContents | null {
  return newestTab && newestTab.at >= at && !newestTab.wc.isDestroyed() ? newestTab.wc : null
}

export function currentTab(): Electron.WebContents | null {
  const live = [...tabs.values()].filter((t) => !t.view.webContents.isDestroyed())
  return (live.find((t) => t.attached) ?? live.at(-1))?.view.webContents ?? null
}

const halted = new WeakSet<Electron.WebContents>()

function tabIdOf(wc: Electron.WebContents): string | null {
  for (const [id, tab] of tabs) if (tab.view.webContents === wc) return id
  return null
}

export function agentStep(wc: Electron.WebContents, sessionId: string | undefined, doing: string): Promise<boolean> {
  const id = tabIdOf(wc)
  const tab = id ? tabs.get(id) : undefined
  if (!id || !tab) return Promise.resolve(true)
  halted.delete(wc)
  tab.agent = { resume: [], ...tab.agent, sessionId, doing }
  driveAgentCursor({ pause: (next) => pauseAgentIn(id, next), stop: () => void stopAgentIn(id) })
  push(id)
  return untilResumed(wc)
}

export function untilResumed(wc: Electron.WebContents): Promise<boolean> {
  if (halted.has(wc)) return Promise.resolve(false)
  const agent = tabs.get(tabIdOf(wc) ?? '')?.agent
  if (!agent?.paused) return Promise.resolve(true)
  return new Promise((resolve) => agent.resume.push(resolve))
}

function pauseAgentIn(id: string, paused: boolean): void {
  const agent = tabs.get(id)?.agent
  if (!agent || !!agent.paused === paused) return
  agent.paused = paused
  if (!paused) for (const go of agent.resume.splice(0)) go(true)
  push(id)
  pauseAgentCursor(paused)
}

export function endAgentDriving(sessionId?: string, halt = false): void {
  let ended = false
  for (const [id, tab] of tabs) {
    if (!tab.agent) tab.agentOpened = false
    if (!tab.agent || (sessionId && tab.agent.sessionId && tab.agent.sessionId !== sessionId)) continue
    for (const go of tab.agent.resume) go(false)
    tab.agent = undefined
    tab.agentOpened = false
    if (halt) halted.add(tab.view.webContents)
    ended = true
    push(id)
  }
  if (ended) hideAgentCursor()
}

async function stopAgentIn(id: string): Promise<void> {
  const sessionId = tabs.get(id)?.agent?.sessionId
  endAgentDriving(sessionId, true)
  if (!sessionId) return
  if (sessionId === CONFIG.MIGHTY.BROWSER_DRIVER) {
    ;(await import('./agent-relay/mcp/browser-tools')).stopChatBrowserRuns()
    return
  }
  const { resolveSessionRef } = await import('./agent-relay/session-control')
  const { sendPaneKeys } = await import('./agent-relay/picker-keys')
  const { setAgentSessionBusy } = await import('./agent-relay/mcp/http-listener')
  const session = resolveSessionRef(sessionId)
  if (session && (await sendPaneKeys(session.origin, [{ key: 'Escape' }]))) setAgentSessionBusy(session.sessionId, false)
}

export function tabScreenCenter(wc: Electron.WebContents): { x: number; y: number } | null {
  const tab = [...tabs.values()].find((t) => t.view.webContents === wc)
  if (!tab) return null
  const view = tab.view.getBounds()
  const zoom = wc.getZoomFactor()
  return tabScreenPoint(wc, view.width / zoom / 2, view.height / zoom / 3)
}

export function tabScreenPoint(wc: Electron.WebContents, x: number, y: number): { x: number; y: number } | null {
  const tab = [...tabs.values()].find((t) => t.view.webContents === wc)
  if (!tab?.attached || tab.owner.isDestroyed() || !tab.owner.isVisible() || tab.owner.isMinimized()) return null
  const content = tab.owner.getContentBounds()
  const view = tab.view.getBounds()
  const zoom = wc.getZoomFactor()
  return { x: Math.round(content.x + view.x + x * zoom), y: Math.round(content.y + view.y + y * zoom) }
}

function ownerOf(event: IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

export function registerSideBrowserHandlers(): void {
  registerSideBrowserPasskeyHandlers()
  void import('./agent-relay/mcp/http-listener').then((m) => m.addSessionTurnEndedListener(endAgentDriving))
  ipcMain.handle(CHANNELS.sideBrowserStopAgent, (_e, id: string) => stopAgentIn(id))
  ipcMain.handle(CHANNELS.sideBrowserPauseAgent, (_e, id: string, paused: boolean) => pauseAgentIn(id, paused))
  ipcMain.handle(CHANNELS.sideBrowserOpen, (event, address: string) => {
    const owner = ownerOf(event)
    return owner ? open(owner, address) : null
  })
  ipcMain.handle(CHANNELS.sideBrowserNavigate, (_e, id: string, address: string) => {
    const tab = tabs.get(id)
    if (tab) tab.agentOpened = address === agentUrlTaken
    if (tab?.agentOpened) agentUrlTaken = null
    void tab
      ?.view.webContents.loadURL(normalizeAddress(address))
      .catch(() => undefined)
  })
  ipcMain.handle(CHANNELS.sideBrowserCommand, (_e, id: string, cmd: SideBrowserCommand) =>
    command(id, cmd)
  )
  ipcMain.handle(CHANNELS.sideBrowserPlace, (_e, id: string, bounds: SideBrowserBounds | null) =>
    place(id, bounds)
  )
  ipcMain.handle(CHANNELS.sideBrowserStill, (_e, id: string) => still(id))
  ipcMain.handle(CHANNELS.sideBrowserFind, (_e, id: string, text: string | null, forward?: boolean) =>
    find(id, text, forward)
  )
  ipcMain.handle(
    CHANNELS.sideBrowserPermission,
    (_e, id: string, kind: string, decision: 'allow' | 'block' | 'reset') => {
      const tab = tabs.get(id)
      if (!tab) return
      decidePermission(tab.view.webContents, kind, decision)
      push(id)
    }
  )
  ipcMain.handle(CHANNELS.sideBrowserMod, (_e, id: string, action: SiteModAction, modId?: string, name?: string) => {
    const tab = tabs.get(id)
    const list = siteModAction(tab?.view.webContents ?? null, action, modId, name)
    if (tab) push(id)
    return list
  })
  ipcMain.handle(CHANNELS.sideBrowserSharedMod, async (_e, id: string, request: SharedModRequest) => {
    const tab = tabs.get(id)
    const result = await sharedModAction(tab?.view.webContents ?? null, request)
    for (const tabId of tabs.keys()) push(tabId)
    return result
  })
  ipcMain.handle(CHANNELS.sideBrowserLocation, (event) => siteLocation(event.sender, pushTabOf))
  ipcMain.handle(CHANNELS.sideBrowserClose, (_e, id: string) => destroy(id))
  ipcMain.handle(CHANNELS.sideBrowserImportSources, () => listImportSources())
  ipcMain.handle(CHANNELS.sideBrowserImportCookies, async (_e, browser: string, profile: string) => {
    const result = await importCookies(browserSession(), browser, profile)
    if (result.ok) {
      const dir = browserDir(browser)
      if (dir) try { importHistory(dir, profile) } catch { /* history is best-effort */ }
      for (const tab of tabs.values()) tab.view.webContents.reload()
    }
    return result
  })
  ipcMain.handle(CHANNELS.sideBrowserSuggest, (_e, query: string) => inlineIcons(suggest(query)))
  ipcMain.handle(CHANNELS.sideBrowserTopSites, () => inlineIcons(topSites()))
  ipcMain.handle(CHANNELS.sideBrowserRecent, () => inlineIcons(recent()))
  ipcMain.handle(CHANNELS.sideBrowserForgetRecent, (_e, url: string) => forgetPage(url))
  ipcMain.handle(CHANNELS.sideBrowserForgetTopSite, (_e, url: string) => forgetSite(url))
  ipcMain.handle(CHANNELS.sideBrowserAnnotate, (_e, id: string) => {
    const wc = tabContents(id)
    return wc ? annotate(wc) : null
  })
  ipcMain.handle(CHANNELS.sideBrowserAnnotateEnd, (_e, id: string, note: string | null) => {
    const wc = tabContents(id)
    if (wc) endAnnotate(wc, note)
  })
  ipcMain.handle(CHANNELS.sideBrowserTakeUrl, () => {
    const url = agentUrl
    agentUrl = null
    agentUrlTaken = url
    return url
  })
}

import { BrowserWindow, screen } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { chrome } from './platform'
import { CONFIG } from '../shared/config'
import { CHANNELS } from '../shared/ipc'
import type { ReplyWindowAim, ReplyWindowSeeing } from '../shared/types'

const WIDTH = 420
const HEIGHT = 600
const SMALL_HEIGHT = 190
const PROTECTION_SETTLE_MS = 120
const EDGE_GAP = 16
const AIM_WAIT_MS = 400

let replyWindow: BrowserWindow | null = null
// set when the user closes it; going back to a browser must not bring it back until the hotkey does
let dismissed = false

function buildWindow(height = HEIGHT): BrowserWindow {
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  const win = new BrowserWindow({
    x: area.x + area.width - WIDTH - EDGE_GAP,
    y: area.y + area.height - height - EDGE_GAP,
    width: WIDTH,
    height,
    minWidth: 340,
    minHeight: 170,
    title: `Reply - ${CONFIG.APP_NAME}`,
    ...chrome.windowOptions('panel'),
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    backgroundColor: CONFIG.THEME_TOKENS.windowBg,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  chrome.showOnAllWorkspaces(win)
  win.on('focus', () => void captureBehind(win))
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=reply`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { query: { window: 'reply' } })
  }
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' || !input.meta || input.key.toLowerCase() !== 'w') return
    // must stop here: the default Window menu's Cmd+W would destroy the window, not hide it
    e.preventDefault()
    hideReplyWindow()
  })
  win.on('closed', () => {
    replyWindow = null
  })
  return win
}

async function captureBehind(win: BrowserWindow): Promise<void> {
  const { captureScreenUnderCursor } = await import('./reply-focus')
  // protection takes effect a beat after it is set; on only for our shot so the user's own screenshots still show the window
  win.setContentProtection(true)
  await new Promise((done) => setTimeout(done, PROTECTION_SETTLE_MS))
  const path = await captureScreenUnderCursor().finally(() => !win.isDestroyed() && win.setContentProtection(false))
  if (path && !win.isDestroyed()) win.webContents.send(CHANNELS.replyWindowScreen, path)
}

export function getReplyWindow(): BrowserWindow | null {
  return replyWindow && !replyWindow.isDestroyed() ? replyWindow : null
}

export function replyWindowFocused(): boolean {
  return Boolean(getReplyWindow()?.isFocused())
}

export function hideReplyWindow(): void {
  dismissed = true
  getReplyWindow()?.hide()
}

export function expandReplyWindow(): void {
  const win = getReplyWindow()
  if (!win) return
  const bounds = win.getBounds()
  const area = screen.getDisplayMatching(bounds).workArea
  const height = Math.min(HEIGHT, area.height)
  if (bounds.height >= height) return
  win.setBounds({ ...bounds, y: Math.max(area.y, bounds.y + bounds.height - height), height })
}

export function tellReplyWindow(seeing: ReplyWindowSeeing): void {
  const win = getReplyWindow()
  if (win && !win.isDestroyed()) win.webContents.send(CHANNELS.replyWindowSeeing, seeing)
}

export function switchReplyWindow(aim: ReplyWindowAim): void {
  const win = getReplyWindow()
  if (win?.isVisible()) win.webContents.send(CHANNELS.replyWindowAim, aim)
}

export function followFrontApp(showHere: boolean, firstAim: () => ReplyWindowAim): void {
  const open = getReplyWindow()
  if (!showHere) {
    if (open?.isVisible()) open.hide()
    return
  }
  if (dismissed) return
  if (open) {
    if (!open.isVisible()) open.showInactive()
    return
  }
  const win = buildWindow(SMALL_HEIGHT)
  replyWindow = win
  win.webContents.once('did-finish-load', () => {
    win.webContents.send(CHANNELS.replyWindowAim, firstAim())
    win.showInactive()
  })
}

// reply-focus is loaded lazily: it pulls the agent relay, which the capture tests cannot load
export function showReplyWindow(ref: string): void {
  void import('./reply-focus').then(({ focusOrder }) => aimWindow({ ref, order: focusOrder() }))
}

function aimWindow(aim: ReplyWindowAim): void {
  dismissed = false
  const open = getReplyWindow()
  const win = open ?? buildWindow()
  replyWindow = win
  const reveal = (): void => {
    win.webContents.send(CHANNELS.replyWindowAim, aim)
    // show() alone: focus() brings the whole app forward, a panel takes typing without it
    win.show()
    win.webContents.focus()
  }
  if (open && !win.webContents.isLoading()) reveal()
  else win.webContents.once('did-finish-load', reveal)
}

export async function toggleReplyWindow(): Promise<void> {
  const open = getReplyWindow()
  if (open?.isVisible()) {
    hideReplyWindow()
    return
  }
  const { aimAtFront, focusOrder } = await import('./reply-focus')
  const ref = await aimAtFront(AIM_WAIT_MS)
  aimWindow({ ref, order: focusOrder() })
}

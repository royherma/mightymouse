import { BrowserWindow, screen } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { chrome } from './platform'
import { CONFIG } from '../shared/config'
import { CHANNELS } from '../shared/ipc'

const WIDTH = 420
const HEIGHT = 600
const EDGE_GAP = 16

let replyWindow: BrowserWindow | null = null

function buildWindow(): BrowserWindow {
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  const win = new BrowserWindow({
    x: area.x + area.width - WIDTH - EDGE_GAP,
    y: area.y + area.height - HEIGHT - EDGE_GAP,
    width: WIDTH,
    height: HEIGHT,
    minWidth: 340,
    minHeight: 360,
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
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=reply`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { query: { window: 'reply' } })
  }
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' || !input.meta || input.key.toLowerCase() !== 'w') return
    // must stop here: the default Window menu's Cmd+W would destroy the window, not hide it
    e.preventDefault()
    win.hide()
  })
  win.on('closed', () => {
    replyWindow = null
  })
  return win
}

export function getReplyWindow(): BrowserWindow | null {
  return replyWindow && !replyWindow.isDestroyed() ? replyWindow : null
}

export function replyWindowFocused(): boolean {
  return Boolean(getReplyWindow()?.isFocused())
}

export function hideReplyWindow(): void {
  getReplyWindow()?.hide()
}

export function showReplyWindow(ref: string): void {
  const open = getReplyWindow()
  const win = open ?? buildWindow()
  replyWindow = win
  const aim = (): void => {
    win.webContents.send(CHANNELS.replyWindowAim, ref)
    win.show()
    win.webContents.focus()
  }
  if (open && !win.webContents.isLoading()) aim()
  else win.webContents.once('did-finish-load', aim)
}

export function toggleReplyWindow(): void {
  const open = getReplyWindow()
  if (open?.isVisible() && open.isFocused()) {
    open.hide()
    return
  }
  const win = open ?? buildWindow()
  replyWindow = win
  const reveal = (): void => {
    // show() alone: focus() brings the whole app forward, a panel takes typing without it
    win.show()
    win.webContents.focus()
  }
  if (open) reveal()
  else win.once('ready-to-show', reveal)
}

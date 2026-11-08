import { BrowserWindow, screen } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { chrome } from './platform'
import { CHANNELS } from '../shared/ipc'
import { CONFIG } from '../shared/config'
import { applyInkOp, EMPTY_INK_SCENE, type InkOp, type InkScene } from '../shared/ink'

// Click-through layer showing the phone Draw page's ink and pointer; never moves the real cursor or takes focus.

let inkWindow: BrowserWindow | null = null
let ready = false
let scene: InkScene = EMPTY_INK_SCENE
let hiddenForCapture = false

export function inkDisplay(): Electron.Display {
  return screen.getPrimaryDisplay()
}

function buildWindow(): BrowserWindow {
  const b = inkDisplay().bounds
  const win = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    resizable: false,
    focusable: false,
    hasShadow: false,
    enableLargerThanScreen: true,
    ...chrome.windowOptions('panel'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
  win.setIgnoreMouseEvents(true, { forward: false })
  win.setAlwaysOnTop(true, 'screen-saver')
  chrome.showOnAllWorkspaces(win)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=ink`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { query: { window: 'ink' } })
  }
  win.webContents.on('did-finish-load', () => {
    ready = true
    win.webContents.send(CHANNELS.inkOp, { op: 'scene', scene } satisfies InkOp)
  })
  win.on('closed', () => {
    inkWindow = null
    ready = false
  })
  return win
}

function ensureWindow(): BrowserWindow {
  if (inkWindow && !inkWindow.isDestroyed()) return inkWindow
  inkWindow = buildWindow()
  inkWindow.once('ready-to-show', () => {
    if (inkWindow && !inkWindow.isDestroyed() && !hiddenForCapture) inkWindow.showInactive()
  })
  return inkWindow
}

/** Mirrors the op into the Mac's copy of the drawing and onto the screen. */
export function pushInkOp(op: InkOp): void {
  scene = applyInkOp(scene, op)
  if (op.op === 'close') {
    closeInkOverlay()
    return
  }
  const win = ensureWindow()
  if (ready) win.webContents.send(CHANNELS.inkOp, op)
}

export function closeInkOverlay(): void {
  scene = EMPTY_INK_SCENE
  if (inkWindow && !inkWindow.isDestroyed()) inkWindow.close()
  inkWindow = null
  ready = false
}

/** Runs `capture` with the ink layer off the screen, so a screenshot shows only the Mac's own pixels. */
export async function withInkHidden<T>(capture: () => Promise<T>): Promise<T> {
  const win = inkWindow && !inkWindow.isDestroyed() && inkWindow.isVisible() ? inkWindow : null
  hiddenForCapture = true
  win?.hide()
  if (win) await new Promise((r) => setTimeout(r, CONFIG.PHONE_REMOTE.INK_HIDE_SETTLE_MS))
  try {
    return await capture()
  } finally {
    hiddenForCapture = false
    if (inkWindow && !inkWindow.isDestroyed() && ready) inkWindow.showInactive()
  }
}

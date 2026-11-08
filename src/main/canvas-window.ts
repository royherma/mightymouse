import { BrowserWindow, screen } from 'electron'
import { chrome } from './platform'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

let canvasWindow: BrowserWindow | null = null

function buildWindow(): BrowserWindow {
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  const win = new BrowserWindow({
    x: wa.x,
    y: wa.y,
    width: wa.width,
    height: wa.height,
    show: false,
    ...chrome.windowOptions('panel'),
    frame: false,
    skipTaskbar: true,
    minimizable: false,
    fullscreenable: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
  chrome.showOnAllWorkspaces(win)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=canvas`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { query: { window: 'canvas' } })
  }
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' || !input.meta || input.key.toLowerCase() !== 'w') return
    // must stop here: the default Window menu's Cmd+W would destroy the window, not hide it
    e.preventDefault()
    win.hide()
  })
  win.on('blur', () => {
    if (!win.isDestroyed()) win.setAlwaysOnTop(false)
  })
  win.on('closed', () => {
    canvasWindow = null
  })
  return win
}

// show() alone: focus() activates the app and pulls the main window forward with it
function reveal(win: BrowserWindow): void {
  win.setAlwaysOnTop(true, 'floating')
  win.show()
  win.webContents.focus()
}

export function canvasWindowShown(): boolean {
  return Boolean(canvasWindow && !canvasWindow.isDestroyed() && canvasWindow.isVisible())
}

export function hideCanvasWindow(): void {
  if (canvasWindow && !canvasWindow.isDestroyed()) canvasWindow.hide()
}

export function showCanvasWindow(): void {
  if (canvasWindow && !canvasWindow.isDestroyed()) {
    reveal(canvasWindow)
    return
  }
  const win = buildWindow()
  canvasWindow = win
  win.once('ready-to-show', () => reveal(win))
}

export function toggleCanvasWindow(): void {
  if (canvasWindowShown()) hideCanvasWindow()
  else showCanvasWindow()
}

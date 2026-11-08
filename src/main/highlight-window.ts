import { BrowserWindow, screen } from 'electron'
import { chrome } from './platform'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { CONFIG } from '../shared/config'
import { CHANNELS } from '../shared/ipc'

// Full-screen, transparent, click-through overlay that flashes a dashed box
// around a real act-mode click/type/drag target — "this is where a change is
// happening", fired just before mm-input actually acts. Same buildWindow/
// multi-display pattern as cursor-window.ts, but fire-and-forget: no polling,
// each call just moves the window to the target's display and pushes a box.

let highlightWindow: BrowserWindow | null = null
let currentDisplayId: number | null = null

function buildWindow(): BrowserWindow {
  const display = screen.getPrimaryDisplay()
  currentDisplayId = display.id
  const b = display.bounds

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
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=highlight`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'highlight' }
    })
  }

  win.on('closed', () => {
    highlightWindow = null
  })

  return win
}

function ensureWindow(onReady: () => void): void {
  if (highlightWindow && !highlightWindow.isDestroyed()) {
    onReady()
    return
  }
  highlightWindow = buildWindow()
  highlightWindow.once('ready-to-show', () => {
    if (highlightWindow && !highlightWindow.isDestroyed()) {
      highlightWindow.showInactive()
      onReady()
    }
  })
}

// Flash a dashed box centered on an absolute SCREEN point. Ensures the overlay
// window exists, moves it to cover the target's display, converts to
// window-local coords (same space as cursorFlyTo/cursorPos), and pushes the
// box over CHANNELS.actHighlight. Fire-and-forget — never awaited by callers.
// sizePx/durationMs default to CONFIG.ACT_HIGHLIGHT — overridable per-call so
// the Playground demo can tune "bigger/longer" live, no restart needed.
export function flashHighlightBox(
  screenX: number,
  screenY: number,
  sizePx: number = CONFIG.ACT_HIGHLIGHT.BOX_SIZE_PX,
  durationMs: number = CONFIG.ACT_HIGHLIGHT.DURATION_MS
): void {
  const send = (): void => {
    if (!highlightWindow || highlightWindow.isDestroyed()) return

    const display = screen.getDisplayNearestPoint({ x: screenX, y: screenY })
    if (display.id !== currentDisplayId) {
      currentDisplayId = display.id
      const b = display.bounds
      highlightWindow.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height })
    }

    const origin = highlightWindow.getBounds()
    highlightWindow.webContents.send(CHANNELS.actHighlight, {
      x: screenX - origin.x - sizePx / 2,
      y: screenY - origin.y - sizePx / 2,
      w: sizePx,
      h: sizePx,
      durationMs
    })
  }
  ensureWindow(send)
}

export function stopHighlightOverlay(): void {
  if (highlightWindow && !highlightWindow.isDestroyed()) {
    highlightWindow.close()
  }
  highlightWindow = null
  currentDisplayId = null
}

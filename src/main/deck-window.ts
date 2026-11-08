import { BrowserWindow, screen } from 'electron'
import { chrome } from './platform'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

// The Mac swipe deck — one live agent per card, cleared with a swipe or a key.
// Singleton and ordinary: a real titled window you focus and type in, unlike the
// frameless overlays (cursor/island/cheese). It reads the relay over the same
// IPC the sessions list already uses, so main owns nothing but the lifecycle.

// Card-shaped. Tall and narrow so a card fills it the way it fills a phone —
// a wide window would strand the deck in a letterboxed column.
const DECK_W = 560
const DECK_H = 760

let deckWindow: BrowserWindow | null = null

function buildWindow(): BrowserWindow {
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  const win = new BrowserWindow({
    x: Math.round(wa.x + (wa.width - DECK_W) / 2),
    y: Math.round(wa.y + (wa.height - DECK_H) / 2),
    width: DECK_W,
    height: DECK_H,
    show: false,
    ...chrome.windowOptions('inset-notraffic'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=deck`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { query: { window: 'deck' } })
  }

  win.on('ready-to-show', () => {
    if (!win.isDestroyed()) win.show()
  })
  win.on('closed', () => {
    deckWindow = null
  })
  return win
}

/** Open the deck, or focus it if it's already up. */
export function showDeckWindow(): void {
  if (deckWindow && !deckWindow.isDestroyed()) {
    deckWindow.show()
    deckWindow.focus()
    return
  }
  deckWindow = buildWindow()
}

// ── Component Playground window ───────────────────────────────────────────────
// A scrollable design-system preview for all UI primitives.
// Open via tray "Playground…" or CHANNELS.openPlaygroundWindow IPC.
// To disable: comment out the import in index.ts and the IPC handler in ipc.ts.

import { BrowserWindow } from 'electron'
import { chrome } from './platform'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { CONFIG } from '../shared/config'

let playgroundWindow: BrowserWindow | null = null

export function showPlaygroundWindow(): void {
  if (playgroundWindow && !playgroundWindow.isDestroyed()) {
    playgroundWindow.show()
    playgroundWindow.focus()
    return
  }

  playgroundWindow = new BrowserWindow({
    width: 720,
    height: 720,
    minWidth: 560,
    title: `${CONFIG.APP_NAME} — Component Playground`,
    frame: true,
    ...chrome.windowOptions('inset'),
    resizable: true,
    minimizable: true,
    maximizable: true,
    show: false,
    backgroundColor: CONFIG.THEME_TOKENS.windowBg,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    playgroundWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=playground`)
  } else {
    playgroundWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'playground' }
    })
  }

  playgroundWindow.on('ready-to-show', () => {
    playgroundWindow?.show()
    playgroundWindow?.focus()
  })

  playgroundWindow.on('closed', () => {
    playgroundWindow = null
  })
}

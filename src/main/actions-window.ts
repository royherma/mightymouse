import { BrowserWindow } from 'electron'
import { chrome } from './platform'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { CONFIG } from '../shared/config'

let actionsWindow: BrowserWindow | null = null

export function getActionsWindow(): BrowserWindow | null {
  return actionsWindow
}

export function showActionsWindow(): void {
  if (actionsWindow && !actionsWindow.isDestroyed()) {
    actionsWindow.show()
    actionsWindow.focus()
    return
  }

  actionsWindow = new BrowserWindow({
    width: 640,
    height: 760,
    minWidth: 580,
    title: `${CONFIG.APP_NAME} Actions`,
    frame: true,
    ...chrome.windowOptions('inset'),
    resizable: true,
    minimizable: true,
    maximizable: false,
    show: false,
    // Opaque form of THEME_TOKENS.bg — Electron's backgroundColor takes no
    // rgba()/var(), so every window in src/main hardcodes this same hex.
    backgroundColor: CONFIG.THEME_TOKENS.windowBg,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    actionsWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=actions`)
  } else {
    actionsWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'actions' }
    })
  }

  actionsWindow.on('ready-to-show', () => {
    actionsWindow?.show()
    actionsWindow?.focus()
  })

  actionsWindow.on('closed', () => {
    actionsWindow = null
  })
}

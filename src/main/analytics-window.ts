import { BrowserWindow } from 'electron'
import { chrome } from './platform'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { CONFIG } from '../shared/config'

let analyticsWindow: BrowserWindow | null = null

export function getAnalyticsWindow(): BrowserWindow | null {
  return analyticsWindow
}

export function showAnalyticsWindow(): void {
  if (analyticsWindow && !analyticsWindow.isDestroyed()) {
    analyticsWindow.show()
    analyticsWindow.focus()
    return
  }

  analyticsWindow = new BrowserWindow({
    width: 640,
    height: 820,
    minWidth: 580,
    title: `${CONFIG.APP_NAME} Analytics`,
    frame: true,
    ...chrome.windowOptions('inset'),
    resizable: true,
    minimizable: true,
    maximizable: false,
    show: false,
    backgroundColor: CONFIG.THEME_TOKENS.windowBg,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    analyticsWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=analytics`)
  } else {
    analyticsWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'analytics' }
    })
  }

  analyticsWindow.on('ready-to-show', () => {
    analyticsWindow?.show()
    analyticsWindow?.focus()
  })

  analyticsWindow.on('closed', () => {
    analyticsWindow = null
  })
}

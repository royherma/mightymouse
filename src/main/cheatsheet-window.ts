import { BrowserWindow } from 'electron'
import { chrome } from './platform'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { CONFIG } from '../shared/config'

let cheatWindow: BrowserWindow | null = null

export function showCheatSheetWindow(): void {
  if (cheatWindow && !cheatWindow.isDestroyed()) {
    cheatWindow.show()
    cheatWindow.focus()
    return
  }

  cheatWindow = new BrowserWindow({
    width: 460,
    height: 520,
    minWidth: 380,
    title: `${CONFIG.APP_NAME} Shortcuts`,
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
    cheatWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=cheatsheet`)
  } else {
    cheatWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'cheatsheet' }
    })
  }

  cheatWindow.on('ready-to-show', () => {
    cheatWindow?.show()
    cheatWindow?.focus()
  })

  cheatWindow.on('closed', () => {
    cheatWindow = null
  })
}

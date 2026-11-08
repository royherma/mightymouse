import { BrowserWindow } from 'electron'
import { chrome } from './platform'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { CONFIG } from '../shared/config'

// The bug report form (?window=bug), opened from the tray item and from the
// crash notification. Mirrors connectors-window.ts: one reusable BrowserWindow,
// shown/focused on repeat opens rather than spawning duplicates.
//
// Sized taller than wide because the form is a vertical stack (two textareas,
// the diagnostics block, the activity trail) — the content scrolls, the window
// doesn't need to be big.
let bugWindow: BrowserWindow | null = null

export function getBugReportWindow(): BrowserWindow | null {
  return bugWindow
}

/** Close the form after a successful submit. No-op if it's already gone. */
export function closeBugReportWindow(): void {
  if (bugWindow && !bugWindow.isDestroyed()) bugWindow.close()
}

export function showBugReportWindow(): void {
  if (bugWindow && !bugWindow.isDestroyed()) {
    bugWindow.show()
    bugWindow.focus()
    return
  }

  bugWindow = new BrowserWindow({
    width: 560,
    height: 720,
    minWidth: 480,
    minHeight: 520,
    title: `Report a Bug - ${CONFIG.APP_NAME}`,
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
    bugWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=bug`)
  } else {
    bugWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'bug' }
    })
  }

  bugWindow.on('ready-to-show', () => {
    bugWindow?.show()
    bugWindow?.focus()
  })

  bugWindow.on('closed', () => {
    bugWindow = null
  })
}

import { BrowserWindow } from 'electron'
import { chrome } from './platform'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { CONFIG } from '../shared/config'

// Standalone Billing & Usage window — the "Show all" target from Settings → Usage.
// Mirrors analytics-window.ts exactly (one singleton, ?window=billing route) so the
// two stay structurally identical; only size + route differ.

let billingWindow: BrowserWindow | null = null

export function showBillingWindow(): void {
  if (billingWindow && !billingWindow.isDestroyed()) {
    billingWindow.show()
    billingWindow.focus()
    return
  }

  billingWindow = new BrowserWindow({
    width: 720,
    height: 860,
    minWidth: 620,
    title: `${CONFIG.APP_NAME} Billing`,
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
    billingWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=billing`)
  } else {
    billingWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'billing' }
    })
  }

  billingWindow.on('ready-to-show', () => {
    billingWindow?.show()
    billingWindow?.focus()
  })

  billingWindow.on('closed', () => {
    billingWindow = null
  })
}

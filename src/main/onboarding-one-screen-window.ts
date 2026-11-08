import { BrowserWindow } from 'electron'
import { chrome } from './platform'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { CONFIG } from '../shared/config'
import { IS_DEV } from '../shared/env'

// Preview window for the one-screen setup. Deliberately its own
// factory rather than a flag on showOnboardingWindow: that one is a HARD GATE —
// alwaysOnTop, and its completion releases the app-tail gate in index.ts. This
// opens the same screen as an ordinary window that can be closed and ignored, so
// previewing it on a working machine can never strand the real flow.
// This preview stays for eyeballing it on an already-set-up machine without touching setup state.

let previewWindow: BrowserWindow | null = null

export function showOnboardingOneScreenPreview(): void {
  if (previewWindow && !previewWindow.isDestroyed()) {
    previewWindow.show()
    previewWindow.focus()
    return
  }

  previewWindow = new BrowserWindow({
    width: 520,
    height: 800,
    title: `Set up ${CONFIG.APP_NAME}`,
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

  // preview=1 is what keeps this honest: the renderer skips onboarding.complete()
  // and the relaunch, so the marker and the gate stay exactly as they were.
  const query = { window: 'onboarding1', preview: '1' }
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const qs = new URLSearchParams(query).toString()
    previewWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?${qs}`)
  } else {
    previewWindow.loadFile(join(__dirname, '../renderer/index.html'), { query })
  }

  if (IS_DEV) {
    previewWindow.webContents.on('console-message', (_e, _level, message) => {
      // eslint-disable-next-line no-console -- intentional dev-only forward
      console.log(`[onboarding1-renderer] ${message}`)
    })
  }

  previewWindow.on('ready-to-show', () => {
    previewWindow?.show()
    previewWindow?.focus()
  })

  previewWindow.on('closed', () => {
    previewWindow = null
  })
}

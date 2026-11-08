/**
 * The Setup window — one surface listing every dependency, with a real button
 * on every failing row.
 *
 * Deliberately NOT a gate like the onboarding wizard. Onboarding blocks the app
 * tail until required permissions pass; Setup is a place the user can *come
 * back to* when something breaks later — from Settings, from an error toast, or
 * from an onboarding row. It closes freely and nothing waits on it.
 *
 * See prds/active/2026-07-23-1784776098-zero-dead-ends-setup-check.md
 */
import { BrowserWindow } from 'electron'
import { chrome } from './platform'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { CONFIG } from '../shared/config'

/** Matches the `?window=setup` branch in renderer/src/main.tsx. */
const SETUP_WINDOW_ROUTE = 'setup'

let setupWindow: BrowserWindow | null = null

export function showSetupWindow(): void {
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.show()
    setupWindow.focus()
    return
  }

  setupWindow = new BrowserWindow({
    width: CONFIG.SETUP_CHECK.windowWidth,
    height: CONFIG.SETUP_CHECK.windowHeight,
    title: CONFIG.SETUP_CHECK.title,
    frame: true,
    ...chrome.windowOptions('inset'),
    resizable: false,
    minimizable: true,
    maximizable: false,
    show: false,
    backgroundColor: CONFIG.THEME_TOKENS.bg,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  const query = { window: SETUP_WINDOW_ROUTE }
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const qs = new URLSearchParams(query).toString()
    setupWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?${qs}`)
  } else {
    setupWindow.loadFile(join(__dirname, '../renderer/index.html'), { query })
  }

  setupWindow.on('ready-to-show', () => {
    setupWindow?.show()
    setupWindow?.focus()
  })

  setupWindow.on('closed', () => {
    setupWindow = null
  })
}

export function closeSetupWindow(): void {
  if (setupWindow && !setupWindow.isDestroyed()) setupWindow.close()
  setupWindow = null
}

/** The setup window, if it's open — used to push fresh checks after a fix. */
export function getSetupWindow(): BrowserWindow | null {
  return setupWindow && !setupWindow.isDestroyed() ? setupWindow : null
}

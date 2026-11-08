import { BrowserWindow } from 'electron'
import { chrome } from './platform'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { CONFIG } from '../shared/config'
import { PREFS } from './store/prefs'
import { track } from './analytics'
import { ANALYTICS_EVENT } from '../shared/analytics-events'
import { IS_DEV } from '../shared/env'
import { showSettingsWindow } from './settings-window'

// Not a gate (alwaysOnTop:false): any close, deliberate or red-X, marks onboarding+tour complete.

let firstRunWindow: BrowserWindow | null = null

// Guards the 'closed' handler's fallback so a deliberate finish() doesn't double-fire it.
let finishing = false

export function showFirstRunWindow(): void {
  if (firstRunWindow && !firstRunWindow.isDestroyed()) {
    firstRunWindow.show()
    firstRunWindow.focus()
    return
  }

  finishing = false

  track(ANALYTICS_EVENT.onboarding_started, { reauth: false, surface: 'first-run' })

  firstRunWindow = new BrowserWindow({
    width: CONFIG.FIRST_RUN.WIDTH,
    height: CONFIG.FIRST_RUN.HEIGHT,
    title: CONFIG.FIRST_RUN.title,
    frame: true,
    ...chrome.windowOptions('inset'),
    resizable: false,
    minimizable: true,
    maximizable: false,
    alwaysOnTop: false,
    show: false,
    backgroundColor: CONFIG.THEME_TOKENS.windowBg,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  const win = firstRunWindow

  const query = { window: 'first-run' }
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=first-run`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { query })
  }

  if (IS_DEV) {
    win.webContents.on('console-message', (_e, _level, message) => {
      console.log(`[first-run-renderer] ${message}`)
    })
  }

  win.on('ready-to-show', () => {
    win.show()
    win.focus()
  })

  win.on('closed', () => {
    firstRunWindow = null
    if (finishing) return
    PREFS.setOnboardingComplete(true)
    PREFS.setTourSeen(true)
    track(ANALYTICS_EVENT.onboarding_completed, { reauth: false, surface: 'first-run' })
  })
}

export function closeFirstRunWindow(): void {
  finishing = true
  if (firstRunWindow && !firstRunWindow.isDestroyed()) {
    firstRunWindow.close()
  }
  firstRunWindow = null
}

// Done clicked, or a path reached its win: persist + close.
export function finishFirstRun(): void {
  PREFS.setOnboardingComplete(true)
  PREFS.setTourSeen(true)
  track(ANALYTICS_EVENT.onboarding_completed, { reauth: false, surface: 'first-run' })
  closeFirstRunWindow()
  showSettingsWindow('phoneRemote')
}

export function sendToFirstRunRenderer(channel: string, ...args: unknown[]): void {
  if (firstRunWindow && !firstRunWindow.isDestroyed()) {
    firstRunWindow.webContents.send(channel, ...args)
  }
}

export function getFirstRunWindow(): BrowserWindow | null {
  return firstRunWindow
}

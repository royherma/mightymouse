import { BrowserWindow } from 'electron'
import { chrome } from './platform'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { CONFIG } from '../shared/config'

// The dedicated Resources window (?window=resources), opened from the tray.
// Mirrors connectors-window.ts: a single reusable BrowserWindow, shown/focused
// on repeat opens rather than spawning duplicates.
let resourcesWindow: BrowserWindow | null = null
let visibilityHandler: ((open: boolean) => void) | null = null

export function getResourcesWindow(): BrowserWindow | null {
  return resourcesWindow
}

export function setResourcesVisibilityHandler(fn: (open: boolean) => void): void {
  visibilityHandler = fn
}

function emitVisibility(open: boolean): void {
  visibilityHandler?.(open)
}

export function showResourcesWindow(): void {
  if (resourcesWindow && !resourcesWindow.isDestroyed()) {
    resourcesWindow.show()
    resourcesWindow.focus()
    return
  }

  resourcesWindow = new BrowserWindow({
    width: 1120,
    height: 820,
    minWidth: 1000,
    title: `${CONFIG.APP_NAME} Resources`,
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
    resourcesWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=resources`)
  } else {
    resourcesWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'resources' }
    })
  }

  resourcesWindow.on('ready-to-show', () => {
    resourcesWindow?.show()
    resourcesWindow?.focus()
  })

  resourcesWindow.on('show', () => emitVisibility(true))
  resourcesWindow.on('restore', () => emitVisibility(true))
  resourcesWindow.on('hide', () => emitVisibility(false))
  resourcesWindow.on('minimize', () => emitVisibility(false))
  resourcesWindow.on('closed', () => {
    resourcesWindow = null
    emitVisibility(false)
  })
}

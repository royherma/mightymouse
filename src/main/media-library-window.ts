import { BrowserWindow } from 'electron'
import { chrome } from './platform'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { CONFIG } from '../shared/config'
import { CHANNELS } from '../shared/ipc'

let mediaLibraryWindow: BrowserWindow | null = null

/**
 * Open the Media Library. `focusFolder` selects one capture on arrival — that's how
 * a finished recording's HUD card lands the user on the thing they just made instead
 * of a cold list. An already-open window is told over IPC (its route is fixed at
 * load, so a re-navigate would throw away scroll + in-flight state).
 */
export function showMediaLibraryWindow(focusFolder?: string): void {
  if (mediaLibraryWindow && !mediaLibraryWindow.isDestroyed()) {
    if (focusFolder) {
      mediaLibraryWindow.webContents.send(CHANNELS.mediaFocusFolder, focusFolder)
    }
    mediaLibraryWindow.show()
    mediaLibraryWindow.focus()
    return
  }

  mediaLibraryWindow = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 720,
    minHeight: 480,
    title: `${CONFIG.APP_NAME} Media Library`,
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

  // The focus target rides in on the query string so it's readable before first
  // paint — no flash of an unselected list, and no IPC race against ready-to-show.
  const query: Record<string, string> = { window: 'media' }
  if (focusFolder) query.focus = focusFolder

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const url = new URL(process.env['ELECTRON_RENDERER_URL'])
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
    mediaLibraryWindow.loadURL(url.toString())
  } else {
    mediaLibraryWindow.loadFile(join(__dirname, '../renderer/index.html'), { query })
  }

  mediaLibraryWindow.on('ready-to-show', () => {
    mediaLibraryWindow?.show()
    mediaLibraryWindow?.focus()
  })

  mediaLibraryWindow.on('closed', () => {
    mediaLibraryWindow = null
  })
}

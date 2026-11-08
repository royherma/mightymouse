import { BrowserWindow } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { CHANNELS } from '../shared/ipc'
import { SoundName } from '../shared/types'
import { PREFS } from './store/prefs'

let soundWindow: BrowserWindow | null = null

/**
 * Create the offscreen, persistent window that plays UI sound effects.
 * Tiny, never shown, not focusable, kept off the taskbar. It exists purely
 * to host a Web Audio player that main-process code can drive via playSound().
 */
export function createSoundWindow(): void {
  if (soundWindow && !soundWindow.isDestroyed()) return

  const win = new BrowserWindow({
    width: 1,
    height: 1,
    show: false,
    frame: false,
    transparent: true,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=sound`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'sound' }
    })
  }

  win.on('closed', () => {
    soundWindow = null
  })

  soundWindow = win
}

/**
 * Play a UI sound. Single choke point for the mute pref — callers don't check.
 */
export function playSound(name: SoundName): void {
  if (!PREFS.getSoundEnabled()) return
  if (soundWindow && !soundWindow.isDestroyed()) {
    soundWindow.webContents.send(CHANNELS.playSound, name)
  }
}

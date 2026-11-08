import { BrowserWindow } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { IS_DEV } from '../shared/env'

/**
 * The renderer that owns the mic + VAD for hands-free dictation
 * (`?window=handsfree`). It has no UI at all — the HUD card is the mode's only
 * visible surface — but it must be a real BrowserWindow because vad-web needs a
 * DOM `getUserMedia` + `AudioWorklet` (see useVoiceActivity.ts's module doc for
 * why the VAD cannot run in main).
 *
 * Deliberately NOT the companion window: Live Companion is a separate feature
 * with a visible character and its own on/off switch, and gating one on the
 * other would mean hands-free either drags a mouse onto the screen or dies when
 * the user turns Live mode off. Two windows, one shared hook.
 */

let hostWindow: BrowserWindow | null = null

function buildWindow(): BrowserWindow {
  // 1x1 and off-screen rather than `show: false`: a hidden window gets its
  // timers and media throttled by Chromium, which stalls the VAD's
  // AudioWorklet. Present-but-invisible keeps it running at full rate.
  const win = new BrowserWindow({
    width: 1,
    height: 1,
    x: -10000,
    y: -10000,
    frame: false,
    transparent: true,
    skipTaskbar: true,
    show: false,
    resizable: false,
    focusable: false,
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      // The window is never visible, so Chromium would otherwise throttle the
      // audio worklet the VAD runs on.
      backgroundThrottling: false
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=handsfree`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'handsfree' }
    })
  }

  win.on('closed', () => {
    hostWindow = null
  })

  if (IS_DEV) {
    win.webContents.on('console-message', (_e, _level, message) => {
      // eslint-disable-next-line no-console -- intentional dev-only forward
      console.log(`[handsfree-renderer] ${message}`)
    })
  }

  return win
}

export function startHandsFreeHost(): void {
  if (hostWindow && !hostWindow.isDestroyed()) return
  hostWindow = buildWindow()
  // showInactive on an off-screen window: it never appears or takes focus, but
  // it counts as visible, which is what keeps the media pipeline unthrottled.
  hostWindow.on('ready-to-show', () => hostWindow?.showInactive())
}

export function stopHandsFreeHost(): void {
  if (hostWindow && !hostWindow.isDestroyed()) {
    hostWindow.close()
  }
  hostWindow = null
}

export function isHandsFreeHostRunning(): boolean {
  return hostWindow !== null && !hostWindow.isDestroyed()
}

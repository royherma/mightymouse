import { BrowserWindow, screen, ipcMain } from 'electron'
import { chrome } from './platform'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { CONFIG } from '../shared/config'
import { CHANNELS } from '../shared/ipc'
import { track } from './analytics'
import { ANALYTICS_EVENT } from '../shared/analytics-events'
import type { UpgradeReason } from '../shared/types'

// The app's single paywall surface. Every upgrade CTA anywhere in the app opens
// this window with the `reason` that triggered it; nothing else talks to Stripe.
// Centered, always-on-top, content-sized — deliberately NOT the fixed-height
// pattern of phone-remote-qr-window.ts, whose hardcoded height leaves dead space
// whenever a shorter state renders.

let upgradeWindow: BrowserWindow | null = null
let currentReason: UpgradeReason = 'settings'

const W = 460
// Opening height only. The renderer measures its real content and calls
// CHANNELS.upgradeResize, so this never has to be right — just close enough to
// avoid a visible resize jump on first paint.
const INITIAL_H = 420
const MIN_H = 240
const MAX_H = 720

function centered(height: number): { x: number; y: number } {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const work = display.workArea
  return {
    x: Math.round(work.x + (work.width - W) / 2),
    y: Math.round(work.y + (work.height - height) / 2)
  }
}

/** The reason the window was last opened with — read by the renderer on mount. */
export function getUpgradeReason(): UpgradeReason {
  return currentReason
}

export function showUpgradeWindow(reason: UpgradeReason): void {
  currentReason = reason
  track(ANALYTICS_EVENT.upgrade_opened, { reason })

  if (upgradeWindow && !upgradeWindow.isDestroyed()) {
    // Re-opened from a different CTA: tell the live renderer which limit sent
    // the user this time, otherwise it would keep showing the first reason.
    upgradeWindow.webContents.send(CHANNELS.upgradeReason, reason)
    upgradeWindow.show()
    upgradeWindow.focus()
    return
  }

  upgradeWindow = new BrowserWindow({
    ...centered(INITIAL_H),
    width: W,
    height: INITIAL_H,
    title: `Upgrade ${CONFIG.APP_NAME}`,
    frame: true,
    ...chrome.windowOptions('inset'),
    resizable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    show: false,
    backgroundColor: CONFIG.THEME_TOKENS.windowBg,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    upgradeWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=upgrade`)
  } else {
    upgradeWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'upgrade' }
    })
  }

  // Esc closes, like every other dismissable panel. Handled here so it fires
  // even when focus sits inside a button.
  upgradeWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') {
      event.preventDefault()
      upgradeWindow?.close()
    }
  })

  upgradeWindow.on('ready-to-show', () => {
    upgradeWindow?.show()
    upgradeWindow?.focus()
  })

  upgradeWindow.on('closed', () => {
    upgradeWindow = null
  })
}

/** Focus an already-open upgrade window; used by the post-checkout deep link. */
export function focusUpgradeWindow(): boolean {
  if (!upgradeWindow || upgradeWindow.isDestroyed()) return false
  if (upgradeWindow.isMinimized()) upgradeWindow.restore()
  upgradeWindow.show()
  upgradeWindow.focus()
  return true
}

/**
 * Height comes from the renderer measuring its own content. Registered here
 * rather than in ipc/windows.ts because only this module owns the window and
 * the clamp that keeps a bad measurement from producing a 4px-tall frame.
 */
export function registerUpgradeResize(): void {
  ipcMain.on(CHANNELS.upgradeResize, (_, height: number) => {
    if (!upgradeWindow || upgradeWindow.isDestroyed()) return
    if (!Number.isFinite(height)) return
    const h = Math.round(Math.min(Math.max(height, MIN_H), MAX_H))
    const [, currentH] = upgradeWindow.getSize()
    // Sub-pixel ResizeObserver churn would otherwise re-center the window on
    // every animation frame.
    if (Math.abs(currentH - h) < 2) return
    const { x, y } = centered(h)
    upgradeWindow.setBounds({ x, y, width: W, height: h })
  })
}

import { BrowserWindow, screen } from 'electron'
import { chrome } from './platform'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { CONFIG } from '../shared/config'
import { getPanelWindow } from './panel-window'

// Standalone Phone Remote pairing QR window — the Panel-header shortcut to the
// same pairing surface Settings has always owned. Mirrors settings-window.ts's
// side-by-side placement + hide-not-destroy pattern; just a smaller frame.

let qrWindow: BrowserWindow | null = null

const QR_W = 420
const QR_H = 560
const SCREEN_MARGIN = 8
const SIDE_GAP = 16

function sideBySidePosition(): { x: number; y: number } | null {
  const panel = getPanelWindow()
  if (!panel || panel.isDestroyed() || !panel.isVisible()) return null

  const panelBounds = panel.getBounds()
  const display = screen.getDisplayNearestPoint({ x: panelBounds.x, y: panelBounds.y })
  const work = display.workArea

  const roomRight = work.x + work.width - (panelBounds.x + panelBounds.width) - SCREEN_MARGIN
  const roomLeft = panelBounds.x - work.x - SCREEN_MARGIN

  let x: number
  if (roomRight >= QR_W + SIDE_GAP) {
    x = panelBounds.x + panelBounds.width + SIDE_GAP
  } else if (roomLeft >= QR_W + SIDE_GAP) {
    x = panelBounds.x - QR_W - SIDE_GAP
  } else {
    x =
      roomRight >= roomLeft
        ? work.x + work.width - QR_W - SCREEN_MARGIN
        : work.x + SCREEN_MARGIN
  }

  const y = Math.min(
    Math.max(panelBounds.y, work.y + SCREEN_MARGIN),
    work.y + work.height - QR_H - SCREEN_MARGIN
  )

  return { x, y }
}

export function showPhoneRemoteQrWindow(): void {
  const pos = sideBySidePosition()

  if (qrWindow && !qrWindow.isDestroyed()) {
    if (pos) qrWindow.setPosition(pos.x, pos.y)
    qrWindow.show()
    qrWindow.focus()
    return
  }

  qrWindow = new BrowserWindow({
    ...(pos ?? {}),
    width: QR_W,
    height: QR_H,
    title: `${CONFIG.APP_NAME} - Phone Remote`,
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
    qrWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=phone-remote-qr`)
  } else {
    qrWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'phone-remote-qr' }
    })
  }

  // Esc closes it, like every other dismissable panel. Handled here rather than
  // in the renderer so it fires even when focus is inside the QR image or a
  // toggle, and needs no extra IPC channel.
  qrWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') {
      event.preventDefault()
      qrWindow?.close()
    }
  })

  qrWindow.on('ready-to-show', () => {
    qrWindow?.show()
    qrWindow?.focus()
  })

  qrWindow.on('closed', () => {
    qrWindow = null
  })
}

export function sendToPhoneRemoteQrRenderer(channel: string, ...args: unknown[]): void {
  if (qrWindow && !qrWindow.isDestroyed()) {
    qrWindow.webContents.send(channel, ...args)
  }
}

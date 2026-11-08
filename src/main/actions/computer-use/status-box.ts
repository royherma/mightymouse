import { BrowserWindow, screen } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { chrome } from '../../platform'
import { CONFIG } from '../../../shared/config'
import { CHANNELS } from '../../../shared/ipc'
import type { ComputerUseStatus } from '../../../shared/types'

const BOX_WIDTH = 320
const BOX_HEIGHT = 96
const BOX_ENDED_HEIGHT = 128
const BOX_MARGIN = 24

let boxWindow: BrowserWindow | null = null
let ready = false
let lastStatus: ComputerUseStatus | null = null
let lingerTimer: NodeJS.Timeout | null = null
let placed = false
let dismissed = false

function bottomRight(): { x: number; y: number } {
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  return {
    x: area.x + area.width - BOX_WIDTH - BOX_MARGIN,
    y: area.y + area.height - BOX_HEIGHT - BOX_MARGIN
  }
}

function buildWindow(): BrowserWindow {
  const win = new BrowserWindow({
    ...bottomRight(),
    width: BOX_WIDTH,
    height: BOX_HEIGHT,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    resizable: false,
    movable: true,
    focusable: false,
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  win.setAlwaysOnTop(true, 'screen-saver')
  chrome.showOnAllWorkspaces(win)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=computer-use-status`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'computer-use-status' }
    })
  }

  win.webContents.once('did-finish-load', () => {
    ready = true
    push()
  })
  win.on('closed', () => {
    boxWindow = null
    ready = false
  })

  return win
}

function push(): void {
  if (!boxWindow || boxWindow.isDestroyed() || !ready || !lastStatus) return
  if (!placed) {
    const at = bottomRight()
    boxWindow.setPosition(at.x, at.y)
    placed = true
  }
  const height = lastStatus.state === 'ended' ? BOX_ENDED_HEIGHT : BOX_HEIGHT
  const at = boxWindow.getBounds()
  if (at.height !== height) {
    boxWindow.setBounds({ x: at.x, y: at.y + at.height - height, width: BOX_WIDTH, height })
  }
  if (!boxWindow.isVisible()) boxWindow.showInactive()
  boxWindow.webContents.send(CHANNELS.computerUseStatus, lastStatus)
}

export function showStatusBox(status: ComputerUseStatus): void {
  if (dismissed) {
    dismissed = status.state !== 'ended'
    return
  }
  lastStatus = status
  if (lingerTimer) {
    clearTimeout(lingerTimer)
    lingerTimer = null
  }
  if (status.state === 'ended') {
    lingerTimer = setTimeout(hideStatusBox, CONFIG.COMPUTER_USE.STATUS_BOX_LINGER_MS)
  }
  if (!boxWindow || boxWindow.isDestroyed()) boxWindow = buildWindow()
  push()
}

export function markRunOutcome(ok: boolean): void {
  if (!lastStatus || lastStatus.state !== 'ended') return
  lastStatus = { ...lastStatus, canRetry: !ok }
  push()
}

export function hideStatusBox(): void {
  if (lingerTimer) {
    clearTimeout(lingerTimer)
    lingerTimer = null
  }
  dismissed = lastStatus !== null && lastStatus.state !== 'ended'
  lastStatus = null
  placed = false
  if (boxWindow && !boxWindow.isDestroyed()) boxWindow.hide()
}

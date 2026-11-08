import { BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { chrome } from '../../platform'
import { CONFIG } from '../../../shared/config'
import { glideMs } from '../../../shared/agent-cursor-motion'
import { CHANNELS } from '../../../shared/ipc'
import type { AgentCursorAction, AgentCursorTarget } from '../../../shared/types'

// Full-screen, transparent, click-through overlay showing a SECOND, drawn cursor
// that glides to the control the computer-use loop (loop.ts) is about to act on
// — so a user watching the run can see it's the agent moving, not their own
// pointer. Picture only: never moves the real cursor, never takes focus, never
// blocks clicks. Same buildWindow/multi-display pattern as highlight-window.ts.

let agentCursorWindow: BrowserWindow | null = null
let currentDisplayId: number | null = null
let idleHide: NodeJS.Timeout | null = null
let lastPoint: { x: number; y: number } | null = null
let drawnAt: { x: number; y: number } | null = null
let controls: AgentCursorControls | null = null
let wired = false

export interface AgentCursorControls {
  pause: (next: boolean) => void
  stop: () => void
}

export function driveAgentCursor(next: AgentCursorControls | null): void {
  controls = next
}

function wireControls(): void {
  if (wired) return
  wired = true
  ipcMain.on(CHANNELS.agentCursorHover, (_e, on: boolean) => {
    agentCursorWindow?.setIgnoreMouseEvents(!on, { forward: true })
  })
  ipcMain.on(CHANNELS.agentCursorControl, (_e, action: AgentCursorAction) => {
    if (action === 'stop') controls?.stop()
    else controls?.pause(action === 'pause')
  })
}

function buildWindow(): BrowserWindow {
  const display = screen.getPrimaryDisplay()
  currentDisplayId = display.id
  const b = display.bounds

  const win = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    resizable: false,
    focusable: false,
    hasShadow: false,
    enableLargerThanScreen: true,
    acceptFirstMouse: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  wireControls()
  win.setIgnoreMouseEvents(true, { forward: true })
  win.setAlwaysOnTop(true, 'screen-saver')
  chrome.showOnAllWorkspaces(win)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=agent-cursor`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'agent-cursor' }
    })
  }

  win.on('closed', () => {
    agentCursorWindow = null
  })

  return win
}

function ensureWindow(onReady: () => void): void {
  if (agentCursorWindow && !agentCursorWindow.isDestroyed()) {
    onReady()
    return
  }
  agentCursorWindow = buildWindow()
  agentCursorWindow.once('ready-to-show', () => {
    if (agentCursorWindow && !agentCursorWindow.isDestroyed()) {
      agentCursorWindow.showInactive()
      onReady()
    }
  })
}

/** Glide the drawn agent cursor to an absolute SCREEN point and play the
 *  kind-specific cue. Ensures the overlay exists, moves it to cover the
 *  target's display, converts to window-local coords (same space as
 *  cursorFlyTo/actHighlight), and pushes the target over CHANNELS.agentCursorShow. */
export function showAgentCursor(target: AgentCursorTarget): number {
  if (idleHide) clearTimeout(idleHide)
  idleHide = null
  const ms = glideMs(drawnAt, target)
  lastPoint = { x: target.x, y: target.y }
  drawnAt = lastPoint
  const send = (): void => {
    if (!agentCursorWindow || agentCursorWindow.isDestroyed()) return

    const display = screen.getDisplayNearestPoint({ x: target.x, y: target.y })
    if (display.id !== currentDisplayId) {
      currentDisplayId = display.id
      const b = display.bounds
      agentCursorWindow.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height })
    }

    const origin = agentCursorWindow.getBounds()
    agentCursorWindow.webContents.send(CHANNELS.agentCursorShow, {
      ...target,
      controls: controls !== null,
      x: target.x - origin.x,
      y: target.y - origin.y
    })
  }
  ensureWindow(send)
  return ms
}

export function flashAgentCursor(target: AgentCursorTarget): number {
  const ms = showAgentCursor(target)
  idleHide = setTimeout(hideAgentCursor, CONFIG.AGENT_CURSOR.IDLE_HIDE_MS)
  return ms
}

export function pauseAgentCursor(paused: boolean): void {
  if (!drawnAt) return
  const target = { ...drawnAt, kind: 'look' as const, paused, label: paused ? 'Paused - your turn' : 'Back to it' }
  if (paused) showAgentCursor(target)
  else flashAgentCursor(target)
}

export function holdAgentCursor(fallback: { x: number; y: number }, label: string): void {
  flashAgentCursor({ ...(lastPoint ?? fallback), kind: 'look', label })
}

/** Fade the agent cursor out at run end. Keeps the window alive for reuse. */
export function hideAgentCursor(): void {
  if (idleHide) clearTimeout(idleHide)
  idleHide = null
  lastPoint = null
  controls = null
  if (agentCursorWindow && !agentCursorWindow.isDestroyed()) {
    agentCursorWindow.setIgnoreMouseEvents(true, { forward: true })
    agentCursorWindow.webContents.send(CHANNELS.agentCursorHide)
  }
}

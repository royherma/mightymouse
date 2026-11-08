import { BrowserWindow, ipcMain, screen } from 'electron'
import { chrome } from './platform'
import { join } from 'path'
import { appendFileSync } from 'fs'
import { homedir } from 'os'
import { is } from '@electron-toolkit/utils'
import { IS_DEV } from '../shared/env'
import { CONFIG } from '../shared/config'
import { CHANNELS } from '../shared/ipc'
import { PREFS } from './store/prefs'
import { CursorStyleId } from '../shared/cursor-styles'
import type { CursorState, SuggestState } from '../shared/types'
import {
  handleCursorSample,
  setSuggestionSender,
  setCancelArmSender,
  replayBubbleState
} from './insights/insights-manager'
import { yieldIfLastRestorable } from './panel-window'

// Full-screen, transparent, click-through overlay that draws a blue companion
// triangle trailing the OS cursor (port of the Swift Triangle + glow follower).
//
// The window covers the whole display and ignores all mouse events, so it never
// blocks clicks. We poll the global cursor position at ~60fps and forward it to
// the renderer, which draws the triangle at (cursor - windowOrigin + offset).

let cursorWindow: BrowserWindow | null = null
let pollTimer: NodeJS.Timeout | null = null
let currentDisplayId: number | null = null
// Last screen point we forwarded to the renderer, and the cached overlay origin.
// The poll loop runs at 60fps but the cursor is still most of the time — gating
// the native lookups + cross-process IPC on actual movement turns the idle path
// into a single getCursorScreenPoint() + idle check, killing the background churn
// that stuttered typing/scrolling. Both reset on stop / display change to re-sync.
let lastSent: { x: number; y: number } | null = null
let cachedOrigin: { x: number; y: number } | null = null

const POLL_MS = 16 // ~60fps

// Registered at module load, before any overlay exists, so the renderer's mount
// call can never arrive before the handler. This is the authoritative read of the
// overlay's startup state — the pushes elsewhere in this file only carry LATER
// changes, and a push that lands before the renderer subscribed is dropped by
// Electron with no error. Pulling here is what makes the art deterministic.
ipcMain.handle(
  CHANNELS.cursorGetState,
  (): CursorState => ({
    style: PREFS.getCursorStyle(),
    pointerEnabled: PREFS.getCursorCompanion()
  })
)

function broadcastCursorSuggestions(state: SuggestState): void {
  if (!cursorWindow || cursorWindow.isDestroyed()) return
  // Seed a fresh cursor position alongside the suggestion so the bubble has real
  // coords even if the cursor hasn't moved since the overlay opened (the poll
  // loop is movement-gated, so a dead-still cursor never sends a frame on its
  // own — which left the loading bubble pinned offscreen at the -100,-100 init).
  const pt = screen.getCursorScreenPoint()
  const b = cursorWindow.getBounds()
  cursorWindow.webContents.send(CHANNELS.cursorPos, { x: pt.x - b.x, y: pt.y - b.y })
  cursorWindow.webContents.send(CHANNELS.cursorSuggest, state)
}

// Reveal the bubble's "⏎ to cancel" hint (bare Esc on a live bubble armed it).
function broadcastCancelArm(): void {
  if (cursorWindow && !cursorWindow.isDestroyed()) {
    cursorWindow.webContents.send(CHANNELS.cursorCancelArm)
  }
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
    ...chrome.windowOptions('panel'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  // Never intercept clicks: the companion is purely decorative.
  // NOTE: forward:true was tried to make the at-rest overlay deliver mousemove to
  // its DOM (so the bubble's onMouseEnter could arm clickability under a stationary
  // cursor) — it delivered ZERO events on macOS, so that path is dead. Overlay
  // hover-delivery is being solved separately; the interaction DESIGN is iterated
  // in the Playground's "Suggestion Lab" (a normal window where hover works).
  win.setIgnoreMouseEvents(true, { forward: false })
  win.setAlwaysOnTop(true, 'screen-saver')
  // Show on every Space / over fullscreen apps, like the Swift overlay.
  chrome.showOnAllWorkspaces(win)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=cursor`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'cursor' }
    })
  }

  win.on('closed', () => {
    cursorWindow = null
  })

  return win
}

function startPolling(): void {
  if (pollTimer) return
  pollTimer = setInterval(() => {
    if (!cursorWindow || cursorWindow.isDestroyed()) return

    const pt = screen.getCursorScreenPoint()

    // handleCursorSample owns the idle timer (fires a suggestion after IDLE_MS of
    // stillness), so it MUST run every tick — moved or not. Only the native lookups
    // + IPC below are movement-gated.
    handleCursorSample(pt)

    // Cursor parked since last forward → nothing to redraw, skip display lookup,
    // getBounds() and the cross-process send. This is the hot idle path.
    if (lastSent && pt.x === lastSent.x && pt.y === lastSent.y) return

    const display = screen.getDisplayNearestPoint(pt)

    // If the cursor moved to another monitor, move the overlay to cover it and
    // refresh the cached origin from the new bounds.
    if (display.id !== currentDisplayId) {
      currentDisplayId = display.id
      const b = display.bounds
      cursorWindow.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height })
      cachedOrigin = null
    }

    if (!cachedOrigin) {
      const b = cursorWindow.getBounds()
      cachedOrigin = { x: b.x, y: b.y }
    }

    // Send cursor position relative to the window origin (renderer-local coords).
    cursorWindow.webContents.send(CHANNELS.cursorPos, {
      x: pt.x - cachedOrigin.x,
      y: pt.y - cachedOrigin.y
    })
    lastSent = { x: pt.x, y: pt.y }
  }, POLL_MS)
}

function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  // Drop the movement cache so the next start forwards a fresh frame immediately.
  lastSent = null
  cachedOrigin = null
}

export function startCursorCompanion(): void {
  if (cursorWindow && !cursorWindow.isDestroyed()) return
  cursorWindow = buildWindow()
  // Register the senders NOW (synchronously), before the caller fires the first
  // suggestion. The window/renderer load async, so a 'loading' broadcast lands
  // before ready-to-show — we capture it in lastBroadcast and replay it once the
  // renderer is up (did-finish-load), so the bubble appears immediately.
  setSuggestionSender(broadcastCursorSuggestions)
  setCancelArmSender(broadcastCancelArm)
  cursorWindow.webContents.on('did-finish-load', () => {
    replayBubbleState()
  })
  // Dev-only: forward the overlay renderer's console to a file so the suggestion/
  // preview lifecycle is monitorable without DevTools open. Renderer console
  // doesn't reach the dev-server stdout, so a `[cursor]`-tagged log is otherwise
  // invisible. Tail ~/MightyMouse/cursor-renderer.log while testing.
  if (IS_DEV) {
    cursorWindow.webContents.on('console-message', (_e, _level, message) => {
      if (!message.startsWith('[cursor]')) return
      try {
        appendFileSync(
          join(homedir(), CONFIG.APP_NAME, 'cursor-renderer.log'),
          `${new Date().toISOString()} ${message}\n`
        )
      } catch {
        // best-effort dev logging — never break the window over a failed append
      }
    })
  }
  cursorWindow.on('ready-to-show', () => {
    if (cursorWindow && !cursorWindow.isDestroyed()) {
      cursorWindow.showInactive()
      // Style + pointer-on are NOT pushed here: ready-to-show can beat the
      // renderer's effect subscriptions, and a send with no listener is dropped
      // silently — that race left the pointer invisible until a restart. The
      // overlay pulls both via CHANNELS.cursorGetState once it's listening.
      startPolling()
      // Re-sync once more after show in case the suggestion arrived between load
      // and show (covers both orderings of the async window bring-up).
      replayBubbleState()
    }
  })
}

// Push a new style to the live overlay so it swaps without restarting the window.
export function broadcastCursorStyle(style: CursorStyleId): void {
  if (cursorWindow && !cursorWindow.isDestroyed()) {
    cursorWindow.webContents.send(CHANNELS.cursorStyle, style)
  }
}

// "Point at" — tell the overlay glyph to glide to an absolute SCREEN point and
// pulse. Ensures the overlay window + pointer art are up first (the user may have
// the companion off), moves the window to cover the target's display, then sends
// the point in window-local coords (same space as cursorPos). The renderer eases
// the glyph there, pulses, then releases back to following the cursor.
export function flyCursorTo(screenX: number, screenY: number): void {
  // Bring the overlay up and turn the pointer art on for the duration — without
  // it the glide would be invisible. Idempotent if already running.
  startCursorCompanion()
  broadcastCursorPointerEnabled(true)
  if (!cursorWindow || cursorWindow.isDestroyed()) return

  // Cover the display the target sits on, then translate to window-local coords.
  const display = screen.getDisplayNearestPoint({ x: screenX, y: screenY })
  if (display.id !== currentDisplayId) {
    currentDisplayId = display.id
    const b = display.bounds
    cursorWindow.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height })
    cachedOrigin = null
  }
  if (!cachedOrigin) {
    const b = cursorWindow.getBounds()
    cachedOrigin = { x: b.x, y: b.y }
  }
  cursorWindow.webContents.send(CHANNELS.cursorFlyTo, {
    x: screenX - cachedOrigin.x,
    y: screenY - cachedOrigin.y
  })
}

// Make the overlay clickable (or back to fully click-through). The suggestion
// bubble flips this ON while it's up so its ✕ button registers clicks; with
// `forward: true` the rest of the screen still passes clicks through to the app
// underneath, so only the bubble itself is interactive.
export function setCursorClickable(clickable: boolean): void {
  if (cursorWindow && !cursorWindow.isDestroyed()) {
    cursorWindow.setIgnoreMouseEvents(!clickable, { forward: true })
  }
}

// Let the overlay take keyboard focus while an editable surface (the suggestion
// preview) is open, then give it back. The window is built focusable:false so it
// never steals focus during normal use — but a textarea can't receive keystrokes
// without it, so we flip it on for the duration of editing. focus()/blur() actually
// moves the OS keyboard focus; setFocusable alone only changes eligibility.
export function setCursorFocusable(focusable: boolean): void {
  if (!cursorWindow || cursorWindow.isDestroyed()) return
  cursorWindow.setFocusable(focusable)
  if (focusable) cursorWindow.focus()
  else cursorWindow.blur()
}

// Toggle the pointer art on the live overlay (companion on/off) without tearing
// the window down — insights may still need the window for the bubble.
export function broadcastCursorPointerEnabled(enabled: boolean): void {
  if (cursorWindow && !cursorWindow.isDestroyed()) {
    cursorWindow.webContents.send(CHANNELS.cursorPointerEnabled, enabled)
  }
}

export function stopCursorCompanion(): void {
  stopPolling()
  setSuggestionSender(null)
  setCancelArmSender(null)
  if (cursorWindow && !cursorWindow.isDestroyed()) {
    // setCursorFocusable(true) flips this focusable (and focus()es it) while the
    // suggestion textarea is open; teardown here is an INDEPENDENT trigger (the
    // settings toggle), so it can land while the window is still key. Closing a key
    // window hands activation back to the app → did-become-active → surfaceApp()
    // pops the panel. Drop focusability, then yield so the echo is swallowed.
    cursorWindow.setFocusable(false)
    const dying = cursorWindow
    dying.close()
    yieldIfLastRestorable(dying)
  }
  cursorWindow = null
  currentDisplayId = null
}

export function isCursorCompanionRunning(): boolean {
  return cursorWindow !== null && !cursorWindow.isDestroyed()
}

export function setCursorCompanion(on: boolean): void {
  if (on) {
    // Window may already be up for the suggestion bubble — starting is a no-op
    // then, so just make sure the pointer art turns on.
    startCursorCompanion()
    broadcastCursorPointerEnabled(true)
    return
  }
  // Companion off: keep the overlay alive if insights still needs it for the
  // bubble, just hide the pointer art. Only tear the window down when nothing
  // else uses it.
  if (PREFS.getExperimentalSuggestions()) {
    broadcastCursorPointerEnabled(false)
  } else {
    stopCursorCompanion()
  }
}

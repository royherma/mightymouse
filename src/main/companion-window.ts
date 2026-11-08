import { app, BrowserWindow, globalShortcut, screen } from 'electron'
import { chrome } from './platform'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { CONFIG } from '../shared/config'
import { PREFS } from './store/prefs'
import { CHANNELS } from '../shared/ipc'
import { IS_DEV } from '../shared/env'
import { COMPANION_SIZE_FULL, COMPANION_SIZE_DEBUG, COMPANION_SIZE_MINI } from '../shared/companion-size'
import { COMPANION_RENDERER_STAGE } from '../shared/companion-renderers'
import type { CompanionStageEvent } from '../shared/companion-debug'
import type { LiveTurnResult } from '../shared/companion-state'
import { HIDEOUT_FULL, isHideoutFull, type HideoutPlace } from '../shared/hideout'

// Live Voice Companion overlay (?window=companion) — Phase 0 of the design
// A single
// small, always-on-top window pinned to the bottom-right corner that hosts
// the mouse character. The renderer drives the idle→listening→thinking→
// talking→reacting cycle — this module ONLY manages the window's lifecycle
// (create/show/destroy/move), mirroring island-window.ts / cursor-window.ts.
//
// Phase 3 (three.js character, drag-to-reposition): the window is NOT
// click-through — `setIgnoreMouseEvents` is left at its default (false) so
// pointer events reach the r3f canvas for a real click-drag. It stays
// `focusable: false` so dragging the character never steals keyboard focus
// from whatever app the user was typing into. MouseCharacter.tsx reports the
// live pointer delta while a drag is in progress over `companionDragMove`;
// `moveCompanionWindow` below applies it to the real BrowserWindow bounds.

let companionWindow: BrowserWindow | null = null
let hideoutOpen = false
let hideoutPlace: HideoutPlace = HIDEOUT_FULL
let hideoutDisplay: Electron.Rectangle | null = null

function hideoutBounds(): Electron.Rectangle {
  const a = hideoutDisplay ?? screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  const width = Math.min(a.width, Math.max(CONFIG.COMPANION.HIDEOUT_MIN_W, Math.round(a.width * hideoutPlace.w)))
  const height = Math.min(a.height, Math.max(CONFIG.COMPANION.HIDEOUT_MIN_H, Math.round(a.height * hideoutPlace.h)))
  return {
    x: a.x + Math.min(a.width - width, Math.round(a.width * hideoutPlace.x)),
    y: a.y + Math.min(a.height - height, Math.round(a.height * hideoutPlace.y)),
    width,
    height
  }
}

function companionBounds(): { x: number; y: number; width: number; height: number } {
  if (hideoutOpen) return hideoutBounds()
  const b = screen.getPrimaryDisplay().workArea

  // Full takes the whole work area — workArea (not bounds) keeps it clear of the
  // menu bar and Dock, since covering those looks like a crash. Minimized is the
  // bottom-right corner puck.
  //
  // Keyed off SIZE, not the renderer: geometry used to follow the renderer pick
  // ('stage' meant full-screen), which made getting the overlay off your whole
  // screen require understanding a dev concept. See companion-size.ts.
  if (PREFS.getCompanionSize() === COMPANION_SIZE_FULL) return { ...b }

  // Debug grows LEFT only, so the capsule never moves when the panel opens.
  const { PILL_H, PAD, CAPTION_MAX_H, CAPTION_W, DEBUG_PANEL_W, MARGIN } = CONFIG.COMPANION
  const extra = PREFS.getCompanionSize() === COMPANION_SIZE_DEBUG ? DEBUG_PANEL_W : 0
  const width = PAD * 2 + CAPTION_W + extra
  const height = PAD * 2 + CAPTION_MAX_H + PILL_H
  return {
    x: b.x + b.width - width - (MARGIN - PAD),
    y: b.y + b.height - height - (MARGIN - PAD),
    width,
    height
  }
}

// The renderer asks for clicks back while the pointer is over the puck (setCompanionInteractive).
function isClickThrough(): boolean {
  if (hideoutOpen) return false
  const size = PREFS.getCompanionSize()
  if (size === COMPANION_SIZE_MINI) return true
  return PREFS.getCompanionRenderer() === COMPANION_RENDERER_STAGE && size === COMPANION_SIZE_FULL
}

/**
 * Re-apply bounds + click-through after the SIZE or RENDERER changes.
 *
 * `forward: true` still delivers move events to the renderer, which is what lets
 * StageView know the pointer is over its own column and ask for clicks back
 * (setCompanionInteractive) — without it the input bar would be untypable.
 */
export function applyCompanionRenderer(): void {
  if (!companionWindow || companionWindow.isDestroyed()) return
  companionWindow.setBounds(companionBounds())
  companionWindow.setIgnoreMouseEvents(isClickThrough(), { forward: true })
}

/**
 * Let the Stage renderer take pointer events back while the cursor is over
 * something interactive (the input bar). No-op unless Stage is the active
 * renderer — every other renderer is a solid window that never gave its clicks
 * away in the first place.
 */
export function setCompanionInteractive(interactive: boolean): void {
  if (!companionWindow || companionWindow.isDestroyed()) return
  if (!isClickThrough()) return
  companionWindow.setIgnoreMouseEvents(!interactive, { forward: true })
}

function buildWindow(): BrowserWindow {
  const win = new BrowserWindow({
    ...companionBounds(),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    resizable: false,
    focusable: false,
    acceptFirstMouse: true,
    hasShadow: false,
    enableLargerThanScreen: true,
    ...chrome.windowOptions('panel'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  // Phase 3: the character is click-draggable, so this window is NOT
  // click-through (unlike Phase 0). `focusable: false` above already keeps it
  // from stealing keyboard focus on click.
  win.setAlwaysOnTop(true, 'screen-saver')
  chrome.showOnAllWorkspaces(win)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=companion`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'companion' }
    })
  }

  win.on('closed', () => {
    companionWindow = null
  })

  // Dev-only: renderer console doesn't reach the electron-vite dev-server
  // stdout, so VAD/model-load errors were invisible without opening DevTools
  // by hand. Forward everything to the same log `make dev`/`make restart`
  // already tails — remove once the debug panel + stage events cover this.
  if (IS_DEV) {
    win.webContents.on('console-message', (_e, _level, message) => {
      // eslint-disable-next-line no-console -- intentional dev-only forward
      console.log(`[companion-renderer] ${message}`)
    })
  }

  return win
}

export function startCompanionWindow(): void {
  if (companionWindow && !companionWindow.isDestroyed()) return
  companionWindow = buildWindow()
  companionWindow.on('ready-to-show', () => {
    companionWindow?.showInactive()
  })
  // Stage is full-screen: without this it would eat every click meant for the
  // apps underneath — including the ones the agent itself is making.
  applyCompanionRenderer()

  // A resolution change or a display unplug leaves a full-screen Stage sized to
  // a screen that no longer exists, which reads as the overlay having vanished.
  screen.on('display-metrics-changed', applyCompanionRenderer)
  screen.on('display-removed', applyCompanionRenderer)
}

export function stopCompanionWindow(): void {
  screen.removeListener('display-metrics-changed', applyCompanionRenderer)
  screen.removeListener('display-removed', applyCompanionRenderer)
  if (companionWindow && !companionWindow.isDestroyed()) {
    companionWindow.close()
  }
  companionWindow = null
}

export function placeCompanionHideout(place: HideoutPlace): void {
  hideoutPlace = place
  const win = companionWindow
  if (!hideoutOpen || !win || win.isDestroyed()) return
  hideoutDisplay ??= screen.getDisplayMatching(win.getBounds()).workArea
  win.setAlwaysOnTop(!isHideoutFull(place), 'floating')
  win.setBounds(hideoutBounds(), true)
}

export function setCompanionHideout(open: boolean): void {
  hideoutOpen = open
  hideoutDisplay = null
  if (open) startCompanionWindow()
  const win = companionWindow
  if (!win || win.isDestroyed()) return
  applyCompanionRenderer()
  win.setFocusable(open)
  if (open) {
    win.setAlwaysOnTop(!isHideoutFull(hideoutPlace), 'floating')
    win.setVisibleOnAllWorkspaces(false, { skipTransformProcessType: true })
    app.focus({ steal: true })
    win.show()
    win.moveTop()
    win.focus()
  } else if (!PREFS.getLiveMode()) {
    stopCompanionWindow()
  } else {
    win.setAlwaysOnTop(true, 'screen-saver')
    chrome.showOnAllWorkspaces(win)
  }
}

export function sendToCompanion(channel: string, payload: unknown): void {
  if (companionWindow && !companionWindow.isDestroyed()) companionWindow.webContents.send(channel, payload)
}

let micPaused = false

export function setCompanionMicPaused(paused: boolean): void {
  if (paused === micPaused) return
  micPaused = paused
  sendToCompanion(CHANNELS.companionMicPaused, paused)
}

export const isCompanionMicPaused = (): boolean => micPaused

export function isCompanionWindowRunning(): boolean {
  return companionWindow !== null && !companionWindow.isDestroyed()
}

/** Toggle wrapper, mirroring setIslandWindow — drives the PREFS live effect. */
export function setCompanionWindow(on: boolean): void {
  if (on) startCompanionWindow()
  else stopCompanionWindow()
}

/**
 * Push one debug/verify stage-event to the companion renderer (Phase 0.5 of the
 * design — see src/shared/companion-debug.ts). Real Phase 1-4 adapters running in
 * main will call this directly on every stage transition; today it's only used
 * to re-broadcast Phase 0's mock-timer sample events sent up from the renderer
 * (see registerWindowHandlers in ipc/windows.ts). No-ops if the window isn't up.
 */
export function sendCompanionStageEvent(event: CompanionStageEvent): void {
  if (companionWindow && !companionWindow.isDestroyed()) {
    companionWindow.webContents.send(CHANNELS.companionStageEvent, event)
  }
}

/**
 * Push one finished Phase 1 voice turn (transcript + mocked reply, or an
 * error) to the companion renderer — see src/shared/companion-state.ts
 * `LiveTurnResult` and live-listen.ts. No-ops if the window isn't up (e.g. the
 * user turned Live mode off mid-transcribe).
 */
export function sendLiveTurnResult(result: LiveTurnResult): void {
  if (companionWindow && !companionWindow.isDestroyed()) {
    companionWindow.webContents.send(CHANNELS.liveTurnResult, result)
  }
}

/**
 * Phase 3 drag-to-reposition: shift the companion window by (dx, dy) screen
 * pixels, clamped to the active display's work area so a fast drag can't fling
 * the window fully off-screen (unrecoverable without a reset). No-ops if the
 * window isn't up. See MouseCharacter.tsx for the pointer-drag side.
 */
export function moveCompanionWindow(dx: number, dy: number): void {
  if (!companionWindow || companionWindow.isDestroyed()) return
  const bounds = companionWindow.getBounds()
  const work = screen.getDisplayMatching(bounds).workArea
  const nextX = Math.max(work.x, Math.min(work.x + work.width - bounds.width, bounds.x + dx))
  const nextY = Math.max(work.y, Math.min(work.y + work.height - bounds.height, bounds.y + dy))
  companionWindow.setBounds({ ...bounds, x: nextX, y: nextY })
}

let actingGlow: BrowserWindow | null = null
// Global only while a voice run is in flight; an agent-pressed Escape stops its own run too.
const STOP_KEY = 'Escape'

function actingGlowHtml(): string {
  const color = CONFIG.THEME_TOKENS.orange
  return `<html><body style="margin:0;background:transparent;overflow:hidden">
<div style="position:fixed;inset:0;border-radius:12px;box-shadow:inset 0 0 0 3px ${color},inset 0 0 48px 6px ${color}88;animation:b 2s ease-in-out infinite"></div>
<style>@keyframes b{0%,100%{opacity:.65}50%{opacity:1}}</style></body></html>`
}

function showActingGlow(): void {
  if (actingGlow && !actingGlow.isDestroyed()) return
  const b = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).bounds
  const win = new BrowserWindow({
    ...b,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    resizable: false,
    focusable: false,
    hasShadow: false,
    enableLargerThanScreen: true
  })
  win.setIgnoreMouseEvents(true, { forward: false })
  win.setAlwaysOnTop(true, 'screen-saver')
  chrome.showOnAllWorkspaces(win)
  win.loadURL(`data:text/html,${encodeURIComponent(actingGlowHtml())}`)
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.showInactive()
  })
  win.on('closed', () => {
    if (actingGlow === win) actingGlow = null
  })
  actingGlow = win
}

function hideActingGlow(): void {
  if (actingGlow && !actingGlow.isDestroyed()) actingGlow.close()
  actingGlow = null
}

export function setCompanionRunActive(active: boolean, drivesScreen: boolean, onStop: () => void): void {
  if (!active) {
    if (globalShortcut.isRegistered(STOP_KEY)) globalShortcut.unregister(STOP_KEY)
    hideActingGlow()
    return
  }
  if (!globalShortcut.isRegistered(STOP_KEY)) globalShortcut.register(STOP_KEY, onStop)
  if (drivesScreen) showActingGlow()
}

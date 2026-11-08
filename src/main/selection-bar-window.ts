import { BrowserWindow, screen } from 'electron'
import { chrome } from './platform'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { CONFIG } from '../shared/config'
import { CHANNELS } from '../shared/ipc'
import { PREFS } from './store/prefs'
import { FAST_SUBMODEL, MIGHTYMOUSE_BACKEND, runLabel } from '../shared/model-label'
import { buildCtxIdentity, buildCtxLabel } from './ipc/panel-state'
import type { ContextData, SelectionBarAction, SelectionBarResultPayload } from '../shared/types'

// focusable:false is load-bearing: taking focus would blur the app the user
// selected in, and macOS drops the selection on blur, so by the time an action
// ran there'd be nothing left to rewrite. A non-focusable window still gets clicks.

let barWindow: BrowserWindow | null = null
let autoHideTimer: NodeJS.Timeout | null = null

// Three independent holds: hover used to share one flag with an in-flight run,
// so leaving the bar mid-rewrite let the paste's Cmd+V hide it.
const hold = { hover: false, run: false, edit: false }

let barSelection = ''
// Snapshot at show time — a chip click fronts the bar, so live recapture would be us.
let barCtx: ContextData = {}

// A hold only means something while the bar is UP. Gated on visibility because
// every path that clears a hold (mousedown, keydown, wheel, mouseup) is itself
// gated on !isSelectionBarBusy() — so a hold surviving the bar going away is a
// latch the watcher can never open, and the bar never shows again until restart.
export function isSelectionBarBusy(): boolean {
  if (!isSelectionBarVisible()) {
    clearHolds()
    return false
  }
  return hold.hover || hold.run || hold.edit
}

export function setSelectionBarHold(reason: keyof typeof hold, on: boolean): void {
  hold[reason] = on
  if (on) clearAutoHide()
}

/** The text the bar was raised over. Empty once the bar has been hidden. */
export function getSelectionBarText(): string {
  return barSelection
}

/** The app that text lives in, for pasting the rewrite back into it. */
export function getSelectionBarApp(): string {
  return barCtx.frontApp ?? ''
}

/** Show-time context (no screenshot). Empty fields if capture failed. */
export function getSelectionBarCtx(): ContextData {
  return barCtx
}

/** Report an inline run's progress to the bar. No-op if it is already gone. */
export function sendSelectionBarResult(p: SelectionBarResultPayload): void {
  if (!barWindow || barWindow.isDestroyed()) return
  barWindow.webContents.send(CHANNELS.selectionBarResult, p)
}

function clearHolds(): void {
  hold.hover = false
  hold.run = false
  hold.edit = false
}

function clearAutoHide(): void {
  if (autoHideTimer) {
    clearTimeout(autoHideTimer)
    autoHideTimer = null
  }
}

/** Window size for an inner content height. PAD is shadow/corner slack. The
 *  result preview is wider than the pill, so the window widens with it. */
function windowSize(innerH: number, innerW?: number): { width: number; height: number } {
  const { WIDTH, MIN_WIDTH, MAX_WIDTH, PAD, PREVIEW_HEIGHT } = CONFIG.SELECTION_BAR
  // The preview owns the width outright; it is a different surface, not a wider
  // pill. Otherwise the renderer's measured content width wins, clamped.
  const measured = innerW ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(innerW))) : WIDTH
  const inner = innerH >= PREVIEW_HEIGHT ? CONFIG.SUGGESTIONS.PREVIEW_MAX_WIDTH : measured
  return { width: inner + PAD * 2, height: innerH + PAD * 2 }
}

function buildWindow(): BrowserWindow {
  const { width, height } = windowSize(CONFIG.SELECTION_BAR.HEIGHT)
  const win = new BrowserWindow({
    width,
    height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    resizable: false,
    movable: false,
    focusable: false,
    hasShadow: false,
    acceptFirstMouse: true,
    ...chrome.windowOptions('panel'),
    roundedCorners: false, // hidden titlebar (~28px) would eat the 38px pill
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  win.setAlwaysOnTop(true, 'screen-saver')
  chrome.showOnAllWorkspaces(win)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=selection-bar`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'selection-bar' }
    })
  }

  win.on('closed', () => {
    barWindow = null
  })

  return win
}

function ensureWindow(onReady: () => void): void {
  if (barWindow && !barWindow.isDestroyed()) {
    onReady()
    return
  }
  barWindow = buildWindow()
  barWindow.once('ready-to-show', onReady)
}

/** Show the bar anchored above an absolute SCREEN point (the mouse-up position),
 *  clamped into the display's work area. */
export function showSelectionBar(
  screenX: number,
  screenY: number,
  actions: SelectionBarAction[],
  chars: number,
  text: string,
  ctx: ContextData
): void {
  // The text as captured at show time. Re-reading it at click time would come
  // back empty: the click lands in the bar's window, not the user's document.
  // Only a run on a bar that is still UP owns the window; a run flag left over
  // from a bar that already went away must not veto the next selection.
  if (hold.run && isSelectionBarVisible()) return
  clearHolds()
  barSelection = text
  barCtx = ctx
  const place = (): void => {
    if (!barWindow || barWindow.isDestroyed()) return

    const { HEIGHT: h, OFFSET_Y, PAD } = CONFIG.SELECTION_BAR
    const { width: winW, height: winH } = windowSize(h)
    const work = screen.getDisplayNearestPoint({ x: screenX, y: screenY }).workArea

    const x = Math.min(Math.max(screenX - winW / 2, work.x), work.x + work.width - winW)
    // PAD is transparent; OFFSET_Y is measured to the pill, not the window.
    let y = screenY - OFFSET_Y - PAD
    if (y < work.y) y = screenY + OFFSET_Y - h - PAD

    // Reset the base height: an open gear menu may have grown the reused window.
    barWindow.setBounds({ x: Math.floor(x), y: Math.floor(y), width: winW, height: winH })
    const { ctxApp, ctxURL } = buildCtxIdentity(ctx)
    barWindow.webContents.send(CHANNELS.selectionBarShow, {
      actions,
      chars,
      fast: PREFS.getSelectionBarFast(),
      backendLabel: CONFIG.BACKEND_META[PREFS.getBackend()]?.label ?? PREFS.getBackend(),
      // Who will answer, for the run's badge. Fast is a submodel of our own API;
      // otherwise it's the user's real provider, named, same as the panel's chip.
      runLabel: PREFS.getSelectionBarFast()
        ? runLabel(MIGHTYMOUSE_BACKEND, FAST_SUBMODEL)
        : runLabel(PREFS.getBackend()),
      ctxOn: PREFS.getCtxToggle(),
      ctxApp,
      ctxURL,
      ctxLabel: buildCtxLabel(ctx)
    })
    barWindow.showInactive()
    startAutoHide()
  }
  ensureWindow(place)
}

/** The bar is an offer, not a mode: unclaimed, it gets out of the way on its own. */
function startAutoHide(): void {
  clearAutoHide()
  autoHideTimer = setTimeout(hideSelectionBar, CONFIG.SELECTION_BAR.AUTO_HIDE_MS)
}

/** Restart the countdown on a bar that stayed up to say something — a failed run.
 *  Hovering still pauses it, so a message is never yanked out from under a reader. */
export function restartSelectionBarAutoHide(): void {
  if (isSelectionBarVisible() && !isSelectionBarBusy()) startAutoHide()
}

/** Hover pauses the countdown; leaving restarts it from full. */
export function setSelectionBarHovered(hovered: boolean): void {
  if (hovered) clearAutoHide()
  else if (isSelectionBarVisible() && !isSelectionBarBusy()) startAutoHide()
}

/** Opaque pill (and menu below it), not the transparent PAD. PAD overlaps the
 *  selection; treating it as the bar ate the next mouseup and never re-showed. */
export function isPointOnSelectionBar(x: number, y: number): boolean {
  if (!barWindow || barWindow.isDestroyed() || !barWindow.isVisible()) return false
  const b = barWindow.getBounds()
  const pad = CONFIG.SELECTION_BAR.PAD
  return x >= b.x + pad && x < b.x + b.width - pad && y >= b.y + pad && y < b.y + b.height - pad
}

/** Focus for the chip editor's text fields. focus()/blur() actually moves the OS
 *  focus; setFocusable alone only changes eligibility. */
export function setSelectionBarFocusable(focusable: boolean): void {
  if (!barWindow || barWindow.isDestroyed()) return
  clearAutoHide()
  barWindow.setFocusable(focusable)
  if (focusable) barWindow.focus()
  else barWindow.blur()
}

/** Grow the window downward so an open gear menu isn't clipped, shrink back on
 *  close. Top-left stays put so the buttons never move under the cursor. */
export function resizeSelectionBar(height: number, width?: number): void {
  if (!barWindow || barWindow.isDestroyed()) return
  // A resize means the gear menu opened — don't yank the bar away mid-choice.
  clearAutoHide()
  const { HEIGHT: base } = CONFIG.SELECTION_BAR
  const b = barWindow.getBounds()
  const size = windowSize(Math.max(base, Math.round(height)), width)
  barWindow.setBounds({ x: b.x, y: b.y, width: size.width, height: size.height })
}

/** Re-pin the preview island. `x,y` is the window's new top-left in screen space. */
export function moveSelectionBar(x: number, y: number): void {
  if (!barWindow || barWindow.isDestroyed()) return
  if (!Number.isFinite(x) || !Number.isFinite(y)) return
  const b = barWindow.getBounds()
  const work = screen.getDisplayNearestPoint({ x, y }).workArea
  const nx = Math.min(Math.max(Math.round(x), work.x), work.x + work.width - b.width)
  const ny = Math.min(Math.max(Math.round(y), work.y), work.y + work.height - b.height)
  barWindow.setBounds({ x: nx, y: ny, width: b.width, height: b.height })
}

export function hideSelectionBar(): void {
  // Every hide resets holds — a stale flag would leave the watcher deaf.
  clearHolds()
  barSelection = ''
  barCtx = {}
  clearAutoHide()
  if (!barWindow || barWindow.isDestroyed()) return
  // Left focusable, the next show would steal focus from the app being selected in.
  if (barWindow.isFocusable()) setSelectionBarFocusable(false)
  barWindow.webContents.send(CHANNELS.selectionBarHide)
  barWindow.hide()
}

export function isSelectionBarVisible(): boolean {
  return !!barWindow && !barWindow.isDestroyed() && barWindow.isVisible()
}

export function closeSelectionBar(): void {
  if (barWindow && !barWindow.isDestroyed()) barWindow.close()
  barWindow = null
}

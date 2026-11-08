import { screen } from 'electron'
import { CONFIG } from '../shared/config'
import { PREFS } from './store/prefs'
import { acquire, isAvailable, on, type AnyEvent } from './capture/uiohook-manager'
import { captureContext, captureSelection } from './platform'
import {
  hideSelectionBar,
  isPointOnSelectionBar,
  isSelectionBarBusy,
  isSelectionBarVisible,
  showSelectionBar
} from './selection-bar-window'
import { SELECTION_ACTIONS } from './store/selection-actions'
import { isPanelVisible } from './panel-window'

// Decides WHEN the selection bar should appear — its only job. Signals: mouse-up
// and the selection-extending keys, both re-read after SETTLE_MS. The window
// lives in selection-bar-window.ts, the bar's IPC in ipc/selection-bar.ts.

let running = false
let release: (() => void) | null = null
const unsubs: Array<() => void> = []

let dragging = false
// The text the visible bar is showing, so an unchanged re-read is a no-op.
// Cleared on every hide: a dismissed bar must be summonable on the same text.
let lastShownText = ''
let settleTimer: NodeJS.Timeout | null = null
let downX = 0
let downY = 0

// Below this a mouseup is a bare click, not a drag-select. Bare clicks must stay
// passive (AX-only): the ⌘C fallback types into whatever is open — it was
// dismissing the tray's NSMenu ~1s after every click (docs/gotchas.md 2026-08-16).
const DRAG_MIN_PX = 5

function log(msg: string): void {
  console.log(`[selection-bar] ${msg}`)
}

// The only hide in this file: every path must drop the cached text, or a
// dismissed bar stays suppressed for the selection it was just showing.
function hideBar(): void {
  lastShownText = ''
  hideSelectionBar()
}

function clearSettle(): void {
  if (settleTimer) {
    clearTimeout(settleTimer)
    settleTimer = null
  }
}

function onMouseDown(e: AnyEvent): void {
  dragging = true
  downX = e.x
  downY = e.y
  clearSettle()
  // Deliberately NOT hiding here. The mouseup that follows re-evaluates a few ms
  // later and hides on a genuinely empty read, so hiding on the way down only
  // made the bar blink on every click inside its own text.
}

// libuiohook keycodes for the keys that EXTEND a selection rather than replace
// it. Everything else (a letter, Delete) means the selection is being typed over.
const ARROW_KEYS = new Set([57419, 57421, 57416, 57424]) // left, right, up, down
const VC_A = 30

function onKeyDown(e: AnyEvent): void {
  // Typing into the chip editor is typing INTO the bar, not over the selection.
  if (isSelectionBarBusy()) return
  const extending = (e.shiftKey && ARROW_KEYS.has(e.keycode)) || (e.metaKey && e.keycode === VC_A)
  if (!extending) {
    // Typing replaces the selection, so the bar is stale the moment a key lands.
    clearSettle()
    if (isSelectionBarVisible()) hideBar()
    return
  }
  // Held arrows fire repeatedly; clearSettle() collapses the burst into one read.
  const { x, y } = screen.getCursorScreenPoint()
  clearSettle()
  settleTimer = setTimeout(() => {
    settleTimer = null
    void evaluateSelection(x, y, true) // shift-arrow/⌘A IS a selection gesture
  }, CONFIG.SELECTION_BAR.SETTLE_MS)
}

function onWheel(): void {
  if (isSelectionBarBusy()) return
  // The bar is anchored in screen space; scrolling leaves it over the wrong line.
  if (isSelectionBarVisible()) hideBar()
}

async function evaluateSelection(x: number, y: number, gesture: boolean): Promise<void> {
  // Re-checked at fire time: the user can flip the setting during settle.
  if (!PREFS.getSelectionBar()) return log('pref off')
  if (isSelectionBarBusy()) return log('busy')
  if (isPanelVisible()) return log('panel open') // the panel already captured the selection

  let text = ''
  try {
    // Only a real selection gesture (drag/double-click/shift-arrow) may use the
    // ⌘C fallback; a bare click stays passive so nothing is ever typed from one.
    text = await captureSelection(!gesture)
  } catch (err) {
    return log(`capture failed: ${String(err)}`)
  }

  const chars = text.trim().length
  const { MIN_CHARS, MAX_CHARS } = CONFIG.SELECTION_BAR
  if (chars < MIN_CHARS) {
    // A bare click reads passively (no ⌘C), which returns empty in a canvas app
    // like Google Docs even while text IS selected. Treating that as "selection
    // gone" is what hid the bar a frame after showing it — the flicker. Only a
    // real gesture is allowed to clear a bar that is showing text.
    if (!gesture && isSelectionBarVisible()) return log('empty passive read — keeping bar')
    lastShownText = ''
    return log('empty selection')
  }
  if (chars > MAX_CHARS) return log(`${chars} chars out of range`)

  // All chips deleted is valid — a bar with no buttons is just a box over text.
  const actions = SELECTION_ACTIONS.load()
  if (actions.length === 0) return log('no actions configured')

  // Whose text this is. Captured now, while they are still frontmost — a chip
  // click makes US frontmost, so the rewrite has no target left to paste into.
  const ctx = (await captureContext().catch(() => null)) ?? {}

  // A click inside already-selected text re-fires mouseup with the SAME text, so
  // the bar re-showed on every click — 277 shows for 145 real selections in one
  // session. Re-showing is only correct when the selection actually changed.
  if (isSelectionBarVisible() && text === lastShownText) return log('unchanged selection')

  log(`showing bar, ${chars} chars, app=${ctx.frontApp || 'unknown'}`)
  lastShownText = text
  showSelectionBar(x, y, actions, chars, text, ctx)
}

/** The ⌘⌥⇧T handler: show the bar at the cursor, or hide it if already up.
 *  Unlike the automatic path this ignores the pref, but an empty selection still
 *  wins — there is nothing for the chips to act on. */
export async function summonSelectionBar(): Promise<void> {
  if (!CONFIG.SELECTION_BAR.ENABLED) return
  if (isSelectionBarVisible()) {
    log('summon: already up, hiding')
    hideBar()
    return
  }
  let text = ''
  try {
    text = await captureSelection()
  } catch (err) {
    log(`summon: capture failed: ${String(err)}`)
  }
  const chars = text.trim().length
  if (chars < CONFIG.SELECTION_BAR.MIN_CHARS) return log('summon: empty selection')

  const ctx = (await captureContext().catch(() => null)) ?? {}
  const { x, y } = screen.getCursorScreenPoint()
  log(`summon: showing at ${x},${y} with ${chars} chars, app=${ctx.frontApp || 'unknown'}`)
  showSelectionBar(x, y, SELECTION_ACTIONS.load(), chars, text, ctx)
}

function onMouseUp(e: AnyEvent): void {
  if (!dragging) return
  dragging = false

  const { x, y } = screen.getCursorScreenPoint()
  if (isSelectionBarBusy() || isPointOnSelectionBar(x, y)) return

  const gesture = Math.hypot(e.x - downX, e.y - downY) >= DRAG_MIN_PX || e.clicks >= 2
  log(`mouseup, evaluating (gesture=${gesture})`)

  // Snapshot now: the bar belongs where the selection ENDED, not where the
  // pointer sits after SETTLE_MS.
  clearSettle()
  settleTimer = setTimeout(() => {
    settleTimer = null
    void evaluateSelection(x, y, gesture)
  }, CONFIG.SELECTION_BAR.SETTLE_MS)
}

/** Idempotent; no-ops if uiohook is unavailable — the bar is never a hard dependency. */
export function startSelectionWatcher(): boolean {
  if (running) return false
  if (!isAvailable()) {
    log('NOT armed — uiohook unavailable')
    return false
  }
  unsubs.push(on('mousedown', onMouseDown))
  unsubs.push(on('mouseup', onMouseUp))
  unsubs.push(on('keydown', onKeyDown))
  unsubs.push(on('wheel', onWheel))
  release = acquire()
  running = true
  console.log('[selection-bar] watcher armed')
  return true
}

export function stopSelectionWatcher(): void {
  if (!running) return
  clearSettle()
  dragging = false
  unsubs.forEach((u) => u())
  unsubs.length = 0
  if (release) {
    release()
    release = null
  }
  hideBar()
  running = false
}

/** Called at startup and on every Settings-toggle flip, so no restart is needed. */
export function applySelectionWatcher(): void {
  if (CONFIG.SELECTION_BAR.ENABLED && PREFS.getSelectionBar()) startSelectionWatcher()
  else stopSelectionWatcher()
}

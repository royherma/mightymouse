/**
 * Phone Remote — cursor/pointer domain. Move deltas, glide interpolation,
 * scroll throttling, and the mirror-warp helpers. Extracted verbatim from
 * ipc/phone-remote.ts. Owns the tracked/posted cursor position
 * and drag-held state, since every function here reads or writes them.
 */
import { screen } from 'electron'
import { CONFIG } from '../../shared/config'
import { PREFS } from '../store/prefs'
import { input, context } from '../platform'
import { sendToPhone } from '../phone-remote/server'
import { moveGainForSpeed } from '../../shared/pointer-accel'
import { noteAppGeneratedInput } from '../phone-remote/local-input-watch'
import { getVirtualDisplay } from '../capture/virtual-display'
import {
  isPhoneRemoteKeyName,
  isPhoneRemoteModifier,
  isPadGesture,
  PAD_ZOOM_MAX_STEPS,
  isTmuxAction,
  TMUX_ACTION,
  TMUX_PREFIX_KEY,
  TMUX_PREFIX_MODIFIER
} from '../../shared/phone-remote-keys'
import { sendAppContext, clipboardHasContent } from './phone-remote-context'
import type { PhoneRemoteMessage } from '../../shared/phone-remote-protocol'
import { phoneMayControlMac } from './phone-remote'

type Msg<T extends PhoneRemoteMessage['type']> = Extract<PhoneRemoteMessage, { type: T }>

// Last delta-tracked coordinate -- where the finger says the cursor SHOULD
// be. null = nothing tracked yet (fresh gesture or just disconnected).
let trackedX: number | null = null
let trackedY: number | null = null

// Last coordinate actually posted to the OS -- the glide interpolator's start
// point. Distinct from trackedX/Y; this is where it was last drawn.
let lastPostedX: number | null = null
let lastPostedY: number | null = null

let dragHeld = false

/** Read the tracked (not yet necessarily posted) cursor position. */
export function getTrackedPosition(): { x: number | null; y: number | null } {
  return { x: trackedX, y: trackedY }
}

export function isDragHeld(): boolean {
  return dragHeld
}

/** dragStart's setup: anchor tracking to the live cursor, reset smoothing,
 *  and mark the button down. */
export function beginDrag(): { x: number; y: number } {
  const pt = screen.getCursorScreenPoint()
  trackedX = pt.x
  trackedY = pt.y
  smoothedDx = 0
  smoothedDy = 0
  dragHeld = true
  cancelGlide()
  lastPostedX = pt.x
  lastPostedY = pt.y
  return pt
}

/** dragEnd / disconnect / toggle-off: drop the held flag and report whether
 *  a real drag was in flight (caller posts the final dragUpFast at
 *  trackedX/Y first, using getTrackedPosition() -- unaffected by this call). */
export function endDrag(): boolean {
  const wasHeld = dragHeld && trackedX !== null && trackedY !== null
  dragHeld = false
  return wasHeld
}

/** dragEnd only: dragUpFast lifted the button at the tracked point, so the
 *  glide anchor must agree it was last drawn there too. */
export function syncPostedToTracked(): void {
  lastPostedX = trackedX
  lastPostedY = trackedY
}

/** mirrorWarp: fold an absolute phone-side coordinate into the tracked
 *  accumulator so a dragMove that follows continues from the real position. */
export function warpTrackedPosition(x: number, y: number): void {
  trackedX = x
  trackedY = y
  smoothedDx = 0
  smoothedDy = 0
}

const TRACKED_POSITION_DRIFT_RESYNC_PX = 4

const MOVE_SMOOTHING_ALPHA = 0.5

let smoothedDx = 0
let smoothedDy = 0
let lastMoveAt = 0
const MOVE_GESTURE_IDLE_MS = 150

// macOS clips the posted CGEvent to the desktop, but the tracked point is ours
// and keeps accumulating past the edge -- so a finger that overshoots builds up
// invisible offscreen travel the user must undo before the cursor moves again.
// A real trackpad has no such debt. Clamping the ACCUMULATOR is the fix.
//
// Clamped against the display nearest the target, not the union of all of them:
// on a multi-display setup the union rectangle contains gaps no display covers,
// and parking the cursor in one is worse than the edge stop it replaces.
export function clampToDesktop(x: number, y: number): { x: number; y: number } {
  const b = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) }).bounds
  return {
    x: Math.min(Math.max(x, b.x), b.x + b.width - 1),
    y: Math.min(Math.max(y, b.y), b.y + b.height - 1)
  }
}

export function extendDisplaySize(): { width: number; height: number } {
  const { width, height } = screen.getPrimaryDisplay().size
  const clamp = (raw: number, fallback: number): number =>
    Number.isFinite(raw) && raw > 0
      ? Math.min(
          Math.max(Math.round(raw), CONFIG.PHONE_REMOTE.EXTEND_MIN_PX),
          CONFIG.PHONE_REMOTE.EXTEND_MAX_PX
        )
      : fallback
  return {
    width: clamp(width, CONFIG.PHONE_REMOTE.EXTEND_FALLBACK_WIDTH),
    height: clamp(height, CONFIG.PHONE_REMOTE.EXTEND_FALLBACK_HEIGHT)
  }
}

const WARP_ALPHA_MIN = 0.3 // slow finger: heavy filtering
const WARP_ALPHA_MAX = 0.9 // fast finger: near passthrough
const WARP_SLOW_PX = 4 // at/below this per-tick distance, treat as jitter
const WARP_FAST_PX = 40 // at/above this, treat as deliberate motion

/** Per-tick smoothing factor for an absolute warp, scaled by how far the
 *  finger travelled since the last one. See the constants above for why this
 *  is distance-dependent rather than a single alpha. */
export function warpAlphaForDistance(distancePx: number): number {
  if (distancePx <= WARP_SLOW_PX) return WARP_ALPHA_MIN
  if (distancePx >= WARP_FAST_PX) return WARP_ALPHA_MAX
  const t = (distancePx - WARP_SLOW_PX) / (WARP_FAST_PX - WARP_SLOW_PX)
  return WARP_ALPHA_MIN + (WARP_ALPHA_MAX - WARP_ALPHA_MIN) * t
}

/** The fraction of a pixel a tracked coordinate is carrying beyond what was
 *  actually posted to the OS (which only accepts whole pixels). Null -- no
 *  tracked point yet -- carries nothing. */
export function subPixelRemainder(tracked: number | null): number {
  if (tracked === null) return 0
  return tracked - Math.round(tracked)
}

export function applyMoveDelta(dx: number, dy: number): void {
  if (!phoneMayControlMac()) return
  // A long enough silence means the previous gesture ended -- start this one
  // from rest rather than from the last one's velocity. See
  // MOVE_GESTURE_IDLE_MS.
  const nowMs = Date.now()
  if (nowMs - lastMoveAt > MOVE_GESTURE_IDLE_MS) {
    smoothedDx = 0
    smoothedDy = 0
    // Same boundary retires the glide anchor: the cursor may have been moved by
    // hand since, so interpolating from the last posted point would sweep it
    // back across the screen. Next move posts directly and re-anchors.
    cancelGlide()
    lastPostedX = null
    lastPostedY = null
  }
  lastMoveAt = nowMs
  smoothedDx = smoothedDx * (1 - MOVE_SMOOTHING_ALPHA) + dx * MOVE_SMOOTHING_ALPHA
  smoothedDy = smoothedDy * (1 - MOVE_SMOOTHING_ALPHA) + dy * MOVE_SMOOTHING_ALPHA
  const pt = screen.getCursorScreenPoint()
  const sensitivity = PREFS.getPhoneRemoteSensitivity()
  if (
    !dragHeld &&
    (trackedX === null ||
      trackedY === null ||
      Math.abs(trackedX - pt.x) > TRACKED_POSITION_DRIFT_RESYNC_PX ||
      Math.abs(trackedY - pt.y) > TRACKED_POSITION_DRIFT_RESYNC_PX)
  ) {
    trackedX = pt.x + subPixelRemainder(trackedX)
    trackedY = pt.y + subPixelRemainder(trackedY)
  }
  // Still null only if this is the very first move of a held drag (the resync
  // above is skipped while dragHeld) -- anchor to the live cursor point.
  if (trackedX === null || trackedY === null) {
    trackedX = pt.x
    trackedY = pt.y
  }
  // Gain is computed from the SMOOTHED speed and applied to both axes equally,
  // so a diagonal keeps its angle -- per-axis gain would bend the path.
  const gain = moveGainForSpeed(Math.hypot(smoothedDx, smoothedDy), sensitivity)
  const next = clampToDesktop(
    trackedX + smoothedDx * sensitivity * gain,
    trackedY + smoothedDy * sensitivity * gain
  )
  trackedX = next.x
  trackedY = next.y
  glideTo(trackedX, trackedY)
}

const GLIDE_MAX_STEPS = 3
const GLIDE_WINDOW_MS = CONFIG.PHONE_REMOTE.MOVE_THROTTLE_MS - 2
const GLIDE_MIN_PX = 1.5
// px of gap per sub-step -- a big sweep earns more steps than a small nudge.
// Halved with the send interval: at 50/sec the same finger speed reports half
// the gap, so keeping 22 here would have quietly demoted every move to 2 steps.
const GLIDE_PX_PER_STEP = 11
let glideTimers: ReturnType<typeof setTimeout>[] = []

export function postMove(x: number, y: number): void {
  // moveCursorFast/dragMoveFast (persistent process) not runInput (spawn-per-
  // call) -- moves are the one per-frame hot path here, see input.ts's
  // moveloop comment.
  if (dragHeld) input.dragMoveFast(x, y)
  else input.moveCursorFast(x, y)
}

/** Cancel any sub-steps still pending from the previous message. A newer
 *  target supersedes them outright -- letting stale steps land after it would
 *  drag the cursor backwards. */
export function cancelGlide(): void {
  for (const t of glideTimers) clearTimeout(t)
  glideTimers = []
}

/** Post a move to (x,y), subdividing a large jump into intermediate steps so
 *  the cursor glides instead of teleporting. */
export function glideTo(x: number, y: number): void {
  cancelGlide()
  const fromX = lastPostedX
  const fromY = lastPostedY
  lastPostedX = x
  lastPostedY = y
  const dist = fromX === null || fromY === null ? 0 : Math.hypot(x - fromX, y - fromY)
  if (dist < GLIDE_MIN_PX || fromX === null || fromY === null) {
    postMove(x, y)
    return
  }
  const steps = Math.min(GLIDE_MAX_STEPS, Math.max(2, Math.round(dist / GLIDE_PX_PER_STEP)))
  const stepMs = GLIDE_WINDOW_MS / steps
  // i=1..steps-1 are the intermediate points; the final one is posted at i=steps
  // so the exact target still lands even if a timer fires late.
  for (let i = 1; i < steps; i++) {
    const t = i / steps
    const sx = fromX + (x - fromX) * t
    const sy = fromY + (y - fromY) * t
    glideTimers.push(setTimeout(() => postMove(sx, sy), i * stepMs))
  }
  glideTimers.push(setTimeout(() => postMove(x, y), steps * stepMs))
}

export function centerCursor(): void {
  if (!phoneMayControlMac()) return
  const b = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).bounds
  const x = Math.round(b.x + b.width / 2)
  const y = Math.round(b.y + b.height / 2)
  // Reset the delta accumulator to the point we just jumped to. Without this
  // the next 'move' would resume from the OLD tracked point and snap the
  // cursor straight back where it was lost -- the exact bug this rescues.
  trackedX = x
  trackedY = y
  smoothedDx = 0
  smoothedDy = 0
  input.moveCursorFast(x, y)
}

let lastScrollAt = 0
let pendingScrollDx = 0
let pendingScrollDy = 0
// Trailing edge for the scroll throttle: without it a gesture's last message is
// accumulated and never posted, since nothing else flushes.
let scrollFlushTimer: ReturnType<typeof setTimeout> | null = null
// Raw touch px per wheel "line" -- tuned so a normal two-finger swipe scrolls
// at roughly the same rate a real Mac trackpad does, not a jarring page-jump
// per touch event.
const SCROLL_PX_PER_LINE = 12

/** Cancel a pending trailing flush. Must run before stopMoveLoop() -- same
 *  hazard as cancelGlide(): a flush firing after it writes to a dead stdin. */
export function cancelScrollFlush(): void {
  if (!scrollFlushTimer) return
  clearTimeout(scrollFlushTimer)
  scrollFlushTimer = null
}

/** Post whatever is accumulated, if anything. The ONE place a wheel is posted,
 *  so the leading and trailing edge cannot drift apart. */
export function postPendingScroll(): void {
  if (pendingScrollDx === 0 && pendingScrollDy === 0) return
  // The trailing flush fires from a timer, NOT from handlePhoneMessage, so the
  // inbound-message stamp never covers it. Stamp here or this function becomes
  // the unattributed wheel it exists to prevent.
  noteAppGeneratedInput()
  lastScrollAt = Date.now()
  // Wheel "lines" are natural-scroll-direction: dragging fingers up moves
  // content up, i.e. scrolls DOWN -- so this negates dy, matching how every
  // Mac trackpad (Natural Scrolling, the default) already behaves.
  const lines = -pendingScrollDy / SCROLL_PX_PER_LINE
  const linesX = pendingScrollDx / SCROLL_PX_PER_LINE
  input.scrollFast(lines, linesX)
  pendingScrollDx = 0
  pendingScrollDy = 0
}

export function applyScrollDelta(dx: number, dy: number): void {
  if (!phoneMayControlMac()) return
  pendingScrollDx += dx
  pendingScrollDy += dy
  const now = Date.now()
  const waited = now - lastScrollAt
  if (waited < CONFIG.PHONE_REMOTE.MOVE_THROTTLE_MS) {
    // Inside the throttle: hold the pixels, but guarantee they land on their
    // own -- the phone sends nothing after the finger lifts, so a dropped
    // message with no trailing flush is a message that is never posted.
    if (!scrollFlushTimer) {
      scrollFlushTimer = setTimeout(() => {
        scrollFlushTimer = null
        postPendingScroll()
      }, CONFIG.PHONE_REMOTE.MOVE_THROTTLE_MS - waited)
    }
    return
  }
  cancelScrollFlush()
  postPendingScroll()
}

let cursorStreamTimer: NodeJS.Timeout | null = null
let lastCursorSent: { x: number; y: number } | null = null

export function startCursorStream(): void {
  if (cursorStreamTimer) return
  cursorStreamTimer = setInterval(() => {
    const pt = screen.getCursorScreenPoint()
    // Parked cursor → no send. This is the hot idle path: one comparison per
    // tick and zero WS traffic while the user isn't moving the mouse.
    if (lastCursorSent && pt.x === lastCursorSent.x && pt.y === lastCursorSent.y) return
    lastCursorSent = { x: pt.x, y: pt.y }

    // Normalize against the display the cursor is ON, which is also the one
    // being mirrored (screen-stream.ts captures the display under the cursor).
    const b = screen.getDisplayNearestPoint(pt).bounds
    if (!b.width || !b.height) return
    sendToPhone({
      type: 'cursorPos',
      x: Math.min(1, Math.max(0, (pt.x - b.x) / b.width)),
      y: Math.min(1, Math.max(0, (pt.y - b.y) / b.height))
    })
  }, CONFIG.PHONE_REMOTE.CURSOR_STREAM_POLL_MS)
}

export function stopCursorStream(): void {
  if (!cursorStreamTimer) return
  clearInterval(cursorStreamTimer)
  cursorStreamTimer = null
  lastCursorSent = null
}

// --- Dispatch handlers (moved verbatim from ipc/phone-remote.ts, C9a) ---

export function handleMove(msg: Msg<'move'>): void {
  applyMoveDelta(msg.dx, msg.dy)
}

export function handleCenterCursor(): void {
  centerCursor()
}

export function handleTap(): void {
  if (!phoneMayControlMac()) return
  const pt = screen.getCursorScreenPoint()
  input.clickAt(pt.x, pt.y)
}

export function handleTwoFingerTap(): void {
  if (!phoneMayControlMac()) return
  const pt = screen.getCursorScreenPoint()
  input.rightClickAt(pt.x, pt.y)
}

export function handleDoubleTap(): void {
  if (!phoneMayControlMac()) return
  const pt = screen.getCursorScreenPoint()
  input.doubleClickAt(pt.x, pt.y)
}

export function handleDragStart(): void {
  if (!phoneMayControlMac()) return
  // beginDrag() does the anchor/smoothing-reset/glide-cancel dance -- button
  // goes down exactly where the cursor already is, so re-anchoring there
  // stops a stale glide anchor from sweeping in from the previous gesture's
  // end point.
  const pt = beginDrag()
  input.dragDownFast(pt.x, pt.y)
}

export function handleDragMove(msg: Msg<'dragMove'>): void {
  // Reuses applyMoveDelta's tracked-position accumulator -- dragHeld just
  // switches which CGEvent type it posts (dragged vs plain move).
  applyMoveDelta(msg.dx, msg.dy)
}

export function handleDragEnd(): void {
  // Drop pending glide steps FIRST -- a sub-step firing after the button is
  // released posts a drag-move with nothing held, landing the dragged item
  // somewhere the finger never asked for.
  cancelGlide()
  {
    const { x: tx, y: ty } = getTrackedPosition()
    if (isDragHeld() && tx !== null && ty !== null) {
      input.dragUpFast(tx, ty)
      syncPostedToTracked()
    }
  }
  endDrag()
}

export function handleScroll(msg: Msg<'scroll'>): void {
  applyScrollDelta(msg.dx, msg.dy)
}

export function handleMirrorWarp(msg: Msg<'mirrorWarp'>): void {
  if (!phoneMayControlMac()) return
  const b = (getVirtualDisplay() ?? screen.getPrimaryDisplay()).bounds
  const targetX = Math.round(b.x + msg.nx * b.width)
  const targetY = Math.round(b.y + msg.ny * b.height)

  let x = targetX
  let y = targetY
  const { x: tx, y: ty } = getTrackedPosition()
  if (!msg.snap && tx !== null && ty !== null) {
    const dx = targetX - tx
    const dy = targetY - ty
    const alpha = warpAlphaForDistance(Math.hypot(dx, dy))
    x = Math.round(tx + dx * alpha)
    y = Math.round(ty + dy * alpha)
  }

  // Keep the shared accumulator in sync so a dragMove that follows a warp
  // continues from where the cursor actually is, not from a stale pre-warp
  // position.
  warpTrackedPosition(x, y)
  if (isDragHeld()) input.dragMoveFast(x, y)
  else input.moveCursorFast(x, y)
}


export function handlePasteClipboard(): void {
  if (!phoneMayControlMac()) return
  if (!clipboardHasContent()) return
  input.typeText('cmd+v', 'key')
}

export function handleAppActivateItem(msg: Msg<'appActivateItem'>): void {
  if (!phoneMayControlMac()) return
  if (typeof msg.itemId !== 'string' || !msg.itemId) return
  context.activateAppItem(msg.itemId)
  sendAppContext()
}

export function handleAppActivateGroup(msg: Msg<'appActivateGroup'>): void {
  if (!phoneMayControlMac()) return
  if (typeof msg.groupId !== 'string' || !msg.groupId) return
  context.activateAppGroup(msg.groupId)
  sendAppContext()
}

export function handleAppActivatePane(msg: Msg<'appActivatePane'>): void {
  if (!phoneMayControlMac()) return
  if (typeof msg.paneId !== 'string' || !msg.paneId) return
  // The shape gate lives in activateAppPane, where the id meets a shell argument.
  context.activateAppPane(msg.paneId)
  sendAppContext()
}

export function handlePressKey(msg: Msg<'pressKey'>): void {
  if (!phoneMayControlMac()) return
  if (!isPhoneRemoteKeyName(msg.key)) return
  const modifiers = msg.modifiers ?? []
  if (!Array.isArray(modifiers) || !modifiers.every(isPhoneRemoteModifier)) return
  input.typeText([...modifiers, msg.key].join('+'), 'key')
}

export function handlePadGesture(msg: Msg<'padGesture'>): void {
  if (!phoneMayControlMac()) return
  if (!isPadGesture(msg.gesture)) return
  // Opening and closing are genuinely different mechanisms, not one toggle:
  // `open -a` re-run while Mission Control is up does nothing at all.
  // Switch, not if/else: a fourth gesture must not silently inherit escape.
  if (msg.gesture === 'missionControl') input.openAppOverview()
  else if (msg.gesture === 'closeMissionControl') input.typeText('escape', 'key')
  else void input.smartZoomMac()
}

export function handlePadZoom(msg: Msg<'padZoom'>): void {
  if (!phoneMayControlMac()) return
  if (typeof msg.steps !== 'number' || !Number.isFinite(msg.steps)) return
  // Clamp off the wire: one gesture frame is a few notches, never a burst
  // big enough to run the zoom to its limit in a single message.
  const steps = Math.max(-PAD_ZOOM_MAX_STEPS, Math.min(PAD_ZOOM_MAX_STEPS, Math.trunc(msg.steps)))
  if (steps === 0) return
  void input.zoomMac(steps)
}

export function handleTmuxAction(msg: Msg<'tmuxAction'>): void {
  if (!phoneMayControlMac()) return
  // Same contract as pressKey: the WS layer only casts, so prove the action
  // is one of ours before it picks the key that reaches mm-input.
  if (!isTmuxAction(msg.action)) return
  void (async () => {
    await input.pressKeys([
      [TMUX_PREFIX_MODIFIER, TMUX_PREFIX_KEY].join('+'),
      TMUX_ACTION[msg.action]
    ])
    // The button we just fired DRAWS the zoom state, and this is the only thing
    // that changes it: zooming a pane switches no app, so the frontmost-app
    // watcher that pushes every other context update never fires for it. Without
    // this the button stays wrong until something unrelated happens to switch
    // apps -- which reads on device as the button simply not working.
    await settleAfterTmuxAction()
    sendAppContext()
  })()
}

/** tmux repaints after the keys land, and the flag flips with the repaint --
 *  reading straight back answers with the state we just left. */
const TMUX_SETTLE_MS = 80
function settleAfterTmuxAction(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, TMUX_SETTLE_MS))
}

export function handleTypeText(msg: Msg<'typeText'>): void {
  if (!phoneMayControlMac()) return
  input.typeText(msg.text, 'text')
}

export function handleDeleteText(msg: Msg<'deleteText'>): void {
  if (!phoneMayControlMac()) return
  // Sequential, not fire-and-forget-in-parallel: each is a real spawned
  // process, and backspaces must land in order relative to each other.
  void (async () => {
    for (let i = 0; i < msg.count; i++) await input.typeText('delete', 'key')
  })()
}

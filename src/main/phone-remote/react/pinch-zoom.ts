// pinch-zoom.ts — the two-finger gesture split: scroll vs pinch-to-zoom.
//
// Both gestures are two fingers on the same pad, so exactly one rule decides
// which a touch becomes, and it LATCHES for the rest of that touch. A gesture
// that flips mid-drag reads as broken hardware.
//
// Pure on purpose: the App.tsx handler is 300 lines of DOM state that no test
// can reach, and this is the part with the actual logic in it.

import { PAD_ZOOM_MAX_STEPS } from '../../../shared/phone-remote-keys'

/** How far the two fingers' separation must change before a touch commits to
 *  zooming. Above TAP_MAX_MOVE_PX (10) so a two-finger tap's wobble can't
 *  trip it, and below the travel a deliberate scroll produces. */
export const PINCH_MIN_SPREAD_PX = 24

/** Separation change per zoom notch. A full pinch across a ~390px phone is
 *  ~300px of spread ≈ 8 notches, which lands near a browser's full zoom range
 *  without the user re-gripping. */
export const PINCH_PX_PER_STEP = 38

/** How far the hand may travel before scroll wins outright, once the spread has
 *  started drifting.
 *
 *  This exists because pan is crossed FIRST in every real pinch: `panDelta` is
 *  finger 0's distance from its origin, and opening two fingers moved finger 0
 *  133px on-device while the SEPARATION was still only 15px. Latching on
 *  whichever threshold tripped first therefore made every pinch scroll. 200 is
 *  above that measured 133 with room to spare -- a pad is only ~360px wide, so
 *  a pinch cannot separate much further than this anyway. */
export const PINCH_PAN_GRACE_PX = 200

/** Separation drift below which two fingers count as "held steady". Fingers
 *  wobble a few px on any real drag, so scroll would never claim a touch if
 *  this were 0. */
export const PINCH_SPREAD_NOISE_PX = 8

/** Pinch sends ⌘= / ⌘- notches: no public API posts a real magnify gesture. */
export const PINCH_ZOOM_ENABLED = true

/** Off: a two-finger double-tap would make every right-click wait out the double-tap window. */
export const SMART_ZOOM_ENABLED = false

export type TwoFingerMode = 'undecided' | 'scrolling' | 'zooming'

/** Distance between two touch points. */
export function touchSpread(
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  return Math.hypot(ax - bx, ay - by)
}

/**
 * Decide what a two-finger touch has become, given how far the fingers have
 * spread apart/together (`spreadDelta`) and how far the hand has travelled
 * (`panDelta`), both measured from the touch's ORIGIN rather than per frame —
 * two fingers land a few ms apart, so a frame delta tracks the second finger
 * arriving instead of the gesture.
 *
 * Once decided, the mode is returned unchanged: the caller latches by passing
 * the previous result back in.
 */
export function decideTwoFingerMode(
  current: TwoFingerMode,
  spreadDelta: number,
  panDelta: number,
  tapMaxMovePx: number
): TwoFingerMode {
  if (current !== 'undecided') return current
  if (Math.abs(spreadDelta) >= PINCH_MIN_SPREAD_PX) return 'zooming'
  // Scroll is pan with the fingers held at a CONSTANT separation, so a touch
  // whose spread is already drifting is a pinch mid-flight and must not be
  // taken by scroll. Gating on panDelta alone handed every pinch to scroll:
  // opening two fingers moves finger 0 ~130px while the separation is still
  // under PINCH_MIN_SPREAD_PX, so pan crossed first every time.
  const spreadIsStable = Math.abs(spreadDelta) < PINCH_SPREAD_NOISE_PX
  if (panDelta > tapMaxMovePx && spreadIsStable) return 'scrolling'
  // Spread is moving but hasn't committed yet. Give it room -- but not forever,
  // or a sloppy two-finger drag never scrolls at all.
  if (panDelta > PINCH_PAN_GRACE_PX) return 'scrolling'
  return 'undecided'
}

/**
 * Whole zoom notches owed for the spread accumulated so far, plus the spread
 * to carry into the next frame. Returning the remainder (rather than zeroing
 * it) is what makes a slow continuous pinch reach full zoom — dropping the
 * sub-notch remainder each frame silently swallows most of a gentle gesture.
 */
export function zoomStepsFor(accumulatedPx: number): {
  steps: number
  remainderPx: number
} {
  const steps = Math.trunc(accumulatedPx / PINCH_PX_PER_STEP)
  if (steps === 0) return { steps: 0, remainderPx: accumulatedPx }
  return {
    steps: Math.max(-PAD_ZOOM_MAX_STEPS, Math.min(PAD_ZOOM_MAX_STEPS, steps)),
    remainderPx: accumulatedPx - steps * PINCH_PX_PER_STEP
  }
}

import { CONFIG } from '@shared/config'

// Rub-to-mirror: one finger scrubbing left-right-left along the top of the pad
// toggles screen share. Chosen because nothing draws that shape by accident --
// a cursor drag is one direction, a scroll is vertical, a swipe is one leg.
//
// Pure geometry, no DOM or timers: the caller supplies its own clock so a test
// can drive the window without waiting on one.
//
// Same asymmetry as the rail and the ring: the band is live trackpad, so a
// false positive steals a cursor drag while a false negative costs one repeat.
// When in doubt RUB_LEGS grows, never shrinks.

/** A touch sample, in pad-local px, with the caller's clock reading. */
export type RubPoint = { x: number; y: number; t: number }

/**
 * What the pad calls to drive the rub watch. Published as a ref by the layout
 * that owns the pad geometry -- same shape as `RailSummonHandle`, so the pad's
 * touch handler drives both the same way. Null whenever there is nothing to
 * watch (keys at the top, or the pad unmeasured).
 *
 * `move` returns true on the frame the rub fires. Unlike the ring and rail, a
 * true here does NOT claim the touch: the cursor keeps tracking for the rest
 * of the gesture, so the pad reads it purely as "the toggle went".
 */
export type RubHandle = {
  start: (t: { clientX: number; clientY: number }) => void
  move: (t: { clientX: number; clientY: number }) => boolean
  end: () => void
}

/** Live state of the one finger being watched. Kept (not nulled) once dead so
 *  the caller can tell "already failed" from "never a candidate". */
export type RubTrace = {
  /** y where the finger landed -- the drift reference for the whole gesture. */
  fromY: number
  /** Clock reading at touchdown, against which the window is measured. */
  startedAt: number
  /** x where the current leg began -- reset at each accepted reversal. */
  legFromX: number
  /** Which way the current leg runs. 0 until the first leg earns a direction. */
  dir: -1 | 0 | 1
  /** Completed legs, including the one in progress once it passes RUB_LEG_PX. */
  legs: number
  /** Drifted vertically, left the band, or ran out of window. */
  dead: boolean
}

function inBand(y: number): boolean {
  return y >= 0 && y <= CONFIG.PHONE_REMOTE.RUB_BAND_PX
}

/**
 * Start watching a touch, or reject it outright.
 *
 * Returns null when the finger lands outside the top band. Requiring the START
 * to be in the band is most of what protects an ordinary drag: a touch
 * beginning lower down can never qualify no matter what it draws next.
 */
export function rubBegin(p: RubPoint): RubTrace | null {
  if (!inBand(p.y)) return null
  return { fromY: p.y, startedAt: p.t, legFromX: p.x, dir: 0, legs: 0, dead: false }
}

/**
 * Fold one move into the trace.
 *
 * A leg is counted the moment it passes RUB_LEG_PX, not when it reverses --
 * so the third leg of left-right-left fires mid-stroke rather than making the
 * user add a fourth. Reversing before that threshold just re-anchors the
 * current leg: sub-threshold wobble is noise, not intent.
 */
export function rubMove(trace: RubTrace, p: RubPoint): RubTrace {
  if (trace.dead) return trace
  const { RUB_DRIFT_PX, RUB_LEG_PX, RUB_WINDOW_MS } = CONFIG.PHONE_REMOTE
  if (!inBand(p.y) || Math.abs(p.y - trace.fromY) > RUB_DRIFT_PX) {
    return { ...trace, dead: true }
  }
  if (p.t - trace.startedAt > RUB_WINDOW_MS) return { ...trace, dead: true }

  const dx = p.x - trace.legFromX
  if (Math.abs(dx) < RUB_LEG_PX) return trace
  const dir = dx > 0 ? 1 : -1
  // Same direction as the leg just credited means the finger never turned
  // around -- one long stroke is one leg, so extend the anchor instead of
  // banking a second.
  if (dir === trace.dir) return { ...trace, legFromX: p.x }
  return { ...trace, legFromX: p.x, dir, legs: trace.legs + 1 }
}

/** Has this trace earned the toggle? */
export function rubQualifies(trace: RubTrace): boolean {
  return !trace.dead && trace.legs >= CONFIG.PHONE_REMOTE.RUB_LEGS
}

import { CONFIG } from '@shared/config'

// The scroll rail: a vertical strip on the off-hand edge that turns a thumb
// drag into a scroll. Summoned by SCRUBBING the strip up-down-up -- the same
// shape rub-to-mirror uses along the top band (rub-toggle.ts), one axis over.
//
// Pure geometry, no DOM or timers: the caller supplies its own clock so a test
// can drive the window without waiting on one, and a hand-derived strip
// manufactures fake failure modes (memory `harness-must-measure-not-assume`).
//
// It used to want one long RAIL_SUMMON_PX sweep, which meant reaching the whole
// length of the thumb's travel to raise a rail the thumb then had to scroll on.
// A short scrub reads the same intent in a third of the distance: a reversal is
// what nothing else on the pad draws, so the leg COUNT carries the signal that
// leg LENGTH used to.
//
// Same asymmetry as the ring's summon threshold: the pad under the strip is a
// live trackpad, so a false positive steals a cursor drag; a false negative
// costs one repeated gesture. When in doubt RAIL_SUMMON_LEGS grows, never
// shrinks.

/** Which edge the strip lives on, resolved once from handedness (`left` when
 *  the ring is on `right`, and vice versa -- the SAME inversion `notchPathB`
 *  already uses, never a second axis). */
export type RailEdge = 'left' | 'right'

/** A touch, in pad-local px, with the caller's clock reading. */
export type RailPoint = { x: number; y: number; t: number }

/**
 * What the pad calls to drive a rail summon. Published as a ref by the
 * layout that owns the geometry, null whenever there is nothing to summon
 * (the rail is already up, or the strip hasn't been measured). Same shape as
 * `RingSummonHandle` on purpose -- the pad's touch handler drives both the
 * same way.
 */
export type RailSummonHandle = {
  start: (t: { clientX: number; clientY: number }) => void
  /** Takes a real Touch: qualifying hands the finger to the rail's own drag,
   *  which tracks it by `identifier` for the rest of the gesture. */
  move: (t: Touch) => boolean
  end: () => void
}

export type RailStrip = {
  edge: RailEdge
  /** Pad width, needed to place the right-edge strip's near boundary. */
  padW: number
}

/** Live state of one finger being watched. Kept (not nulled) once dead so the
 *  caller can tell "already failed" from "never a candidate". */
export type RailSummonTrace = {
  /** x where the finger entered the strip -- horizontal reference for stray. */
  fromX: number
  /** Clock reading at touchdown, against which the window is measured. */
  startedAt: number
  /** y where the current leg began -- reset at each accepted reversal. */
  legFromY: number
  /** Which way the current leg runs. 0 until the first leg earns a direction. */
  dir: -1 | 0 | 1
  /** Completed legs, including the one in progress once it passes the leg
   *  length. */
  legs: number
  /** Its latest y. */
  toY: number
  /** Left the strip horizontally, or ran out of window. */
  strayed: boolean
}

function inStrip(p: RailPoint, strip: RailStrip): boolean {
  const x = strip.edge === 'left' ? p.x : strip.padW - p.x
  return x >= 0 && x <= CONFIG.PHONE_REMOTE.RAIL_STRIP_PX
}

/**
 * Start tracking a touch, or reject it outright.
 *
 * Returns null when the touch does not begin inside the edge strip. Requiring
 * the START to be in the strip is most of what protects an ordinary cursor
 * drag: a touch beginning anywhere else can never qualify no matter what it
 * draws next.
 */
export function railSummonBegin(p: RailPoint, strip: RailStrip): RailSummonTrace | null {
  if (!inStrip(p, strip)) return null
  return { fromX: p.x, startedAt: p.t, legFromY: p.y, dir: 0, legs: 0, toY: p.y, strayed: false }
}

/**
 * Fold one move into the trace.
 *
 * Straying outside the strip's horizontal band KILLS the trace rather than
 * pausing it -- a finger that wanders off and comes back has drawn something
 * other than a scrub, and forgiving that is exactly how a diagonal cursor drag
 * near the edge would qualify. The dead trace is kept (not nulled) so the
 * caller can tell "this touch already failed" from "this touch was never a
 * candidate".
 *
 * A leg is counted the moment it passes RAIL_SUMMON_LEG_PX, not when it
 * reverses -- so the third leg of up-down-up fires mid-stroke rather than
 * making the thumb add a fourth. Reversing before that threshold just
 * re-anchors the current leg: sub-threshold wobble is noise, not intent.
 */
export function railSummonMove(
  trace: RailSummonTrace,
  p: RailPoint,
  strip: RailStrip
): RailSummonTrace {
  if (trace.strayed) return trace
  const { RAIL_STRAY_PX, RAIL_SUMMON_LEG_PX, RAIL_SUMMON_WINDOW_MS } = CONFIG.PHONE_REMOTE
  const x = strip.edge === 'left' ? p.x : strip.padW - p.x
  const fromX = strip.edge === 'left' ? trace.fromX : strip.padW - trace.fromX
  if (Math.abs(x - fromX) > RAIL_STRAY_PX) return { ...trace, strayed: true }
  if (p.t - trace.startedAt > RAIL_SUMMON_WINDOW_MS) return { ...trace, strayed: true }

  const next = { ...trace, toY: p.y }
  const dy = p.y - trace.legFromY
  if (Math.abs(dy) < RAIL_SUMMON_LEG_PX) return next
  const dir = dy > 0 ? 1 : -1
  // Same direction as the leg just credited means the thumb never turned
  // around -- one long stroke is one leg, so extend the anchor instead of
  // banking a second. This is what stops a plain long drag down the edge from
  // summoning, now that distance alone no longer qualifies.
  if (dir === trace.dir) return { ...next, legFromY: p.y }
  return { ...next, legFromY: p.y, dir, legs: trace.legs + 1 }
}

/**
 * Has this trace earned the rail? Leg count, not distance: reversing direction
 * is the signal, because a scrub is the one shape ordinary pad work never
 * draws -- a cursor drag runs one way, a two-finger scroll never starts in the
 * strip, and a swipe is a single leg.
 */
export function railSummonQualifies(trace: RailSummonTrace): boolean {
  if (trace.strayed) return false
  return trace.legs >= CONFIG.PHONE_REMOTE.RAIL_SUMMON_LEGS
}

/** Which zone of the rail a y-position falls in, 0..1 normalized against the
 *  rail's own height. The outer bands are rate zones; the middle is ~1:1. */
export type RailZone = 'rateTop' | 'middle' | 'rateBottom'

export function railZone(y: number, h: number): RailZone {
  const t = h <= 0 ? 0.5 : y / h
  const outer = CONFIG.PHONE_REMOTE.RAIL_RATE_ZONE_FRAC
  if (t <= outer) return 'rateTop'
  if (t >= 1 - outer) return 'rateBottom'
  return 'middle'
}

/**
 * Px of scroll to send for one tick at position `y` on a rail of height `h`,
 * elapsed `dtMs` since the last tick.
 *
 * Middle zone: 1:1 with the finger's own motion is handled by the caller (it
 * already has the raw touch delta) -- this function only synthesizes deltas
 * for the two rate zones, where the finger is HELD rather than dragged.
 *
 * Rate sign matches natural scrolling's own convention one level up: a
 * positive return here means "the same signed px `applyScrollDelta` already
 * expects", so the rail must NEVER negate dy a second time.
 */
export function railRateDelta(y: number, h: number, dtMs: number): number {
  const t = h <= 0 ? 0.5 : y / h
  const outer = CONFIG.PHONE_REMOTE.RAIL_RATE_ZONE_FRAC
  let depth = 0
  let sign = 0
  if (t <= outer) {
    depth = outer <= 0 ? 1 : 1 - t / outer
    sign = -1
  } else if (t >= 1 - outer) {
    depth = outer <= 0 ? 1 : (t - (1 - outer)) / outer
    sign = 1
  } else {
    return 0
  }
  const clamped = depth < 0 ? 0 : depth > 1 ? 1 : depth
  const pxPerSec =
    CONFIG.PHONE_REMOTE.RAIL_RATE_MIN_PX_S +
    (CONFIG.PHONE_REMOTE.RAIL_RATE_MAX_PX_S - CONFIG.PHONE_REMOTE.RAIL_RATE_MIN_PX_S) * clamped
  return sign * pxPerSec * (dtMs / 1000)
}

/** Which edge the rail anchors to: the SAME side as the button cluster and the
 *  app ring, so the scrolling thumb never crosses the pad. It occupies the open
 *  strip ABOVE the cluster, which is why sharing the side doesn't collide. */
export function railEdgeFor(handedness: 'left' | 'right'): RailEdge {
  return handedness
}

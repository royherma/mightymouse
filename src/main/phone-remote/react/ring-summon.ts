import { CONFIG } from '@shared/config'
import { onRing, ringPolar, type RingAnchor, type RingBand, type RingPoint } from './app-ring-geometry'

// Summoning the ring by drawing it. While the ring is OFF the arc still has a
// place -- ringBand resolves from the cluster the same way either way -- so the
// gesture that turns it on is simply tracing that band: stay within it and
// sweep far enough along it, and the ring appears under the finger already
// scrubbing.
//
// Pure geometry, no DOM or timers, for the reason the rest of this directory
// splits the same way: a hand-derived arc manufactures fake failure modes
// (memory `harness-must-measure-not-assume`).
//
// The threshold has to survive being wrong in one direction only. The pad under
// this band is a live trackpad, so a false positive steals a cursor drag and
// switches an app; a false negative costs one repeated gesture. Hence a sweep
// requirement near the full quarter rather than a permissive arc detector.

/**
 * What the pad calls to drive a summon. Published as a ref by the layout that
 * owns the geometry, and null whenever there is nothing to summon (the ring is
 * already on, or the band has not been measured).
 *
 * `move` returns true exactly once -- the moment the gesture qualifies. The pad
 * reads that as "this finger belongs to the ring now" and hands the rest of the
 * touch over, so one motion summons and scrubs.
 */
export type RingSummonHandle = {
  start: (t: { clientX: number; clientY: number }) => void
  /** Takes a real Touch, not just a point: qualifying hands the finger to the
   *  ring's scrub, which tracks it by `identifier` for the rest of the gesture. */
  move: (t: Touch) => boolean
  end: () => void
}

/** Live state of one finger being watched. Null `t` until it first lands on the band. */
export type SummonTrace = {
  /** Arc position where the finger entered the band. */
  fromT: number
  /** Its latest arc position. */
  toT: number
  /** Total swept arc, ignoring direction reversals -- see summonSweep. */
  swept: number
  /** Set once the finger leaves the band's radius: the trace is dead. */
  strayed: boolean
}

/**
 * Start tracking a touch, or reject it outright.
 *
 * Returns null when the touch does not begin on the band. Requiring the START
 * to be on the band is most of what keeps ordinary cursor drags intact: the
 * band is a thin annulus around the cluster corner, and a drag beginning
 * anywhere else can never qualify no matter what shape it draws.
 */
export function summonBegin(
  p: RingPoint,
  anchor: RingAnchor,
  band: RingBand,
  mirrored: boolean
): SummonTrace | null {
  const polar = ringPolar(p, anchor, band, mirrored)
  if (!onRing(polar.dist, band)) return null
  return { fromT: polar.t, toT: polar.t, swept: 0, strayed: false }
}

/**
 * Fold one move into the trace.
 *
 * Straying outside the band KILLS the trace rather than pausing it: a finger
 * that wanders off the arc and returns has drawn something other than the ring,
 * and forgiving that is exactly how a cursor drag around the corner would
 * qualify. The dead trace is kept (not nulled) so the caller can tell "this
 * touch already failed" from "this touch was never a candidate".
 */
export function summonMove(
  trace: SummonTrace,
  p: RingPoint,
  anchor: RingAnchor,
  band: RingBand,
  mirrored: boolean
): SummonTrace {
  if (trace.strayed) return trace
  const polar = ringPolar(p, anchor, band, mirrored)
  // Tolerance beyond the painted band: the finger is tracing a band it cannot
  // see yet, so holding it to the exact stroke width would make the gesture a
  // guess. Radius only -- the angle is already clamped to the quarter.
  if (!onRing(polar.dist, band, CONFIG.PHONE_REMOTE.APP_RING_SUMMON_SLACK_PX)) {
    return { ...trace, strayed: true }
  }
  return {
    ...trace,
    toT: polar.t,
    // Accumulated |delta|, not |toT - fromT|: a sweep out and back covers real
    // arc but nets to zero, and that is a scrub, not a stray. Summing the
    // absolute steps counts the distance the finger actually travelled.
    swept: trace.swept + Math.abs(polar.t - trace.toT)
  }
}

/**
 * Has this trace earned the ring?
 *
 * Measured in ARC PX rather than normalized t, for the same reason
 * ringNearness is: the same angle is a very different finger movement on a
 * small pad than a large one, and the gesture should feel like one distance.
 */
export function summonQualifies(trace: SummonTrace, band: RingBand): boolean {
  if (trace.strayed) return false
  const arcPx = trace.swept * band.radius * (Math.PI / 2)
  return arcPx >= CONFIG.PHONE_REMOTE.APP_RING_SUMMON_ARC_PX
}

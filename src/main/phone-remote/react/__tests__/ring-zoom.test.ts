/**
 * The zoom track's geometry and its scale mapping.
 *
 * Two things are load-bearing here and neither is visible on glass:
 *   - the track must never overlap the app ring (they'd fight for the same
 *     touch, and the outer one would win by radius);
 *   - it must return null rather than a clipped band, because a half-drawn
 *     arc reads as a rendering bug rather than as "no room".
 */

import { describe, expect, it } from 'vitest'
import { CONFIG } from '@shared/config'
import {
  onRing,
  ringBand,
  ringZoomBand,
  ringZoomScale,
  ringZoomT,
  ringZoomTrackT,
  ringZoomTrackTInverse,
  type RingAnchor,
  type RingBand
} from '../app-ring-geometry'

const { MIRROR_ZOOM_MIN: MIN, MIRROR_ZOOM_MAX: MAX } = CONFIG.PHONE_REMOTE

/** A roomy portrait pad, cluster in the bottom-right. The numbers are the
 *  shape TouchpadLayout measures, not invented: a pad wide enough that both
 *  bands fit, so a test that wants the no-room case has to ask for it. */
function anchor(over: Partial<RingAnchor> = {}): RingAnchor {
  return {
    cx: 360,
    cy: 620,
    clusterX: 150,
    clusterY: 120,
    reachX: 340,
    reachY: 600,
    padW: 360,
    padH: 620,
    keysPosition: 'bottom',
    ...over
  }
}

describe('ringZoomT / ringZoomScale', () => {
  it('puts the ends of the arc at the ends of the zoom range', () => {
    expect(ringZoomT(MIN)).toBe(0)
    expect(ringZoomT(MAX)).toBe(1)
    expect(ringZoomScale(0)).toBe(MIN)
    expect(ringZoomScale(1)).toBe(MAX)
  })

  it('round-trips any scale in range', () => {
    for (const scale of [1, 1.2, 1.87, 2.5, 3.33, 4]) {
      expect(ringZoomScale(ringZoomT(scale))).toBeCloseTo(scale, 6)
    }
  })

  // The whole reason this is linear rather than logarithmic: ZoomBar's `pct`
  // is linear, and two zoom surfaces disagreeing about where 2x sits is the
  // two-derivations-of-one-decision bug this directory has had three times.
  it('agrees with ZoomBar: the midpoint of the track is the midpoint of the range', () => {
    expect(ringZoomScale(0.5)).toBeCloseTo((MIN + MAX) / 2, 6)
    expect(ringZoomT((MIN + MAX) / 2)).toBeCloseTo(0.5, 6)
  })

  it('clamps rather than extrapolating past either end', () => {
    expect(ringZoomT(MIN - 10)).toBe(0)
    expect(ringZoomT(MAX + 10)).toBe(1)
    expect(ringZoomScale(-1)).toBe(MIN)
    expect(ringZoomScale(2)).toBe(MAX)
  })
})

describe('ringZoomBand', () => {
  it('sits entirely outside the app ring, with no overlap', () => {
    const a = anchor()
    const app = ringBand(a)
    expect(app).not.toBeNull()
    const zoom = ringZoomBand(a, app)
    expect(zoom).not.toBeNull()
    // The gap is real clearance between the two strokes, not centre-to-centre.
    expect(zoom!.rMin).toBeGreaterThanOrEqual(app!.rMax)
    expect(zoom!.rMin - app!.rMax).toBeCloseTo(CONFIG.PHONE_REMOTE.RING_ZOOM_GAP_PX, 6)
  })

  it('never lets the zoom track reach back over the app ring stroke', () => {
    const a = anchor()
    const app = ringBand(a)!
    const zoom = ringZoomBand(a, app)!
    // The strokes sit RING_ZOOM_GAP_PX apart, closer than the app ring's own
    // grab slack, so their tolerance zones do meet in the seam -- the outer
    // band takes those by radius, which is fine. What must never happen is the
    // zoom track claiming a touch on the app ring's PAINTED stroke, where the
    // eye is aiming at an app icon.
    const zoomSlack = CONFIG.PHONE_REMOTE.RING_ZOOM_GRAB_SLACK_PX
    for (let d = app.rMin; d <= app.rMax; d += 0.5) {
      expect(onRing(d, zoom, zoomSlack)).toBe(false)
    }
  })

  // The user's ask, and the reason the solo case exists at all: the track is
  // there whether or not the switcher is on, AT THE SAME RADIUS either way.
  // A control that moves when an unrelated setting is toggled is one the thumb
  // has to find again (Roy, on device).
  it('sits at the same radius whether or not the app ring is painted', () => {
    const a = anchor()
    const withRing = ringZoomBand(a, ringBand(a))
    const solo = ringZoomBand(a, null)
    expect(withRing).not.toBeNull()
    expect(solo).not.toBeNull()
    expect(solo!.radius).toBeCloseTo(withRing!.radius, 6)
    expect(solo!.rMin).toBeGreaterThan(0)
  })

  it('clears the control cluster when it stands alone', () => {
    const a = anchor()
    const solo = ringZoomBand(a, null)!
    // Same floor ringBand enforces: the band must not cut through the buttons.
    expect(solo.rMin).toBeGreaterThanOrEqual(Math.max(a.clusterX, a.clusterY))
  })

  it('returns null rather than a band clipped by the pad edge', () => {
    // Reach barely past the app ring: enough for the inner band, not the outer.
    const a = anchor({ reachX: 190, reachY: 190, padW: 200, padH: 200 })
    const app = ringBand(a)
    const zoom = ringZoomBand(a, app)
    if (zoom) {
      expect(zoom.rMax).toBeLessThanOrEqual(Math.min(a.reachX, a.reachY))
    } else {
      expect(zoom).toBeNull()
    }
  })

  it('never returns a band wider than the room it has', () => {
    // Sweep pad sizes; whatever survives must fit, and the rest must be null.
    for (let reach = 60; reach <= 400; reach += 5) {
      const a = anchor({ reachX: reach, reachY: reach, padW: reach, padH: reach })
      const zoom = ringZoomBand(a, ringBand(a))
      if (!zoom) continue
      expect(zoom.rMax).toBeLessThanOrEqual(reach)
      expect(zoom.rMin).toBeGreaterThan(0)
      expect(zoom.band).toBe(CONFIG.PHONE_REMOTE.RING_ZOOM_BAND_PX)
    }
  })

  it('keeps the app ring when the zoom track cannot fit', () => {
    // The incumbent wins ties: a pad too small for both still gets a switcher.
    const a = anchor({ reachX: 150, reachY: 150, padW: 160, padH: 160 })
    expect(ringBand(a)).not.toBeNull()
    // Whatever ringZoomBand decides, it must not have changed the app ring.
    const before = ringBand(a)
    ringZoomBand(a, before)
    expect(ringBand(a)).toEqual(before)
  })
})

describe('ringZoomTrackT — the end inset', () => {
  const band = (): RingBand => {
    const b = ringZoomBand(anchor(), ringBand(anchor()))
    if (!b) throw new Error('the roomy fixture must produce a band')
    return b
  }

  it('keeps both extremes off the arc ends', () => {
    // The whole point: t=0 and t=1 land ON the two pad edges the radius is
    // capped against, so a knob centred there hangs half off the pad.
    const b = band()
    expect(ringZoomTrackT(0, b)).toBeGreaterThan(0)
    expect(ringZoomTrackT(1, b)).toBeLessThan(1)
  })

  it('clears the edge by at least the knob radius', () => {
    // In ARC PX, which is what a thumb actually travels -- a fraction alone
    // would pass on a huge band and fail on a small one.
    const b = band()
    const arcPx = b.radius * (Math.PI / 2)
    const knobR = CONFIG.PHONE_REMOTE.RING_ZOOM_KNOB_PX / 2
    expect(ringZoomTrackT(0, b) * arcPx).toBeGreaterThanOrEqual(knobR)
    expect((1 - ringZoomTrackT(1, b)) * arcPx).toBeGreaterThanOrEqual(knobR)
  })

  it('insets both ends equally, so the track stays centred on the arc', () => {
    const b = band()
    expect(ringZoomTrackT(0, b)).toBeCloseTo(1 - ringZoomTrackT(1, b), 10)
  })

  it('round-trips every zoom position', () => {
    // Paint uses the forward map and the drag uses the inverse; a mismatch
    // means the knob renders somewhere the thumb cannot put it.
    const b = band()
    for (const t of [0, 0.13, 0.5, 0.77, 1]) {
      expect(ringZoomTrackTInverse(ringZoomTrackT(t, b), b)).toBeCloseTo(t, 10)
    }
  })

  it('clamps a thumb inside either inset end to that extreme', () => {
    // The gap must read as "the end of the range", never as a dead strip that
    // stops responding -- that is the symptom this whole change fixes.
    const b = band()
    expect(ringZoomTrackTInverse(0, b)).toBe(0)
    expect(ringZoomTrackTInverse(1, b)).toBe(1)
  })

  it('never inverts on a tiny band', () => {
    // A band whose arc is shorter than two insets would otherwise produce a
    // start past its own end, painting the fill backwards.
    const tiny = { radius: 8, band: 34, rMin: 0, rMax: 25 }
    expect(ringZoomTrackT(0, tiny)).toBeLessThan(ringZoomTrackT(1, tiny))
  })
})

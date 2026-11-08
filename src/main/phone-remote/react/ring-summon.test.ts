import { describe, expect, it } from 'vitest'
import { CONFIG } from '@shared/config'
import { ringBand, ringPointAt, type RingAnchor } from './app-ring-geometry'
import { summonBegin, summonMove, summonQualifies } from './ring-summon'

// A right-handed bottom-keys deck: the cluster hugs the pad's bottom-right, so
// the arc sweeps up and to the left from that corner. Sized so ringBand finds
// room -- the anchor is what the real hook measures, not a hand-drawn one.
const anchor: RingAnchor = {
  cx: 360,
  cy: 400,
  clusterX: 120,
  clusterY: 80,
  // The pad sets the radius, and the radius sets the arc length a summon has
  // to cover. Big enough here that a full sweep clears APP_RING_SUMMON_ARC_PX.
  padW: 700,
  padH: 700,
  reachX: 360,
  reachY: 400,
  keysPosition: 'bottom'
}
const band = ringBand(anchor)!
const MIRRORED = false

/** Walk the band's centerline from t0 to t1 in `steps` moves. */
function traceArc(t0: number, t1: number, steps = 24) {
  let trace = summonBegin(ringPointAt(t0, anchor, band, MIRRORED), anchor, band, MIRRORED)
  if (!trace) return null
  for (let i = 1; i <= steps; i++) {
    const t = t0 + ((t1 - t0) * i) / steps
    trace = summonMove(trace, ringPointAt(t, anchor, band, MIRRORED), anchor, band, MIRRORED)
  }
  return trace
}

describe('ringBand fixture', () => {
  it('resolves a band for the test anchor', () => {
    expect(band).toBeTruthy()
  })
})

describe('summonBegin', () => {
  it('accepts a touch landing on the band', () => {
    expect(summonBegin(ringPointAt(0.5, anchor, band, MIRRORED), anchor, band, MIRRORED)).not.toBeNull()
  })

  it('rejects a touch in the open pad, away from the band', () => {
    // Mid-pad, far inside the arc's radius: an ordinary cursor drag's origin.
    expect(summonBegin({ x: 80, y: 80 }, anchor, band, MIRRORED)).toBeNull()
  })

  it('rejects a touch inside the cluster, under the buttons', () => {
    expect(summonBegin({ x: anchor.cx - 10, y: anchor.cy - 10 }, anchor, band, MIRRORED)).toBeNull()
  })
})

describe('summonQualifies', () => {
  it('accepts a near-full sweep along the band', () => {
    const trace = traceArc(0, 1)!
    expect(trace.strayed).toBe(false)
    expect(summonQualifies(trace, band)).toBe(true)
  })

  it('rejects a short nudge along the band', () => {
    const trace = traceArc(0.4, 0.5)!
    expect(summonQualifies(trace, band)).toBe(false)
  })

  it('rejects a finger that holds still on the band', () => {
    const trace = traceArc(0.5, 0.5)!
    expect(summonQualifies(trace, band)).toBe(false)
  })

  it('counts a sweep out and back, which nets to zero displacement', () => {
    // Out to the far end and most of the way back: real arc travelled, but
    // |toT - fromT| is small. Summing |delta| is what makes this qualify.
    let trace = traceArc(0.1, 0.9)!
    for (let i = 1; i <= 12; i++) {
      const t = 0.9 - (0.7 * i) / 12
      trace = summonMove(trace, ringPointAt(t, anchor, band, MIRRORED), anchor, band, MIRRORED)
    }
    expect(Math.abs(trace.toT - trace.fromT)).toBeLessThan(0.15)
    expect(summonQualifies(trace, band)).toBe(true)
  })

  it('abandons a trace that leaves the band, even if it sweeps far', () => {
    let trace = summonBegin(ringPointAt(0, anchor, band, MIRRORED), anchor, band, MIRRORED)!
    // Straight across the open pad toward the far corner -- a cursor drag that
    // happens to have started on the band.
    for (let i = 1; i <= 20; i++) {
      trace = summonMove(trace, { x: anchor.cx - i * 15, y: anchor.cy - 4 }, anchor, band, MIRRORED)
    }
    expect(trace.strayed).toBe(true)
    expect(summonQualifies(trace, band)).toBe(false)
  })

  it('stays dead once strayed, even if the finger returns to the band', () => {
    let trace = summonBegin(ringPointAt(0, anchor, band, MIRRORED), anchor, band, MIRRORED)!
    trace = summonMove(trace, { x: 40, y: 40 }, anchor, band, MIRRORED)
    expect(trace.strayed).toBe(true)
    for (let i = 1; i <= 24; i++) {
      trace = summonMove(trace, ringPointAt(i / 24, anchor, band, MIRRORED), anchor, band, MIRRORED)
    }
    expect(summonQualifies(trace, band)).toBe(false)
  })

  it('tolerates a wobble within the slack, without straying', () => {
    let trace = summonBegin(ringPointAt(0, anchor, band, MIRRORED), anchor, band, MIRRORED)!
    // Ride the centerline but drift radially by less than the slack allowance.
    const drift = CONFIG.PHONE_REMOTE.APP_RING_SUMMON_SLACK_PX / 2
    for (let i = 1; i <= 24; i++) {
      const t = i / 24
      const p = ringPointAt(t, anchor, band, MIRRORED)
      const push = i % 2 === 0 ? drift : -drift
      // Push along the radius from the corner, so only `dist` changes.
      const len = Math.hypot(p.x - anchor.cx, p.y - anchor.cy)
      const ux = (p.x - anchor.cx) / len
      const uy = (p.y - anchor.cy) / len
      trace = summonMove(trace, { x: p.x + ux * push, y: p.y + uy * push }, anchor, band, MIRRORED)
    }
    expect(trace.strayed).toBe(false)
    expect(summonQualifies(trace, band)).toBe(true)
  })
})

describe('mirrored (left-handed) deck', () => {
  const leftAnchor: RingAnchor = { ...anchor, cx: 30 }
  const leftBand = ringBand(leftAnchor)!

  it('summons on the same sweep with handedness flipped', () => {
    let trace = summonBegin(ringPointAt(0, leftAnchor, leftBand, true), leftAnchor, leftBand, true)!
    for (let i = 1; i <= 24; i++) {
      trace = summonMove(trace, ringPointAt(i / 24, leftAnchor, leftBand, true), leftAnchor, leftBand, true)
    }
    expect(summonQualifies(trace, leftBand)).toBe(true)
  })
})

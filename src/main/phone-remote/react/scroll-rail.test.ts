import { describe, expect, it } from 'vitest'
import { CONFIG } from '@shared/config'
import {
  railSummonBegin,
  railSummonMove,
  railSummonQualifies,
  railZone,
  railRateDelta,
  railEdgeFor,
  type RailStrip,
  type RailSummonTrace
} from './scroll-rail'

const leftStrip: RailStrip = { edge: 'left', padW: 700 }
const rightStrip: RailStrip = { edge: 'right', padW: 700 }

describe('railEdgeFor', () => {
  // Same side as the cluster and the ring, never the opposite edge: the island
  // fills the space above the buttons so the thumb never crosses the pad.
  it('defaults to right when right-handed', () => {
    expect(railEdgeFor('right')).toBe('right')
  })
  it('follows the hand to the left', () => {
    expect(railEdgeFor('left')).toBe('left')
  })
})

describe('railSummonBegin', () => {
  it('accepts a touch starting inside the left strip', () => {
    expect(railSummonBegin({ x: 10, y: 200, t: 0 }, leftStrip)).not.toBeNull()
  })

  it('rejects a touch starting mid-pad, off-strip', () => {
    expect(railSummonBegin({ x: 350, y: 200, t: 0 }, leftStrip)).toBeNull()
  })

  it('accepts a touch starting inside the right strip', () => {
    expect(railSummonBegin({ x: 690, y: 200, t: 0 }, rightStrip)).not.toBeNull()
  })

  it('rejects a touch on the wrong edge for the strip', () => {
    // Near the pad's right edge while the strip watches the left.
    expect(railSummonBegin({ x: 690, y: 200, t: 0 }, leftStrip)).toBeNull()
  })
})

describe('railSummonMove / railSummonQualifies', () => {
  const { RAIL_SUMMON_LEG_PX, RAIL_SUMMON_WINDOW_MS, RAIL_STRAY_PX } = CONFIG.PHONE_REMOTE
  const leg = RAIL_SUMMON_LEG_PX + 4

  /** Walk one leg of `dy` from the trace's latest y, in 4px steps on a clock
   *  that advances 16ms per step -- a real touchmove stream, not one jump. */
  const scrub = (
    trace: RailSummonTrace,
    dy: number,
    opts: { x?: number; t0?: number } = {}
  ): RailSummonTrace => {
    const x = opts.x ?? 10
    let t = opts.t0 ?? 0
    let next = trace
    const step = dy > 0 ? 4 : -4
    for (let moved = 0; Math.abs(moved) < Math.abs(dy); moved += step) {
      t += 16
      next = railSummonMove(next, { x, y: next.toY + step, t }, leftStrip)
    }
    return next
  }

  it('qualifies an up-down-up scrub', () => {
    let trace = railSummonBegin({ x: 10, y: 300, t: 0 }, leftStrip)!
    trace = scrub(trace, -leg)
    trace = scrub(trace, leg, { t0: 200 })
    trace = scrub(trace, -leg, { t0: 400 })
    expect(trace.strayed).toBe(false)
    expect(trace.legs).toBe(3)
    expect(railSummonQualifies(trace)).toBe(true)
  })

  it('qualifies the mirrored down-up-down scrub', () => {
    let trace = railSummonBegin({ x: 10, y: 100, t: 0 }, leftStrip)!
    trace = scrub(trace, leg)
    trace = scrub(trace, -leg, { t0: 200 })
    trace = scrub(trace, leg, { t0: 400 })
    expect(railSummonQualifies(trace)).toBe(true)
  })

  it('rejects two legs -- a back-and-forth correction is not a summon', () => {
    let trace = railSummonBegin({ x: 10, y: 300, t: 0 }, leftStrip)!
    trace = scrub(trace, -leg)
    trace = scrub(trace, leg, { t0: 200 })
    expect(trace.legs).toBe(2)
    expect(railSummonQualifies(trace)).toBe(false)
  })

  it('does not bank a second leg for one long stroke, however far it runs', () => {
    // The case distance-based qualifying used to accept: a plain drag down the
    // edge, now 10x the leg length and still one leg.
    let trace = railSummonBegin({ x: 10, y: 50, t: 0 }, leftStrip)!
    trace = scrub(trace, RAIL_SUMMON_LEG_PX * 10)
    expect(trace.legs).toBe(1)
    expect(railSummonQualifies(trace)).toBe(false)
  })

  it('treats sub-threshold wobble as noise, not reversals', () => {
    let trace = railSummonBegin({ x: 10, y: 200, t: 0 }, leftStrip)!
    let t = 0
    for (let i = 0; i < 12; i++) {
      t += 16
      const y = 200 + (i % 2 === 0 ? RAIL_SUMMON_LEG_PX - 6 : 0)
      trace = railSummonMove(trace, { x: 10, y, t }, leftStrip)
    }
    expect(trace.legs).toBe(0)
    expect(railSummonQualifies(trace)).toBe(false)
  })

  it('kills a scrub that drags past the window', () => {
    let trace = railSummonBegin({ x: 10, y: 300, t: 0 }, leftStrip)!
    trace = scrub(trace, -leg)
    trace = scrub(trace, leg, { t0: 200 })
    // Third leg arrives after the window closes.
    trace = scrub(trace, -leg, { t0: RAIL_SUMMON_WINDOW_MS + 100 })
    expect(trace.strayed).toBe(true)
    expect(railSummonQualifies(trace)).toBe(false)
  })

  it('a stray horizontal wander kills the trace permanently', () => {
    let trace = railSummonBegin({ x: 10, y: 300, t: 0 }, leftStrip)!
    trace = railSummonMove(trace, { x: 10 + RAIL_STRAY_PX + 5, y: 280, t: 16 }, leftStrip)
    expect(trace.strayed).toBe(true)
    // Even if the finger comes back and scrubs a full qualifying shape.
    trace = scrub(trace, -leg, { t0: 100 })
    trace = scrub(trace, leg, { t0: 300 })
    trace = scrub(trace, -leg, { t0: 500 })
    expect(trace.strayed).toBe(true)
    expect(railSummonQualifies(trace)).toBe(false)
  })

  it('tolerates a wander within the stray slack', () => {
    let trace = railSummonBegin({ x: 10, y: 300, t: 0 }, leftStrip)!
    const x = 10 + (RAIL_STRAY_PX - 2)
    trace = scrub(trace, -leg, { x })
    trace = scrub(trace, leg, { x, t0: 200 })
    trace = scrub(trace, -leg, { x, t0: 400 })
    expect(trace.strayed).toBe(false)
    expect(railSummonQualifies(trace)).toBe(true)
  })

  it('a diagonal drag starting in the strip but running far sideways is a stray, not a summon', () => {
    // The false-positive case the PRD ship gate calls out: an ordinary cursor
    // drag that begins in the edge strip and runs diagonally.
    let trace = railSummonBegin({ x: 10, y: 100, t: 0 }, leftStrip)!
    for (let i = 1; i <= 20; i++) {
      trace = railSummonMove(trace, { x: 10 + i * 15, y: 100 + i * 10, t: i * 16 }, leftStrip)
    }
    expect(trace.strayed).toBe(true)
    expect(railSummonQualifies(trace)).toBe(false)
  })
})

describe('railZone', () => {
  const h = 300
  it('top rate zone at the very top', () => {
    expect(railZone(0, h)).toBe('rateTop')
  })
  it('bottom rate zone at the very bottom', () => {
    expect(railZone(h, h)).toBe('rateBottom')
  })
  it('middle at the center', () => {
    expect(railZone(h / 2, h)).toBe('middle')
  })
  it('boundary exactly at the top zone edge is still rate', () => {
    const frac = CONFIG.PHONE_REMOTE.RAIL_RATE_ZONE_FRAC
    expect(railZone(h * frac, h)).toBe('rateTop')
  })
  it('just past the top zone edge is middle', () => {
    const frac = CONFIG.PHONE_REMOTE.RAIL_RATE_ZONE_FRAC
    expect(railZone(h * frac + 1, h)).toBe('middle')
  })
})

describe('railRateDelta', () => {
  const h = 300

  it('is zero in the middle zone', () => {
    expect(railRateDelta(h / 2, h, 16)).toBe(0)
  })

  it('is negative (scroll up) at the very top', () => {
    expect(railRateDelta(0, h, 16)).toBeLessThan(0)
  })

  it('is positive (scroll down) at the very bottom', () => {
    expect(railRateDelta(h, h, 16)).toBeGreaterThan(0)
  })

  it('magnitude grows toward the extreme within the top zone', () => {
    const frac = CONFIG.PHONE_REMOTE.RAIL_RATE_ZONE_FRAC
    const nearEdge = Math.abs(railRateDelta(h * frac * 0.9, h, 16))
    const atTip = Math.abs(railRateDelta(0, h, 16))
    expect(atTip).toBeGreaterThan(nearEdge)
  })

  it('scales linearly with elapsed time', () => {
    const d16 = railRateDelta(0, h, 16)
    const d32 = railRateDelta(0, h, 32)
    expect(d32).toBeCloseTo(d16 * 2, 5)
  })

  it('never negates a second time -- sign is stable across the whole top zone', () => {
    const frac = CONFIG.PHONE_REMOTE.RAIL_RATE_ZONE_FRAC
    for (let t = 0; t <= frac; t += frac / 10) {
      expect(railRateDelta(h * t, h, 16)).toBeLessThanOrEqual(0)
    }
  })
})

import { describe, expect, it } from 'vitest'
import { MOVE_FAST_PX, MOVE_SLOW_MULTIPLIER, MOVE_SLOW_PX, moveGainForSpeed } from '../pointer-accel'

// The curve exists so a high sensitivity slider
// stops amplifying hand jitter as hard as it amplifies intent. These lock in the
// two ends -- a fixed precision speed when slow, full reach when fast -- and the
// monotonic ramp between them, since a non-monotonic gain would make the cursor
// surge mid-stroke.
describe('moveGainForSpeed', () => {
  it('resolves a slow finger to the same absolute speed at every sensitivity', () => {
    // The property that makes accuracy reachable at 20x: the slow end does NOT
    // scale with the slider. Regression guard for the original fraction-based
    // floor, where 20x meant a 10x "precision" mode.
    for (const s of [5, 10, 20]) {
      expect(s * moveGainForSpeed(0, s)).toBeCloseTo(MOVE_SLOW_MULTIPLIER)
      expect(s * moveGainForSpeed(MOVE_SLOW_PX, s)).toBeCloseTo(MOVE_SLOW_MULTIPLIER)
    }
  })

  it('gives a deliberately fast finger the full sensitivity multiplier', () => {
    expect(moveGainForSpeed(MOVE_FAST_PX, 20)).toBe(1)
    expect(moveGainForSpeed(200, 20)).toBe(1)
  })

  it('never accelerates a slider set below the precision speed', () => {
    // At 0.5x the user has asked for something slower than the floor targets;
    // the curve must pass it through, not speed it up.
    expect(moveGainForSpeed(0, 0.5)).toBe(1)
    expect(moveGainForSpeed(MOVE_FAST_PX, 0.5)).toBe(1)
    // Anything at or below the precision speed passes straight through.
    expect(moveGainForSpeed(0, MOVE_SLOW_MULTIPLIER)).toBe(1)
  })

  it('ramps monotonically between the two, never exceeding 1', () => {
    for (const s of [0.5, 5, 20]) {
      let prev = -Infinity
      for (let px = 0; px <= 30; px += 0.5) {
        const g = moveGainForSpeed(px, s)
        expect(g).toBeGreaterThanOrEqual(prev)
        expect(g).toBeLessThanOrEqual(1)
        prev = g
      }
    }
  })

  it('keeps a fine-positioning nudge walkable onto a target at max sensitivity', () => {
    // 1.5px/tick finger at 20x landed 15px per tick under the old fraction
    // floor -- past any small target. The absolute floor brings it to ~7.5px,
    // the same precision a 10x slider always had.
    expect(1.5 * 20 * moveGainForSpeed(1.5, 20)).toBeLessThan(9)
  })
})

import { describe, it, expect } from 'vitest'
import { zoomLevelToPercent, zoomPercentToLevel } from '../zoom'
import { CONFIG } from '../config'

describe('zoomLevelToPercent', () => {
  it('maps the default level to 100%', () => {
    expect(zoomLevelToPercent(CONFIG.MIGHTY.ZOOM.DEFAULT_LEVEL)).toBe(100)
  })
  it('applies the 1.2^level curve, not a linear one', () => {
    expect(zoomLevelToPercent(1)).toBe(120)
    expect(zoomLevelToPercent(2)).toBe(144) // 1.2^2 — linear would say 140
    expect(zoomLevelToPercent(-1)).toBe(83) // 1/1.2
  })
  it('rounds to a whole percent', () => {
    expect(Number.isInteger(zoomLevelToPercent(0.5))).toBe(true)
  })
})

describe('zoomPercentToLevel', () => {
  it('inverts zoomLevelToPercent', () => {
    for (const level of [-3, -1, 0, 1, 2.5]) {
      expect(zoomPercentToLevel(zoomLevelToPercent(level))).toBeCloseTo(level, 1)
    }
  })
})

describe('CONFIG.MIGHTY.ZOOM bounds', () => {
  // The config comment promises the clamp lands on ~50%–200%. If someone retunes
  // MIN/MAX_LEVEL, this fails rather than letting the comment quietly go stale.
  it('clamps to roughly 50%-200%', () => {
    expect(zoomLevelToPercent(CONFIG.MIGHTY.ZOOM.MIN_LEVEL)).toBeGreaterThanOrEqual(45)
    expect(zoomLevelToPercent(CONFIG.MIGHTY.ZOOM.MIN_LEVEL)).toBeLessThanOrEqual(55)
    expect(zoomLevelToPercent(CONFIG.MIGHTY.ZOOM.MAX_LEVEL)).toBeGreaterThanOrEqual(190)
    expect(zoomLevelToPercent(CONFIG.MIGHTY.ZOOM.MAX_LEVEL)).toBeLessThanOrEqual(210)
  })
  it('steps by a level that produces a visible change', () => {
    const stepped = zoomLevelToPercent(CONFIG.MIGHTY.ZOOM.DEFAULT_LEVEL - CONFIG.MIGHTY.ZOOM.STEP)
    expect(stepped).toBeLessThan(100)
    expect(stepped).toBeGreaterThan(80)
  })
})

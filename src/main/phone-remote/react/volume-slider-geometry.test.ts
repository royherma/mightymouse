import { describe, it, expect } from 'vitest'
import { volumeFromTouch, crossedDetent } from './volume-slider-geometry'

// Track spanning y=100 (top) to y=200 (bottom).
const TOP = 100
const HEIGHT = 100

describe('volumeFromTouch', () => {
  it('maps the track top to 100 and the bottom to 0', () => {
    expect(volumeFromTouch(TOP, TOP, HEIGHT)).toBe(100)
    expect(volumeFromTouch(TOP + HEIGHT, TOP, HEIGHT)).toBe(0)
  })

  it('is inverted relative to screen Y', () => {
    // A touch a quarter of the way DOWN the track is three quarters volume.
    expect(volumeFromTouch(TOP + 25, TOP, HEIGHT)).toBe(75)
    expect(volumeFromTouch(TOP + 50, TOP, HEIGHT)).toBe(50)
  })

  it('pins to an extreme when the drag slides off either end', () => {
    expect(volumeFromTouch(TOP - 400, TOP, HEIGHT)).toBe(100)
    expect(volumeFromTouch(TOP + HEIGHT + 400, TOP, HEIGHT)).toBe(0)
  })

  it('returns 0 for a zero-height track rather than dividing by zero', () => {
    expect(volumeFromTouch(TOP, TOP, 0)).toBe(0)
  })
})

describe('crossedDetent', () => {
  it('fires once per step boundary, not per frame', () => {
    // Same 5-wide bucket -> no tick.
    expect(crossedDetent(50, 52)).toBe(false)
    expect(crossedDetent(50, 54)).toBe(false)
    // Into the next bucket -> tick.
    expect(crossedDetent(50, 55)).toBe(true)
  })

  it('fires when dragging down as well as up', () => {
    expect(crossedDetent(55, 49)).toBe(true)
  })

  it('ticks once for a jump spanning several steps', () => {
    expect(crossedDetent(10, 90)).toBe(true)
  })
})

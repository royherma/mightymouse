import { describe, expect, it, beforeEach } from 'vitest'
import { clampRect, rectFits, viewportReady } from '../hooks/use-floating-rect'
import type { FloatingRectOptions } from '../hooks/use-floating-rect'

const OPTS: FloatingRectOptions = {
  prefKey: 'test-rect',
  aspect: 4 / 3,
  minW: 84,
  maxW: 320,
  defaultW: 132,
  place: (w) => ({ x: 1000 - w, y: 0 })
}

function viewport(w: number, h: number): void {
  ;(globalThis as unknown as { window: { innerWidth: number; innerHeight: number } }).window = {
    innerWidth: w,
    innerHeight: h
  }
}

describe('clampRect', () => {
  beforeEach(() => viewport(390, 844))

  it('holds a rect that already fits', () => {
    expect(clampRect({ x: 20, y: 40, w: 132 }, OPTS)).toEqual({ x: 20, y: 40, w: 132 })
  })

  it('pulls a rect back inside the right and bottom edges', () => {
    // 132 wide / 99 tall, so the furthest legal origin is 258,745.
    expect(clampRect({ x: 999, y: 999, w: 132 }, OPTS)).toEqual({ x: 258, y: 745, w: 132 })
  })

  it('pulls a negative origin back to the top-left', () => {
    expect(clampRect({ x: -50, y: -50, w: 132 }, OPTS)).toEqual({ x: 0, y: 0, w: 132 })
  })

  it('clamps width to the min/max before deriving height', () => {
    expect(clampRect({ x: 0, y: 800, w: 10 }, OPTS).w).toBe(84)
    expect(clampRect({ x: 0, y: 0, w: 9999 }, OPTS).w).toBe(320)
  })

  it('never returns a negative origin on a viewport smaller than the rect', () => {
    viewport(60, 60)
    expect(clampRect({ x: 10, y: 10, w: 320 }, OPTS)).toEqual({ x: 0, y: 0, w: 320 })
  })
})

describe('viewportReady', () => {
  it('is false before the webview has laid out', () => {
    viewport(0, 0)
    expect(viewportReady()).toBe(false)
  })

  it('is true once there are real dimensions', () => {
    viewport(390, 844)
    expect(viewportReady()).toBe(true)
  })
})

describe('rectFits', () => {
  it('accepts anything while the viewport is unmeasurable, so nothing is welded to an edge', () => {
    viewport(0, 0)
    expect(rectFits({ x: 900, y: 900, w: 132 }, 4 / 3)).toBe(true)
  })

  it('rejects a rect saved under a wider viewport', () => {
    viewport(390, 844)
    expect(rectFits({ x: 700, y: 40, w: 132 }, 4 / 3)).toBe(false)
  })

  it('accepts a rect that lands exactly on the far edge', () => {
    viewport(390, 844)
    expect(rectFits({ x: 258, y: 745, w: 132 }, 4 / 3)).toBe(true)
  })
})

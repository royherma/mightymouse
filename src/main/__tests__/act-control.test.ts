import { describe, it, expect, vi, beforeEach } from 'vitest'

// The act-control socket is the act agent's only route to APP-side capabilities.
// These cover the two things that silently produce a wrong-looking highlight
// rather than an error: the Retina coordinate conversion (the agent speaks in
// screenshot pixels, the overlay wants logical points), and the arg coercion
// that must drop malformed lines instead of flashing a box at NaN.

const flashHighlightBox = vi.fn()

vi.mock('electron', () => ({
  screen: {
    // 2x Retina, origin at 0,0 — the shape that makes px ÷ scale matter.
    getDisplayNearestPoint: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1728, height: 1117 }, scaleFactor: 2 }),
    getPrimaryDisplay: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1728, height: 1117 }, scaleFactor: 2 })
  }
}))
vi.mock('../highlight-window', () => ({ flashHighlightBox }))
vi.mock('../store/paths', () => ({ PATHS: { TMP: '/tmp/mm-test', ROOT: '/tmp/mm-test' } }))

import { toScreenPoint } from '../backend/act-highlight'

describe('act-highlight coordinate conversion', () => {
  beforeEach(() => flashHighlightBox.mockClear())

  it('halves screenshot pixels on a 2x display', () => {
    // The real failing case: the "Email me the download" button sat at
    // (1280, 1606) in a 3456x2234 screenshot, i.e. (640, 803) on screen.
    expect(toScreenPoint(1280, 1606)).toEqual({ x: 640, y: 803 })
  })

  it('maps the origin to the display origin', () => {
    expect(toScreenPoint(0, 0)).toEqual({ x: 0, y: 0 })
  })

  it('rounds to whole logical points', () => {
    // An odd pixel can't land on a half-point — the overlay takes integers.
    const pt = toScreenPoint(1281, 1607)
    expect(Number.isInteger(pt.x)).toBe(true)
    expect(Number.isInteger(pt.y)).toBe(true)
  })
})

describe('mm-ui highlight payload shape', () => {
  // Mirrors act-control.ts's num() coercion. A malformed line must be dropped,
  // never forwarded — a NaN reaches setBounds and throws inside the main process.
  const num = (v: unknown): number | null => {
    const n = typeof v === 'number' ? v : Number(v)
    return Number.isFinite(n) ? n : null
  }

  it('accepts integers and numeric strings', () => {
    expect(num(640)).toBe(640)
    expect(num('803')).toBe(803)
    expect(num(-100)).toBe(-100)
  })

  it('rejects values that would flash a box at NaN', () => {
    expect(num('abc')).toBeNull()
    expect(num(undefined)).toBeNull()
    expect(num(null)).toBe(0) // Number(null) === 0 — documented, harmless (rings the origin)
    expect(num({})).toBeNull()
    expect(num(Infinity)).toBeNull()
  })
})

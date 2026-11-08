import { describe, it, expect } from 'vitest'
import {
  computeLayout,
  framesMatch,
  isTwoAppLayout,
  TILED_MARGIN_PX,
  type Rect,
  type WindowLayoutKind
} from './geometry'

// A real measured work area: the 1728x1117 display this was developed on,
// menu bar excluded. AX space, so y=34 is just below the menu bar.
const SCREEN: Rect = { x: 0, y: 34, w: 1728, h: 1006 }

/** Every kind, so a new one can't be added without a test touching it. */
const ALL_KINDS: WindowLayoutKind[] = [
  'left',
  'right',
  'top',
  'bottom',
  'full',
  'leftRight',
  'topBottom',
  'quarters',
  'restore'
]

describe('computeLayout — no margins', () => {
  it('full fills the whole work area', () => {
    expect(computeLayout('full', SCREEN, 0)).toEqual([SCREEN])
  })

  it('left and right each take half the width', () => {
    const [left] = computeLayout('left', SCREEN, 0)
    const [right] = computeLayout('right', SCREEN, 0)
    expect(left).toEqual({ x: 0, y: 34, w: 864, h: 1006 })
    expect(right).toEqual({ x: 864, y: 34, w: 864, h: 1006 })
  })

  it('top and bottom each take half the height', () => {
    const [top] = computeLayout('top', SCREEN, 0)
    const [bottom] = computeLayout('bottom', SCREEN, 0)
    expect(top).toEqual({ x: 0, y: 34, w: 1728, h: 503 })
    expect(bottom).toEqual({ x: 0, y: 537, w: 1728, h: 503 })
  })

  it('leftRight returns two rects that tile with no gap and no overlap', () => {
    const [a, b] = computeLayout('leftRight', SCREEN, 0)
    expect(a.x + a.w).toBe(b.x)
    expect(a.w + b.w).toBe(SCREEN.w)
    expect(a.y).toBe(b.y)
    expect(a.h).toBe(b.h)
  })

  it('topBottom stacks with no gap and no overlap', () => {
    const [a, b] = computeLayout('topBottom', SCREEN, 0)
    expect(a.y + a.h).toBe(b.y)
    expect(a.h + b.h).toBe(SCREEN.h)
  })

  it('quarters puts both apps in the TOP half, side by side', () => {
    const [a, b] = computeLayout('quarters', SCREEN, 0)
    expect(a.h).toBe(503)
    expect(b.h).toBe(503)
    expect(a.y).toBe(SCREEN.y)
    expect(b.y).toBe(SCREEN.y)
    expect(a.x + a.w).toBe(b.x)
  })

  it('restore computes nothing — it replays a stash', () => {
    expect(computeLayout('restore', SCREEN, 0)).toEqual([])
  })
})

describe('computeLayout — with tiled margins', () => {
  const M = TILED_MARGIN_PX

  it('insets every edge of a full-screen layout', () => {
    const [full] = computeLayout('full', SCREEN, M)
    expect(full).toEqual({ x: M, y: 34 + M, w: 1728 - M * 2, h: 1006 - M * 2 })
  })

  it('leaves exactly one margin BETWEEN two tiled windows', () => {
    const [a, b] = computeLayout('leftRight', SCREEN, M)
    expect(b.x - (a.x + a.w)).toBe(M)
  })

  it('keeps both windows inside the work area', () => {
    const [a, b] = computeLayout('leftRight', SCREEN, M)
    expect(a.x).toBeGreaterThanOrEqual(SCREEN.x)
    expect(b.x + b.w).toBeLessThanOrEqual(SCREEN.x + SCREEN.w)
  })

  it('stacks with one margin between, top to bottom', () => {
    const [a, b] = computeLayout('topBottom', SCREEN, M)
    expect(b.y - (a.y + a.h)).toBe(M)
    expect(b.y + b.h).toBeLessThanOrEqual(SCREEN.y + SCREEN.h)
  })
})

describe('computeLayout — odd widths never leave a hairline gap', () => {
  // An odd usable width can't halve evenly. The two halves must still meet
  // exactly, or a strip of desktop shows between two "adjacent" windows.
  it.each([1727, 1728, 1729, 1001])('width %i tiles seamlessly', (w) => {
    const screen: Rect = { x: 0, y: 0, w, h: 900 }
    const [a, b] = computeLayout('leftRight', screen, 0)
    expect(a.x + a.w).toBe(b.x)
    expect(b.x + b.w).toBe(w)
    expect(Number.isInteger(a.w)).toBe(true)
    expect(Number.isInteger(b.w)).toBe(true)
  })

  it.each([1005, 1006, 1007])('height %i stacks seamlessly', (h) => {
    const screen: Rect = { x: 0, y: 0, w: 1400, h }
    const [a, b] = computeLayout('topBottom', screen, 0)
    expect(a.y + a.h).toBe(b.y)
    expect(b.y + b.h).toBe(h)
  })
})

describe('computeLayout — a non-zero screen origin is respected', () => {
  // A second display sits at a non-zero origin. Layouts computed against it
  // must land on THAT screen, not back at 0,0 on the main one.
  const SECOND: Rect = { x: 1728, y: 0, w: 1512, h: 900 }

  it('keeps left-half on the second display', () => {
    const [left] = computeLayout('left', SECOND, 0)
    expect(left.x).toBe(1728)
    expect(left.w).toBe(756)
  })

  it('keeps right-half on the second display', () => {
    const [right] = computeLayout('right', SECOND, 0)
    expect(right.x).toBe(1728 + 756)
    expect(right.x + right.w).toBe(SECOND.x + SECOND.w)
  })
})

describe('layout slot counts', () => {
  it('two-app layouts return exactly two rects', () => {
    for (const kind of ALL_KINDS.filter(isTwoAppLayout)) {
      expect(computeLayout(kind, SCREEN, 0)).toHaveLength(2)
    }
  })

  it('single-app layouts return exactly one rect', () => {
    const single = ALL_KINDS.filter((k) => !isTwoAppLayout(k) && k !== 'restore')
    for (const kind of single) {
      expect(computeLayout(kind, SCREEN, 0)).toHaveLength(1)
    }
  })

  it('classifies exactly the three two-app kinds', () => {
    expect(ALL_KINDS.filter(isTwoAppLayout)).toEqual(['leftRight', 'topBottom', 'quarters'])
  })
})

describe('framesMatch — apps clamp their own size', () => {
  const want: Rect = { x: 0, y: 34, w: 864, h: 1006 }

  it('accepts the real measured clamp (Finder took 1005 for 1006)', () => {
    expect(framesMatch(want, { ...want, h: 1005 })).toBe(true)
  })

  it('accepts x = -0, which AX returns for a window at the left edge', () => {
    expect(framesMatch(want, { ...want, x: -0 })).toBe(true)
  })

  it('rejects a window that landed on the wrong half', () => {
    expect(framesMatch(want, { ...want, x: 864 })).toBe(false)
  })

  it('rejects a difference just past tolerance', () => {
    expect(framesMatch(want, { ...want, w: 864 - 3 })).toBe(false)
  })
})

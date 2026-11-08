import { describe, expect, it } from 'vitest'

import { CONFIG } from '../../../../shared/config'
import { clampCoverPan, coverPanLimits, coverPanStep } from '../cover-pan'
import { nextDpadMode, resolveDpad, type DpadMode } from '../mirror-dpad'

import type { Direction } from '../arrow-focus-nav'

const DIRS: Direction[] = ['up', 'down', 'left', 'right']

// The glasses' square panel showing a 16:10 desktop -- the case the whole
// cover-pan module exists for.
const PANE = 600
const VW = 1512
const VH = 982

describe('dpad mode', () => {
  it('toggles and round-trips', () => {
    expect(nextDpadMode('pan')).toBe('zoom')
    expect(nextDpadMode('zoom')).toBe('pan')
    expect(nextDpadMode(nextDpadMode('pan'))).toBe('pan')
  })
})

describe('resolveDpad', () => {
  it('gives every direction a meaning in both modes', () => {
    for (const mode of ['pan', 'zoom'] as DpadMode[]) {
      for (const dir of DIRS) {
        const action = resolveDpad(mode, dir)
        expect(action.kind).toBe(mode)
      }
    }
  })

  it('pans the view the way the swipe points', () => {
    // Panning the view UP slides the picture DOWN -- the translate is the
    // negative of the intended travel, and a magnitude-only assertion would
    // pass with these backwards.
    const up = resolveDpad('pan', 'up')
    const down = resolveDpad('pan', 'down')
    expect(up).toEqual({ kind: 'pan', dx: 0, dy: CONFIG.PHONE_REMOTE.MIRROR_DPAD_PAN_STEP })
    expect(down.kind === 'pan' && down.dy).toBe(-CONFIG.PHONE_REMOTE.MIRROR_DPAD_PAN_STEP)

    const left = resolveDpad('pan', 'left')
    const right = resolveDpad('pan', 'right')
    expect(left.kind === 'pan' && left.dx).toBeGreaterThan(0)
    expect(right.kind === 'pan' && right.dx).toBeLessThan(0)
    expect(left.kind === 'pan' && left.dy).toBe(0)
  })

  it('zooms in on Up/Right and out on Down/Left, coarser sideways', () => {
    const factor = (dir: Direction): number => {
      const a = resolveDpad('zoom', dir)
      if (a.kind !== 'zoom') throw new Error('expected zoom')
      return a.factor
    }
    // Up/Right = forward, Left/Down = back: memory
    // `cursorless-arrow-direction-pairing`, set by the user on the band.
    expect(factor('up')).toBeGreaterThan(1)
    expect(factor('right')).toBeGreaterThan(1)
    expect(factor('down')).toBeLessThan(1)
    expect(factor('left')).toBeLessThan(1)
    // Sideways is the coarse pair, not a duplicate of the vertical one.
    expect(factor('right')).toBeGreaterThan(factor('up'))
  })

  it('steps are multiplicative, so in and out cancel exactly', () => {
    const inF = resolveDpad('zoom', 'up')
    const outF = resolveDpad('zoom', 'down')
    if (inF.kind !== 'zoom' || outF.kind !== 'zoom') throw new Error('expected zoom')
    expect(inF.factor * outF.factor).toBeCloseTo(1, 10)
  })

  it('crosses the full zoom range in a usable number of swipes', () => {
    const { MIRROR_ZOOM_MIN, MIRROR_ZOOM_MAX, MIRROR_DPAD_ZOOM_STEP } = CONFIG.PHONE_REMOTE
    const swipes = Math.log(MIRROR_ZOOM_MAX / MIRROR_ZOOM_MIN) / Math.log(MIRROR_DPAD_ZOOM_STEP)
    expect(swipes).toBeGreaterThan(5)
    expect(swipes).toBeLessThan(15)
  })
})

describe('coverPanStep', () => {
  const scale = 2

  it('never pans past the content edge', () => {
    const { maxX, maxY } = coverPanLimits(PANE, PANE, VW, VH, scale)
    let pan = { x: 0, y: 0 }
    // Far more swipes than it takes to reach the edge.
    for (let i = 0; i < 40; i++) {
      pan = coverPanStep(PANE, PANE, VW, VH, scale, pan, 1, 1)
    }
    expect(pan.x).toBeLessThanOrEqual(maxX + 1e-9)
    expect(pan.y).toBeLessThanOrEqual(maxY + 1e-9)
    expect(pan.x).toBeCloseTo(maxX, 6)
  })

  it('is symmetric in both directions', () => {
    const { maxX } = coverPanLimits(PANE, PANE, VW, VH, scale)
    let pan = { x: 0, y: 0 }
    for (let i = 0; i < 40; i++) pan = coverPanStep(PANE, PANE, VW, VH, scale, pan, -1, 0)
    expect(pan.x).toBeCloseTo(-maxX, 6)
  })

  it('moves the same fraction of the range at every zoom', () => {
    // The point of a fractional step: a px step would cross the desktop in a
    // few swipes when barely zoomed and dozens when zoomed right in.
    const stepsToEdge = (s: number): number => {
      const { maxX } = coverPanLimits(PANE, PANE, VW, VH, s)
      let pan = { x: 0, y: 0 }
      let n = 0
      while (pan.x < maxX - 1e-6 && n < 500) {
        pan = coverPanStep(PANE, PANE, VW, VH, s, pan, CONFIG.PHONE_REMOTE.MIRROR_DPAD_PAN_STEP, 0)
        n++
      }
      return n
    }
    expect(stepsToEdge(1.5)).toBe(stepsToEdge(4))
  })

  it('does not divide by zero before loadedmetadata', () => {
    const pan = coverPanStep(PANE, PANE, 0, 0, scale, { x: 0, y: 0 }, 1, 1)
    expect(Number.isFinite(pan.x)).toBe(true)
    expect(Number.isFinite(pan.y)).toBe(true)
  })
})

describe('clampCoverPan', () => {
  it('pulls a cornered pan back in when zooming out', () => {
    // The silent one: panning to the corner at 3x is fine, and only shows as a
    // black gutter on the way back out.
    const wide = coverPanLimits(PANE, PANE, VW, VH, 3)
    const cornered = { x: wide.maxX, y: wide.maxY }
    const narrow = coverPanLimits(PANE, PANE, VW, VH, 1.2)

    const clamped = clampCoverPan(PANE, PANE, VW, VH, 1.2, cornered)
    expect(clamped.x).toBeCloseTo(narrow.maxX, 6)
    expect(clamped.y).toBeCloseTo(narrow.maxY, 6)
    expect(clamped.x).toBeLessThan(cornered.x)
  })

  it('leaves an in-range pan untouched', () => {
    const pan = { x: 10, y: -10 }
    expect(clampCoverPan(PANE, PANE, VW, VH, 3, pan)).toEqual(pan)
  })
})

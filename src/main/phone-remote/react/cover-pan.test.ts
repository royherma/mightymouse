/**
 * Pins the fill-and-pan math for the glasses: a 16:10 desktop `object-fit:
 * contain` into a 600x600 panel, enlarged to fill by a baseline scale and
 * panned by cursor-follow.
 *
 * The two bugs this locks out shipped together. `object-fit: cover` crops
 * inside the element box, so the outer third was never painted and panning
 * toward it opened a gutter; and dividing the translate by `scale` under-panned
 * by that factor, so the edge stayed unreachable even zoomed in.
 */
import { describe, it, expect } from 'vitest'
import { coverBaselineScale, coverPanLimits, coverPanForCursor } from './cover-pan'

// The Ray-Ban panel and a 16:10 Mac desktop.
const PANE = 600
const DESK_W = 1920
const DESK_H = 1200

// Contain fits the LONG axis: 600/1920 => 600x375 painted, 225px letterbox.
const CONTAIN_FIT = PANE / DESK_W
const FILL = coverBaselineScale(PANE, PANE, DESK_W, DESK_H)

describe('coverBaselineScale', () => {
  it('is the factor that turns the letterboxed picture into a filled panel', () => {
    // cover/contain = (600/1200)/(600/1920) = 1.6
    expect(FILL).toBeCloseTo(1.6)
    // Sanity: at that scale the short axis exactly reaches the pane.
    expect(DESK_H * CONTAIN_FIT * FILL).toBeCloseTo(PANE)
  })

  it('is 1 when the aspect ratios already match', () => {
    expect(coverBaselineScale(PANE, PANE, 1000, 1000)).toBe(1)
  })

  it('is 1, not NaN, before loadedmetadata reports an intrinsic size', () => {
    expect(coverBaselineScale(PANE, PANE, 0, 0)).toBe(1)
  })
})

describe('the phone path is untouched', () => {
  // This fix is glasses-only. A phone's mirror pane matches the stream's
  // aspect (sizeMirrorPane sizes it from videoWidth/videoHeight), so the
  // baseline must resolve to exactly 1 -- effective scale == the user's zoom,
  // and the shipped contain clamp keeps its own numbers.
  const PHONE_W = 390
  const PHONE_H = PHONE_W * (DESK_H / DESK_W)

  it('resolves a baseline of exactly 1 when the pane matches the stream', () => {
    expect(coverBaselineScale(PHONE_W, PHONE_H, DESK_W, DESK_H)).toBeCloseTo(1)
  })

  it('agrees with the shipped pane-box clamp when there are no letterbox bars', () => {
    for (const scale of [1, 1.5, 2, 4]) {
      const { maxX, maxY } = coverPanLimits(PHONE_W, PHONE_H, DESK_W, DESK_H, scale)
      expect(maxX).toBeCloseTo((PHONE_W * (scale - 1)) / 2)
      expect(maxY).toBeCloseTo((PHONE_H * (scale - 1)) / 2)
    }
  })
})

describe('coverPanLimits', () => {
  it('allows sideways pan at the fill baseline, and none vertically', () => {
    const { maxX, maxY } = coverPanLimits(PANE, PANE, DESK_W, DESK_H, FILL)
    // Rendered 960 wide at fill; overflow 360, so 180px of travel each way.
    expect(maxX).toBeCloseTo(180)
    // Height is exactly covered -- panning would show a gutter.
    expect(maxY).toBeCloseTo(0)
  })

  it('pans on neither axis for a square source in a square pane', () => {
    const { maxX, maxY } = coverPanLimits(PANE, PANE, 1000, 1000, 1)
    expect(maxX).toBe(0)
    expect(maxY).toBe(0)
  })

  it('measures the CONTENT, not the pane box, so it cannot pan into the bars', () => {
    // At scale 1 the contained picture is 600x375: it is smaller than the pane
    // on both axes, so nothing may move. A pane-box clamp would agree here...
    expect(coverPanLimits(PANE, PANE, DESK_W, DESK_H, 1)).toEqual({ maxX: 0, maxY: 0 })
    // ...but at 1.3 it still says 90px of vertical travel while the picture is
    // only 487 tall, which slides the letterbox bar into view.
    expect(coverPanLimits(PANE, PANE, DESK_W, DESK_H, 1.3).maxY).toBe(0)
    expect((PANE * (1.3 - 1)) / 2).toBeCloseTo(90)
  })

  it('adds the user zoom term on top of the fill overflow', () => {
    const at1 = coverPanLimits(PANE, PANE, DESK_W, DESK_H, FILL)
    const at2 = coverPanLimits(PANE, PANE, DESK_W, DESK_H, FILL * 2)
    expect(at2.maxX).toBeGreaterThan(at1.maxX)
    // At 2x past fill the height finally overflows too, so vertical unlocks.
    expect(at2.maxY).toBeCloseTo(300)
  })

  it('degrades to the contain clamp before loadedmetadata reports a size', () => {
    const { maxX, maxY } = coverPanLimits(PANE, PANE, 0, 0, 2)
    expect(maxX).toBeCloseTo(300)
    expect(maxY).toBeCloseTo(300)
    expect(Number.isNaN(maxX)).toBe(false)
  })

  it('never returns a negative limit', () => {
    const { maxX, maxY } = coverPanLimits(PANE, PANE, DESK_W, DESK_H, 0.5)
    expect(maxX).toBeGreaterThanOrEqual(0)
    expect(maxY).toBeGreaterThanOrEqual(0)
  })
})

describe('coverPanForCursor', () => {
  it('pushes the picture to its limit when the cursor is at a screen edge', () => {
    const left = coverPanForCursor(PANE, PANE, DESK_W, DESK_H, FILL, { x: 0, y: 0.5 })
    const right = coverPanForCursor(PANE, PANE, DESK_W, DESK_H, FILL, { x: 1, y: 0.5 })
    expect(left.x).toBeCloseTo(180)
    expect(right.x).toBeCloseTo(-180)
    expect(left.y).toBeCloseTo(0)
  })

  it('returns SCREEN px: translate(x) scale(s) is T·S, so no division by s', () => {
    // The regression this locks: dividing by scale under-panned by a factor of
    // s, leaving the desktop edge unreachable at every zoom above the baseline.
    const s = FILL * 2
    const at2 = coverPanForCursor(PANE, PANE, DESK_W, DESK_H, s, { x: 0, y: 0.5 })
    expect(at2.x).toBeCloseTo(coverPanLimits(PANE, PANE, DESK_W, DESK_H, s).maxX)
  })

  it('brings every desktop edge fully into the panel with no gutter', () => {
    // The acceptance case. For each corner, the visible window in desktop
    // coordinates must sit inside [0,1] (no gutter) and touch the edge it
    // is aimed at.
    for (const s of [FILL, FILL * 1.2, FILL * 2]) {
      const renderedW = DESK_W * CONTAIN_FIT * s
      const renderedH = DESK_H * CONTAIN_FIT * s
      for (const cx of [0, 1]) {
        for (const cy of [0, 1]) {
          const { x, y } = coverPanForCursor(PANE, PANE, DESK_W, DESK_H, s, { x: cx, y: cy })
          // Left edge of the pane in units of the rendered picture, 0..1.
          const viewLeft = 0.5 - x / renderedW - PANE / renderedW / 2
          const viewTop = 0.5 - y / renderedH - PANE / renderedH / 2
          const viewRight = viewLeft + PANE / renderedW
          const viewBottom = viewTop + PANE / renderedH
          expect(viewLeft).toBeGreaterThanOrEqual(-1e-9)
          expect(viewTop).toBeGreaterThanOrEqual(-1e-9)
          expect(viewRight).toBeLessThanOrEqual(1 + 1e-9)
          expect(viewBottom).toBeLessThanOrEqual(1 + 1e-9)
          // And the cursor's own edge is inside the window.
          expect(cx).toBeGreaterThanOrEqual(viewLeft - 1e-9)
          expect(cx).toBeLessThanOrEqual(viewRight + 1e-9)
        }
      }
    }
  })

  it('centres the picture for a centred cursor', () => {
    const { x, y } = coverPanForCursor(PANE, PANE, DESK_W, DESK_H, FILL, { x: 0.5, y: 0.5 })
    expect(x).toBeCloseTo(0)
    expect(y).toBeCloseTo(0)
  })

  it('is symmetric about the centre', () => {
    for (const d of [0.1, 0.25, 0.4]) {
      const a = coverPanForCursor(PANE, PANE, DESK_W, DESK_H, FILL, { x: 0.5 + d, y: 0.5 })
      const b = coverPanForCursor(PANE, PANE, DESK_W, DESK_H, FILL, { x: 0.5 - d, y: 0.5 })
      expect(a.x).toBeCloseTo(-b.x)
    }
  })

  it('holds every position pinned when there is no overflow to pan into', () => {
    for (const x of [0, 0.5, 1]) {
      // toBeCloseTo, not toBe: a clamp to zero can yield -0, which renders
      // identically in a transform but fails Object.is against +0.
      expect(coverPanForCursor(PANE, PANE, 1000, 1000, 1, { x, y: 0.5 }).x).toBeCloseTo(0)
    }
  })
})

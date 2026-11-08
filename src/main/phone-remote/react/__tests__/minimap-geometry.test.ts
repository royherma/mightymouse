/**
 * The minimap's geometry -- the little screen-shaped frame that says which part
 * of the Mac the glasses are looking at.
 *
 * Two invariants here are the whole point and neither shows up on glass:
 *   - the view box never hangs off the frame, so the box a thumb drags to the
 *     corner stays a rectangle instead of half-vanishing;
 *   - a touch resolves to a centre the glasses will actually honour. The Mac's
 *     `coverPanForCursor` clamps to the desktop's edges, so a minimap that
 *     asked for an unreachable centre would watch the box spring back out from
 *     under the finger -- which reads as a laggy socket, not as a clamp.
 */

import { describe, expect, it } from 'vitest'
import {
  MINIMAP_MAX_EDGE_PX,
  minimapFrame,
  minimapVisible,
  panPointFromTouch,
  viewBoxFraction,
  viewBoxOffset
} from '../minimap-geometry'

describe('minimapFrame', () => {
  it('pins the longest edge and keeps the desktop aspect', () => {
    const wide = minimapFrame(3840, 2160)
    expect(wide.width).toBe(MINIMAP_MAX_EDGE_PX)
    expect(wide.height).toBe(Math.round((MINIMAP_MAX_EDGE_PX * 2160) / 3840))

    const ultrawide = minimapFrame(5120, 2160)
    expect(ultrawide.width).toBe(MINIMAP_MAX_EDGE_PX)
    expect(ultrawide.height).toBeLessThan(wide.height)
  })

  it('falls back to 16:10 before the Mac has reported bounds', () => {
    // Zero is the pre-`viewer`-event value, not an error: a zero-sized or NaN
    // box would paint as nothing at all, which is worse than a brief wrong
    // aspect that self-corrects on the first event.
    const blank = minimapFrame(0, 0)
    expect(blank.width).toBe(MINIMAP_MAX_EDGE_PX)
    expect(blank.height).toBe(Math.round((MINIMAP_MAX_EDGE_PX * 10) / 16))
  })
})

describe('viewBoxFraction', () => {
  it('is the reciprocal of zoom', () => {
    expect(viewBoxFraction(2)).toBeCloseTo(0.5)
    expect(viewBoxFraction(1)).toBe(1)
  })

  it('never exceeds the frame, whatever the ring publishes', () => {
    expect(viewBoxFraction(0.5)).toBe(1)
    expect(viewBoxFraction(Number.NaN)).toBe(1)
  })

  it('holds a floor so the box stays grabbable at max zoom', () => {
    // 1/8 of an 88px frame is 11px -- under a fingertip. The lie is deliberate.
    expect(viewBoxFraction(8)).toBe(0.18)
  })
})

describe('minimapVisible', () => {
  it('is up whenever the glasses are zoomed', () => {
    expect(minimapVisible(true, false)).toBe(true)
  })

  it('stays up through the dwell after zoom returns to 1x', () => {
    // The 3x->1x moment is exactly when the widget is worth watching -- the box
    // grows to fill the frame. Hiding on the same tick is the one way to miss it.
    expect(minimapVisible(false, true)).toBe(true)
  })

  it('is gone once the dwell expires at 1x', () => {
    expect(minimapVisible(false, false)).toBe(false)
  })
})

describe('viewBoxOffset', () => {
  const frame = { width: 88, height: 55 }

  it('centres the box on the point', () => {
    const box = viewBoxOffset(frame, 0.5, { x: 0.5, y: 0.5 })
    expect(box.left).toBeCloseTo(22)
    expect(box.top).toBeCloseTo(13.75)
  })

  it('keeps the box inside the frame at both extremes', () => {
    const tl = viewBoxOffset(frame, 0.5, { x: 0, y: 0 })
    expect(tl.left).toBe(0)
    expect(tl.top).toBe(0)

    const br = viewBoxOffset(frame, 0.5, { x: 1, y: 1 })
    expect(br.left + br.width).toBeCloseTo(frame.width)
    expect(br.top + br.height).toBeCloseTo(frame.height)
  })

  it('fills the frame at 1x', () => {
    const box = viewBoxOffset(frame, 1, { x: 0.5, y: 0.5 })
    expect(box).toMatchObject({ left: 0, top: 0, width: 88, height: 55 })
  })
})

describe('panPointFromTouch', () => {
  const frame = { width: 88, height: 55 }

  it('reads the touch as the box centre', () => {
    expect(panPointFromTouch(frame, 0.5, 44, 27.5)).toEqual({ x: 0.5, y: 0.5 })
  })

  it('clamps to centres the glasses can actually reach', () => {
    // At 2x the view is half the desktop, so the reachable centres are
    // 0.25..0.75. Asking for 0 would be clamped Mac-side and the box would
    // spring back -- so the minimap must not ask.
    expect(panPointFromTouch(frame, 0.5, 0, 0)).toEqual({ x: 0.25, y: 0.25 })
    expect(panPointFromTouch(frame, 0.5, 88, 55)).toEqual({ x: 0.75, y: 0.75 })
  })

  it('has exactly one reachable centre at 1x', () => {
    expect(panPointFromTouch(frame, 1, 0, 55)).toEqual({ x: 0.5, y: 0.5 })
  })

  it('round-trips against viewBoxOffset', () => {
    // The two halves must agree: aim somewhere, and the box drawn from that
    // aim point must contain the touch that produced it.
    const fraction = viewBoxFraction(3)
    const centre = panPointFromTouch(frame, fraction, 70, 12)
    const box = viewBoxOffset(frame, fraction, centre)
    expect(70).toBeGreaterThanOrEqual(box.left)
    expect(70).toBeLessThanOrEqual(box.left + box.width)
    expect(12).toBeGreaterThanOrEqual(box.top)
    expect(12).toBeLessThanOrEqual(box.top + box.height)
  })
})

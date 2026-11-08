import { describe, it, expect } from 'vitest'
import {
  touchSpread,
  decideTwoFingerMode,
  zoomStepsFor,
  PINCH_MIN_SPREAD_PX,
  PINCH_PX_PER_STEP,
  PINCH_PAN_GRACE_PX
} from '../pinch-zoom'
import { PAD_ZOOM_MAX_STEPS } from '../../../../shared/phone-remote-keys'

const TAP_MAX_MOVE_PX = 10

describe('touchSpread', () => {
  it('is the distance between the two points', () => {
    expect(touchSpread(0, 0, 3, 4)).toBe(5)
    expect(touchSpread(10, 10, 10, 10)).toBe(0)
  })
})

describe('decideTwoFingerMode', () => {
  it('stays undecided while both fingers are still', () => {
    expect(decideTwoFingerMode('undecided', 0, 0, TAP_MAX_MOVE_PX)).toBe('undecided')
  })

  it('does not commit on a two-finger tap wobble', () => {
    expect(decideTwoFingerMode('undecided', 6, 8, TAP_MAX_MOVE_PX)).toBe('undecided')
  })

  it('commits to scrolling on a pan with no spread', () => {
    expect(decideTwoFingerMode('undecided', 2, 40, TAP_MAX_MOVE_PX)).toBe('scrolling')
  })

  it('commits to zooming once the fingers spread far enough', () => {
    expect(
      decideTwoFingerMode('undecided', PINCH_MIN_SPREAD_PX, 0, TAP_MAX_MOVE_PX)
    ).toBe('zooming')
  })

  it('commits to zooming when the fingers close, not just open', () => {
    expect(
      decideTwoFingerMode('undecided', -PINCH_MIN_SPREAD_PX, 0, TAP_MAX_MOVE_PX)
    ).toBe('zooming')
  })

  it('lets spread win a tie -- a pinch also pans, but a pan never spreads', () => {
    expect(
      decideTwoFingerMode('undecided', PINCH_MIN_SPREAD_PX, 200, TAP_MAX_MOVE_PX)
    ).toBe('zooming')
  })

  // Regression: shipped once latching on whichever threshold tripped first,
  // which made EVERY pinch scroll. Numbers are one real on-device frame --
  // finger 0 travelled 133px while the separation had grown only 15px.
  it('does not hand a mid-flight pinch to scroll just because the hand moved', () => {
    expect(decideTwoFingerMode('undecided', 15, 133, TAP_MAX_MOVE_PX)).toBe('undecided')
  })

  it('still scrolls promptly when the fingers hold their separation', () => {
    expect(decideTwoFingerMode('undecided', 3, 20, TAP_MAX_MOVE_PX)).toBe('scrolling')
  })

  it('falls back to scroll on a sloppy drag whose spread never commits', () => {
    expect(
      decideTwoFingerMode('undecided', 15, PINCH_PAN_GRACE_PX + 1, TAP_MAX_MOVE_PX)
    ).toBe('scrolling')
  })

  it('latches: a decided mode never flips mid-touch', () => {
    expect(decideTwoFingerMode('scrolling', 999, 0, TAP_MAX_MOVE_PX)).toBe('scrolling')
    expect(decideTwoFingerMode('zooming', 0, 999, TAP_MAX_MOVE_PX)).toBe('zooming')
  })
})

describe('zoomStepsFor', () => {
  it('owes nothing below one notch, and carries the whole amount forward', () => {
    const r = zoomStepsFor(PINCH_PX_PER_STEP - 1)
    expect(r.steps).toBe(0)
    expect(r.remainderPx).toBe(PINCH_PX_PER_STEP - 1)
  })

  it('converts whole notches and carries the remainder', () => {
    const r = zoomStepsFor(PINCH_PX_PER_STEP * 2 + 5)
    expect(r.steps).toBe(2)
    expect(r.remainderPx).toBe(5)
  })

  it('zooms out on a negative accumulation', () => {
    expect(zoomStepsFor(-PINCH_PX_PER_STEP * 3).steps).toBe(-3)
  })

  it('caps a single frame at PAD_ZOOM_MAX_STEPS', () => {
    expect(zoomStepsFor(PINCH_PX_PER_STEP * 50).steps).toBe(PAD_ZOOM_MAX_STEPS)
    expect(zoomStepsFor(-PINCH_PX_PER_STEP * 50).steps).toBe(-PAD_ZOOM_MAX_STEPS)
  })

  it('a slow pinch fed one pixel at a time still reaches full notches', () => {
    // The remainder is the whole point: zeroing it each frame swallows a
    // gentle gesture entirely, which is how this reads as "pinch is broken".
    let carry = 0
    let total = 0
    for (let i = 0; i < PINCH_PX_PER_STEP * 4; i++) {
      const r = zoomStepsFor(carry + 1)
      carry = r.remainderPx
      total += r.steps
    }
    expect(total).toBe(4)
  })
})

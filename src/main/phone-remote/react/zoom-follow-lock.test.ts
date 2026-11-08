/**
 * Pins the hold-vs-scrub fork on the Pro zoom bar. Long-pressing the KNOB
 * locks the mirror to the Mac cursor; pressing anywhere else on the track is
 * an ordinary scrub. Both gestures start with an identical touchstart, so
 * isOnZoomKnob is the only thing separating them -- widen it and the whole
 * track becomes a lock target, narrow it and the lock stops being reachable.
 */
import { describe, it, expect } from 'vitest'
import { isOnZoomKnob } from './ZoomBar'

// A 200px track starting at x=50, matching the shape of the real bar.
const LEFT = 50
const WIDTH = 200

describe('isOnZoomKnob', () => {
  it('accepts a press dead-on the knob at any position along the track', () => {
    expect(isOnZoomKnob(LEFT, 0, LEFT, WIDTH)).toBe(true)
    expect(isOnZoomKnob(LEFT + 100, 50, LEFT, WIDTH)).toBe(true)
    expect(isOnZoomKnob(LEFT + WIDTH, 100, LEFT, WIDTH)).toBe(true)
  })

  it('rejects a press at the far end of the track from the knob', () => {
    // Knob parked at 1x (left edge), finger at the right edge: this is the
    // "jump the zoom way up" scrub, and must never arm a lock.
    expect(isOnZoomKnob(LEFT + WIDTH, 0, LEFT, WIDTH)).toBe(false)
    // And the mirror case: knob at max, press at the low end.
    expect(isOnZoomKnob(LEFT, 100, LEFT, WIDTH)).toBe(false)
  })

  it('allows a fingertip-width miss but not a deliberate one', () => {
    const knobAtMid = LEFT + 100
    // ~a fat-finger offset from centre still grabs the knob.
    expect(isOnZoomKnob(knobAtMid + 20, 50, LEFT, WIDTH)).toBe(true)
    expect(isOnZoomKnob(knobAtMid - 20, 50, LEFT, WIDTH)).toBe(true)
    // Half the track away is a scrub, not a miss.
    expect(isOnZoomKnob(knobAtMid + 60, 50, LEFT, WIDTH)).toBe(false)
  })

  it('is symmetric around the knob', () => {
    const knobAtMid = LEFT + 100
    for (const d of [5, 15, 27, 29, 50]) {
      expect(isOnZoomKnob(knobAtMid + d, 50, LEFT, WIDTH)).toBe(
        isOnZoomKnob(knobAtMid - d, 50, LEFT, WIDTH)
      )
    }
  })

  it('reports false for a zero-width track instead of dividing by nothing', () => {
    // Happens on the first render before layout -- must not throw or claim a
    // hit at every x, which would lock on any touch.
    expect(isOnZoomKnob(LEFT, 50, LEFT, 0)).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'

import { drivesCursor, isHeld, transition, type TouchMode } from '../touch-mode'

describe('touch-mode', () => {
  it('starts driving the cursor on a gesture, and rests back to pan', () => {
    const driving = transition('pan', { type: 'gestureBegin' })
    expect(driving).toBe('resting')
    expect(drivesCursor(driving)).toBe(true)
    expect(transition(driving, { type: 'rest' })).toBe('pan')
  })

  it('never rests out of held -- that is what held means', () => {
    expect(transition('held', { type: 'rest' })).toBe('held')
  })

  it('does not downgrade a held mode when a gesture begins', () => {
    // The toggle is on and the user drives the cursor: lifting the finger must
    // leave the toggle on, or the deck's button would silently turn itself off.
    expect(transition('held', { type: 'gestureBegin' })).toBe('held')
  })

  it('toggles hold both ways', () => {
    expect(transition('pan', { type: 'toggleHold' })).toBe('held')
    expect(transition('resting', { type: 'toggleHold' })).toBe('held')
    expect(transition('held', { type: 'toggleHold' })).toBe('pan')
  })

  it('setHold(false) lands in pan, not resting', () => {
    // Returning to `resting` would re-arm a mode with no finger driving it.
    expect(transition('held', { type: 'setHold', hold: false })).toBe('pan')
    expect(transition('resting', { type: 'setHold', hold: false })).toBe('pan')
    expect(transition('pan', { type: 'setHold', hold: true })).toBe('held')
  })

  it('reset always returns to pan', () => {
    for (const s of ['pan', 'resting', 'held'] as TouchMode[]) {
      expect(transition(s, { type: 'reset' })).toBe('pan')
    }
  })

  it('only held is held, and only pan does not drive', () => {
    expect(isHeld('held')).toBe(true)
    expect(isHeld('resting')).toBe(false)
    expect(drivesCursor('pan')).toBe(false)
  })
})

describe('touch-mode drives the gesture entry gate', () => {
  // use-mirror-gestures reads `drivesCursor(state)` via touchModeActiveRef to
  // decide whether a one-finger touchdown warps immediately or must wait out
  // the 1000ms long-press. These lock the design's stated toggle semantics.
  it('toggle ON makes a one-finger drag drive the cursor with no hold', () => {
    const held = transition('pan', { type: 'setHold', hold: true })
    expect(drivesCursor(held)).toBe(true)
  })

  it('toggle OFF restores the long-press requirement', () => {
    const off = transition('held', { type: 'setHold', hold: false })
    expect(drivesCursor(off)).toBe(false)
  })

  it('long-press still works while the toggle is off', () => {
    // The 1000ms path calls gestureBegin regardless of the toggle, so
    // long-press-to-warp must not regress in either state.
    expect(drivesCursor(transition('pan', { type: 'gestureBegin' }))).toBe(true)
    expect(drivesCursor(transition('held', { type: 'gestureBegin' }))).toBe(true)
  })
})

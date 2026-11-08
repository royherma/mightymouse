/**
 * Pins the double-tap latch rules. A latch is an armed modifier with nobody
 * touching it -- if these rules drift, the keyboard silently starts sending
 * ⌘-prefixed keystrokes the user never asked for, which reads as the Mac
 * misbehaving rather than as a keyboard bug.
 */
import { describe, it, expect } from 'vitest'
import { latchAction, DOUBLE_TAP_MS } from './modifier-latch'

describe('latchAction', () => {
  it('does nothing on a first-ever press', () => {
    expect(latchAction(Infinity, false)).toBe('none')
  })

  it('does nothing on two slow taps', () => {
    expect(latchAction(DOUBLE_TAP_MS, false)).toBe('none')
    expect(latchAction(DOUBLE_TAP_MS + 1, false)).toBe('none')
  })

  it('latches on a fast second tap', () => {
    expect(latchAction(DOUBLE_TAP_MS - 1, false)).toBe('latch')
    expect(latchAction(0, false)).toBe('latch')
  })

  // The ONLY escape hatch short of closing the keyboard -- latches persist
  // across keypresses, so without this a mis-tapped ⌘ would ride every
  // subsequent key.
  it('un-latches on a fast tap of an already-latched key', () => {
    expect(latchAction(0, true)).toBe('unlatch')
  })

  // A slow tap must not clear a latch -- that's a fresh hold on a key that
  // happens to be armed, which is how you'd start ⌘⇧-something by hand.
  it('leaves an existing latch alone on a slow tap', () => {
    expect(latchAction(DOUBLE_TAP_MS + 100, true)).toBe('none')
  })
})

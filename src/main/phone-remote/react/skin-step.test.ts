/**
 * Pins stepSkin's arithmetic: the hidden corner taps are the only skin control
 * with no visible target, so a wrong step is invisible until it strands you on
 * a skin you can't leave.
 */
import { describe, it, expect } from 'vitest'
import { stepSkin, SKIN_OPTIONS } from './skins'

const IDS = SKIN_OPTIONS.map((o) => o.id)

describe('stepSkin', () => {
  // Walk every adjacent pair rather than fixed indices: the ring shrinks as
  // skins are retired from the store (down to proII + default today), so a
  // hardcoded IDS[2] indexes past the end into undefined.
  it('walks forward through the built-ins in display order', () => {
    for (let i = 0; i + 1 < IDS.length; i++) {
      expect(stepSkin(IDS[i], 1)).toBe(IDS[i + 1])
    }
  })

  it('walks backward', () => {
    for (let i = 1; i < IDS.length; i++) {
      expect(stepSkin(IDS[i], -1)).toBe(IDS[i - 1])
    }
  })

  it('wraps past the end so the corner is never a dead tap', () => {
    expect(stepSkin(IDS[IDS.length - 1], 1)).toBe(IDS[0])
  })

  it('wraps past the start -- the negative-modulo case', () => {
    // Bare `% length` answers -1 here and indexes to undefined.
    expect(stepSkin(IDS[0], -1)).toBe(IDS[IDS.length - 1])
  })

  it('returns to where it started after a full lap', () => {
    let skin = IDS[0]
    for (let i = 0; i < IDS.length; i++) skin = stepSkin(skin, 1)
    expect(skin).toBe(IDS[0])
  })

  it('keeps a worn remote skin in the ring so you can step back to it', () => {
    const worn = 'remote:gold-lace' as const
    // Forward off it lands on a built-in...
    expect(stepSkin(worn, 1)).toBe(IDS[0])
    // ...and back from that built-in returns to the remote skin, rather than
    // wrapping to the last built-in and losing it.
    expect(stepSkin(IDS[0], -1)).not.toBe(worn) // not worn -> not in the ring
    expect(stepSkin(worn, -1)).toBe(IDS[IDS.length - 1])
  })

  it('never answers the skin it was given, given a ring of 2+', () => {
    for (const id of IDS) {
      expect(stepSkin(id, 1)).not.toBe(id)
      expect(stepSkin(id, -1)).not.toBe(id)
    }
  })

  // The corner tap feeds in the remote skins already installed on the phone so
  // they join the cycle -- the built-ins are the head of the ring, the installed
  // remote skins the tail.
  it('cycles installed remote skins after the built-ins', () => {
    const installed = ['remote:hero-crunch-4', 'remote:mil-spec-2'] as const
    // Last built-in steps forward into the first installed remote skin...
    expect(stepSkin(IDS[IDS.length - 1], 1, installed)).toBe(installed[0])
    // ...the two remote skins are adjacent...
    expect(stepSkin(installed[0], 1, installed)).toBe(installed[1])
    // ...and the last remote skin wraps back to the first built-in.
    expect(stepSkin(installed[installed.length - 1], 1, installed)).toBe(IDS[0])
  })
})

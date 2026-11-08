import { describe, it, expect } from 'vitest'
import { KIND_HUES, kindHue, isRunKind } from '../mode'
import { CONFIG } from '../config'

// KIND_HUES is the SSOT for "what color is this kind", read by BOTH the Electron
// renderer (mode-colors.ts) and the phone-remote bundle (history-kinds.ts). It
// replaced two hand-copies of the same mapping. These tests exist so a third copy
// -- or a hue whose tokens don't exist -- fails the build instead of shipping a
// kind that's violet on the Mac and grey on the phone.

const T = CONFIG.THEME_TOKENS

describe('KIND_HUES', () => {
  it('covers every RunKind', () => {
    // `satisfies Record<RunKind, string>` already enforces this at compile time;
    // asserted at runtime too so the list can't be narrowed by a bad cast.
    expect(Object.keys(KIND_HUES).sort()).toEqual(
      ['act', 'ask', 'listen', 'recording', 'rewrite', 'screenshot', 'write'].sort()
    )
  })

  it('gives every kind a DISTINCT hue', () => {
    // Two kinds sharing a hue is the failure the palette exists to prevent --
    // the chip stops identifying anything.
    const hues = Object.values(KIND_HUES)
    expect(new Set(hues).size).toBe(hues.length)
  })

  it('every hue ships all three THEME_TOKENS the chips need', () => {
    // The chip triple is looked up by computed key (`${hue}BgSubtle`), which
    // TypeScript cannot check. A missing token is `undefined` at runtime and
    // paints a transparent chip -- silent on both surfaces.
    for (const hue of Object.values(KIND_HUES)) {
      for (const suffix of ['', 'BgSubtle', 'BorderSubtle']) {
        const key = `${hue}${suffix}` as keyof typeof T
        expect(T[key], `THEME_TOKENS.${key} missing for hue "${hue}"`).toBeTruthy()
      }
    }
  })
})

describe('kindHue', () => {
  it('resolves a known kind', () => {
    expect(kindHue('act')).toBe('violet')
    expect(kindHue('listen')).toBe('green')
  })

  it('returns null for an unknown kind off the wire', () => {
    // The phone renders whatever `kind` string the Mac sends. An unrecognized
    // one must fall back to the neutral chip, never crash or pick a hue.
    expect(kindHue('teleport')).toBeNull()
  })
})

describe('isRunKind', () => {
  it('accepts real kinds and rejects anything else', () => {
    expect(isRunKind('rewrite')).toBe(true)
    expect(isRunKind('teleport')).toBe(false)
    expect(isRunKind(null)).toBe(false)
    expect(isRunKind(42)).toBe(false)
  })
})

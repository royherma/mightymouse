import { describe, expect, it } from 'vitest'
import { barTopFor } from '../useClusterTop'

// Where the floating context bar's edge lands. The rule exists because the app
// ring cannot be made to enclose the bar: a circle clearing the buttons AND the
// bar wants ~259px on a 393pt portrait pad that offers ~227, so `ringBand` caps
// at the pad edge and the arc's icons end up behind the tab chips (Roy,
// on-device 2026-08-03). The bar moves instead.

// Gap-inset values in one space, shaped like a portrait deck: cluster keys near
// the bottom of the screen, arc sweeping up past them.
const KEYS_TOP = 600
const CELL_BOTTOM = 800

describe('barTopFor', () => {
  it('sits on the cluster when no ring is painted', () => {
    // The ring is OFF by default, so this path is what most users get. A
    // regression here moves the bar for people who never enabled the feature.
    expect(barTopFor('bottom', KEYS_TOP, CELL_BOTTOM, null)).toBe(KEYS_TOP)
  })

  it('lifts to the arc when the ring reaches above the cluster', () => {
    // The whole point: the arc's outer edge is higher up the screen (smaller y)
    // than the keys, so the bar has to clear the arc, not the keys.
    expect(barTopFor('bottom', KEYS_TOP, CELL_BOTTOM, 540)).toBe(540)
  })

  it('stays on the cluster when the arc does not reach it', () => {
    // A small ring on a roomy pad ends below the bar's existing home. Taking the
    // arc unconditionally would DROP the bar onto the buttons.
    expect(barTopFor('bottom', KEYS_TOP, CELL_BOTTOM, 660)).toBe(KEYS_TOP)
  })

  it('ignores the arc entirely when keys are at the top', () => {
    // Landscape top-keys hangs the bar DOWNWARD into open deck, away from the
    // corner the arc sweeps from. A floor there pushes it the wrong way.
    expect(barTopFor('top', KEYS_TOP, CELL_BOTTOM, 100)).toBe(CELL_BOTTOM)
    expect(barTopFor('top', KEYS_TOP, CELL_BOTTOM, null)).toBe(CELL_BOTTOM)
  })

  it('never returns a lower edge than the ring-off case', () => {
    // The floor may only ever move the bar UP. Anything else puts it over the
    // buttons it is supposed to sit above.
    for (const ring of [null, 0, 400, 599, 601, 900, Infinity]) {
      expect(barTopFor('bottom', KEYS_TOP, CELL_BOTTOM, ring)).toBeLessThanOrEqual(KEYS_TOP)
    }
  })
})

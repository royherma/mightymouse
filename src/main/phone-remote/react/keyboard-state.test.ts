import { describe, it, expect } from 'vitest'
import {
  pillTarget,
  resolveSwitchToNative,
  reconcileNative,
  barHostVisible,
  type KeyboardMode
} from './keyboard-state'

describe('pillTarget', () => {
  it('opens the keyboard the Settings pref names', () => {
    expect(pillTarget('none', false)).toBe('native')
    expect(pillTarget('none', true)).toBe('virtual')
  })

  it('is a toggle: tapping the pill again puts the same board away', () => {
    expect(pillTarget('native', false)).toBe('none')
    expect(pillTarget('virtual', true)).toBe('none')
  })

  it('resolves to the preferred board when the OTHER one is up', () => {
    // Reachable via the swap button, which is session-scoped and does not
    // rewrite the pref -- so the pill can find a board the pref did not choose.
    expect(pillTarget('virtual', false)).toBe('native')
    expect(pillTarget('native', true)).toBe('virtual')
  })
})

describe('resolveSwitchToNative', () => {
  it('commits to native when iOS honoured the focus', () => {
    expect(resolveSwitchToNative(true)).toBe('native')
  })

  it('THE PHANTOM SWITCH: stays on the visible board when iOS refused focus', () => {
    // The old code went to a state with no keyboard at all, and the pending
    // focus resolved on the next tap anywhere -- the reported symptom.
    expect(resolveSwitchToNative(false)).toBe('virtual')
    expect(resolveSwitchToNative(false)).not.toBe('none')
  })
})

describe('reconcileNative', () => {
  const base = { minOcclusionPx: 120, sheetOpen: false }

  it('tears down the native board once nothing is occluded', () => {
    expect(reconcileNative({ ...base, mode: 'native', occludedPx: 0 })).toBe('none')
  })

  it('keeps it while the keyboard still occludes the viewport', () => {
    expect(reconcileNative({ ...base, mode: 'native', occludedPx: 300 })).toBe('native')
  })

  it('ignores the mid-animation dip while a bar dropdown is open', () => {
    expect(reconcileNative({ ...base, mode: 'native', occludedPx: 0, sheetOpen: true })).toBe(
      'native'
    )
  })

  it('never closes the virtual board -- it is our DOM, not iOS chrome', () => {
    expect(reconcileNative({ ...base, mode: 'virtual', occludedPx: 0 })).toBe('virtual')
  })

  it('leaves `none` alone', () => {
    expect(reconcileNative({ ...base, mode: 'none', occludedPx: 0 })).toBe('none')
  })
})

describe('barHostVisible', () => {
  it('mounts each host only for its own keyboard', () => {
    expect(barHostVisible('native', 'native')).toBe(true)
    expect(barHostVisible('virtual', 'virtual')).toBe(true)
    expect(barHostVisible('virtual', 'native')).toBe(false)
    expect(barHostVisible('native', 'virtual')).toBe(false)
  })

  it('mounts neither when no keyboard is up', () => {
    expect(barHostVisible('none', 'native')).toBe(false)
    expect(barHostVisible('none', 'virtual')).toBe(false)
  })

  it('applies the SAME rule to both hosts -- the two-lifecycle bug', () => {
    const modes: KeyboardMode[] = ['none', 'native', 'virtual']
    for (const mode of modes) {
      const mounted = modes
        .filter((m): m is 'native' | 'virtual' => m !== 'none')
        .filter((host) => barHostVisible(mode, host))
      // Never two bars at once, and never a bar with no keyboard under it.
      expect(mounted.length).toBeLessThanOrEqual(1)
    }
  })
})

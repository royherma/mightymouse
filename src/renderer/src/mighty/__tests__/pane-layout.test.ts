import { describe, it, expect } from 'vitest'
import {
  shouldUseStackedLayout,
  PANE_STACK_WIDTH_THRESHOLD,
  paneCountToPreset,
  resolveLayout
} from '../pane-layout'

describe('shouldUseStackedLayout — hidden tab must not remount panes', () => {
  it('returns false for width 0 (display:none background tab)', () => {
    expect(shouldUseStackedLayout(0)).toBe(false)
  })

  it('returns false for negative width (bad measurement)', () => {
    expect(shouldUseStackedLayout(-1)).toBe(false)
  })

  it('returns true just below the stack threshold', () => {
    expect(shouldUseStackedLayout(PANE_STACK_WIDTH_THRESHOLD - 1)).toBe(true)
  })

  it('returns false at or above the stack threshold', () => {
    expect(shouldUseStackedLayout(PANE_STACK_WIDTH_THRESHOLD)).toBe(false)
    expect(shouldUseStackedLayout(PANE_STACK_WIDTH_THRESHOLD + 100)).toBe(false)
  })
})

describe('paneCountToPreset', () => {
  it('maps 2 panes to 2up', () => {
    expect(paneCountToPreset(2)).toBe('2up')
  })
})

describe('resolveLayout', () => {
  it('falls back to even split for a fresh tab', () => {
    const layout = resolveLayout(2, undefined)
    expect(layout.colRatios).toEqual([0.5, 0.5])
  })
})

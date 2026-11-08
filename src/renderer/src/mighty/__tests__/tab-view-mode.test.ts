import { describe, it, expect } from 'vitest'
import { tabDisplayViewMode } from '../tab-view-mode'

describe('tabDisplayViewMode — addPane must not flip single→grid', () => {
  it('defaults to grid for a fresh tab (one pane or many)', () => {
    expect(tabDisplayViewMode({ viewMode: undefined })).toBe('grid')
    expect(tabDisplayViewMode({})).toBe('grid')
  })

  it('keeps grid when user chose grid', () => {
    expect(tabDisplayViewMode({ viewMode: 'grid' })).toBe('grid')
  })

  it('honours explicit single mode (multi-pane tabbed view)', () => {
    expect(tabDisplayViewMode({ viewMode: 'single' })).toBe('single')
  })

  it('stays grid before and after a second pane is added (same tab object shape)', () => {
    // Same invariant as hidden-tab fix: layout branch must not flip on tab/pane changes.
    const onePaneTab = { viewMode: undefined as undefined }
    const twoPaneTab = { viewMode: undefined as undefined }
    expect(tabDisplayViewMode(onePaneTab)).toBe('grid')
    expect(tabDisplayViewMode(twoPaneTab)).toBe('grid')
    expect(tabDisplayViewMode(onePaneTab)).toBe(tabDisplayViewMode(twoPaneTab))
  })
})

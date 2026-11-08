import { describe, it, expect } from 'vitest'
import { dayKeyFor, letterForIndex, formatTabName, nextWorkspaceName } from './workspace-naming'
import type { ChatWorkspaceTab } from '../../../shared/types'

// Local-time constructor on purpose: dayKeyFor reads wall-clock fields, so a UTC-parsed
// string would drift a day for anyone running the suite west of Greenwich.
const at = (y: number, mon: number, d: number): Date => new Date(y, mon - 1, d, 12)

const tab = (name: string): ChatWorkspaceTab => ({
  id: name,
  name,
  panes: [],
  layout: {},
  createdAt: ''
})

describe('dayKeyFor', () => {
  it('renders a human month + unpadded day for the display formats', () => {
    expect(dayKeyFor(at(2026, 7, 24), 'pretty')).toBe('Jul 24')
    expect(dayKeyFor(at(2026, 7, 4), 'compact')).toBe('Jul 4')
  })

  it('keeps the lowercase zero-padded form for slug', () => {
    expect(dayKeyFor(at(2026, 7, 4), 'slug')).toBe('jul-04')
    expect(dayKeyFor(at(2026, 1, 31), 'slug')).toBe('jan-31')
  })
})

describe('letterForIndex', () => {
  it('walks a→z then wraps to two letters without reusing a', () => {
    expect(letterForIndex(0)).toBe('a')
    expect(letterForIndex(25)).toBe('z')
    expect(letterForIndex(26)).toBe('aa')
    expect(letterForIndex(27)).toBe('ab')
  })
})

describe('formatTabName', () => {
  it('numbers pretty names from 1, including the first tab', () => {
    expect(formatTabName('Jul 24', 0, 'pretty')).toBe('Jul 24 · 1')
    expect(formatTabName('Jul 24', 1, 'pretty')).toBe('Jul 24 · 2')
  })

  it('omits the counter on compact’s first tab only', () => {
    expect(formatTabName('Jul 24', 0, 'compact')).toBe('Jul 24')
    expect(formatTabName('Jul 24', 1, 'compact')).toBe('Jul 24 (2)')
  })

  it('keeps the original slug shape', () => {
    expect(formatTabName('jul-24', 0, 'slug')).toBe('jul-24-s-a')
    expect(formatTabName('jul-24', 1, 'slug')).toBe('jul-24-s-b')
  })
})

describe('nextWorkspaceName', () => {
  const now = at(2026, 7, 24)

  it('starts at 1 when no tabs exist today', () => {
    expect(nextWorkspaceName([], 'pretty', now)).toBe('Jul 24 · 1')
  })

  it('counts only today’s tabs, ignoring other days', () => {
    const tabs = [tab('Jul 23 · 1'), tab('Jul 23 · 2'), tab('Jul 24 · 1')]
    expect(nextWorkspaceName(tabs, 'pretty', now)).toBe('Jul 24 · 2')
  })

  it('ignores user-renamed tabs that no longer carry a date prefix', () => {
    expect(nextWorkspaceName([tab('Taxes')], 'pretty', now)).toBe('Jul 24 · 1')
  })

  // Renaming frees a number, but the tab holding the NEXT one is still on screen —
  // so the freed slot gets reused and the surviving tab is skipped, not duplicated.
  it('reuses a number freed by a rename instead of colliding with a live tab', () => {
    expect(nextWorkspaceName([tab('Taxes'), tab('Jul 24 · 2')], 'pretty', now)).toBe('Jul 24 · 1')
  })

  it('skips past every number already on screen', () => {
    const tabs = [tab('Jul 24 · 1'), tab('Jul 24 · 2'), tab('Jul 24 · 3')]
    expect(nextWorkspaceName(tabs, 'pretty', now)).toBe('Jul 24 · 4')
  })

  // A user is free to type a name that looks auto-generated; it still must not be
  // handed out twice.
  it('treats a hand-typed date-shaped name as taken', () => {
    expect(nextWorkspaceName([tab('Jul 24 · 1')], 'pretty', now)).toBe('Jul 24 · 2')
  })

  // The setting is switchable mid-day, so a day can hold a mix of formats. Ignoring
  // the other formats' names would hand out an index another format already occupies.
  it('skips indexes taken in any format when the setting changed today', () => {
    // 'jul-24-s-a' occupies index 0 and 'Jul 24 (2)' occupies index 1, in different
    // formats — so index 2 is the first genuinely free one for either.
    const tabs = [tab('jul-24-s-a'), tab('Jul 24 (2)')]
    expect(nextWorkspaceName(tabs, 'pretty', now)).toBe('Jul 24 · 3')
    expect(nextWorkspaceName(tabs, 'slug', now)).toBe('jul-24-s-c')
  })
})

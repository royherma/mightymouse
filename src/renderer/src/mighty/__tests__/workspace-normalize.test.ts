import { describe, it, expect } from 'vitest'
import { normalizeWorkspaceTabs } from '../workspace-normalize'
import type { ChatWorkspaceTab } from '../../../../shared/types'

const tab = (panes: ChatWorkspaceTab['panes']): ChatWorkspaceTab => ({
  id: 't1',
  name: 'Aug 4 · 1',
  panes,
  createdAt: '2026-08-04T00:00:00.000Z'
})

describe('normalizeWorkspaceTabs', () => {
  it('leaves tabs that already have panes untouched', () => {
    const input = [tab([{ id: 'p1', sessionId: null }])]
    expect(normalizeWorkspaceTabs(input)[0].panes).toHaveLength(1)
    expect(normalizeWorkspaceTabs(input)[0].panes[0].id).toBe('p1')
  })

  it('mints one empty pane when a tab has panes:[]', () => {
    const input = [tab([])]
    const out = normalizeWorkspaceTabs(input)
    expect(out[0].panes).toHaveLength(1)
    expect(out[0].panes[0].sessionId).toBeNull()
    expect(out[0].panes[0].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    )
  })
})

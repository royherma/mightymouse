import { describe, it, expect } from 'vitest'
import {
  focusedPaneId,
  planOpenSession,
  planOpenSessionGlobal,
  firstEmptyPaneId,
  chatOpenState,
  sessionsOpenElsewhere
} from '../pane-selection'
import type { ChatPaneRef, ChatWorkspaceTab } from '../../../../shared/types'

const pane = (id: string, sessionId: string | null = null): ChatPaneRef => ({ id, sessionId })

const tab = (id: string, panes: ChatPaneRef[], name = 'Tab'): ChatWorkspaceTab => ({
  id,
  name,
  panes
})

describe('focusedPaneId — the one cursor', () => {
  it('uses the explicit focus when it points at a live pane', () => {
    expect(focusedPaneId(tab('t1', [pane('a'), pane('b')]), { t1: 'b' })).toBe('b')
  })

  it('falls back to the first pane when nothing is focused yet', () => {
    expect(focusedPaneId(tab('t1', [pane('a'), pane('b')]), {})).toBe('a')
  })

  it('falls back when the focused pane has been closed', () => {
    expect(focusedPaneId(tab('t1', [pane('a')]), { t1: 'gone' })).toBe('a')
  })

  it('is null with no tab', () => {
    expect(focusedPaneId(null, { t1: 'a' })).toBeNull()
  })
})

describe('sessionsOpenElsewhere', () => {
  it('collects sessions bound to non-focused panes', () => {
    const t = tab('t1', [pane('a', 's1'), pane('b', 's2'), pane('c', 's3')])
    expect(sessionsOpenElsewhere(t, 'a')).toEqual(new Set(['s2', 's3']))
  })

  it('excludes the focused pane and ignores empty panes', () => {
    const t = tab('t1', [pane('a', 's1'), pane('b', null)])
    expect(sessionsOpenElsewhere(t, 'a')).toEqual(new Set())
  })

  it('is empty for a single-pane tab', () => {
    expect(sessionsOpenElsewhere(tab('t1', [pane('a', 's1')]), 'a').size).toBe(0)
  })
})

describe('chatOpenState — the sidebar tells the truth about the grid', () => {
  const elsewhere = new Set(['s2'])

  it('marks the focused pane’s session as focused', () => {
    expect(chatOpenState('s1', pane('a', 's1'), elsewhere)).toBe('focused')
  })

  it('marks a session open in another pane as elsewhere, not closed', () => {
    expect(chatOpenState('s2', pane('a', 's1'), elsewhere)).toBe('elsewhere')
  })

  it('marks an unopened session as closed', () => {
    expect(chatOpenState('s9', pane('a', 's1'), elsewhere)).toBe('closed')
  })

  it('reports closed when the focused pane is empty', () => {
    expect(chatOpenState('s9', pane('a', null), new Set())).toBe('closed')
  })

  it('prefers focused over elsewhere if both somehow claim it', () => {
    expect(chatOpenState('s1', pane('a', 's1'), new Set(['s1']))).toBe('focused')
  })
})

describe('firstEmptyPaneId', () => {
  it('returns the first unbound pane in tab order', () => {
    expect(firstEmptyPaneId(tab('t1', [pane('a', 's1'), pane('b', null), pane('c', null)]))).toBe('b')
  })

  it('is null when every pane is bound', () => {
    expect(firstEmptyPaneId(tab('t1', [pane('a', 's1'), pane('b', 's2')]))).toBeNull()
  })
})

describe('planOpenSession — single-tab helper', () => {
  it('adds a pane when all slots are full and under the max', () => {
    const t = tab('t1', [pane('a', 's1'), pane('b', 's2')])
    expect(planOpenSession(t, 'a', 's9', 6)).toEqual({ kind: 'add-pane', tabId: 't1' })
  })

  it('opens a new workspace tab when every pane is full at the max', () => {
    const t = tab('t1', [pane('a', 's1'), pane('b', 's2')])
    expect(planOpenSession(t, 'a', 's9', 2)).toEqual({ kind: 'add-tab' })
  })

  it('binds an empty pane instead of replacing the focused pane when a slot is free', () => {
    const t = tab('t1', [pane('a', 's1'), pane('b', null)])
    expect(planOpenSession(t, 'a', 's9')).toEqual({ kind: 'bind', tabId: 't1', paneId: 'b' })
  })

  it('focuses the owning pane instead of duplicating it into the cursor', () => {
    const t = tab('t1', [pane('a', 's1'), pane('b', 's2')])
    expect(planOpenSession(t, 'a', 's2')).toEqual({ kind: 'focus', tabId: 't1', paneId: 'b' })
  })

  it('is a no-op re-focus when the session is already in the focused pane', () => {
    const t = tab('t1', [pane('a', 's1'), pane('b', 's2')])
    expect(planOpenSession(t, 'a', 's1')).toEqual({ kind: 'focus', tabId: 't1', paneId: 'a' })
  })

  it('fills an empty focused pane', () => {
    const t = tab('t1', [pane('a', null), pane('b', 's2')])
    expect(planOpenSession(t, 'a', 's9')).toEqual({ kind: 'bind', tabId: 't1', paneId: 'a' })
  })

  it('does nothing without a tab', () => {
    expect(planOpenSession(null, 'a', 's1')).toEqual({ kind: 'none' })
  })

  it('falls back to the first pane when the cursor is unset', () => {
    expect(planOpenSession(tab('t1', [pane('a')]), null, 's1')).toEqual({
      kind: 'bind',
      tabId: 't1',
      paneId: 'a'
    })
  })
})

const MAX = 6

describe('planOpenSessionGlobal — cross-tab sidebar open', () => {
  const tabs = [
    tab('t1', [pane('a', 's1'), pane('b', null)], 'Aug 4 · 1'),
    tab('t2', [pane('c', 's2'), pane('d', null)], 'Aug 4 · 2')
  ]

  it('focuses a session already open in the active tab', () => {
    expect(planOpenSessionGlobal(tabs, 't1', { t1: 'a' }, 's1', MAX)).toEqual({
      kind: 'focus',
      tabId: 't1',
      paneId: 'a'
    })
  })

  it('focuses a session open in a background workspace tab', () => {
    expect(planOpenSessionGlobal(tabs, 't1', { t1: 'a', t2: 'c' }, 's2', MAX)).toEqual({
      kind: 'focus',
      tabId: 't2',
      paneId: 'c'
    })
  })

  it('adds a workspace tab when the session is closed and all panes are full at the max', () => {
    expect(planOpenSessionGlobal(
      [tab('t1', [pane('a', 's1'), pane('b', 's2')])],
      't1',
      { t1: 'a' },
      's9',
      2
    )).toEqual({ kind: 'add-tab' })
  })

  it('adds a pane when every slot is full but under the max', () => {
    expect(planOpenSessionGlobal(
      [tab('t1', [pane('a', 's1'), pane('b', 's2')])],
      't1',
      { t1: 'b' },
      's9',
      MAX
    )).toEqual({ kind: 'add-pane', tabId: 't1' })
  })

  it('binds an empty pane in the active tab before replacing a live chat', () => {
    expect(planOpenSessionGlobal(tabs, 't1', { t1: 'a' }, 's9', MAX)).toEqual({
      kind: 'bind',
      tabId: 't1',
      paneId: 'b'
    })
  })

  it('focuses the pane already showing the session instead of binding the cursor', () => {
    expect(planOpenSessionGlobal(tabs, 't1', { t1: 'b' }, 's1', MAX)).toEqual({
      kind: 'focus',
      tabId: 't1',
      paneId: 'a'
    })
  })

  it('returns none when there is no active tab or cursor', () => {
    expect(planOpenSessionGlobal([], null, {}, 's1', MAX)).toEqual({ kind: 'none' })
    expect(planOpenSessionGlobal(tabs, 'missing', {}, 's9', MAX)).toEqual({ kind: 'none' })
  })
})

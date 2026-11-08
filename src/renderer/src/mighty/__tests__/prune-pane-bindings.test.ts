import { describe, it, expect } from 'vitest'
import { pruneDeadPaneBindings } from '../prune-pane-bindings'
import type { ChatWorkspaceTab } from '../../../../shared/types'

const tab = (id: string, sessionIds: (string | null)[]): ChatWorkspaceTab => ({
  id,
  name: id,
  createdAt: '2026-08-04T00:00:00.000Z',
  panes: sessionIds.map((sessionId, i) => ({ id: `${id}-p${i}`, sessionId })),
  layout: {}
})

const liveOnly =
  (...alive: string[]) =>
  async (id: string) =>
    alive.includes(id)

describe('pruneDeadPaneBindings', () => {
  it('nulls a binding whose session was deleted in an earlier launch', async () => {
    const out = await pruneDeadPaneBindings([tab('t1', ['gone'])], liveOnly())
    expect(out[0].panes[0].sessionId).toBeNull()
  })

  it('keeps live bindings untouched', async () => {
    const out = await pruneDeadPaneBindings([tab('t1', ['alive'])], liveOnly('alive'))
    expect(out[0].panes[0].sessionId).toBe('alive')
  })

  it('prunes only the dead pane in a mixed tab', async () => {
    const out = await pruneDeadPaneBindings([tab('t1', ['alive', 'gone', null])], liveOnly('alive'))
    expect(out[0].panes.map((p) => p.sessionId)).toEqual(['alive', null, null])
  })

  // Losing the pane would lose the split layout; an empty pane is still usable.
  it('never removes panes or tabs', async () => {
    const out = await pruneDeadPaneBindings([tab('t1', ['gone', 'gone']), tab('t2', ['gone'])], liveOnly())
    expect(out).toHaveLength(2)
    expect(out[0].panes).toHaveLength(2)
    expect(out[1].panes).toHaveLength(1)
  })

  it('checks each distinct session id once, not once per pane', async () => {
    const asked: string[] = []
    await pruneDeadPaneBindings([tab('t1', ['s1', 's1', 's2'])], async (id) => {
      asked.push(id)
      return true
    })
    expect(asked.sort()).toEqual(['s1', 's2'])
  })

  it('short-circuits when nothing is bound', async () => {
    const tabs = [tab('t1', [null])]
    const out = await pruneDeadPaneBindings(tabs, async () => {
      throw new Error('should not query')
    })
    expect(out).toBe(tabs)
  })
})

import { describe, it, expect } from 'vitest'
import { paneRenderKey, recordCreatedSession, switchBinding } from '../pane-binding'
import type { ChatPaneRef } from '../../../../shared/types'

const pane = (over: Partial<ChatPaneRef> = {}): ChatPaneRef => ({
  id: 'p1',
  sessionId: null,
  ...over
})

describe('pane render key', () => {
  // The bug: "new chat" showed the previous conversation, because the pane instance was
  // reused and cleared its state one frame too late. The key must CHANGE on a switch.
  it('changes when the user switches the pane to another chat', () => {
    const before = pane({ sessionId: 'old' })
    const after = switchBinding(before, 'new')
    expect(paneRenderKey(after)).not.toBe(paneRenderKey(before))
  })

  it('changes when the pane is unbound (delete / prune)', () => {
    const before = pane({ sessionId: 'gone' })
    expect(paneRenderKey(switchBinding(before, null))).not.toBe(paneRenderKey(before))
  })

  // The counterpart: a first send flips sessionId null→real mid-run. Remounting there
  // would throw away the live answer the pane is streaming.
  it('does NOT change when a first send reports the id it just created', () => {
    const before = pane({ sessionId: null })
    const after = recordCreatedSession(before, 'fresh')
    expect(after.sessionId).toBe('fresh')
    expect(paneRenderKey(after)).toBe(paneRenderKey(before))
  })

  it('keeps two panes distinct even at the same generation', () => {
    expect(paneRenderKey(pane({ id: 'a' }))).not.toBe(paneRenderKey(pane({ id: 'b' })))
  })

  it('treats a legacy pane with no bindGen as generation 0', () => {
    expect(paneRenderKey({ id: 'p1', bindGen: undefined })).toBe('p1:0')
  })

  // Switching away and back must not collide with the first key — otherwise React
  // reuses the instance and the stale-state bug returns on the round trip.
  it('never reuses a key when switching away and back to the same chat', () => {
    const start = pane({ sessionId: 'a' })
    const away = switchBinding(start, 'b')
    const back = switchBinding(away, 'a')
    expect(back.sessionId).toBe('a')
    expect(paneRenderKey(back)).not.toBe(paneRenderKey(start))
    expect(paneRenderKey(back)).not.toBe(paneRenderKey(away))
  })

  it('advances monotonically across repeated switches', () => {
    let p = pane()
    const keys = new Set([paneRenderKey(p)])
    for (const id of ['a', 'b', null, 'c']) {
      p = switchBinding(p, id)
      keys.add(paneRenderKey(p))
    }
    expect(keys.size).toBe(5)
  })
})

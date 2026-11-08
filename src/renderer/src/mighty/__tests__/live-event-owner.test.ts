import { describe, it, expect } from 'vitest'
import { ownsLivePush } from '../live-event-owner'

// The bug this file exists for: two panes each sending their FIRST message have no
// session id yet, so a sessionId-only filter compared null to null and let each pane
// render the other's stream. Screenshot 2026-08-04: one answer in three panes.
describe('ownsLivePush — concurrent first sends', () => {
  const paneA = { sessionId: null, clientRunId: 'run-a' }
  const paneB = { sessionId: null, clientRunId: 'run-b' }

  it("does not give pane A pane B's stream when neither has a session yet", () => {
    const fromB = { sessionId: '', clientRunId: 'run-b' }
    expect(ownsLivePush(paneA, fromB)).toBe(false)
    expect(ownsLivePush(paneB, fromB)).toBe(true)
  })

  it('still matches once the run resolves to a real session id', () => {
    const fromB = { sessionId: 'sess-b', clientRunId: 'run-b' }
    expect(ownsLivePush(paneA, fromB)).toBe(false)
    expect(ownsLivePush(paneB, fromB)).toBe(true)
  })

  it('ignores a push whose run this pane no longer owns (superseded send)', () => {
    const settled = { sessionId: 'sess-a', clientRunId: null }
    expect(ownsLivePush(settled, { sessionId: 'sess-a', clientRunId: 'run-a' })).toBe(false)
  })
})

describe('ownsLivePush — runs this pane did not start', () => {
  it('accepts an uncorrelated push for the session it is showing', () => {
    const pane = { sessionId: 'sess-1', clientRunId: null }
    expect(ownsLivePush(pane, { sessionId: 'sess-1' })).toBe(true)
  })

  it('rejects an uncorrelated push for another session', () => {
    const pane = { sessionId: 'sess-1', clientRunId: null }
    expect(ownsLivePush(pane, { sessionId: 'sess-2' })).toBe(false)
  })

  // An unbound pane must not adopt a stray push just because both sides are empty —
  // this is the null-vs-null compare that caused the original cross-talk.
  it('rejects everything uncorrelated while unbound', () => {
    const fresh = { sessionId: null, clientRunId: null }
    expect(ownsLivePush(fresh, { sessionId: '' })).toBe(false)
    expect(ownsLivePush(fresh, { sessionId: 'sess-1' })).toBe(false)
  })
})

import { describe, it, expect } from 'vitest'
import { sameHistory, sameFeedback } from '../HistoryList'
import type { FeedbackEntry, HistoryItem } from '../../../../shared/types'

// Every finished run re-pushes all 30 recent rows. These guards decide whether
// that push re-renders the list, so a false positive strands the user on stale
// rows — the one failure that isn't visible in a diff.

function row(over: Partial<HistoryItem> = {}): HistoryItem {
  return {
    run_id: 'r1',
    instruction: 'do the thing',
    mode: 'ask',
    ts: '2026-09-21T14:00:00Z',
    backend: 'claude',
    selection_preview: '',
    ok: true,
    ...over
  }
}

describe('sameHistory', () => {
  it('suppresses the re-render when the push is identical', () => {
    expect(sameHistory([row()], [row()])).toBe(true)
  })

  it('lets a new run through', () => {
    expect(sameHistory([row()], [row({ run_id: 'r2' }), row()])).toBe(false)
  })

  it('lets a run that just finished through', () => {
    const before = row({ run_state: 'pending' })
    expect(sameHistory([before], [row({ run_state: undefined, result: 'done' })])).toBe(false)
  })

  it('lets a still-streaming answer through', () => {
    const before = row({ turns: [{ q: 'hi', a: 'par' }] })
    const after = row({ turns: [{ q: 'hi', a: 'partial answer' }] })
    expect(sameHistory([before], [after])).toBe(false)
  })

  it('lets an added turn through', () => {
    const before = row({ turns: [{ q: 'hi', a: 'yes' }] })
    const after = row({ turns: [{ q: 'hi', a: 'yes' }, { q: 'more', a: 'ok' }] })
    expect(sameHistory([before], [after])).toBe(false)
  })

  it('lets a failure through', () => {
    expect(sameHistory([row()], [row({ ok: false })])).toBe(false)
  })

  it('lets a search result that dropped rows through', () => {
    expect(sameHistory([row(), row({ run_id: 'r2' })], [row()])).toBe(false)
  })
})

describe('sameFeedback', () => {
  const entry = (over: Partial<FeedbackEntry> = {}): FeedbackEntry =>
    ({ rating: 'up', note: null, ...over }) as FeedbackEntry

  it('suppresses the re-render when nothing was rated', () => {
    expect(sameFeedback({ r1: entry() }, { r1: entry() })).toBe(true)
  })

  it('lets a changed rating through', () => {
    expect(sameFeedback({ r1: entry() }, { r1: entry({ rating: 'down' }) })).toBe(false)
  })

  it('lets a new note through', () => {
    expect(sameFeedback({ r1: entry() }, { r1: entry({ note: 'wrong tone' }) })).toBe(false)
  })

  it('lets a first-ever rating through', () => {
    expect(sameFeedback({}, { r1: entry() })).toBe(false)
  })
})

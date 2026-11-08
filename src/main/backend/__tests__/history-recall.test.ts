/**
 * Tests for the history-recall feature's pure logic:
 *   1. parseDateRange — natural phrases → correct UTC-ish local windows, null otherwise
 *   2. mightBeRecall — keyword gate fires on recall phrasing, not on normal requests
 *   3. assembleHistoryRecall — budget-bounded, empty-safe, inlines turns for top row
 */

import { describe, it, expect } from 'vitest'
import { parseDateRange } from '../history-date-parser'
import { mightBeRecall } from '../recall-classifier'
import { assembleHistoryRecall, RECALL_CHAR_BUDGET } from '../context-memory'
import { HistoryEntry } from '../../../shared/types'

function entry(over: Partial<HistoryEntry>): HistoryEntry {
  return {
    schema_version: 1,
    run_id: Math.random().toString(36).slice(2),
    ts: '2026-06-01T10:00:00Z',
    duration_s: 1,
    instruction: 'do a thing',
    mode: 'ask',
    selection: '',
    selection_chars: 0,
    ok: true,
    backend: 'mightymouse',
    model: 'x',
    ctx_attached: false,
    ...over
  }
}

describe('parseDateRange', () => {
  it('yesterday is a 1-day window ending at the start of today', () => {
    const r = parseDateRange('what did I ask yesterday')!
    expect(r).not.toBeNull()
    const ms = r.to.getTime() - r.from.getTime()
    expect(Math.round(ms / 3_600_000)).toBe(24)
  })

  it('this morning ends at local noon', () => {
    const r = parseDateRange('what was I doing this morning')!
    expect(r.from.getHours()).toBe(0)
    expect(r.to.getHours()).toBe(12)
  })

  it('matches weekday names', () => {
    expect(parseDateRange('what did I do on tuesday')).not.toBeNull()
  })

  it('returns null when no date phrase is present', () => {
    expect(parseDateRange('rewrite this email')).toBeNull()
    expect(parseDateRange('summarize the selection')).toBeNull()
  })

  it('prefers "last week" over a bare week match', () => {
    const last = parseDateRange('what did I work on last week')!
    const thisW = parseDateRange('what did I work on this week')!
    // last week's window ends where this week's begins
    expect(last.to.getTime()).toBe(thisW.from.getTime())
  })
})

describe('mightBeRecall', () => {
  it('fires on recall phrasing', () => {
    for (const q of [
      'what did I ask yesterday',
      'show me my history',
      'what was I working on last week',
      'remind me what I did this morning'
    ]) {
      expect(mightBeRecall(q)).toBe(true)
    }
  })

  it('does not fire on ordinary requests', () => {
    for (const q of ['rewrite this paragraph', 'make it shorter', 'translate to french', 'what is the capital of France']) {
      expect(mightBeRecall(q)).toBe(false)
    }
  })
})

describe('assembleHistoryRecall', () => {
  it('returns a no-records message when empty', () => {
    const out = assembleHistoryRecall([], 'what did I ask yesterday')
    expect(out).toContain('No matching activity')
  })

  it('stays within the budget even with many rows', () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      entry({ instruction: `question number ${i} with some length to it`, result: 'a fairly long answer '.repeat(20) })
    )
    const out = assembleHistoryRecall(many, 'what did I ask')
    expect(out.length).toBeLessThanOrEqual(RECALL_CHAR_BUDGET + 64) // +slack for the trailing "more" line
    expect(out).toContain('more not shown')
  })

  it('inlines Q/A turns for the most recent row only', () => {
    const rows = [
      entry({ instruction: 'top row', turns: [{ q: 'first q', a: 'first a' }] }),
      entry({ instruction: 'older row', turns: [{ q: 'old q', a: 'old a' }] })
    ]
    const out = assembleHistoryRecall(rows, 'recap')
    expect(out).toContain('Q: first q')
    expect(out).toContain('A: first a')
    // older row is summarized, not inlined
    expect(out).toContain('1-turn conversation')
    expect(out).not.toContain('Q: old q')
  })

  it('anchors the model with the current local time + weekday', () => {
    // 2026-06-02 is a Tuesday. Pass an explicit `now` so the assertion is
    // deterministic regardless of when the suite runs.
    const now = new Date(2026, 5, 2, 16, 47) // local June 2, 16:47
    const out = assembleHistoryRecall([entry({})], 'recap', RECALL_CHAR_BUDGET, now)
    expect(out).toContain('Current local time: 2026-06-02 16:47 (Tuesday')
    // Offset is pinned so a backend reasoning in UTC can reconcile the wall-clock.
    expect(out).toMatch(/UTC[+-]\d{2}:\d{2}/)
    expect(out).toContain('local time')
  })

  it('renders entry timestamps in LOCAL time, not UTC', () => {
    // A UTC instant whose local wall-clock differs from its UTC string. We assert the
    // rendered minute matches getHours()/getMinutes() of the SAME instant in local tz,
    // which is what the user reads on their clock — never the toISOString() UTC form.
    const ts = '2026-06-01T09:10:00Z'
    const d = new Date(ts)
    const p = (n: number): string => String(n).padStart(2, '0')
    const expectedLocal = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
    const out = assembleHistoryRecall([entry({ ts })], 'recap')
    expect(out).toContain(expectedLocal)
    // The bug we fixed: must NOT emit the raw UTC wall-clock when tz offset is nonzero.
    if (d.getTimezoneOffset() !== 0) {
      expect(out).not.toContain('2026-06-01 09:10')
    }
  })
})

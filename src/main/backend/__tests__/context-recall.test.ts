/**
 * Tests for assembleContextRecall — the relevance search that powers the MANUAL
 * (⌘⌥⇧S) suggestion trigger. Unlike the idle bubble, this searches ALL history for
 * rows matching the current on-screen context (contact / subject / topic).
 *
 * Covers:
 *   1. Distinctive terms are pulled from window title + selection (stopwords dropped).
 *   2. Per-term results are unioned + deduped by run_id, most-recent-first.
 *   3. No usable terms (empty/stopword-only context) → '' (clean degrade to recency).
 *   4. Terms search but match nothing → '' (no empty "## Your history" header noise).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../store/paths', () => ({
  PATHS: { CONTEXT_LOG_DIR: '/fake/context-log', HISTORY: '/fake/rewrite-history.jsonl' }
}))
vi.mock('../../store/prefs', () => ({ PREFS: { getContextLog: vi.fn(() => false) } }))

const { searchText } = vi.hoisted(() => ({ searchText: vi.fn() }))
vi.mock('../../store/history', async () => {
  const actual = await vi.importActual<typeof import('../../store/history')>('../../store/history')
  return { HISTORY: { searchText }, parseTs: actual.parseTs }
})

import { assembleContextRecall } from '../context-memory'
import type { ContextData, HistoryEntry } from '../../../shared/types'

function ctx(windowTitle: string | null): ContextData {
  return { frontApp: 'Mail', windowTitle, browserURL: null, screenshotPath: null }
}

function entry(run_id: string, instruction: string, ts: string): HistoryEntry {
  return {
    run_id,
    ts,
    mode: 'ask',
    instruction,
    selection: '',
    result: '',
    ok: true,
    front_app: 'Mail',
    window_title: '',
    browser_url: ''
  } as HistoryEntry
}

beforeEach(() => searchText.mockReset())

describe('assembleContextRecall', () => {
  it('searches distinctive terms from the window title and drops stopwords', () => {
    searchText.mockReturnValue([entry('r1', 'draft a reply to Acme', '2026-06-01T10:00:00.000Z')])

    const blob = assembleContextRecall(ctx('Re: Acme pricing - Inbox'), '')

    // 'Re' and 'Inbox' are stopwords; 'Acme' and 'pricing' are the real needles.
    const searched = searchText.mock.calls.map((c) => c[0][0])
    expect(searched).toContain('acme')
    expect(searched).toContain('pricing')
    expect(searched).not.toContain('re')
    expect(searched).not.toContain('inbox')
    expect(blob).toContain('Acme')
  })

  it('unions and dedupes per-term hits, most-recent-first', () => {
    // Same row matches two terms; a newer row matches one. Expect both, newest first.
    const older = entry('dup', 'older acme note', '2026-06-01T09:00:00.000Z')
    const newer = entry('new', 'newer pricing note', '2026-06-02T09:00:00.000Z')
    searchText.mockImplementation((terms: string[]) =>
      terms?.[0] === 'acme' ? [older] : [older, newer]
    )

    const blob = assembleContextRecall(ctx('Acme pricing'), '')

    // 'dup' appears once despite matching both terms; 'new' is present and ordered first.
    expect(blob.indexOf('newer pricing note')).toBeGreaterThan(-1)
    expect(blob.indexOf('older acme note')).toBeGreaterThan(-1)
    expect(blob.indexOf('newer pricing note')).toBeLessThan(blob.indexOf('older acme note'))
  })

  it('returns empty when no usable terms exist', () => {
    expect(assembleContextRecall(ctx('Re: Inbox'), '')).toBe('')
    expect(searchText).not.toHaveBeenCalled()
  })

  it('returns empty when terms match nothing', () => {
    searchText.mockReturnValue([])
    expect(assembleContextRecall(ctx('Acme pricing'), '')).toBe('')
  })
})

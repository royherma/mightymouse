import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HistoryEntry } from '../../../shared/types'
import type { Outcome } from '../../insights/outcome-store'
import { CONFIG } from '../../../shared/config'

// estimateDuration's ONLY dependency is HISTORY.readAllEntries(). Mock it so each
// test feeds an exact set of rows and asserts the median/confidence/window logic.
const entries: HistoryEntry[] = []
vi.mock('../../store/history', () => ({
  HISTORY: { readAllEntries: () => entries }
}))

// estimateSuggestionDuration reads OutcomeStore.readRecent (newest-first). Mock it
// to feed gen-time rows directly. The estimator slices to a window itself, so the
// mock just returns the whole array.
const outcomes: Outcome[] = []
vi.mock('../../insights/outcome-store', () => ({
  OutcomeStore: { readRecent: () => outcomes }
}))

import { estimateDuration, estimateSuggestionDuration } from '../duration-estimator'

/** Minimal valid row; override the fields a test cares about. */
function row(over: Partial<HistoryEntry>): HistoryEntry {
  return {
    schema_version: 1,
    run_id: 'r',
    ts: '2026-06-04T10:00:00Z',
    duration_s: 2,
    instruction: 'x',
    mode: 'ask',
    selection: '',
    selection_chars: 0,
    ok: true,
    backend: 'mightymouse',
    model: 'm',
    ctx_attached: false,
    ...over
  }
}

/** Minimal valid Outcome row; override what a test cares about. */
function outcome(over: Partial<Outcome>): Outcome {
  return {
    ts: '2026-06-04T10:00:00Z',
    front_app: 'app',
    mode: 'ask',
    instruction_stem: 'x',
    shown_index: 0,
    accepted: false,
    gen_ms: 5000,
    ...over
  }
}

afterEach(() => {
  entries.length = 0
  outcomes.length = 0
})

describe('estimateDuration', () => {
  it('returns null when there is no matching history', () => {
    entries.push(row({ mode: 'act', backend: 'codex' }))
    expect(estimateDuration('ask', 'mightymouse')).toBeNull()
  })

  it('estimates off a SINGLE matching run (low confidence, never null)', () => {
    entries.push(row({ duration_s: 3 }))
    const est = estimateDuration('ask', 'mightymouse')
    expect(est).toEqual({ etaMs: 3000, sampleSize: 1, confidence: 'low' })
  })

  it('uses the median, so one outlier does not drag the ETA', () => {
    // 2s, 2s, 2s, 90s → median 2s, not the ~24s mean.
    for (const s of [2, 2, 2, 90]) entries.push(row({ duration_s: s }))
    expect(estimateDuration('ask', 'mightymouse')?.etaMs).toBe(2000)
  })

  it('keys on (mode, backend) — never blends across shapes', () => {
    entries.push(row({ mode: 'ask', backend: 'mightymouse', duration_s: 2 }))
    entries.push(row({ mode: 'act', backend: 'mightymouse', duration_s: 40 }))
    entries.push(row({ mode: 'ask', backend: 'codex', duration_s: 99 }))
    expect(estimateDuration('ask', 'mightymouse')?.etaMs).toBe(2000)
    expect(estimateDuration('act', 'mightymouse')?.etaMs).toBe(40000)
  })

  it('ignores failed runs (a timed-out run is not a typical time)', () => {
    entries.push(row({ duration_s: 2, ok: true }))
    entries.push(row({ duration_s: 120, ok: false }))
    expect(estimateDuration('ask', 'mightymouse')?.etaMs).toBe(2000)
  })

  it('skips implausibly-fast rows below MIN_SAMPLE_MS', () => {
    entries.push(row({ duration_s: 0.05 })) // 50ms — below the floor
    entries.push(row({ duration_s: 4 }))
    const est = estimateDuration('ask', 'mightymouse')
    expect(est?.sampleSize).toBe(1)
    expect(est?.etaMs).toBe(4000)
  })

  it('only windows the most recent SAMPLE_WINDOW matches', () => {
    // Oldest rows are slow; the recent window is fast. The estimate should follow
    // the recent window, proving old runs fall out.
    for (let i = 0; i < 5; i++) entries.push(row({ duration_s: 100 })) // old + slow
    for (let i = 0; i < CONFIG.ESTIMATOR.SAMPLE_WINDOW; i++) entries.push(row({ duration_s: 3 }))
    expect(estimateDuration('ask', 'mightymouse')?.etaMs).toBe(3000)
  })

  it('grades confidence by sample size', () => {
    const push = (n: number): void => {
      entries.length = 0
      for (let i = 0; i < n; i++) entries.push(row({ duration_s: 2 }))
    }
    push(1)
    expect(estimateDuration('ask', 'mightymouse')?.confidence).toBe('low')
    push(CONFIG.ESTIMATOR.CONFIDENCE_MED_AT)
    expect(estimateDuration('ask', 'mightymouse')?.confidence).toBe('med')
    push(CONFIG.ESTIMATOR.CONFIDENCE_HIGH_AT)
    expect(estimateDuration('ask', 'mightymouse')?.confidence).toBe('high')
  })

  it('degrades to null if history throws (never crashes a run)', async () => {
    const mod = await import('../../store/history')
    const spy = vi.spyOn(mod.HISTORY, 'readAllEntries').mockImplementation(() => {
      throw new Error('decrypt failed')
    })
    expect(estimateDuration('ask', 'mightymouse')).toBeNull()
    spy.mockRestore()
  })
})

describe('estimateSuggestionDuration', () => {
  it('returns null when there are no usable gen rows', () => {
    expect(estimateSuggestionDuration()).toBeNull()
  })

  it('estimates off a single gen row (low confidence)', () => {
    outcomes.push(outcome({ gen_ms: 6000 }))
    expect(estimateSuggestionDuration()).toEqual({ etaMs: 6000, sampleSize: 1, confidence: 'low' })
  })

  it('counts each batch once even when it wrote multiple chip rows', () => {
    // One 3-chip batch (same ts + gen_ms) + one 1-chip batch. Median of the TWO
    // distinct batches, not of four rows — else the big batch would dominate.
    outcomes.push(outcome({ ts: 'b1', gen_ms: 4000 }))
    outcomes.push(outcome({ ts: 'b1', gen_ms: 4000 }))
    outcomes.push(outcome({ ts: 'b1', gen_ms: 4000 }))
    outcomes.push(outcome({ ts: 'b2', gen_ms: 8000 }))
    const est = estimateSuggestionDuration()
    expect(est?.sampleSize).toBe(2)
    expect(est?.etaMs).toBe(6000) // median(4000, 8000)
  })

  it('uses the median so one slow gen does not drag the ring', () => {
    for (const [i, ms] of [3000, 3000, 3000, 40000].entries()) {
      outcomes.push(outcome({ ts: `t${i}`, gen_ms: ms }))
    }
    expect(estimateSuggestionDuration()?.etaMs).toBe(3000)
  })

  it('skips rows below MIN_SAMPLE_MS and legacy rows missing gen_ms', () => {
    outcomes.push(outcome({ ts: 'a', gen_ms: 50 })) // too fast
    outcomes.push(outcome({ ts: 'b', gen_ms: undefined })) // legacy
    outcomes.push(outcome({ ts: 'c', gen_ms: 7000 }))
    const est = estimateSuggestionDuration()
    expect(est?.sampleSize).toBe(1)
    expect(est?.etaMs).toBe(7000)
  })

  it('degrades to null if the outcome store throws', async () => {
    const mod = await import('../../insights/outcome-store')
    const spy = vi.spyOn(mod.OutcomeStore, 'readRecent').mockImplementation(() => {
      throw new Error('decrypt failed')
    })
    expect(estimateSuggestionDuration()).toBeNull()
    spy.mockRestore()
  })
})

// duration-estimator.ts — predicts how long a run will take, from the durations
// of past runs with the SAME shape (mode + backend). It's the single home for the
// progress bar's ETA: the UI ticks elapsed time itself, but it has no idea what
// "done" looks like — this service supplies the target.
//
// Design notes (the "smart" part, on purpose):
//   • Keyed by (mode, backend). An `act` run dwarfs a `rewrite`, and codex ≠
//     mightymouse ≠ claude — one global average would lie. Never blend across keys.
//   • Median, not mean. One 90s outlier (a slow agent, a network stall) must not
//     drag every future bar. The median of recent runs is the typical case.
//   • Successful runs only. A timed-out 120s run isn't a "typical time" — including
//     failures would teach the bar to expect the worst.
//   • Recency window (last N). The estimate tracks the user's CURRENT machine and
//     model, adapting as those change, instead of being anchored to ancient runs.
//   • Reads HISTORY through its warm cache — calling this on every run start is free.
//
// Fully standalone: it imports HISTORY (read-only) and CONFIG, nothing else. It
// knows nothing about HUD cards, IPC, or React. Delete this folder + its two call
// sites and the app behaves exactly as it did before — the bar simply never shows.
import { CONFIG } from '../../shared/config'
import type { AppMode, DurationEstimate, EstimateConfidence } from '../../shared/types'
import { HISTORY } from '../store/history'
import { OutcomeStore } from '../insights/outcome-store'
import type { BackendId } from '../backend/adapters'

/** Median of a numeric list. Caller guarantees length ≥ 1. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/** Sample count → confidence tier. More past runs = a tighter, more trustworthy ETA. */
function confidenceFor(sampleSize: number): EstimateConfidence {
  if (sampleSize >= CONFIG.ESTIMATOR.CONFIDENCE_HIGH_AT) return 'high'
  if (sampleSize >= CONFIG.ESTIMATOR.CONFIDENCE_MED_AT) return 'med'
  return 'low'
}

/**
 * Predict the duration of a `(mode, backend)` run from history.
 *
 * Returns `null` when there's NO usable prior run for that pair — the caller then
 * shows just the live timer (no bar), which is honest: we don't invent an ETA we
 * can't back. As soon as ONE matching run exists, we estimate (low confidence) —
 * an imperfect bar beats no bar, and it sharpens as more runs land.
 *
 * Pure read: never writes, never throws on bad data (a malformed row is skipped).
 */
export function estimateDuration(mode: AppMode, backend: BackendId): DurationEstimate | null {
  let durationsMs: number[]
  try {
    const entries = HISTORY.readAllEntries()
    durationsMs = []
    // Walk newest→oldest so the window is the most RECENT N matching runs.
    for (let i = entries.length - 1; i >= 0; i--) {
      if (durationsMs.length >= CONFIG.ESTIMATOR.SAMPLE_WINDOW) break
      const row = entries[i]
      if (!row || row.ok !== true) continue
      if (row.mode !== mode || row.backend !== backend) continue
      const ms = (row.duration_s ?? 0) * 1000
      // Skip implausibly-fast rows (instant cache hit / mis-logged) so they can't
      // pull the median to near-zero and make the bar finish before it starts.
      if (ms < CONFIG.ESTIMATOR.MIN_SAMPLE_MS) continue
      durationsMs.push(ms)
    }
  } catch {
    // History unreadable (decryption mid-toggle, disk hiccup) — degrade to no bar.
    return null
  }

  if (durationsMs.length === 0) return null

  return {
    etaMs: Math.round(median(durationsMs)),
    sampleSize: durationsMs.length,
    confidence: confidenceFor(durationsMs.length)
  }
}

/**
 * Predict how long the next suggestion-generation will take, for the "Thinking
 * about your next move" bubble's ring.
 *
 * Sibling of estimateDuration but reads the OUTCOME store, not HISTORY —
 * suggestion gen-times live there (`gen_ms`), keyed by neither mode nor backend
 * but by "what the model took last time". A batch writes one row per shown chip,
 * all sharing the same `ts` + `gen_ms`, so we dedupe by `ts` to count each batch
 * once (else a 3-chip batch would weigh 3× a 1-chip batch in the median).
 *
 * Same contract as estimateDuration: null when there's no usable prior gen (→ no
 * ring, just the spinner), one sample is enough to estimate, never throws.
 */
export function estimateSuggestionDuration(): DurationEstimate | null {
  let durationsMs: number[]
  try {
    const rows = OutcomeStore.readRecent(CONFIG.ESTIMATOR.SAMPLE_WINDOW * 4)
    const seenBatch = new Set<string>()
    durationsMs = []
    // readRecent is already newest→oldest. Dedupe per batch (by ts) and window to
    // the most RECENT N distinct gens.
    for (const row of rows) {
      if (durationsMs.length >= CONFIG.ESTIMATOR.SAMPLE_WINDOW) break
      const ms = row.gen_ms ?? 0
      if (ms < CONFIG.ESTIMATOR.MIN_SAMPLE_MS) continue
      if (seenBatch.has(row.ts)) continue
      seenBatch.add(row.ts)
      durationsMs.push(ms)
    }
  } catch {
    return null
  }

  if (durationsMs.length === 0) return null

  return {
    etaMs: Math.round(median(durationsMs)),
    sampleSize: durationsMs.length,
    confidence: confidenceFor(durationsMs.length)
  }
}

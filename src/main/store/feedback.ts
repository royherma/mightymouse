/**
 * feedback.ts — explicit user feedback on a generation (👍 / 👎 + an optional
 * "what I expected" note), keyed by the run's `run_id`.
 *
 * WHY a separate store (not a HistoryEntry field): feedback is written LATER than
 * the run (the user rates after seeing the result, sometimes from the History
 * flyout long after), and a history row is the immutable record of what happened.
 * Bolting a mutable rating onto it would mean rewriting history rows out of band.
 * A small append-only log keyed by run_id, latest-wins, keeps the two concerns
 * clean and lets the rating change without touching history.
 *
 * The loop this feeds:
 *   1. capture  — the user rates a result (this store).
 *   2. learn    — recent 👎 + corrections are summarized into the memory blob
 *                 (context-memory.ts) so the model adapts to THIS user.
 *   3. measure  — a `feedback_given` analytics event tracks the good/bad/correction
 *                 rate over time (the eval signal).
 *
 * At rest: a note can contain anything the user typed, so each line honors the same
 * history-encryption toggle (PREFS.getHistoryEncryption) via safe-storage. Latest
 * row for a run_id wins, so re-rating just appends — no in-place edit, no lost data.
 */

import { existsSync, readFileSync, appendFileSync } from 'fs'
import { PATHS } from './paths'
import { PREFS } from './prefs'
import { encryptLine, decryptLine } from './safe-storage'
import { historyTimestamp } from './history'
import { FeedbackEntry, FeedbackRating } from '../../shared/types'

// ── Warm in-memory map ─────────────────────────────────────────────────────────
// run_id → latest FeedbackEntry. Built once per session from the file, then kept in
// lockstep by record(). Tiny (one row per rated run), so a full-file Map is fine
// well past the history sqlite/qmd seam.
let _cache: Map<string, FeedbackEntry> | null = null

function decodeLine(line: string): FeedbackEntry | null {
  const plain = decryptLine(line) // legacy plaintext passes through; encrypted decrypts
  if (plain === null) return null // decrypt failed (wrong machine) → skip row
  const t = plain.trim()
  if (t === '') return null
  try {
    const e = JSON.parse(t) as FeedbackEntry
    return e && typeof e.run_id === 'string' && e.run_id !== '' ? e : null
  } catch {
    return null
  }
}

/** Load the file into the run_id→entry map (last line per run_id wins). Idempotent. */
function loadCache(): Map<string, FeedbackEntry> {
  if (_cache) return _cache
  const map = new Map<string, FeedbackEntry>()
  if (existsSync(PATHS.FEEDBACK)) {
    try {
      for (const line of readFileSync(PATHS.FEEDBACK, 'utf-8').split('\n')) {
        if (line.trim() === '') continue
        const e = decodeLine(line)
        if (e) map.set(e.run_id, e) // later line overrides earlier → latest rating wins
      }
    } catch (err) {
      console.error('Failed to read feedback:', err)
    }
  }
  _cache = map
  return map
}

export const FEEDBACK = {
  /**
   * Record (or overwrite) feedback for a run. Appends a fresh line — never mutates
   * an existing one — so a re-rate is just another append and the cache picks the
   * latest. Pass note='' to rate with no note; pass rating to flip thumbs. Pass
   * rating=null for a NOTE-ONLY entry (a user-generated capture with no AI answer
   * to thumb) — the note still persists and folds into memory, but no up/down.
   */
  record(input: {
    run_id: string
    rating: FeedbackRating | null
    note?: string
    mode?: string
    backend?: string
  }): void {
    if (PREFS.getIncognito()) return
    const entry: FeedbackEntry = {
      run_id: input.run_id,
      rating: input.rating,
      note: input.note?.trim() || undefined,
      mode: input.mode,
      backend: input.backend,
      ts: historyTimestamp()
    }
    try {
      const json = JSON.stringify(entry)
      const line = PREFS.getHistoryEncryption() ? encryptLine(json) : json
      appendFileSync(PATHS.FEEDBACK, line + '\n', 'utf-8')
      loadCache().set(entry.run_id, entry) // keep warm map in lockstep
    } catch (err) {
      console.error('Failed to append feedback:', err)
    }
  },

  /** Latest rating for one run, or null if never rated. */
  get(runId: string): FeedbackEntry | null {
    return loadCache().get(runId) ?? null
  },

  /** Every run_id→rating, for hydrating the History flyout in one shot. */
  all(): Record<string, FeedbackEntry> {
    return Object.fromEntries(loadCache())
  },

  /**
   * The most recent corrections (👎 with a note), newest-first. These are the
   * "model missed, here's what I wanted" signals that buildMemoryBlob folds back
   * into the prompt. Capped by `limit`.
   */
  recentCorrections(limit = 5): FeedbackEntry[] {
    const rows = Array.from(loadCache().values())
      .filter((e) => e.rating === 'down' && e.note)
      .sort((a, b) => (a.ts < b.ts ? 1 : -1))
    return rows.slice(0, limit)
  },

  /**
   * The most recent praises (👍 WITH a note), newest-first. The positive mirror of
   * recentCorrections: "this was great because X" is reinforcement the model should
   * KEEP doing, folded into the memory blob alongside corrections. Capped by `limit`.
   */
  recentPraises(limit = 5): FeedbackEntry[] {
    const rows = Array.from(loadCache().values())
      .filter((e) => e.rating === 'up' && e.note)
      .sort((a, b) => (a.ts < b.ts ? 1 : -1))
    return rows.slice(0, limit)
  },

  /**
   * The most recent NOTE-ONLY entries (a capture note with no thumb: rating=null),
   * newest-first. These are "why I grabbed this screenshot/recording" — context the
   * model can fold in the same way it uses corrections/praises. Capped by `limit`.
   */
  recentNotes(limit = 5): FeedbackEntry[] {
    const rows = Array.from(loadCache().values())
      .filter((e) => e.rating === null && e.note)
      .sort((a, b) => (a.ts < b.ts ? 1 : -1))
    return rows.slice(0, limit)
  }
}

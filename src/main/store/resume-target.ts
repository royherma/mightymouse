/**
 * How a history row resolves to something Continue can open.
 *
 * Two questions, one place, so the IPC handler and its tests can't drift:
 *   1. Is there anything to resume at all? (turns, or a result to synthesize one from)
 *   2. Which Mighty conversation does this row belong to?
 *
 * (2) is the one that kept getting this wrong. Three generations of rows exist on
 * disk and they record the link differently:
 *   - capture rows      → session_id, written by logCapture since captures existed
 *   - ask/act rows      → session_id, only since the fix that added it there
 *   - everything older  → nothing on the row; the turn-level run_id stamp is the
 *                         only remaining link, and rows older than THAT have none
 *
 * A row with no resolvable session isn't broken — it just has to be seeded as a
 * transient thread instead of opened. Callers must handle null, never assume.
 */

import type { HistoryEntry } from '../../shared/types'

/** The pair Continue needs: the thread to show, and the session to open (if any). */
export interface ResumeTarget {
  /** Flat q/a turns to render. Empty means there is nothing to resume. */
  turns: Array<{ q: string; a: string }>
  /** The conversation to open, or null to seed `turns` as a transient thread. */
  sessionId: string | null
}

/**
 * The turns a row can be resumed from.
 *
 * A chat row carries its own thread. A capture (or any single-shot row) carries only
 * a result — the transcript — which becomes turn one with no answer yet, which is
 * exactly the "first message, press Enter" shape Continue wants for a voice note.
 */
export function resumableTurns(entry: HistoryEntry): Array<{ q: string; a: string }> {
  if (entry.turns && entry.turns.length > 0) return entry.turns.slice()
  if (entry.result) return [{ q: entry.instruction, a: entry.result }]
  return []
}

/**
 * The conversation a row belongs to, or null if the link isn't recoverable.
 *
 * `findByRunId` is the fallback for rows written before session_id was recorded on
 * ask/act rows — passed in rather than imported so this stays a pure function.
 */
export function resolveSessionId(
  entry: HistoryEntry,
  findByRunId: (runId: string) => string | null
): string | null {
  if (entry.session_id) return entry.session_id
  return entry.run_id ? findByRunId(entry.run_id) : null
}

/** Both answers at once — what the resumeSession IPC actually needs. */
export function resumeTarget(
  entry: HistoryEntry,
  findByRunId: (runId: string) => string | null
): ResumeTarget {
  return {
    turns: resumableTurns(entry),
    sessionId: resolveSessionId(entry, findByRunId)
  }
}

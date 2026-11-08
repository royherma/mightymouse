/**
 * What counts as a message vs. a draft, for one stored session.
 *
 * A session can end in a turn that was never sent: a listen capture parks its
 * transcript as turn one with an empty answer, waiting for the user to hit Enter.
 * Rendered as a message that turn is a dead bubble under a reply that is never
 * coming — so it belongs in the composer instead.
 *
 * This lives apart from any component because every surface that opens a session has
 * to agree on it. Put it inside one pane and the next reader silently gets it wrong.
 *
 * The `inFlight` guard matters: a LIVE run has the exact same shape (a trailing turn
 * with no answer yet) and that one is the pending bubble — splitting it off would
 * erase the user's own question mid-run.
 */

import type { MightySession, MightyTurn } from '../../../shared/types'

export interface SessionView {
  /** Turns to render as messages. */
  turns: MightyTurn[]
  /** The unsent trailing question, or '' when there isn't one. */
  draft: string
}

export function splitPendingDraft(
  session: MightySession | null | undefined,
  inFlight: boolean
): SessionView {
  const all = session?.turns ?? []
  const last = all[all.length - 1]
  if (!inFlight && last && last.a === '' && last.q !== '') {
    return { turns: all.slice(0, -1), draft: last.q }
  }
  return { turns: all, draft: '' }
}

export function neverSent(session: MightySession): boolean {
  return (
    session.turns.length > 0 &&
    session.runId === undefined &&
    session.turns.every((t) => (t.a ?? '') === '' && !t.run_id)
  )
}

import type { MightySession } from '../../shared/types'

/**
 * Is this session worth showing in the PHONE's thread picker?
 *
 * The phone already has a History sheet listing every dictation and capture, so a
 * session that is nothing but one unanswered voice note is a second copy of a row
 * the user can already see — and it buries the real conversations under it.
 * Measured against real data (2026-07-27): 623 sessions reached the picker, 561 of
 * them (90%) were single-bubble `listen` rows, so the entire first page but one was
 * noise. The Mac's sidebar deliberately keeps showing them; it has no History sheet
 * beside it and far more room.
 *
 * The rule is "did a conversation actually happen", expressed as bubble count rather
 * than turn count. A turn is a Q+A pair but its `a` is empty until the run resolves,
 * so a lone voice note is one bubble while a genuine ask that got an answer is two.
 * That distinction is the whole filter: counting turns would keep every voice note.
 *
 * Kept deliberately, despite being short:
 *   - A RUNNING session (`runId` set) — its answer is still streaming in, so it is
 *     one bubble right now and two in a moment. Hiding it would make the thread the
 *     user just started from the phone vanish until it finished.
 *   - A session whose single turn HAS an answer — that is a real Q+A, just a brief
 *     one, and it is exactly what a phone-started ask looks like.
 */
export function isPhoneChatSession(session: MightySession): boolean {
  // A live run's trailing turn is unanswered by definition — judge it by the mark,
  // not by the bubble count it happens to have mid-flight.
  if (session.runId !== undefined) return true
  return countBubbles(session) > 1
}

/**
 * Rendered bubbles in a session: every turn contributes its question, plus its
 * answer only once one exists. Mirrors the `messageCount` the picker already ships,
 * so the number the filter judges is the number the row displays.
 */
export function countBubbles(session: MightySession): number {
  return session.turns.reduce((n, t) => n + 1 + (t.a.trim() !== '' ? 1 : 0), 0)
}

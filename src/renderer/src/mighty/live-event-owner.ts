/**
 * Who owns a live phase/event push?
 *
 * Extracted from ConversationPane so the rule is testable without rendering a pane
 * (there's no @testing-library/react here). Every cross-talk bug this file guards
 * against was a real one, seen with three panes rendering a single run's tokens.
 */

export interface LiveOwnerState {
  /** The session this pane is bound to, or null before its first reply lands. */
  sessionId: string | null
  /** Correlation id of this pane's in-flight send, or null when idle. */
  clientRunId: string | null
}

export interface LivePush {
  sessionId: string
  /** Absent for runs started outside a chat pane (scheduler, phone, panel). */
  clientRunId?: string
}

/**
 * True when `push` belongs to `pane`.
 *
 * clientRunId decides whenever the push carries one, because sessionId cannot answer
 * this during the window that matters: on a first send no session exists yet, so
 * every fresh pane compared null-to-null and accepted every other fresh pane's
 * stream. Falls back to sessionId for pushes with no correlation id — a run this
 * pane didn't start, but which targets the session it is showing.
 */
export function ownsLivePush(pane: LiveOwnerState, push: LivePush): boolean {
  if (push.clientRunId) return push.clientRunId === pane.clientRunId
  return pane.sessionId !== null && push.sessionId === pane.sessionId
}

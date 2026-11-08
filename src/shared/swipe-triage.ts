/**
 * The swipe deck's meaning, with no React in it: which sessions become cards,
 * what order they sit in, what a card may DO, and what an affirm sends.
 *
 * Pure and in `shared/` for the same reason `relay-sessions.ts` is -- the Mac
 * panel is meant to mount the same deck, and a second copy of "which actions
 * can this card land" is how the two start offering buttons that do nothing.
 */

import type { AgentRelaySessionInfo } from './types'
import type { RelayRequestWire } from './phone-remote-protocol'
import type { RelayQuestion } from './relay-interview'
import { cursorFor } from './relay-interview'
import { sessionActivity, senderMatchKey } from './relay-cards'
import type { SessionActivity } from './relay-cards'
import { sessionCanReply, sessionIsWorking } from './relay-status'
import type { SessionRow } from './relay-status'
import { sessionEntry, sortEntries } from './relay-sessions'
import type { SessionEntry } from './relay-sessions'

/** The nudge "Keep going" types into the pane. Deliberately short: it lands as
 *  literal keystrokes in someone's agent, so it has to read as a human line. */
export const KEEP_GOING_TEXT = 'Keep going.'

export interface SwipeCard {
  /** Session label -- the join key every relay message already uses, and the
   *  React key. `sessionId` renames-safely but is absent on older shims. */
  label: string
  session: AgentRelaySessionInfo
  row: SessionRow
  activity: SessionActivity
  /** The oldest still-pending card for this session, when one exists. Oldest,
   *  not newest: whatever has blocked the agent longest is the thing to answer. */
  pending?: RelayRequestWire
  /** Which question of `pending` is unanswered, or -1 for a single-question
   *  ask. Stated here so the affirm payload and the rendered options cannot
   *  come from two different derivations. */
  questionIndex: number
  /** True when `pending` carries more unanswered questions than the one shown.
   *  The deck renders a tap-through instead of options -- a half-answered
   *  interview is worse than one finished in the sheet that can do it. */
  moreQuestions: boolean
  /** One plain line about what this session is doing: the declared TLDR, else
   *  a subject derived from its cards, else its last card's summary. */
  subject?: string
}

/** What tapping one action will send. The deck holds the choice; the surface
 *  turns it into a WS message, so the same union serves phone and Mac. */
export type SwipeAffirm =
  | { kind: 'respond'; requestId: string; questionIndex?: number; answer: string; via: 'chip' | 'typed' }
  /** `label` addresses the CARD (React key, skip list, failure flash); `ref`
   *  addresses the SESSION. They differ for an unnamed Cursor/VS Code pane,
   *  where two rows in one checkout share a label and only the id separates
   *  them -- send on `label` and the elder pane receives the text. */
  | { kind: 'reply'; label: string; ref: string; text: string }
  | { kind: 'wrap'; label: string; ref: string }
  | { kind: 'archive'; label: string; ref: string }

export interface SwipeAction {
  /** Stable within a card, so React keys and tests don't lean on the label. */
  id: string
  label: string
  /** Free text goes through the type-your-own field rather than a chip tap;
   *  the chip only opens it. */
  kind: 'chip' | 'typed' | 'wrap' | 'archive'
  /** Recognition glyph for a model-written chip. Decoration only -- what gets
   *  sent is `label`, never this. Absent on every canned action: an emoji on
   *  "Wrap up" would say the model chose it. */
  emoji?: string
}

/** Ask-carried options come first and canned actions never join them: a card
 *  that is blocking on a question should not offer "Wrap up" in the same row
 *  as the answer, where a swipe is one gesture away from ending the session. */
export function actionsFor(
  card: SwipeCard,
  // Plain strings still accepted: the pre-JSON shape, and what every caller
  // that has no model output to pass (`mcp/verbs.ts`) already sends.
  suggestions: readonly (string | { text: string; emoji?: string })[] = [],
  archive = false
): SwipeAction[] {
  const actions: SwipeAction[] = []

  // A multi-question ask gets a tap-through to the sheet that can finish it and
  // NOTHING else -- not even the canned three. Offering "Keep going" beside an
  // unanswered interview is how an agent gets nudged past its own question.
  if (card.moreQuestions) return actions

  if (card.pending) {
    for (const [i, option] of pendingOptions(card).entries()) {
      actions.push({ id: `opt-${i}`, label: option, kind: 'chip' })
    }
    if (sessionCanReply(card.session)) {
      actions.push({ id: 'typed', label: 'Type your own', kind: 'typed' })
    }
    return actions
  }

  // Suggestions REPLACE "Keep going" rather than joining it: they are the same
  // thing said better, and a row holding both offers the user a choice between
  // a specific instruction and a generic one, which is not a choice.
  if (sessionCanReply(card.session)) {
    if (suggestions.length > 0) {
      for (const [i, suggestion] of suggestions.entries()) {
        const { text, emoji } =
          typeof suggestion === 'string' ? { text: suggestion, emoji: undefined } : suggestion
        actions.push({ id: `sug-${i}`, label: text, kind: 'chip', ...(emoji ? { emoji } : {}) })
      }
    } else {
      actions.push({ id: 'keep', label: 'Keep going', kind: 'chip' })
    }
  }
  if (archive) {
    actions.push({ id: 'archive', label: 'Archive', kind: 'archive' })
  } else if (card.session.canWrapUp) {
    actions.push({ id: 'wrap', label: 'Wrap up', kind: 'wrap' })
  }
  if (sessionCanReply(card.session)) {
    actions.push({ id: 'typed', label: 'Type your own', kind: 'typed' })
  }
  return actions
}

/** The options actually on screen: the current question's for an interview,
 *  the flat `options` for the single-question case both surfaces still send. */
export function pendingOptions(card: SwipeCard): string[] {
  const pending = card.pending
  if (!pending) return []
  const questions = pending.params.questions
  if (questions && card.questionIndex >= 0) {
    return questions[card.questionIndex]?.options ?? []
  }
  return pending.params.options ?? []
}

/** What one chosen action sends, or null when it cannot land. Null rather than
 *  a thrown error: an action row can go stale between render and swipe (the
 *  card resolves elsewhere), and that is a snap-back, not a crash. */
export function affirmFor(
  card: SwipeCard,
  action: SwipeAction,
  typed?: string
): SwipeAffirm | null {
  if (action.kind === 'archive') {
    return { kind: 'archive', label: card.label, ref: sessionRefOf(card) }
  }
  if (action.kind === 'wrap') {
    return card.session.canWrapUp
      ? { kind: 'wrap', label: card.label, ref: sessionRefOf(card) }
      : null
  }

  const text = action.kind === 'typed' ? typed?.trim() : undefined
  if (action.kind === 'typed' && !text) return null

  if (card.pending && !card.moreQuestions) {
    return {
      kind: 'respond',
      requestId: card.pending.id,
      questionIndex: card.questionIndex >= 0 ? card.questionIndex : undefined,
      answer: text ?? action.label,
      via: action.kind === 'typed' ? 'typed' : 'chip'
    }
  }

  if (!sessionCanReply(card.session)) return null
  return {
    kind: 'reply',
    label: card.label,
    ref: sessionRefOf(card),
    text: text ?? (action.id === 'keep' ? KEEP_GOING_TEXT : action.label)
  }
}

/** Falls back to the label only for a shim too old to send an id: main refuses
 *  a label two live rows share, so the worst case is a refusal, not a misdeliver. */
function sessionRefOf(card: SwipeCard): string {
  return card.session.sessionId ?? card.label
}

/** Oldest pending card for a session, by the same `from` join the rest of the
 *  relay uses. */
function pendingFor(
  session: AgentRelaySessionInfo,
  requests: readonly RelayRequestWire[]
): RelayRequestWire | undefined {
  const from = senderMatchKey(session.stated ?? session.label)
  let oldest: RelayRequestWire | undefined
  for (const request of requests) {
    if (request.status !== 'pending') continue
    if (senderMatchKey(request.params.from) !== from) continue
    // `notify` blocks nobody -- it resolves on mint, and a card offering to
    // answer one would send an answer no agent is waiting for.
    if (request.verb === 'notify') continue
    if (!oldest || request.createdAt < oldest.createdAt) oldest = request
  }
  return oldest
}

function subjectFor(entry: SessionEntry): string | undefined {
  return (
    entry.session.tldr?.trim() ||
    entry.activity.derivedSubject ||
    entry.activity.lastSummary ||
    undefined
  )
}

function questionCursor(pending: RelayRequestWire | undefined): {
  index: number
  more: boolean
} {
  const questions: RelayQuestion[] | undefined = pending?.params.questions
  if (!pending || !questions || questions.length === 0) return { index: -1, more: false }
  const index = cursorFor(questions, pending.params.buffered ?? [])
  // Every question already answered: nothing left to render, so it reads as an
  // ordinary card rather than a picker with no options.
  if (index < 0) return { index: -1, more: false }
  return { index, more: questions.length > 1 }
}

/** Ended sessions never become cards: swiping cannot do anything to a dropped
 *  socket, so an empty deck means "nothing needs you" rather than "nothing you
 *  can act on is left".
 *
 *  Neither does a session that has never said anything. A deck is for deciding,
 *  and a session with no cards behind it and no question in front of it offers
 *  nothing to decide -- it is a row in a list. On a Mac running 42 agents that
 *  filter is the difference between a deck and a phone book. */
export function buildDeck(
  sessions: readonly AgentRelaySessionInfo[],
  requests: readonly RelayRequestWire[],
  now: number
): SwipeCard[] {
  const entries: SessionEntry[] = []
  for (const session of sessions) {
    if (session.stale) continue
    // Mid-turn = in motion: whatever its card offered went stale the moment the
    // agent started working again, so it sits out until its next Stop. A
    // pending ask still deals -- the question is what the turn is blocked on.
    // Same two-window rule as `sessionRow` -- a third copy of it here is how the
    // deck kept dealing cards for an agent that was demonstrably still writing.
    const working = sessionIsWorking(session, now)
    if (working && !pendingFor(session, requests)) continue
    const from = session.stated ?? session.label
    const activity = sessionActivity(from, requests)
    // A pending ask always earns a card, even as the session's first: the whole
    // point is the question, and "has it spoken before" says nothing about that.
    if (activity.total === 0 && !pendingFor(session, requests)) continue
    entries.push(sessionEntry(session, activity, now))
  }

  // Recency first, then pending-first on top of it: within "needs you" the
  // freshest is still the one you were just looking at.
  const sorted = sortEntries(entries, 'recent')
  const cards = sorted.map((entry) => {
    const pending = pendingFor(entry.session, requests)
    const { index, more } = questionCursor(pending)
    return {
      label: entry.session.label,
      session: entry.session,
      row: entry.row,
      activity: entry.activity,
      pending,
      questionIndex: index,
      moreQuestions: more,
      subject: subjectFor(entry)
    }
  })

  // Stable partition, not a comparator: `sortEntries` already decided the order
  // inside each half, and a second sort key would silently override it.
  return [...cards.filter((c) => c.pending), ...cards.filter((c) => !c.pending)]
}

/** Left swipe: the card leaves the deck. It used to rotate to the back, which
 *  meant a pass-everything run never ended and there was no moment that said
 *  "you have seen them all" -- the surface holds the skipped ones aside and
 *  offers them at the end instead. */
export function skip<T>(deck: readonly T[]): T[] {
  return deck.slice(1)
}

/** Affirmed or resolved: gone from the deck, order of the rest untouched. */
export function removeCard(deck: readonly SwipeCard[], label: string): SwipeCard[] {
  return deck.filter((card) => card.label !== label)
}

/**
 * Deal a named card to the top, keeping everyone else in their current order.
 *
 * A ROTATION rather than a swap: the cards it passes shuffle down one, so the
 * queue you were reading stays the queue you were reading. Swapping with the
 * top would fling that card to wherever the one you picked was sitting, which
 * is the opposite of "jump to this one and carry on".
 *
 * An unknown label leaves the deck untouched -- a session can resolve out from
 * under the list while it is open, and reordering to nothing is worse than
 * ignoring the tap.
 */
export function jumpTo(deck: readonly SwipeCard[], label: string): SwipeCard[] {
  const at = deck.findIndex((card) => card.label === label)
  if (at <= 0) return [...deck]
  return [deck[at], ...deck.slice(0, at), ...deck.slice(at + 1)]
}

/**
 * Rebuild against fresh server state while keeping the order the user is
 * mid-way through. A card that resolves elsewhere drops out in place; a new one
 * joins at the back rather than jumping under the thumb.
 */
export function mergeDeck(current: readonly SwipeCard[], next: readonly SwipeCard[]): SwipeCard[] {
  const byLabel = new Map(next.map((card) => [card.label, card]))
  const kept: SwipeCard[] = []
  for (const card of current) {
    const fresh = byLabel.get(card.label)
    if (!fresh) continue
    kept.push(fresh)
    byLabel.delete(card.label)
  }
  return [...kept, ...byLabel.values()]
}

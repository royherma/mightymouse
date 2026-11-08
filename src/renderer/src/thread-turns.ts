import type { MightyTurn } from '../../shared/types'

/**
 * The turns the panel's thread should render, given a live pending bubble.
 *
 * Main publishes the question the moment a run STARTS (MIGHTY.startTurn + a
 * mightyTurnAppended broadcast), so the panel's refetch sees a trailing turn with an
 * empty `a` while it is ALSO drawing that same question as its own pending bubble —
 * the question appears twice. The pending bubble wins (it owns the thinking dots and
 * the Stop button), so the store's unanswered copy is dropped until resolveTurn fills
 * `a` in. An unanswered turn from a run we merely bound to (Mighty, a hotkey) still
 * renders, since nothing else is showing it.
 */
export function visibleThreadTurns(turns: MightyTurn[], chatPending: boolean): MightyTurn[] {
  const last = turns[turns.length - 1]
  if (chatPending && last && last.a === '') return turns.slice(0, -1)
  return turns
}

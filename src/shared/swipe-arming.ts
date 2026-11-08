/**
 * Which action a card opens armed with, and how last time's choice informs it.
 *
 * The deck preselects an action so a right swipe always has something to send --
 * that is what makes it one gesture instead of tap-then-swipe. Which one gets
 * preselected is therefore a real decision, and the best available answer is
 * what was picked last time a card looked like this.
 *
 * Pure, so the surface owns storage: the phone keeps this in `localStorage`
 * (one person's habit on one device, never round-tripped), and the Mac panel
 * can key it off whatever it already persists.
 */

import type { SwipeAction, SwipeCard } from './swipe-triage'

/** Keyed on the SHAPE of the choice, not the session. A session id is gone
 *  tomorrow; what repeats is "an ask offering these options" and "an idle
 *  session offering the canned set". */
export function armingKey(card: SwipeCard, actions: readonly SwipeAction[]): string | undefined {
  const answerable = actions.filter((a) => a.kind !== 'typed')
  if (answerable.length === 0) return undefined
  // Sorted and lowercased: the same two options asked in either order are the
  // same question as far as "what did I answer last time" is concerned.
  const shape = answerable
    .map((a) => a.label.trim().toLowerCase())
    .sort()
    .join('|')
  return card.pending ? `ask:${shape}` : `idle:${shape}`
}

/**
 * The action to open armed with: last time's choice when it is still on offer,
 * otherwise the first one the card leads with.
 *
 * `Type your own` is never it. Arming an empty text field is the unarmed state
 * wearing a costume -- the swipe would snap back and the card would look ready.
 */
export function armedAction(
  actions: readonly SwipeAction[],
  remembered?: string
): SwipeAction | undefined {
  const armable = actions.filter((a) => a.kind !== 'typed')
  if (armable.length === 0) return undefined
  if (remembered) {
    const match = armable.find((a) => a.label.trim().toLowerCase() === remembered)
    if (match) return match
  }
  return armable[0]
}

/** What to remember after an affirm. Normalized the same way `armedAction`
 *  matches, so a write and a read cannot disagree about case or padding. */
export function rememberedValue(action: SwipeAction): string | undefined {
  if (action.kind === 'typed') return undefined
  return action.label.trim().toLowerCase()
}

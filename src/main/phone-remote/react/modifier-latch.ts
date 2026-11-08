/**
 * The double-tap latch decision, pulled out of VirtualKeyboard so it can be
 * tested without a DOM. The component owns the timing source and the state;
 * this owns the RULES, which are the part that can be silently wrong.
 *
 * A latch is a modifier armed with no finger on it -- exactly the "stuck on"
 * state that got sticky modifiers rejected the first time this keyboard was
 * built. It's acceptable now only because the user asks for it explicitly
 * (double tap), so the rules below are what keep it from happening by
 * accident: the window is short, and a third tap always turns it back off.
 *
 * That third tap matters more than it looks: a latch persists across
 * keypresses (you latch ⌃ to walk tabs with ⌃1, ⌃2, ⌃3), so it is the only
 * way to disarm one without closing the keyboard.
 */

/** Double-tap window. Deliberately longer than a desktop dblclick (~300ms):
 *  this is a thumb on glass reaching a small key, not a mouse that never
 *  moved. */
export const DOUBLE_TAP_MS = 400

export type LatchAction = 'none' | 'latch' | 'unlatch'

/**
 * What a press on a modifier key should do to its latch, given how long ago
 * that same key was last pressed.
 *
 * `sinceLastTapMs` is Infinity for a first-ever press, which is why the
 * comparison is `<` on the elapsed time rather than arithmetic on timestamps:
 * no clock is read here, so the caller can't hand this a stale `now`.
 */
export function latchAction(sinceLastTapMs: number, isLatched: boolean): LatchAction {
  if (sinceLastTapMs >= DOUBLE_TAP_MS) return 'none'
  // Inside the window, the key toggles: second tap latches, third clears it.
  // Without the unlatch half, a mis-tapped ⌘ could only be cleared by firing
  // a keystroke you didn't want.
  return isLatched ? 'unlatch' : 'latch'
}

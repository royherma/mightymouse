/**
 * What a one-finger touch on the mirror does. The whole answer, in one place.
 *
 * This replaced two booleans -- `touchModeActive` (transient, gesture-entered,
 * auto-resting) and `touchModeLocked` (a snackbar lock that only suppressed the
 * rest timer) -- which between them had four writers and made "locked but not
 * active" spellable. Adding a user-facing toggle as a fifth writer on that pair
 * is what this file exists to avoid: see the directory's CLAUDE.md, *"Five
 * consecutive commits guarding one boolean means the boolean is wrong."*
 *
 * - `pan`     one finger pans/zooms the picture. The Mac's cursor does not move.
 * - `resting` the cursor is being driven, and will fall back to `pan` on its own
 *             once the rest timer expires. This is the gesture-entered state.
 * - `held`    the cursor is being driven and STAYS that way until something
 *             explicitly leaves. Both the snackbar lock and the deck's screen
 *             button land here -- they differ in which control set it, not in
 *             behaviour, so they are one state and not two.
 */
export type TouchMode = 'pan' | 'resting' | 'held'

export type TouchModeEvent =
  /** A long-press (or a touchdown while already up) began driving the cursor. */
  | { type: 'gestureBegin' }
  /** The rest timer expired. Ignored while `held` -- that is what held means. */
  | { type: 'rest' }
  /** The snackbar lock, or the deck's screen button. */
  | { type: 'toggleHold' }
  /** A user-facing control setting an explicit value (the deck's toggle). */
  | { type: 'setHold'; hold: boolean }
  /** The mirror went away: a disconnect, or the pane unmounting. */
  | { type: 'reset' }

/**
 * The only function allowed to produce a `TouchMode`. Never assign a literal --
 * same discipline as `connection-state.ts`, and for the same reason: the illegal
 * edges are guarded in one place instead of at every call site.
 */
export function transition(state: TouchMode, event: TouchModeEvent): TouchMode {
  switch (event.type) {
    case 'gestureBegin':
      // A gesture must not silently downgrade a hold the user asked for: if the
      // toggle is on, driving the cursor leaves it on when the finger lifts.
      return state === 'held' ? 'held' : 'resting'
    case 'rest':
      return state === 'held' ? 'held' : 'pan'
    case 'toggleHold':
      return state === 'held' ? 'pan' : 'held'
    case 'setHold':
      // Turning the toggle OFF returns to `pan` outright rather than to
      // `resting`: the finger that flipped it is not driving anything, so
      // leaving a rest timer running would re-arm a mode nobody is in.
      return event.hold ? 'held' : 'pan'
    case 'reset':
      return 'pan'
  }
}

/** True when a one-finger drag drives the Mac's cursor rather than the picture. */
export function drivesCursor(state: TouchMode): boolean {
  return state !== 'pan'
}

/** True when the mode persists instead of auto-resting -- what the pill paints. */
export function isHeld(state: TouchMode): boolean {
  return state === 'held'
}

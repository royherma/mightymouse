/**
 * SINGLE SOURCE OF TRUTH for voice mode's SIZE — how much of the screen a live
 * conversation takes. A different axis from `CompanionRendererId` (WHICH
 * visualization draws the character) and from `CompanionState` (what it's
 * doing).
 *
 * Why this exists: the window's geometry used to key off the RENDERER pick
 * ('stage' meant full-screen, everything else meant the corner card), which
 * forced the user to learn what a "renderer" is just to get the overlay off
 * their whole screen. Size is now its own pref, so the renderer pick goes back
 * to being a dev-only choice of what's drawn and the user only ever sees
 * "full screen" vs "minimized".
 *
 * Named union + const list (not bare string literals) per the repo's
 * no-magic-strings rule, exactly like companion-renderers.ts.
 */

export type CompanionSize = 'full' | 'mini' | 'debug'

/** Minimized: the small bottom-right puck. Click it to go back to full. */
export const COMPANION_SIZE_MINI: CompanionSize = 'mini'

/** Full: voice mode takes the whole work area (never the menu bar or Dock). */
export const COMPANION_SIZE_FULL: CompanionSize = 'full'

/** Debug: the puck, widened to fit the signal panel BESIDE the circle. Its own
 *  size rather than a flag on `mini` because it changes the window's bounds, and
 *  bounds are what this axis is for. Deliberately not `full` — opening debug
 *  used to expand to the whole screen, where the End button no longer existed
 *  and the conversation could not be stopped. */
export const COMPANION_SIZE_DEBUG: CompanionSize = 'debug'

/** Minimized on first run. A voice conversation should never be the thing
 *  covering your screen before you've asked it to be — the puck is the resting
 *  state and full-screen is opt-in, one click away. */
export const DEFAULT_COMPANION_SIZE: CompanionSize = COMPANION_SIZE_MINI

export function toCompanionSize(value: string | null | undefined): CompanionSize {
  if (value === COMPANION_SIZE_FULL) return COMPANION_SIZE_FULL
  if (value === COMPANION_SIZE_DEBUG) return COMPANION_SIZE_DEBUG
  return COMPANION_SIZE_MINI
}

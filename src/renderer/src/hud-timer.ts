/**
 * The HUD card's timer freeze/resume state machine.
 *
 * Extracted from HudApp because this is the piece that kept regressing: a capture
 * card must stop counting the instant the MIC closes, not when the whole run ends.
 * Left ticking through transcription it reads as "still recording", and then jumps
 * backwards when doneHud freezes it on the real clip length.
 *
 * `freezeTimer` is deliberately a tri-state. It was previously a one-way latch —
 * the renderer could apply a freeze but had no way to lift one — so a phase update
 * could never resume a card, and the Mac dictation path only behaved because every
 * one of its updates happened to re-assert the freeze.
 */

/** What the card should do with its timer, given one hudUpdate payload. */
export type TimerTransition =
  /** Hold the timer at `at` and stop ticking. */
  | { kind: 'freeze'; at: string }
  /** Resume ticking. `rebaseToMs` is how far into the run the clock should read at
   *  the moment it restarts — the frozen span is time the user was told had
   *  stopped, so it must not be handed back. Null = nothing was frozen, keep the
   *  existing start time. */
  | { kind: 'resume'; rebaseToMs: number | null }
  /** The payload said nothing about the timer — leave the freeze state alone. */
  | { kind: 'unchanged' }

/**
 * A settled run's duration, for the "how long did that take" line the panel, chat,
 * and history all show. One decimal under a minute (0.5s, 4.3s) — whole seconds hid
 * the difference between a fast rewrite and an instant one. Legacy history rows
 * promoted from whole-second duration_s land on an exact multiple of 1000 and drop
 * the ".0" rather than claim precision they don't have.
 */
export function formatRunDuration(ms: number): string {
  if (ms < 60_000) {
    const s = ms / 1000
    return Number.isInteger(s) ? `${s}s` : `${s.toFixed(1)}s`
  }
  const mins = Math.floor(ms / 60_000)
  const secs = Math.round((ms % 60_000) / 1000)
  return secs === 0 ? `${mins}m` : `${mins}m ${secs}s`
}

/** Seconds string as sent on the wire ("12.4s") → ms. Returns 0 for anything
 *  unparseable so a malformed freeze can never rebase the clock into the future. */
export function parseFrozenMs(frozen: string): number {
  const n = parseFloat(frozen)
  return Number.isFinite(n) && n > 0 ? n * 1000 : 0
}

/**
 * Decide the timer transition for one update.
 *
 * @param freezeTimer the payload's tri-state flag
 * @param timerFreeze the value to hold at; a freeze without one is ignored rather
 *        than blanking the visible timer
 * @param currentlyFrozenAt what the card is frozen at right now, or null if live
 */
export function timerTransition(
  freezeTimer: boolean | undefined,
  timerFreeze: string | undefined,
  currentlyFrozenAt: string | null
): TimerTransition {
  if (freezeTimer === true) {
    if (!timerFreeze) return { kind: 'unchanged' }
    return { kind: 'freeze', at: timerFreeze }
  }
  if (freezeTimer === false) {
    return {
      kind: 'resume',
      rebaseToMs: currentlyFrozenAt !== null ? parseFrozenMs(currentlyFrozenAt) : null
    }
  }
  return { kind: 'unchanged' }
}

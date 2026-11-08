import { CONFIG } from '../../../shared/config'
import { TOUR } from '../../../shared/tour/constants'
import type { HotkeyConfirmState, TourProbeEventPayload } from '../../../shared/tour/types'

// Pure, framework-free state machine for one hotkey step's press-to-confirm flow
// (PRD §4.3/§5.3). Extracted out of useHotkeyConfirm.ts so it's unit-testable under
// this repo's `environment: 'node'` vitest config — no jsdom/testing-library is
// installed, so anything that needs React rendering or `window`/`document` can't be
// driven directly in a test. Mirrors the existing convention in gaze/tracker.ts:
// pure math/logic lives in its own file, the hook is a thin timer/IPC wrapper
// around it. See __tests__/hotkeyConfirmMachine.test.ts.
//
// The machine owns exactly the state a render needs (state/unlocked/mods) plus the
// two "should I fire a callback now" questions (unlock, advance) — it does NOT own
// timers, IPC, or focus polling; those stay in the hook, which calls the machine's
// pure transition functions and reacts to their return values.

export interface Mods {
  meta: boolean
  alt: boolean
  shift: boolean
}

export interface HotkeyConfirmMachineState {
  state: HotkeyConfirmState
  unlocked: boolean
  mods: Mods
  /** True while ⌘⌥⇧ are ALL down at once — the step's first of two gates.
   *  Stage A is "get the chord down" (only the three mod caps are on screen);
   *  clearing it reveals stage B beneath, "now tap the letter". Deliberately
   *  LIVE, not latched: letting go of a modifier really should take the letter
   *  cap away, because that's what the chord does. Safe to track live only
   *  because the probe reports PHYSICAL modifier state — uiohook's raw flag
   *  bits lag a modifier's own transition by one event, and driving this off
   *  them made caps drop out mid-hold (see tour-hotkey-probe.ts). */
  chordDown: boolean
  /** Timestamp probe was armed — msToPress for analytics is `now - armedAt`. */
  armedAt: number
  /** Latches true the instant a correct press lands, so a second 'hit' (there
   *  shouldn't be one — capture-hotkey.ts also latches) can't re-fire onConfirmed. */
  advanceFired: boolean
}

export const EMPTY_MODS: Mods = { meta: false, alt: false, shift: false }

/** Fresh state for a newly-armed step. */
export function initMachine(armedAt: number): HotkeyConfirmMachineState {
  return {
    state: TOUR.CONFIRM_STATE.idle,
    unlocked: false,
    mods: EMPTY_MODS,
    chordDown: false,
    armedAt,
    advanceFired: false
  }
}

/** All three base modifiers physically down = stage A cleared. */
export function isChordDown(mods: Mods): boolean {
  return mods.meta && mods.alt && mods.shift
}

/** A correct press landed. Always flips to `confirmed` — the caller is
 *  responsible for latching so this isn't called twice per arm. */
export function applyHit(s: HotkeyConfirmMachineState): HotkeyConfirmMachineState {
  return { ...s, state: TOUR.CONFIRM_STATE.confirmed }
}

/** A wrong chord fired while armed. */
export function applyWrong(s: HotkeyConfirmMachineState): HotkeyConfirmMachineState {
  return { ...s, state: TOUR.CONFIRM_STATE.wrong }
}

/** The wrong-key shake/flash's revert timer elapsed. No-op if the state moved on
 *  (e.g. a correct press landed while the wrong-reset timer was still pending). */
export function applyWrongReset(s: HotkeyConfirmMachineState): HotkeyConfirmMachineState {
  if (s.state !== TOUR.CONFIRM_STATE.wrong) return s
  return { ...s, state: TOUR.CONFIRM_STATE.idle }
}

/** Live ⌘⌥⇧ held-state, throttled by the caller (only call on an actual change —
 *  matches probeReportMods' throttle on the main-process side). */
export function applyMods(s: HotkeyConfirmMachineState, mods: Mods): HotkeyConfirmMachineState {
  return { ...s, mods, chordDown: isChordDown(mods) }
}

/** The 8s unlock timer elapsed with no correct press yet. */
export function applyUnlock(s: HotkeyConfirmMachineState): HotkeyConfirmMachineState {
  return { ...s, unlocked: true }
}

/** True the FIRST time a correct press should fire onConfirmed — latches
 *  `advanceFired` so a duplicate call (e.g. two focus events) can't re-fire it. */
export function tryAdvance(
  s: HotkeyConfirmMachineState,
  hasFocus: boolean
): { next: HotkeyConfirmMachineState; shouldAdvance: boolean } {
  if (s.advanceFired || !hasFocus || s.state !== TOUR.CONFIRM_STATE.confirmed) {
    return { next: s, shouldAdvance: false }
  }
  return { next: { ...s, advanceFired: true }, shouldAdvance: true }
}

/** Route one probe IPC payload to the matching pure transition. Returns the
 *  event's "kind" too so the hook knows which timers to (re)start. */
export function applyProbeEvent(
  s: HotkeyConfirmMachineState,
  payload: TourProbeEventPayload
): HotkeyConfirmMachineState {
  if (payload.kind === 'hit') return applyHit(s)
  if (payload.kind === 'wrong') return applyWrong(s)
  return applyMods(s, { meta: payload.meta, alt: payload.alt, shift: payload.shift })
}

export const TIMING = {
  UNLOCK_MS: CONFIG.TOUR_UNLOCK_MS,
  ADVANCE_MS: CONFIG.TOUR_ADVANCE_MS,
  WRONG_RESET_MS: CONFIG.TOUR_WRONG_RESET_MS
} as const

import type { TourProbeEventPayload, TourStepKey } from '../../../shared/tour/types'
import {
  initMachine,
  applyProbeEvent,
  applyUnlock,
  applyWrongReset,
  tryAdvance,
  TIMING,
  type HotkeyConfirmMachineState
} from './hotkeyConfirmMachine'

// The imperative shell around hotkeyConfirmMachine.ts — owns timers, the event
// subscription, and the arm/disarm lifecycle for ONE confirmable step. Extracted
// out of useHotkeyConfirm.ts so the arm → hit/wrong/timeout → disarm sequence is
// unit-testable without mounting a React component (no jsdom in this repo's
// vitest config — see hotkeyConfirmMachine.ts's header comment for why).
//
// The hook (useHotkeyConfirm.ts) is now just: call startSession() in a useEffect,
// call session.cleanup() in the effect's return. All the actual logic — timers,
// latching, disarm-on-unmount — lives here and in the pure machine.
//
// DELIBERATELY SOURCE-AGNOSTIC. Nothing here knows what "arming" means or where
// a `hit` comes from — every side effect is injected. That's what lets the phone
// pairing step (arm = start the phone-remote server, hit = a phone connected)
// reuse this file wholesale instead of cloning ~90 LOC of identical timer and
// latch logic. Anything hotkey-specific belongs in the CALLER's deps, not here.
// Renamed from hotkeyConfirmSession.ts when the second caller landed.

export interface SessionDeps {
  /** Start listening for this step's confirm signal; called once on start.
   *  The caller closes over whatever "arm" means for its source. */
  arm: () => void
  /** Stop listening. Called from cleanup() — MUST be safe to call after arm()
   *  failed, since a step that never armed still tears down. */
  disarm: () => void
  /** Subscribe to confirm events. Returns its own unsubscribe. */
  subscribe: (cb: (payload: TourProbeEventPayload) => void) => () => void
  hasFocus: () => boolean
  now: () => number
  setTimeout: (fn: () => void, ms: number) => number
  clearTimeout: (id: number) => void
  addFocusListener: (cb: () => void) => () => void
  onConfirmed: () => void
  onStateChange: (s: HotkeyConfirmMachineState) => void
  /** How long before Next silently unlocks. Injected because the two callers
   *  differ by ~3x: a keypress is instant, scanning a QR with a second device
   *  is not (CONFIG.TOUR_UNLOCK_MS vs TOUR_PHONE_UNLOCK_MS). */
  unlockMs: number
  /** How long the confirmed state holds before advancing. Injected for the same
   *  reason as unlockMs: advancing tears down any live demo surface, so a step
   *  that opened one needs the longer TOUR_DEMO_ADVANCE_MS or the user watches
   *  the panel/HUD appear and vanish in one blink. */
  advanceMs: number
  analytics: {
    confirmed: (stepKey: TourStepKey, msToConfirm: number) => void
    timedOut: (stepKey: TourStepKey) => void
  }
}

export interface Session {
  cleanup: () => void
}

/** Arms the step's confirm source and wires up all timers/listeners. Returns a
 *  `cleanup()` that disarms and tears down everything — call it from the owning
 *  effect's return, and ALWAYS call it on unmount/step-change (an
 *  armed probe must never outlive its step). */
export function startSession(stepKey: TourStepKey, deps: SessionDeps): Session {
  let machine = initMachine(deps.now())
  deps.onStateChange(machine)

  deps.arm()

  const unlockTimer = deps.setTimeout(() => {
    machine = applyUnlock(machine)
    deps.onStateChange(machine)
    deps.analytics.timedOut(stepKey)
  }, deps.unlockMs)

  let wrongResetTimer: number | null = null
  let advanceTimer: number | null = null

  const attemptAdvance = (): void => {
    const { next, shouldAdvance } = tryAdvance(machine, deps.hasFocus())
    machine = next
    if (shouldAdvance) deps.onConfirmed()
  }

  const removeFocusListener = deps.addFocusListener(attemptAdvance)

  const offProbe = deps.subscribe((payload) => {
    machine = applyProbeEvent(machine, payload)
    deps.onStateChange(machine)

    if (payload.kind === 'hit') {
      deps.analytics.confirmed(stepKey, deps.now() - machine.armedAt)
      advanceTimer = deps.setTimeout(attemptAdvance, deps.advanceMs)
    } else if (payload.kind === 'wrong') {
      wrongResetTimer = deps.setTimeout(() => {
        machine = applyWrongReset(machine)
        deps.onStateChange(machine)
      }, TIMING.WRONG_RESET_MS)
    }
  })

  return {
    cleanup: (): void => {
      deps.disarm()
      deps.clearTimeout(unlockTimer)
      if (wrongResetTimer !== null) deps.clearTimeout(wrongResetTimer)
      if (advanceTimer !== null) deps.clearTimeout(advanceTimer)
      removeFocusListener()
      offProbe()
    }
  }
}

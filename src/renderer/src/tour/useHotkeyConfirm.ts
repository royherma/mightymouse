import { useEffect, useRef, useState } from 'react'
import { CONFIG } from '../../../shared/config'
import { TOUR } from '../../../shared/tour/constants'
import type { HotkeyConfirmState, TourStepKey } from '../../../shared/tour/types'
import { hasLiveDemo } from '../../../shared/tour/types'
import type { ShortcutId } from '../../../shared/shortcuts'
import { useTourAnalytics } from './useTourAnalytics'
import { EMPTY_MODS, type Mods } from './hotkeyConfirmMachine'
import { startSession } from './confirmSession'

export interface HotkeyConfirmResult {
  /** Current cap state — idle/held/confirmed/wrong. */
  state: HotkeyConfirmState
  /** True once the 8s timer has elapsed with no correct press — Next silently
   *  unlocks without changing `state`. */
  unlocked: boolean
  /** Live ⌘⌥⇧ held-state for the `held` cap treatment. */
  mods: Mods
}

/**
 * Press-to-confirm state machine for one hotkey step. Arms the main-process
 * probe (tour-hotkey-probe.ts) on mount/step-change, disarms on unmount — the
 * ONLY renderer-side owner of the arm/disarm lifecycle (an armed
 * probe that outlives its step must never happen; belt-and-braces disarm also
 * lives in tour-window.ts's `closed` handler for a crashed renderer).
 *
 * Auto-advance timing: on a correct press the state flips to
 * `confirmed` immediately (so the animation always plays), but `onConfirmed`
 * only fires TOUR_ADVANCE_MS later AND only once the tour window has real OS
 * focus — `document.hasFocus()` is this renderer's own focus state, exactly
 * the signal the design asks for (no new IPC needed: a BrowserWindow's focus
 * *is* its webContents document's focus).
 *
 * This hook is a thin React shell around hotkeyConfirmSession.ts (timers/IPC
 * wiring) and hotkeyConfirmMachine.ts (pure state transitions) — both are
 * unit-tested directly, since this repo's vitest config has no jsdom and can't
 * mount the hook itself. See __tests__/hotkeyConfirmSession.test.ts.
 */
export function useHotkeyConfirm(
  shortcutId: ShortcutId | undefined,
  stepKey: TourStepKey,
  onConfirmed: () => void
): HotkeyConfirmResult {
  const [state, setState] = useState<HotkeyConfirmState>(TOUR.CONFIRM_STATE.idle)
  const [unlocked, setUnlocked] = useState(false)
  const [mods, setMods] = useState<Mods>(EMPTY_MODS)
  const analytics = useTourAnalytics()

  // Ref so the probe callback (registered once per arm) always calls the
  // latest onConfirmed without re-subscribing on every render.
  const onConfirmedRef = useRef(onConfirmed)
  onConfirmedRef.current = onConfirmed

  useEffect(() => {
    // The welcome step has no confirmShortcutId — nothing to arm, stay idle.
    if (!shortcutId) return

    const session = startSession(stepKey, {
      // Hotkey-shaped deps for the shared session shell: arm/disarm are the
      // probe's two states, and `hit` arrives over the probe IPC channel.
      arm: () => window.api.tour.armProbe(shortcutId),
      disarm: () => window.api.tour.armProbe(null),
      subscribe: window.api.tour.onProbeEvent,
      unlockMs: CONFIG.TOUR_UNLOCK_MS,
      // Steps with a live demo hold longer: advancing calls armProbe(next),
      // which tears the demo down, so the short beat made the HUD flash and
      // vanish before it could be read.
      advanceMs: hasLiveDemo(shortcutId) ? CONFIG.TOUR_DEMO_ADVANCE_MS : CONFIG.TOUR_ADVANCE_MS,
      hasFocus: () => document.hasFocus(),
      now: () => Date.now(),
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (id) => window.clearTimeout(id),
      addFocusListener: (cb) => {
        window.addEventListener('focus', cb)
        return () => window.removeEventListener('focus', cb)
      },
      analytics: {
        confirmed: analytics.keyConfirmed,
        timedOut: analytics.keyTimedOut
      },
      onConfirmed: () => onConfirmedRef.current(),
      onStateChange: (m) => {
        setState(m.state)
        setUnlocked(m.unlocked)
        setMods(m.mods)
      }
    })

    return session.cleanup
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shortcutId, stepKey])

  return { state, unlocked, mods }
}

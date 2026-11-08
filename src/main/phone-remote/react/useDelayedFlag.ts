import { useEffect, useState } from 'react'

/**
 * Should a delayed indicator be on screen right now?
 *
 * Pure so it's testable under this repo's `environment: 'node'` vitest config --
 * no jsdom/testing-library is installed, so the hook below (timers + React
 * state) can't be driven directly in a test. Same split as
 * tour/hotkeyConfirmMachine.ts: the decision is a pure function, the hook is a
 * thin timer wrapper around it.
 *
 * Both gates matter. `active` alone would leave the indicator up after the wait
 * resolved; `elapsed` alone would strand it forever once the timer had fired.
 */
export function shouldShowDelayed(active: boolean, elapsed: boolean): boolean {
  return active && elapsed
}

/**
 * True only once `active` has been continuously true for `delayMs`.
 *
 * For "don't flash a spinner at a wait that was never slow" -- the transcribe
 * round trip is usually fast enough that an indicator appearing and vanishing
 * reads as a glitch, but a slow one (long dictation, busy Mac) with NO feedback
 * reads as a dead app. Gating on elapsed time gets both: silence when it's
 * quick, a clear signal when it isn't.
 *
 * Falls back to false the instant `active` goes false, with the pending timer
 * cancelled -- a wait that resolves inside the window never shows anything.
 */
export function useDelayedFlag(active: boolean, delayMs: number): boolean {
  const [elapsed, setElapsed] = useState(false)

  useEffect(() => {
    if (!active) {
      setElapsed(false)
      return
    }
    const timer = window.setTimeout(() => setElapsed(true), delayMs)
    return () => window.clearTimeout(timer)
  }, [active, delayMs])

  return shouldShowDelayed(active, elapsed)
}

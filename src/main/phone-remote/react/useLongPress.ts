// useLongPress.ts — "tap does one thing, hold does another" for one button.
//
// Built for the Settings button: a tap opens Settings, a 1s hold opens the
// window-layout sheet. Written as a hook rather than inline because the timing
// rules below are each a bug someone already shipped on this surface.

import { useCallback, useEffect, useRef } from 'react'
import { hapticTick } from './haptics'

/**
 * How long a hold must last to count.
 *
 * 1s, not the 500ms the pad's other gestures use: Settings' tap is the common
 * action, and a 500ms arm makes a slow ordinary tap open the wrong surface.
 * A second is long enough that only a deliberate hold reaches it.
 */
export const SETTINGS_LONG_PRESS_MS = 1000

/**
 * How far a finger may travel and still be a press, not a drag.
 *
 * A thumb resting on a button drifts a few px without the user intending to
 * move; anything past this is a scroll or a slide off the control.
 */
const LONG_PRESS_SLOP_PX = 10

export interface LongPressHandlers {
  onPointerDown: (e: React.PointerEvent) => void
  onPointerUp: (e: React.PointerEvent) => void
  onPointerCancel: () => void
  onPointerLeave: () => void
}

/**
 * Wire a button for tap-vs-hold.
 *
 * Both callbacks fire at most once per press, never both.
 *
 * Deliberately on pointer events, not `click`: `click` lands ~300ms after the
 * touch ends, and on this surface that is routinely outside iOS's
 * user-activation window (see the keyboard-focus notes in CLAUDE.md). It also
 * gives no way to notice a hold that never lifts.
 *
 * The tap still fires on RELEASE with no added delay — waiting out the hold
 * timer before acting on a tap would put a 1s lag on opening Settings, which
 * is the button's everyday job.
 */
export function useLongPress(
  onTap: () => void,
  onLongPress: () => void
): LongPressHandlers {
  const timerRef = useRef<number | null>(null)
  const firedRef = useRef(false)
  const startRef = useRef<{ x: number; y: number } | null>(null)

  const clear = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    startRef.current = null
  }, [])

  // A press in flight when the button unmounts would leave a timer that fires
  // into a dead component.
  useEffect(() => clear, [clear])

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      firedRef.current = false
      startRef.current = { x: e.clientX, y: e.clientY }
      timerRef.current = window.setTimeout(() => {
        firedRef.current = true
        timerRef.current = null
        // Buzz on ARM, not on release: the hold has no visual of its own, so
        // this is the only signal that waiting longer was worth it.
        hapticTick()
        onLongPress()
      }, SETTINGS_LONG_PRESS_MS)
    },
    [onLongPress]
  )

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const start = startRef.current
      const armed = timerRef.current !== null
      clear()
      // A completed hold swallows the tap -- otherwise lifting the finger
      // would open Settings on top of the sheet the hold just opened.
      if (firedRef.current) return
      if (!armed) return
      if (start) {
        const dx = e.clientX - start.x
        const dy = e.clientY - start.y
        if (Math.hypot(dx, dy) > LONG_PRESS_SLOP_PX) return
      }
      onTap()
    },
    [clear, onTap]
  )

  return {
    onPointerDown,
    onPointerUp,
    onPointerCancel: clear,
    onPointerLeave: clear
  }
}

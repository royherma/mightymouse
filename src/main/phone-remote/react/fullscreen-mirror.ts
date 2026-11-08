/**
 * TEMPORARY: fullscreen mirror for cursorless hosts (Meta Ray-Ban Display).
 *
 * On a 600x600 HUD the deck's controls are unreachable anyway -- there is no
 * pointer for the pad and the key cluster is a wall of focus stops -- so when
 * the mirror is on, the picture is the only thing painted. The phone is
 * driving; the HUD is a screen with one way out.
 *
 * Because nothing is painted, the four arrows and the band's Select are free
 * here -- `arrow-focus-nav` finds an empty roster and `enter-activates-focused`
 * finds `<body>` focused. This hook claims them: arrows drive the picture and
 * Select swaps what they mean. Nothing is drawn for that either.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { CONFIG } from '@shared/config'

import type { Direction } from './arrow-focus-nav'
import { noteKeySeen } from './last-key-seen'
import { nextDpadMode, resolveDpad, type DpadMode } from './mirror-dpad'

export type FullscreenMirror = {
  /** Fills the viewport with the video and hides every deck control. */
  active: boolean
  /** What the arrows currently do. The mode itself is never painted -- only
   *  confirmed for a moment on the toggle, via `modeToast`. */
  mode: DpadMode
  /** True for ~1.5s after a pinch. The one exception to "nothing is drawn":
   *  with no persistent indicator, a toggle you don't feel is a toggle you
   *  discover by swiping and watching the picture do the wrong thing. */
  modeToast: boolean
}

const ARROWS: Record<string, Direction> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right'
}

export function useFullscreenMirror(opts: {
  enabled: boolean
  onExit: () => void
  onPan: (dx: number, dy: number) => void
  onZoom: (factor: number) => void
}): FullscreenMirror {
  const { enabled, onExit, onPan, onZoom } = opts

  // Pan is the default because it is the safe one: a stray swipe slides the
  // picture a little and is instantly obvious, where a stray zoom swipe changes
  // the whole scale. Reset on every open rather than remembered -- with nothing
  // painted, the only way to discover a remembered mode is to swipe and watch.
  const [mode, setMode] = useState<DpadMode>('pan')

  // The handler is installed once per open, so it would otherwise close over
  // the mode at install time and the toggle would never take effect.
  const modeRef = useRef<DpadMode>('pan')
  const [modeToast, setModeToast] = useState(false)
  const toastTimerRef = useRef<number | null>(null)

  // `toast` is false for the reset-on-open, which is not a toggle the user
  // made and must not flash a pill at them as the picture appears.
  const setDpadMode = useCallback((next: DpadMode, toast: boolean) => {
    modeRef.current = next
    setMode(next)
    if (!toast) return
    setModeToast(true)
    // Restarted on every toggle, so a fast pan-zoom-pan doesn't leave the pill
    // stuck from the first one -- same shape as setZoomFollow's timer.
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current)
    toastTimerRef.current = window.setTimeout(() => {
      setModeToast(false)
      toastTimerRef.current = null
    }, CONFIG.PHONE_REMOTE.MIRROR_DPAD_MODE_TOAST_MS)
  }, [])

  // Don't leave the timer running past unmount -- it would setState on a dead
  // component when the mirror closes mid-toast.
  useEffect(() => {
    return () => {
      if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    setDpadMode('pan', false)
    setModeToast(false)

    const onKey = (e: KeyboardEvent): void => {
      // Back-pinch is the only gesture with a meaning here, and with no control
      // painted there is no focus hierarchy to resolve first -- it exits
      // outright. Stays FIRST: the way out must never be behind a mode.
      if (e.key === 'Escape') {
        onExit()
        e.preventDefault()
        return
      }

      if (e.key === 'Enter') {
        const next = nextDpadMode(modeRef.current)
        setDpadMode(next, true)
        e.preventDefault()
        return noteKeySeen(e.key, `mirror-dpad:mode=${next}`)
      }

      const dir = ARROWS[e.key]
      if (!dir) return

      const action = resolveDpad(modeRef.current, dir)
      if (action.kind === 'pan') onPan(action.dx, action.dy)
      else onZoom(action.factor)
      e.preventDefault()
      // Breadcrumbed because none of this paints: on the glasses "the swipe did
      // nothing" and "the swipe never arrived" look identical in the hand, and
      // this trail is the only thing that tells them apart.
      noteKeySeen(e.key, `mirror-dpad:${action.kind}`)
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled, onExit, onPan, onZoom, setDpadMode])

  return { active: enabled, mode, modeToast }
}

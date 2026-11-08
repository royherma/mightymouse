/**
 * Horizontal flick-to-dismiss for Code cards. Shared so Mac and phone agree on
 * when a drag is a flick vs a scroll, and when it commits.
 */

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent
} from 'react'

/** Finger has to travel this far before we pick an axis — under it, it's still a tap. */
export const FLICK_LOCK_PX = 12
/** Travel that commits even on a slow drag. */
export const FLICK_DISMISS_PX = 80
/** px/ms. A short fast flick (~50px in 100ms) commits under DISMISS_PX. */
export const FLICK_VELOCITY = 0.45
export const FLICK_ROTATE = 0.06
export const FLICK_FLY_MS = 220
export const FLICK_SNAP_MS = 180
/** X tap: long enough to read the sentence and hit Keep. */
export const RELAY_CLEAR_DELAY_MS = 3000

export const FLICK_IGNORE = 'button, textarea, input, a, select, [contenteditable]'

export type FlickAxis = 'x' | 'y'

export function lockAxis(dx: number, dy: number, slop = FLICK_LOCK_PX): FlickAxis | null {
  const ax = Math.abs(dx)
  const ay = Math.abs(dy)
  if (ax < slop && ay < slop) return null
  return ax > ay ? 'x' : 'y'
}

export function shouldDismiss(dx: number, vx: number): boolean {
  if (Math.abs(dx) >= FLICK_DISMISS_PX) return true
  if (Math.abs(dx) < FLICK_LOCK_PX) return false
  return Math.abs(vx) >= FLICK_VELOCITY && Math.sign(vx) === Math.sign(dx)
}

export function flyOffDx(dx: number, width: number, vx = 0): number {
  const dir = Math.sign(dx) || Math.sign(vx) || 1
  return dir * (width + 64)
}

export function flickTransform(dx: number): Pick<CSSProperties, 'transform' | 'opacity'> {
  return {
    transform: `translate3d(${dx}px,0,0) rotate(${dx * FLICK_ROTATE}deg)`,
    opacity: Math.max(0.35, 1 - Math.abs(dx) / 400)
  }
}

export function isFlickIgnoredTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(FLICK_IGNORE))
}

type Phase = 'idle' | 'drag' | 'snap' | 'fly'

export function useFlickDismiss(onDismiss?: () => void): {
  style: CSSProperties
  handlers: {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void
    onPointerCancel: () => void
  }
} {
  const origin = useRef<{ x: number; y: number; t: number } | null>(null)
  const axis = useRef<FlickAxis | null>(null)
  const [dx, setDx] = useState(0)
  const [phase, setPhase] = useState<Phase>('idle')
  const dismissRef = useRef(onDismiss)
  dismissRef.current = onDismiss

  const reset = (): void => {
    origin.current = null
    axis.current = null
    setDx(0)
    setPhase('idle')
  }

  useEffect(() => {
    if (phase !== 'fly') return
    const timer = window.setTimeout(() => dismissRef.current?.(), FLICK_FLY_MS)
    return () => window.clearTimeout(timer)
  }, [phase])

  useEffect(() => {
    if (phase !== 'snap') return
    const timer = window.setTimeout(() => setPhase('idle'), FLICK_SNAP_MS)
    return () => window.clearTimeout(timer)
  }, [phase])

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>): void => {
    if (!onDismiss || phase === 'fly') return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if (isFlickIgnoredTarget(e.target)) return
    origin.current = { x: e.clientX, y: e.clientY, t: e.timeStamp }
    axis.current = null
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>): void => {
    if (!origin.current) return
    const ddx = e.clientX - origin.current.x
    const ddy = e.clientY - origin.current.y
    if (!axis.current) {
      const locked = lockAxis(ddx, ddy)
      if (locked === 'y') {
        origin.current = null
        return
      }
      if (locked === 'x') {
        axis.current = 'x'
        e.currentTarget.setPointerCapture(e.pointerId)
        setPhase('drag')
      }
    }
    if (axis.current === 'x') setDx(ddx)
  }

  const onPointerUp = (e: ReactPointerEvent<HTMLElement>): void => {
    if (!origin.current || axis.current !== 'x') {
      reset()
      return
    }
    const ddx = e.clientX - origin.current.x
    const elapsed = e.timeStamp - origin.current.t
    const vx = elapsed > 0 ? ddx / elapsed : 0
    origin.current = null
    axis.current = null
    if (shouldDismiss(ddx, vx)) {
      setPhase('fly')
      setDx(flyOffDx(ddx, e.currentTarget.clientWidth, vx))
    } else {
      setPhase('snap')
      setDx(0)
    }
  }

  const style: CSSProperties =
    phase === 'drag'
      ? { ...flickTransform(dx), transition: 'none', userSelect: 'none' }
      : phase === 'snap'
        ? {
            ...flickTransform(0),
            transition: `transform ${FLICK_SNAP_MS}ms ease, opacity ${FLICK_SNAP_MS}ms ease`
          }
        : phase === 'fly'
          ? {
              ...flickTransform(dx),
              transition: `transform ${FLICK_FLY_MS}ms ease-in, opacity ${FLICK_FLY_MS}ms ease-in`,
              pointerEvents: 'none'
            }
          : {}

  return {
    style,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: () => {
        if (!origin.current) return
        reset()
      }
    }
  }
}

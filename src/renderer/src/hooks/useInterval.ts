import { useEffect, useRef } from 'react'

/**
 * Declarative setInterval. Calls `callback` every `delayMs`, or pauses when
 * `delayMs` is null. The latest callback always runs without resetting the
 * timer (classic Dan Abramov pattern), so callers can close over fresh state
 * without re-arming the interval.
 */
export function useInterval(callback: () => void, delayMs: number | null): void {
  const savedCallback = useRef(callback)

  useEffect(() => {
    savedCallback.current = callback
  }, [callback])

  useEffect(() => {
    if (delayMs === null) return
    const id = setInterval(() => savedCallback.current(), delayMs)
    return () => clearInterval(id)
  }, [delayMs])
}

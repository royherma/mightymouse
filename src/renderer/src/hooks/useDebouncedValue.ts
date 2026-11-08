import { useEffect, useState } from 'react'

/**
 * Returns `value` after it has stopped changing for `delayMs`. Typing keeps
 * resetting the timer, so a fast typist causes one settle instead of one per
 * keystroke.
 *
 * Used by the conversation search: matching runs over every turn's text in
 * every session, which is far more work than the old title-only filter. The
 * input itself stays on the raw value so it never feels laggy — only the
 * expensive filtering waits.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value)

  useEffect(() => {
    const id = setTimeout(() => setSettled(value), delayMs)
    return () => clearTimeout(id)
  }, [value, delayMs])

  return settled
}

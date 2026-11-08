import { useEffect, useRef, useState } from 'react'

/** m:ss, minutes uncapped so a long clip reads 12:04 rather than wrapping. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/**
 * Live `m:ss` while `active`, '' otherwise. Derived from a start timestamp
 * rather than a counter, because iOS throttles timers in a backgrounded tab
 * and an incremented count would drift low by however long Safari paused us.
 */
export function useRecordingElapsed(active: boolean): string {
  const startedAt = useRef(0)
  const [text, setText] = useState('')

  useEffect(() => {
    if (!active) {
      setText('')
      return
    }
    startedAt.current = Date.now()
    setText('0:00')
    const id = setInterval(() => setText(formatElapsed(Date.now() - startedAt.current)), 250)
    return () => clearInterval(id)
  }, [active])

  return text
}

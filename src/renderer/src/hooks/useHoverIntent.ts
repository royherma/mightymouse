import { useCallback, useEffect, useRef } from 'react'
import { CONFIG } from '../../../shared/config'

// Hover-intent close debounce for a chip → side-panel group (the write suggestion
// preview). The panel renders to the RIGHT of the chip across a small gap; the seam
// between them fires a synthetic mouseleave a frame BEFORE the panel's mouseenter, so
// a bare close-on-mouseleave yanks the panel shut the instant the user reaches for it.
//
// Fix: on leave, SCHEDULE the close after a grace period; on any re-enter within the
// group (chip or panel), CANCEL the pending close. Crossing the seam therefore cancels
// its own close before it fires, while a genuine hover-off still closes after the
// grace. This is the standard menu/submenu hover-intent pattern.
//
// `onClose` is read through a ref so a changing callback identity never resets the
// timer or stales the closure.
export function useHoverIntent(onClose: () => void): {
  cancelClose: () => void
  scheduleClose: () => void
} {
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancelClose = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  const scheduleClose = useCallback(() => {
    cancelClose()
    timer.current = setTimeout(() => {
      timer.current = null
      onCloseRef.current()
    }, CONFIG.SUGGESTIONS.PREVIEW_CLOSE_GRACE_MS)
  }, [cancelClose])

  // Never leave a timer running past unmount.
  useEffect(() => cancelClose, [cancelClose])

  return { cancelClose, scheduleClose }
}

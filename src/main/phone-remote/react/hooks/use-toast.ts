import { useCallback, useRef, useState } from 'react'
import { CONFIG } from '@shared/config'

const TOAST_MS = 1600
const TOAST_ACTIONABLE_MS = 5000
export const TOAST_ACT_HOLD_MS = 1400

export function useToast() {
  const [toast, setToast] = useState('')
  const [toastShown, setToastShown] = useState(false)
  const [toastHistoryId, setToastHistoryId] = useState<string | null>(null)
  const [toastRunning, setToastRunning] = useState(false)
  const [toastFailed, setToastFailed] = useState(false)
  const [toastOffline, setToastOffline] = useState(false)
  const [toastActArming, setToastActArming] = useState(false)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const phoneTextTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const toastHoldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const toastActFiredRef = useRef(false)

  const cancelToastHold = useCallback(() => {
    if (toastHoldTimerRef.current) {
      clearTimeout(toastHoldTimerRef.current)
      toastHoldTimerRef.current = null
    }
    setToastActArming(false)
    toastActFiredRef.current = false
  }, [])

  const showToast = useCallback(
    (
      text: string,
      historyId: string | null = null,
      persist = false,
      failed = false,
      offline = false
    ) => {
      setToast(text)
      setToastShown(true)
      setToastHistoryId(historyId)
      setToastFailed(failed)
      setToastOffline(offline)
      setToastRunning(persist)
      cancelToastHold()
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
      if (phoneTextTimerRef.current) {
        clearTimeout(phoneTextTimerRef.current)
        phoneTextTimerRef.current = null
      }
      if (persist) return
      toastTimerRef.current = setTimeout(
        () => setToastShown(false),
        historyId === null ? TOAST_MS : TOAST_ACTIONABLE_MS
      )
    },
    [cancelToastHold]
  )

  const schedulePhoneTextWatchdog = useCallback(() => {
    phoneTextTimerRef.current = setTimeout(
      () => showToast(CONFIG.UI_LABELS.CLIP_PHONE_TEXT_SLOW, null, false, false, true),
      CONFIG.PHONE_REMOTE.CLIP_PHONE_TEXT_TIMEOUT_MS
    )
  }, [showToast])

  return {
    toast,
    toastShown,
    toastHistoryId,
    toastRunning,
    toastFailed,
    toastOffline,
    toastActArming,
    setToastShown,
    setToastActArming,
    toastHoldTimerRef,
    toastActFiredRef,
    cancelToastHold,
    showToast,
    schedulePhoneTextWatchdog
  }
}

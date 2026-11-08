import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { AppSwitchItem } from '../app-list-merge'
import { quickSwitchTargetIndex } from '../TouchpadControls'
import { hapticTick } from '../haptics'
import type { UseConnectionResult } from './use-connection'

const QUICK_SWITCH_BURST_MS = 350
const QUICK_SWITCH_LINGER_MS = 1200

export function useAppSwitcherState() {
  const [quickSteps, setQuickSteps] = useState(0)
  const quickStepsRef = useRef(0)
  quickStepsRef.current = quickSteps
  const [quickAnchor, setQuickAnchor] = useState<string | null>(null)
  const quickAnchorRef = useRef<string | null>(null)
  const [quickPinned, setQuickPinned] = useState<string | null>(null)
  return {
    quickSteps,
    setQuickSteps,
    quickStepsRef,
    quickAnchor,
    setQuickAnchor,
    quickAnchorRef,
    quickPinned,
    setQuickPinned
  }
}

interface UseAppSwitcherArgs {
  send: UseConnectionResult['send']
  appListRef: MutableRefObject<AppSwitchItem[] | null>
  pendingAppListRef: MutableRefObject<AppSwitchItem[] | null>
  setAppList: (apps: AppSwitchItem[] | null) => void
  quickAnchorRef: MutableRefObject<string | null>
  setQuickSteps: React.Dispatch<React.SetStateAction<number>>
  setQuickAnchor: (id: string | null) => void
  setQuickPinned: (id: string | null) => void
  applyRingRefreshWhenIdle: () => void
  ringDraggingRef: MutableRefObject<boolean>
}

export function useAppSwitcher({
  send,
  appListRef,
  pendingAppListRef,
  setAppList,
  quickAnchorRef,
  setQuickSteps,
  setQuickAnchor,
  setQuickPinned,
  applyRingRefreshWhenIdle,
  ringDraggingRef
}: UseAppSwitcherArgs) {
  const quickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const quickLingerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const quickSwitchTap = useCallback(() => {
    hapticTick()
    const reachable = Math.max(1, (appListRef.current?.length ?? 2) - 1)
    const lingering = quickLingerRef.current !== null
    if (lingering) {
      clearTimeout(quickLingerRef.current!)
      quickLingerRef.current = null
      setQuickPinned(null)
      if (pendingAppListRef.current) {
        setAppList(pendingAppListRef.current)
        appListRef.current = pendingAppListRef.current
        pendingAppListRef.current = null
      }
    }
    setQuickSteps((prev) => (lingering ? 1 : Math.min(reachable, prev + 1)))
    if (quickTimerRef.current) clearTimeout(quickTimerRef.current)
    quickTimerRef.current = setTimeout(() => {
      quickTimerRef.current = null
      setQuickSteps((steps) => {
        if (steps > 0) {
          const list = appListRef.current
          const target = list?.length
            ? list[quickSwitchTargetIndex(list, quickAnchorRef.current, steps)]
            : null
          if (target) {
            send({ type: 'appSwitchActivate', bundleId: target.bundleId })
            quickAnchorRef.current = target.bundleId
            setQuickAnchor(target.bundleId)
            setQuickPinned(target.bundleId)
          } else send({ type: 'appSwitchQuick', steps })
        }
        return steps
      })
      if (quickLingerRef.current) clearTimeout(quickLingerRef.current)
      quickLingerRef.current = setTimeout(() => {
        quickLingerRef.current = null
        setQuickSteps(0)
        setQuickPinned(null)
        applyRingRefreshWhenIdle()
      }, QUICK_SWITCH_LINGER_MS)
    }, QUICK_SWITCH_BURST_MS)
  }, [
    appListRef,
    pendingAppListRef,
    setAppList,
    setQuickSteps,
    setQuickAnchor,
    setQuickPinned,
    send,
    quickAnchorRef,
    applyRingRefreshWhenIdle
  ])

  const quickSwitchPick = useCallback(
    (bundleId: string) => {
      hapticTick()
      if (quickTimerRef.current) {
        clearTimeout(quickTimerRef.current)
        quickTimerRef.current = null
      }
      quickAnchorRef.current = bundleId
      setQuickAnchor(bundleId)
      setQuickPinned(bundleId)
      requestAnimationFrame(() =>
        requestAnimationFrame(() => send({ type: 'appSwitchActivate', bundleId }))
      )
      if (quickLingerRef.current) clearTimeout(quickLingerRef.current)
      quickLingerRef.current = setTimeout(() => {
        quickLingerRef.current = null
        setQuickSteps(0)
        setQuickPinned(null)
        applyRingRefreshWhenIdle()
      }, QUICK_SWITCH_LINGER_MS)
    },
    [quickAnchorRef, setQuickAnchor, setQuickPinned, setQuickSteps, send, applyRingRefreshWhenIdle]
  )

  const onRingRelease = useCallback(() => {
    ringDraggingRef.current = false
    applyRingRefreshWhenIdle()
  }, [ringDraggingRef, applyRingRefreshWhenIdle])

  useEffect(
    () => () => {
      if (quickTimerRef.current) clearTimeout(quickTimerRef.current)
      if (quickLingerRef.current) clearTimeout(quickLingerRef.current)
    },
    []
  )

  return { quickSwitchTap, quickSwitchPick, onRingRelease }
}

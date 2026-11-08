import { useCallback, useEffect, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import type { AppContext } from '@shared/app-context'
import { CONFIG } from '@shared/config'
import {
  type HostKeyboard,
  type PhoneRemoteKeyName,
  type PhoneRemoteModifier,
  type TmuxAction
} from '@shared/phone-remote-keys'
import type { WindowLayoutKind } from '@shared/phone-remote-protocol'
import { KEYBOARD_LAYOUT_FOR_HOST } from '../keyboard-layouts'
import { KEYBOARD_MIN_OCCLUSION_PX } from '../KeyboardAccessoryBar'
import { kbTrace } from '../keyboard-trace'
import {
  pillTarget,
  resolveSwitchToNative,
  reconcileNative,
  barHostVisible,
  type KeyboardMode
} from '../keyboard-state'
import { getVirtualKeyboardEnabled } from '../virtual-keyboard-pref'
import { focusWasStolenByBar } from '../focus-stolen'
import { hapticTick } from '../haptics'
import { mergeAppList, type AppSwitchItem } from '../app-list-merge'
import {
  readCachedAppContext,
  readCachedAppList,
  writeCachedAppContext,
  writeCachedAppList
} from '../app-context-cache'
import type { SocketBus } from '../socket-bus'
import type { UseConnectionResult } from './use-connection'

// How often to re-ask whether the Mac clipboard has something, while a
// keyboard is up. Slow on purpose: the answer is one boolean and the only
// cost of lag is the paste key appearing a beat late.
const CLIPBOARD_POLL_MS = 2000
const APP_CONTEXT_HEARTBEAT_MS = 20_000
// Zero-width space kept as the first char of the hidden keyboard input so the
// field is never empty -- see onKeyboardTextChange for why that's load-bearing
// on iOS. Invisible, zero-width, and stripped before anything is sent.
const KEYBOARD_SENTINEL = '\u200B'

interface UseKeyboardArgs {
  bus: SocketBus
  send: UseConnectionResult['send']
  connState: UseConnectionResult['connState']
  hostKeyboard: HostKeyboard
  setQuickAnchor: (id: string | null) => void
  quickAnchorRef: MutableRefObject<string | null>
  quickStepsRef: MutableRefObject<number>
  appRingRef: MutableRefObject<boolean>
  applyRingRefreshWhenIdleRef: MutableRefObject<(() => void) | null>
}

/** Owns keyboard, app switcher, clipboard, and window-layout sheet. */
export function useKeyboard({
  bus,
  send,
  connState,
  hostKeyboard,
  setQuickAnchor,
  quickAnchorRef,
  quickStepsRef,
  appRingRef,
  applyRingRefreshWhenIdleRef
}: UseKeyboardArgs) {
  const [windowLayoutOpen, setWindowLayoutOpen] = useState(false)
  // Whether the Mac has an arrangement it can undo. Pushed by the Mac after
  // every layout -- never inferred here, because the stash is session state on
  // that side and a phone reconnect must not resurrect a dead Restore.
  const [canRestoreWindows, setCanRestoreWindows] = useState(false)
  const [appSwitchOpen, setAppSwitchOpen] = useState(false)
  const [appList, setAppList] = useState<AppSwitchItem[] | null>(readCachedAppList)
  const [keyboardText, setKeyboardText] = useState('')
  const [keyboardMode, setKeyboardMode] = useState<KeyboardMode>('none')
  const nativeKeyboardOpen = barHostVisible(keyboardMode, 'native')
  const virtualKeyboardOpen = barHostVisible(keyboardMode, 'virtual')
  const keyboardModeRef = useRef<KeyboardMode>('none')
  keyboardModeRef.current = keyboardMode
  const [appContext, setAppContext] = useState<AppContext | null>(
    (typeof window === 'undefined' ? undefined : window.__MM_APP_CONTEXT__) ??
      readCachedAppContext(Date.now())
  )
  // Whether the Mac clipboard holds anything pasteable, image or file included
  // -- gates the paste key. Contents are never sent, so this bare yes/no is all
  // the phone ever knows about the Mac's clipboard.
  const [clipboardHasContent, setClipboardHasContent] = useState(false)

  const keyboardInputRef = useRef<HTMLInputElement | null>(null)
  const intentionalFocusRef = useRef(false)
  const browserSheetOpenRef = useRef(false)

  // ── App switcher (defined before mic/trackpad handlers that reference it) ──
  const appSwitchOpenRef = useRef(false)
  appSwitchOpenRef.current = appSwitchOpen
  // Live mirror of appList so openAppSwitcher can tell first-open (cache empty)
  // from a re-open (keep the cached grid up). Declared here, above the callbacks
  // that read it, since it's referenced by openAppSwitcher below.
  const appListRef = useRef<AppSwitchItem[] | null>(null)
  appListRef.current = appList

  const pendingAppListRef = useRef<AppSwitchItem[] | null>(null)

  useEffect(() => {
    const unsubscribers = [
      bus.subscribe('appContextState', (msg) => {
        setAppContext(msg.context)
        writeCachedAppContext(msg.context, Date.now())
      }),
      bus.subscribe('clipboardStateResult', (msg) => {
        setClipboardHasContent(msg.hasContent)
      }),
      bus.subscribe('windowLayoutState', (msg) => {
        setCanRestoreWindows(msg.canRestore)
      }),
      bus.subscribe('appSwitchList', (msg) => {
        const anchor = msg.anchorBundleId ?? null
        writeCachedAppList(msg.apps, CONFIG.PHONE_REMOTE.APP_RING_MAX_SLOTS)
        setQuickAnchor(anchor)
        quickAnchorRef.current = anchor
        if ((quickStepsRef.current > 0 || appRingRef.current) && appListRef.current !== null) {
          const { immediate, deferred } = mergeAppList(appListRef.current, msg.apps)
          if (immediate) {
            setAppList(immediate)
            appListRef.current = immediate
          }
          pendingAppListRef.current = deferred
          if (deferred) applyRingRefreshWhenIdleRef.current?.()
        } else setAppList(msg.apps)
      })
    ]
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe())
  }, [appRingRef, applyRingRefreshWhenIdleRef, bus, quickAnchorRef, quickStepsRef, setQuickAnchor])

  const closeAppSwitcher = useCallback(() => {
    if (!appSwitchOpenRef.current) return
    setAppSwitchOpen(false)
  }, [])

  const openAppSwitcher = useCallback(() => {
    setAppSwitchOpen(true)
    if (appListRef.current === null) setAppList(null)
    send({ type: 'appSwitchOpen' })
  }, [send])

  const toggleAppSwitcher = useCallback(() => {
    hapticTick()
    if (appSwitchOpenRef.current) closeAppSwitcher()
    else openAppSwitcher()
  }, [closeAppSwitcher, openAppSwitcher])

  const activateApp = useCallback(
    (bundleId: string) => {
      hapticTick()
      send({ type: 'appSwitchActivate', bundleId })
      closeAppSwitcher()
    },
    [send, closeAppSwitcher]
  )

  const applyWindowLayout = useCallback(
    (kind: WindowLayoutKind, bundleIds: string[]) => {
      hapticTick()
      send({ type: 'windowLayout', kind, bundleIds })
    },
    [send]
  )

  const onCloseWindowLayouts = useCallback(() => setWindowLayoutOpen(false), [])

  const openWindowLayouts = useCallback(() => {
    // The list backs the sheet's two app slots, and it can be stale or empty on
    // a phone that has not opened the switcher this session.
    send({ type: 'appSwitchMru' })
    setWindowLayoutOpen(true)
  }, [send])

  const pressKey = useCallback(
    (key: 'tab' | 'return' | 'escape') => {
      hapticTick()
      send({ type: 'pressKey', key })
    },
    [send]
  )

  const lastSentTextRef = useRef('')

  const onKeyboardTextChange = useCallback(
    (raw: string) => {
      // Backspace ate the sentinel -> the user meant "delete on the Mac" with
      // nothing of their own left to remove. Forward one delete and re-seed.
      const atFloor = !raw.startsWith(KEYBOARD_SENTINEL)
      const next = atFloor ? '' : raw.slice(KEYBOARD_SENTINEL.length)
      setKeyboardText(KEYBOARD_SENTINEL + next)
      const prev = lastSentTextRef.current
      let common = 0
      const maxCommon = Math.min(prev.length, next.length)
      while (common < maxCommon && prev[common] === next[common]) common++
      const removed = prev.length - common
      const added = next.slice(common)
      // atFloor with nothing of ours to remove == a bare Backspace: send one
      // delete so it hits the Mac's own selection/text, not just our buffer.
      if (removed > 0) send({ type: 'deleteText', count: removed })
      else if (atFloor) send({ type: 'deleteText', count: 1 })
      if (added) send({ type: 'typeText', text: added })
      lastSentTextRef.current = next
    },
    [send]
  )

  const applyKeyboardMode = useCallback((next: KeyboardMode) => {
    if (next === 'native') {
      // Seed the sentinel before focus so the very first Backspace already has
      // something to eat -- otherwise the first press is swallowed by iOS.
      setKeyboardText(KEYBOARD_SENTINEL)
      lastSentTextRef.current = ''
      const input = keyboardInputRef.current
      if (input) input.disabled = false
      intentionalFocusRef.current = true
      input?.focus()
      intentionalFocusRef.current = false
      const took = document.activeElement === input
      const landed = resolveSwitchToNative(took)
      kbTrace('mode:native', { took, landed })
      setKeyboardMode(landed)
      return
    }
    // Blur first: it tears down the native keyboard (and runs
    // submitKeyboardText, resetting the sentinel) before anything else takes
    // over, so the two boards are never on screen together.
    keyboardInputRef.current?.blur()
    kbTrace('mode', { to: next })
    setKeyboardMode(next)
  }, [])

  const openKeyboard = useCallback(() => {
    hapticTick()
    applyKeyboardMode(pillTarget(keyboardModeRef.current, getVirtualKeyboardEnabled()))
  }, [applyKeyboardMode])

  const onCloseVirtualKeyboard = useCallback(
    () => applyKeyboardMode('none'),
    [applyKeyboardMode]
  )

  useEffect(() => {
    if (!nativeKeyboardOpen && !virtualKeyboardOpen) return
    send({ type: 'appContext' })
    send({ type: 'clipboardState' })
    const poll = setInterval(() => send({ type: 'clipboardState' }), CLIPBOARD_POLL_MS)
    return () => clearInterval(poll)
  }, [nativeKeyboardOpen, virtualKeyboardOpen, send])

  useEffect(() => {
    if (connState.kind !== 'connected') return
    if (keyboardMode !== 'none') return
    send({ type: 'appContext' })
    const beat = setInterval(() => send({ type: 'appContext' }), APP_CONTEXT_HEARTBEAT_MS)
    return () => clearInterval(beat)
  }, [connState, keyboardMode, send])

  const onPasteClipboard = useCallback(() => send({ type: 'pasteClipboard' }), [send])

  const onActivateItem = useCallback(
    // The Mac's own id, straight back out -- see the "send the resolved
    // identity, never an index" rule in this directory's CLAUDE.md.
    (itemId: string) => send({ type: 'appActivateItem', itemId }),
    [send]
  )
  const onActivateGroup = useCallback(
    (groupId: string) => send({ type: 'appActivateGroup', groupId }),
    [send]
  )
  const onActivatePane = useCallback(
    // tmux's id (`%47`), not the row's position -- an index shifts the moment a
    // sibling pane dies.
    (paneId: string) => send({ type: 'appActivatePane', paneId }),
    [send]
  )
  const onTmuxAction = useCallback(
    (action: TmuxAction) => send({ type: 'tmuxAction', action }),
    [send]
  )

  const barTapAtRef = useRef(0)
  const onBarTap = useCallback(() => {
    barTapAtRef.current = Date.now()
  }, [])

  // A ref, not state: submitKeyboardText reads it from inside a blur handler,
  // and a re-render between the sheet opening and the blur arriving would be a
  // race. Nothing renders off this value.
  const onBrowserSheetOpenChange = useCallback((sheetOpen: boolean) => {
    kbTrace('sheet', { open: sheetOpen, mode: keyboardModeRef.current })
    browserSheetOpenRef.current = sheetOpen
    if (sheetOpen) send({ type: 'appContext' })
    if (!sheetOpen && keyboardModeRef.current === 'native') {
      keyboardInputRef.current?.focus()
    }
  }, [send])

  const switchKeyboard = useCallback(
    (to: 'native' | 'virtual') => {
      kbTrace('switchKeyboard', { to })
      hapticTick()
      applyKeyboardMode(to)
    },
    [applyKeyboardMode]
  )

  const onSwitchToVirtualKeyboard = useCallback(() => switchKeyboard('virtual'), [switchKeyboard])
  const onSwitchToNativeKeyboard = useCallback(() => switchKeyboard('native'), [switchKeyboard])
  // iOS raised its keyboard -- including the ways we never asked for, like the
  // user tapping the hidden input directly. Trusting the event rather than
  // inferring keeps the mode honest about what is actually on screen.
  const onKeyboardInputFocus = useCallback(() => {
    if (!intentionalFocusRef.current && keyboardModeRef.current === 'virtual') {
      kbTrace('input:focus', { rejected: 'virtual' })
      keyboardInputRef.current?.blur()
      return
    }
    kbTrace('input:focus')
    setKeyboardMode('native')
  }, [])

  useEffect(() => {
    if (!nativeKeyboardOpen) return
    const vv = window.visualViewport
    if (!vv) return
    const reconcile = (): void => {
      const occluded = window.innerHeight - (vv.height + vv.offsetTop)
      const next = reconcileNative({
        mode: keyboardModeRef.current,
        occludedPx: occluded,
        minOcclusionPx: KEYBOARD_MIN_OCCLUSION_PX,
        sheetOpen: browserSheetOpenRef.current
      })
      kbTrace('vv:resize', {
        occluded: Math.round(occluded),
        sheet: browserSheetOpenRef.current,
        verdict: next === keyboardModeRef.current ? 'keep' : `-> ${next}`
      })
      if (next === keyboardModeRef.current) return
      setKeyboardMode(next)
      keyboardInputRef.current?.blur()
    }
    vv.addEventListener('resize', reconcile)
    return () => vv.removeEventListener('resize', reconcile)
  }, [nativeKeyboardOpen])

  const onVirtualKeyboardChar = useCallback(
    (text: string) => send({ type: 'typeText', text }),
    [send]
  )

  const onVirtualKeyboardBackspace = useCallback(() => send({ type: 'deleteText', count: 1 }), [send])

  const onVirtualKeyboardSpecialKey = useCallback(
    (key: PhoneRemoteKeyName) => send({ type: 'pressKey', key }),
    [send]
  )

  const onVirtualKeyboardCombo = useCallback(
    (modifiers: PhoneRemoteModifier[], key: PhoneRemoteKeyName) =>
      send({ type: 'pressKey', key, modifiers }),
    [send]
  )

  // Mirror whatever keyboard the host reports
  // -- no picker, the mapping IS
  // the selection. New host types are one KEYBOARD_LAYOUT_FOR_HOST row.
  const virtualKeyboardLayoutId = KEYBOARD_LAYOUT_FOR_HOST[hostKeyboard]

  const submitKeyboardText = useCallback(() => {
    const sinceTap = Date.now() - barTapAtRef.current
    const stolen = focusWasStolenByBar(browserSheetOpenRef.current, sinceTap)
    kbTrace('input:blur', { sheet: browserSheetOpenRef.current, sinceTap, stolen })
    setKeyboardText(KEYBOARD_SENTINEL)
    lastSentTextRef.current = ''
    if (stolen && keyboardModeRef.current === 'native') {
      keyboardInputRef.current?.focus()
    }
  }, [])

  const onKeyboardEnter = useCallback(() => {
    send({ type: 'pressKey', key: 'return' })
    setKeyboardText(KEYBOARD_SENTINEL)
    lastSentTextRef.current = ''
  }, [send])


  return {
    windowLayoutOpen,
    canRestoreWindows,
    appSwitchOpen,
    appList,
    setAppList,
    appListRef,
    appSwitchOpenRef,
    pendingAppListRef,
    keyboardText,
    keyboardMode,
    nativeKeyboardOpen,
    virtualKeyboardOpen,
    keyboardInputRef,
    appContext,
    clipboardHasContent,
    closeAppSwitcher,
    openAppSwitcher,
    toggleAppSwitcher,
    activateApp,
    applyWindowLayout,
    onCloseWindowLayouts,
    openWindowLayouts,
    pressKey,
    onKeyboardTextChange,
    openKeyboard,
    onCloseVirtualKeyboard,
    onPasteClipboard,
    onActivateItem,
    onActivateGroup,
    onActivatePane,
    onTmuxAction,
    onBarTap,
    onBrowserSheetOpenChange,
    onSwitchToVirtualKeyboard,
    onSwitchToNativeKeyboard,
    onKeyboardInputFocus,
    onVirtualKeyboardChar,
    onVirtualKeyboardBackspace,
    onVirtualKeyboardSpecialKey,
    onVirtualKeyboardCombo,
    virtualKeyboardLayoutId,
    submitKeyboardText,
    onKeyboardEnter
  }
}

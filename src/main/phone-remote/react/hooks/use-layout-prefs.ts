import { useCallback, useEffect, useRef, useState } from 'react'
import { CONFIG } from '@shared/config'
import type {
  InstallableSkin,
  PhoneRemoteColorScheme,
  PhoneRemoteHandedness,
  PhoneRemoteKeysPosition,
  PhoneRemoteDeckMode,
  PhoneRemoteSplitConcept,
  PhoneRemoteMirrorPlacement
} from '@shared/types'
import { isRemoteSkinId } from '@shared/types'
import { HOST_KEYBOARD, type HostDevice, type HostKeyboard } from '@shared/phone-remote-keys'
import type { PhoneRemoteEvent, PhoneRemoteMessage } from '@shared/phone-remote-protocol'

// iOS-only, not in lib.dom.d.ts: true when launched standalone from the
// Home Screen icon (no Safari chrome, so no URL bar to tap a cert warning
// through -- this is exactly what Layer 4's stranded guard checks for).
declare global {
  interface Window {
    /** Layout prefs the server inlines into index.html (see injectLayoutPrefs
     *  in server.ts) so first paint uses the right layout. Undefined when the
     *  page is served by the Vite dev server, which doesn't inject. */
    __MM_LAYOUT_PREFS__?: {
      skin: InstallableSkin
      colorScheme: PhoneRemoteColorScheme
      handedness: PhoneRemoteHandedness
      keysPosition: PhoneRemoteKeysPosition
      deckMode: PhoneRemoteDeckMode
      splitConcept: PhoneRemoteSplitConcept
      mirrorPlacement: PhoneRemoteMirrorPlacement
      showCursor: boolean
      appRing: boolean
      renderMarkup: boolean
      hostKeyboard?: HostKeyboard
      hostDevice?: HostDevice
      /** See the layoutPrefs event -- inlined too, so the Settings row can name
       *  a worn remote skin on the FIRST paint rather than after a store open. */
      wornSkinLabel?: string
    }
    __MM_INSTALLED_SKINS__?: string[]
  }
}

// Read once at module load: the server writes it before the bundle's <script>
// runs, and the WS push owns every change after that.
const INLINE_PREFS = typeof window === 'undefined' ? undefined : window.__MM_LAYOUT_PREFS__
export const INSTALLED_REMOTE_SKINS: InstallableSkin[] =
  typeof window === 'undefined' ? [] : (window.__MM_INSTALLED_SKINS__ ?? []).filter(isRemoteSkinId)

interface UseLayoutPrefsArgs {
  send: (msg: PhoneRemoteMessage) => void
  onMessage: (handler: (msg: PhoneRemoteEvent) => void) => () => void
}

/** Every phone-local layout/skin pref that round-trips the Mac: seeded inline
 *  by the server, refreshed by the layoutPrefs WS push, changed by an
 *  on*Change callback that optimistically sets local state then sends. */
export function useLayoutPrefs({ send, onMessage }: UseLayoutPrefsArgs) {
  // WHAT the pad is painted as. Same inline-then-WS seeding as the rest.
  const [skin, setSkin] = useState<InstallableSkin>(
    INLINE_PREFS?.skin ?? CONFIG.PHONE_REMOTE.SKIN_DEFAULT
  )
  // Name for `skin` when it's a remote one, straight from the Mac's manifest.
  // Seeded inline and refreshed by every layoutPrefs push, exactly like `skin`
  // itself -- the two must move together or Settings names the wrong skin.
  const [wornSkinLabel, setWornSkinLabel] = useState<string | undefined>(
    INLINE_PREFS?.wornSkinLabel
  )
  const [colorScheme, setColorScheme] = useState<PhoneRemoteColorScheme>(
    INLINE_PREFS?.colorScheme ?? CONFIG.PHONE_REMOTE.COLOR_SCHEME_DEFAULT
  )
  const [handedness, setHandedness] = useState<PhoneRemoteHandedness>(
    INLINE_PREFS?.handedness ?? CONFIG.PHONE_REMOTE.HANDEDNESS_DEFAULT
  )
  const [keysPosition, setKeysPosition] = useState<PhoneRemoteKeysPosition>(
    INLINE_PREFS?.keysPosition ?? CONFIG.PHONE_REMOTE.KEYS_POSITION_DEFAULT
  )
  const [deckMode, setDeckMode] = useState<PhoneRemoteDeckMode>(
    INLINE_PREFS?.deckMode ?? CONFIG.PHONE_REMOTE.DECK_MODE_DEFAULT
  )
  const [splitConcept, setSplitConcept] = useState<PhoneRemoteSplitConcept>(
    INLINE_PREFS?.splitConcept ?? CONFIG.PHONE_REMOTE.SPLIT_CONCEPT_DEFAULT
  )
  const [mirrorPlacement, setMirrorPlacement] = useState<PhoneRemoteMirrorPlacement>(
    INLINE_PREFS?.mirrorPlacement ?? CONFIG.PHONE_REMOTE.MIRROR_PLACEMENT_DEFAULT
  )
  // Which physical keyboard the HOST machine has -- the virtual keyboard
  // mirrors it (Mac host -> full MacBook layout). Same inline-then-WS seeding
  // as the rest; 'generic' fallback covers a dev-server page with no injection.
  const [hostKeyboard, setHostKeyboard] = useState<HostKeyboard>(
    INLINE_PREFS?.hostKeyboard ?? HOST_KEYBOARD.generic
  )
  const [hostDevice, setHostDevice] = useState<HostDevice | undefined>(INLINE_PREFS?.hostDevice)
  const [showCursor, setShowCursor] = useState(
    INLINE_PREFS?.showCursor ?? CONFIG.PHONE_REMOTE.SHOW_CURSOR_DEFAULT
  )
  // The MRU-scrubbing arc around the button cluster.
  const [appRing, setAppRing] = useState(
    INLINE_PREFS?.appRing ?? CONFIG.PHONE_REMOTE.APP_RING_DEFAULT
  )
  // Read inside the WS handler's closure, which never re-runs on state.
  const appRingRef = useRef(appRing)
  appRingRef.current = appRing
  const [renderMarkup, setRenderMarkup] = useState(INLINE_PREFS?.renderMarkup ?? true)

  useEffect(
    () =>
      onMessage((msg) => {
        if (msg.type === 'layoutPrefs') {
          setSkin(msg.skin)
          setWornSkinLabel(msg.wornSkinLabel)
          setColorScheme(msg.colorScheme)
          setHandedness(msg.handedness)
          setKeysPosition(msg.keysPosition)
          setDeckMode(msg.deckMode)
          setSplitConcept(msg.splitConcept)
          setMirrorPlacement(msg.mirrorPlacement)
          setShowCursor(msg.showCursor)
          setAppRing(msg.appRing)
          setRenderMarkup(msg.renderMarkup)
          setHostKeyboard(msg.hostKeyboard)
          if (msg.hostDevice) setHostDevice(msg.hostDevice)
        }
      }),
    [onMessage]
  )

  // No onLayoutChange: layout is deprecated and has no control any more. The
  // 'setLayout' WS message and the pref both stay — an existing 'classic' pref
  // is still honored and still round-trips — there's just nothing that sets it.
  const onSkinChange = useCallback(
    (value: InstallableSkin) => {
      setSkin(value)
      send({ type: 'setSkin', value })
    },
    [send]
  )
  const onColorSchemeChange = useCallback(
    (value: PhoneRemoteColorScheme) => {
      setColorScheme(value)
      send({ type: 'setColorScheme', value })
    },
    [send]
  )
  const onHandednessChange = useCallback(
    (value: PhoneRemoteHandedness) => {
      setHandedness(value)
      send({ type: 'setHandedness', value })
    },
    [send]
  )
  const onKeysPositionChange = useCallback(
    (value: PhoneRemoteKeysPosition) => {
      setKeysPosition(value)
      send({ type: 'setKeysPosition', value })
    },
    [send]
  )
  const onDeckModeChange = useCallback(
    (value: PhoneRemoteDeckMode) => {
      setDeckMode(value)
      send({ type: 'setDeckMode', value })
    },
    [send]
  )
  const onSplitConceptChange = useCallback(
    (value: PhoneRemoteSplitConcept) => {
      setSplitConcept(value)
      send({ type: 'setSplitConcept', value })
    },
    [send]
  )
  const onMirrorPlacementChange = useCallback(
    (value: PhoneRemoteMirrorPlacement) => {
      setMirrorPlacement(value)
      send({ type: 'setMirrorPlacement', value })
    },
    [send]
  )
  const onShowCursorChange = useCallback(
    (value: boolean) => {
      setShowCursor(value)
      send({ type: 'setShowCursor', value })
    },
    [send]
  )
  const onAppRingChange = useCallback(
    (value: boolean) => {
      setAppRing(value)
      send({ type: 'setAppRing', value })
    },
    [send]
  )
  const onRenderMarkupChange = useCallback(
    (value: boolean) => {
      setRenderMarkup(value)
      send({ type: 'setRenderMarkup', value })
    },
    [send]
  )

  return {
    skin,
    wornSkinLabel,
    onSkinChange,
    installedRemoteSkins: INSTALLED_REMOTE_SKINS,
    colorScheme,
    onColorSchemeChange,
    handedness,
    onHandednessChange,
    keysPosition,
    onKeysPositionChange,
    deckMode,
    onDeckModeChange,
    splitConcept,
    onSplitConceptChange,
    mirrorPlacement,
    onMirrorPlacementChange,
    hostKeyboard,
    hostDevice,
    showCursor,
    onShowCursorChange,
    appRing,
    onAppRingChange,
    appRingRef,
    renderMarkup,
    onRenderMarkupChange
  }
}

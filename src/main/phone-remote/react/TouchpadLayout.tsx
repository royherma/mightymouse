import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties
} from 'react'
import { History } from 'lucide-react'
import MirrorAudioBadge from './MirrorAudioBadge'
import { MirrorFullScreenBadge, MirrorPane, MirrorTouchModeBadge } from './MirrorPane'
import { VoiceCallPane } from './VoiceCallPane'
import MirrorMinimap from './MirrorMinimap'
import MicInputBadge from './MicInputBadge'
import { FirstSteps, type FirstStepsState } from './FirstSteps'
import { CONFIG, type SupabaseEnvName } from '@shared/config'
import type { Suggestion } from '@shared/swipe-suggest'
import type { HostDevice, PhoneRemoteKeyName, PhoneRemoteModifier, TmuxAction } from '@shared/phone-remote-keys'
import type { AppContext } from '@shared/app-context'
import type { HostCapabilities } from '@shared/phone-remote-protocol'
import type {
  PhoneRemoteMessage,
  RelayRequestWire,
  RelayResponseWire,
  RelayTapMissReason,
  RelayTapOutcome,
  RelayVerbWire,
  WindowLayoutKind
} from '@shared/phone-remote-protocol'
import type { RelayNotifyPushLevel, RelayPushFilter } from '@shared/relay-push-filter'
import type { RelayRefusal } from '@shared/relay-cards'
import type { KeyboardLayoutId } from './keyboard-layouts'
import type { RefObject } from 'react'
import type {
  InstallableSkin,
  PhoneRemoteColorScheme,
  PhoneRemoteHandedness,
  PhoneRemoteKeysPosition,
  PhoneRemoteDeckMode,
  PhoneRemoteSplitConcept,
  PhoneRemoteMirrorPlacement,
  AgentRelayStatus
} from '@shared/types'
import { KeyPillGrid, BottomIconRow, QuickSwitchOverlay } from './TouchpadControls'
import { AppRing, AppRingSummonZone, RingZoomTrack } from './AppRing'
import { useAppRing } from './useAppRing'
import { summonBegin, summonMove, summonQualifies, type SummonTrace } from './ring-summon'
import type { RingSummonHandle } from './ring-summon'
import { ringSlotCount } from './app-ring-geometry'
import { useScrollRail } from './useScrollRail'
import type { RailSummonHandle } from './scroll-rail'
import {
  rubBegin,
  rubMove,
  rubQualifies,
  type RubHandle,
  type RubPoint,
  type RubTrace
} from './rub-toggle'
import { ChevronDown, ChevronLeft, ChevronUp, Mic, MonitorUp, MonitorX, X } from 'lucide-react'
import type { KeyPillId, IconBtnId } from './TouchpadControls'
import type { HandsFreeDisplay } from './hands-free-rules'
import SettingsBody, { type EnvSwitcherState } from './SettingsBody'
import HistorySheet, { type DictationEntry } from './HistorySheet'
import PhoneRemoteTitleBar from './PhoneRemoteTitleBar'
import { getHiddenKinds } from './history-kinds'
import type { ChatSessionSummary, ChatStep, OpenChatThread } from './chat-steps'
import AiRoot, { type CodeProps } from './ai/AiRoot'
import { ScreenView } from './ai/ScreenView'
import MacLookView from './MacLookView'
import type { AiSession } from './ai/use-ai-session'
import { nativeBridge, subscribeNativeIntent } from './native-bridge'
import DeckControlIsland, { readIslandOpen, writeIslandOpen } from './DeckControlIsland'
import { type SessionMicProps, type SessionPeekOutcome } from './SessionList'
import ActProgressSheet from './ActProgressSheet'
import BrandWatermark from './BrandWatermark'
import TranscriptToast from './TranscriptToast'
import VoiceCallBanner from './VoiceCallBanner'
import { TranscribePill } from './TranscribePill'
import ReferralSheet from './ReferralSheet'
import VirtualKeyboard from './VirtualKeyboard'
import KeyboardAccessoryBar from './KeyboardAccessoryBar'
import FloatingContextBar from './FloatingContextBar'
import FloatingPasteButton from './FloatingPasteButton'
import { floatingBarVisible, type KeyboardMode } from './keyboard-state'
import { useFreeViewport, FREE_VIEWPORT_MARGIN_PX } from './useFreeViewport'
import ZoomBar from './ZoomBar'
import MacCursor from './MacCursor'
import CursorTrail from './CursorTrail'
import { MicWaveform } from './MicWaveform'
import { useNotchPath, NOTCH_PATH_ID, NOTCH_PATH_B_ID } from './useNotchPath'
import { isImageSkin, isLightPinnedSkin, readsAsImageSkin, stepSkin } from './skins'
import { hapticTick } from './haptics'
import { useCursorless } from './cursorless-host'
import { useFullscreenMirror } from './fullscreen-mirror'
import { useSheetFocus } from './useSheetFocus'
import { copyDebugReport, measureLayers, useDebugLayout, useNavTick } from './debug-layout'
import { useLazyMode } from './lazy-mode-pref'
import { setScreenShareLayout, useScreenShareLayout } from './screen-share-layout'
import type { MirrorRigStatus } from './MirrorStatsOverlay'
import type { BenchSummary } from './mirror-bench'
import AppSwitchGrid from './AppSwitchGrid'
import WindowLayoutSheet from './WindowLayoutSheet'
import DrawPage from './DrawPage'
import { createPortal } from 'react-dom'
import type { SocketBus } from './socket-bus'

// How long the status line shows "copied" before falling back to the live
// measurements. Long enough to read on a phone at arm's length, short enough
// that the numbers are back before you'd think to look again.
const COPY_FEEDBACK_MS = 1500

// Breathing room between the glass zoom bar and the context bar above the
// cluster. Matches useClusterTop's own GAP, so the two stack evenly.
const GLASS_CONTEXT_GAP = 8

// The floating Paste button, parked off. It works -- built and verified
// on-device 2026-08-17 -- but pastes the MAC's clipboard, and the thing a phone
// in your hand makes you want is the other direction: something copied on the
// PHONE, sent to the Mac. The user's call after trying it. Kept as a flag rather
// than commented-out JSX so it keeps typechecking against the props around it
// and cannot rot while it is parked. Flip to true to bring it back.
const FLOATING_PASTE_ENABLED = false

type AppSwitchItem = { name: string; bundleId: string; iconPngBase64: string }
import type { MirrorMode, MirrorQuality } from './mirror-quality'
// Imported, not re-declared -- a hand-copied union silently drifts.
import type { ConnState } from '../connection-state'
import { Button } from '@shared/ui/Button'

/** Which controls land in which thumb's cluster, per split concept.
 *  `primary` is the dominant-thumb (data-hand) cluster, `secondary` the off
 *  hand; `header` demotes a control out of the thumb arcs entirely (pods only). */
const SPLIT_CONCEPTS: Record<
  PhoneRemoteSplitConcept,
  {
    primary: { keys: KeyPillId[]; icons: IconBtnId[] }
    secondary: { keys: KeyPillId[]; icons: IconBtnId[] }
    header?: IconBtnId[]
  }
> = {
  // Both thumbs get the identical full deck. The duplicates drive the SAME
  // action (both mics one recording), so handlers are shared by construction.
  mirror: {
    primary: {
      keys: ['escape', 'keyboard', 'tab', 'return'],
      icons: ['mic', 'switcher', 'prev', 'settings']
    },
    secondary: {
      keys: ['escape', 'keyboard', 'tab', 'return'],
      icons: ['mic', 'switcher', 'prev', 'settings']
    }
  },
  // The deck's two natural groups, one per side, each keeping its stacked-deck
  // shape and order. Unlike `fan`, does NOT re-sort by frequency.
  // Array order IS screen order -- see the caution on `fan`.
  groups: {
    primary: { keys: ['escape', 'keyboard', 'tab', 'return'], icons: [] },
    secondary: { keys: [], icons: ['mic', 'switcher', 'prev', 'settings'] }
  },
  // Split by FREQUENCY: mic/keyboard/Enter to the dominant thumb, nav to the other.
  // Array order IS screen order, left to right. Do NOT pre-reverse to compensate
  // for a row's flex-direction -- that shipped as a mirrored portrait deck once.
  fan: {
    primary: { keys: ['keyboard', 'return'], icons: ['mic'] },
    secondary: { keys: ['escape', 'tab'], icons: ['switcher', 'prev', 'settings'] }
  },
  // Same assignment as fan -- rails differ in SHAPE (a vertical edge rail), not
  // in who owns what, and that difference lives entirely in CSS.
  rails: {
    primary: { keys: ['keyboard', 'return'], icons: ['mic', 'settings'] },
    secondary: { keys: ['escape', 'tab'], icons: ['switcher', 'prev'] }
  },
  // Three per corner: settings leaves the arc for the header band, which is
  // what buys pods its reach.
  pods: {
    primary: { keys: ['keyboard', 'return'], icons: ['mic'] },
    secondary: { keys: ['escape', 'tab'], icons: ['switcher', 'prev'] },
    header: ['settings']
  }
}

export default function TouchpadLayout(props: {
  ai: AiSession
  status: string
  connState: ConnState
  colorScheme: PhoneRemoteColorScheme
  handedness: PhoneRemoteHandedness
  keysPosition: PhoneRemoteKeysPosition
  deckMode: PhoneRemoteDeckMode
  splitConcept: PhoneRemoteSplitConcept
  onSplitConceptChange: (value: PhoneRemoteSplitConcept) => void
  /** PORTRAIT-only: where the mirror pane sits. 'stacked' keeps the shipped
   *  layout (pane above, pad pushed below); the other three place it inside the
   *  pad, which means the pad must NOT be offset — see padStacksBelowMirror. */
  mirrorPlacement: PhoneRemoteMirrorPlacement
  onMirrorPlacementChange: (value: PhoneRemoteMirrorPlacement) => void
  appSwitchOpen: boolean
  recording: boolean
  chatRecording: boolean
  thoughtRecording: boolean
  micLatched: boolean
  /** A VAD utterance is being captured -- lights the recording visuals
   *  without arming Cancel/Stop, which own the press-and-hold recorder. */
  handsFreeSpeaking: boolean
  /** The VAD's own stream, so the waveform meters hands-free with no second
   *  getUserMedia. Null unless an utterance is live. */
  handsFreeStreamRef: RefObject<MediaStream | null>
  disarmHandsFree: () => void
  handsFree: HandsFreeDisplay
  transcribing: boolean
  transcribeStage: 'received' | 'transcribing' | null
  transcribeClipId: string | null
  retryableClip: boolean
  cancelTranscribe: () => void
  retryTranscribe: () => void
  dismissTranscribe: () => void
  toggleAppSwitcher: () => void
  quickSwitchTap: () => void
  /** Tapping a tile in the switcher overlay: jump straight to that app. */
  quickSwitchPick: (bundleId: string) => void
  quickSteps: number
  quickAnchor: string | null
  quickPinned: string | null
  micSidePress: (kind: 'cancel' | 'stop') => void
  micStreamRef: RefObject<MediaStream | null>
  appList: AppSwitchItem[] | null
  activateApp: (bundleId: string) => void
  pressKey: (key: 'tab' | 'return' | 'escape') => void
  openKeyboard: () => void
  keyboardInputRef: RefObject<HTMLInputElement | null>
  keyboardText: string
  onKeyboardTextChange: (next: string) => void
  submitKeyboardText: () => void
  /** Return key on the native keyboard -- sends a real Return to the Mac. */
  onKeyboardEnter: () => void
  // On-screen virtual keyboard sheet -- same Keyboard pill as openKeyboard,
  // gated by the Settings toggle. Each board carries a swap button pointing at
  // the other (KeyboardAccessoryBar / VirtualKeyboard's header).
  onKeyboardInputFocus: () => void
  /** Which keyboard is on screen. Read ONLY to mount the deck's floating context
   *  bar (`floatingBarVisible`), which is the one surface here that cares about
   *  'none' specifically rather than about one board or the other. */
  keyboardMode: KeyboardMode
  nativeKeyboardOpen: boolean
  onSwitchToVirtualKeyboard: () => void
  onSwitchToNativeKeyboard: () => void
  virtualKeyboardOpen: boolean
  onCloseVirtualKeyboard: () => void
  onVirtualKeyboardChar: (text: string) => void
  onVirtualKeyboardBackspace: () => void
  onVirtualKeyboardSpecialKey: (key: PhoneRemoteKeyName) => void
  onVirtualKeyboardCombo: (modifiers: PhoneRemoteModifier[], key: PhoneRemoteKeyName) => void
  // App-aware keyboard bar: passed straight through to BOTH keyboard bars,
  // which each render the same AppContextBar.
  appContext: AppContext | null
  /** Whether the Mac clipboard holds anything pasteable (image and file
   *  included) -- gates both bars' paste key. */
  clipboardHasContent: boolean
  onPasteClipboard: () => void
  onActivateItem: (itemId: string) => void
  onActivatePane: (paneId: string) => void
  onActivateGroup: (groupId: string) => void
  /** Raised while an app-context dropdown is open, so App can hold the hidden
   *  input focused instead of reading its blur as a keyboard dismissal. */
  onBrowserSheetOpenChange: (open: boolean) => void
  onBarTap: () => void
  onTmuxAction: (action: TmuxAction) => void
  // Which layout to draw -- resolved in App.tsx from the host's reported
  // keyboard (KEYBOARD_LAYOUT_FOR_HOST).
  virtualKeyboardLayoutId: KeyboardLayoutId
  settingsOpen: boolean
  setSettingsOpen: (fn: (v: boolean) => boolean) => void
  // Window-layout sheet, opened by holding Settings.
  windowLayoutOpen: boolean
  openWindowLayouts: () => void
  onCloseWindowLayouts: () => void
  /** Host OS capabilities from hostStatus; null before the first push. */
  hostCaps: HostCapabilities | null
  macName: string | null
  hostDevice: HostDevice | undefined
  onApplyWindowLayout: (kind: WindowLayoutKind, bundleIds: string[]) => void
  canRestoreWindows: boolean
  historyOpen: boolean
  setHistoryOpen: (fn: (v: boolean) => boolean) => void
  // Referral share sheet, opened from the brand mark.
  referralOpen: boolean
  onToggleReferral: () => void
  onCloseReferral: () => void
  onRetryReferral: () => void
  referralLink: string | null
  referralCode: string | null
  referredCount: number
  referralError: string | null
  inviteState: string | null
  onSendInvite: (email: string) => void
  // Chat sheet. All state lives in App.tsx; this component just renders it.
  chatOpen: boolean
  chatSessions: ChatSessionSummary[]
  chatThread: OpenChatThread | null
  chatBusy: boolean
  chatSteps: ChatStep[]
  chatStreamed: string
  chatDictating: boolean
  chatDraftPatch: string | null
  onChatMicDown: () => void
  onChatMicUp: () => void
  onChatDraftConsumed: () => void
  renderMarkup: boolean
  onToggleChat: () => void
  onCloseChat: () => void
  onChatOpenSession: (id: string) => void
  onChatNewSession: () => void
  onChatSend: (text: string, projectId?: string) => boolean
  onStopChat: () => void
  codeOpen: boolean
  relayPending: RelayRequestWire[]
  relayResolved: RelayRequestWire[]
  relayDismissed: RelayRequestWire[]
  /** Connected AND a relay snapshot has arrived -- see App.tsx. */
  relayLinkOk: boolean
  /** Who is connected right now. Null until the first `relayStatus` push. */
  relayStatus: AgentRelayStatus | null
  /** Set when the Mac threw the last answer away. */
  relayRefusal: RelayRefusal | null
  /** Set by a notification tap. CodeSheet scrolls to and highlights this card
   *  once, then calls `onFocusedRelayRequestConsumed`. */
  focusedRelayRequestId: string | null
  onFocusedRelayRequestConsumed: () => void
  /** Diagnostic. Where that tap actually landed, for `make phone-log`. */
  onRelayTapMissed: (reason: RelayTapMissReason) => void
  onRelayTapTrace: (requestId: string, outcome: RelayTapOutcome) => void
  onToggleCode: () => void
  onCloseCode: () => void
  onRelayRespond: (requestId: string, response: RelayResponseWire) => void
  onRelayUndismiss: (requestId: string) => void
  sessionPreviews: Record<string, string>
  sessionSent: Record<string, { text: string; at: number }[]>
  onSessionSentGet: (label: string) => void
  sessionSuggestions: Record<string, Suggestion[]>
  onRequestSuggestions: (label: string, tldr: string) => void
  sessionPreviewAges: Record<string, number>
  sessionPeekOutcome: SessionPeekOutcome | null
  onSessionPeek: (label: string) => void
  onSessionReply: (label: string, text: string) => void
  onSessionStop: (label: string) => void
  onSessionAttach: (label: string, file: File) => Promise<boolean>
  onSessionGoTo: (label: string) => void
  onSessionZoom: (label: string, on: boolean) => void
  sessionZoomed: Readonly<Record<string, boolean>>
  sessionGoToFailed: ReadonlySet<string>
  /** When the Mac last confirmed it raised a window, so the sheet can step
   *  aside and leave the trackpad under the thumb. */
  sessionRevealedAt: number | null
  /** Which kinds of message may buzz this phone. Null until the Mac answers. */
  relayPushFilter: RelayPushFilter | null
  relayNotifyLevel: RelayNotifyPushLevel
  relayTurnEndPing: boolean
  onSetRelayPush: (verb: RelayVerbWire, on: boolean) => void
  onSetRelayNotifyLevel: (level: RelayNotifyPushLevel) => void
  onSetRelayTurnEndPing: (on: boolean) => void
  onRequestRelayPush: () => void
  sessionMic: SessionMicProps
  relayImageSrc: (requestId: string) => string
  /** Send a picked photo up, answering a photos_get card. */
  onRelayPickPhoto: (requestId: string, file: File) => Promise<boolean>
  highlightHistoryId: string | null
  dictations: DictationEntry[]
  historyHasMore: boolean
  historyLoadingMore: boolean
  onLoadMoreHistory: () => void
  onPasteDictation: (id: string) => void
  onActDictation: (id: string) => void
  actProgressOpen: boolean
  onHideActProgress: () => void
  onStopActProgress: () => void
  actInstruction: string
  actSteps: ChatStep[]
  onToastTap: () => void
  onToastHoldStart: () => void
  onToastHoldEnd: () => void
  sensitivity: { min: number; max: number; value: number }
  onSensitivityChange: (value: number) => void
  onCursorSizeChange: (size: number) => void
  onCursorAnimatedChange: (animated: boolean) => void
  mirrorOn: boolean
  toggleMirror: (on: boolean) => void
  /** The glasses' invisible D-pad — see fullscreen-mirror.ts. */
  onMirrorDpadPan: (dx: number, dy: number) => void
  onMirrorDpadZoom: (factor: number) => void
  mirrorQuality: MirrorQuality
  onMirrorQualityChange: (quality: MirrorQuality) => void
  mirrorMode: MirrorMode
  onMirrorModeChange: (mode: MirrorMode) => void
  mirrorPaneRef: RefObject<HTMLDivElement | null>
  mirrorPaneHeight: number | null
  /** Landscape splits the card into mirror + touchpad rail. Drives `data-orient`
   *  and drops the zoom bar -- 44px of the vertical space the rail reclaims,
   *  and pinch-to-zoom already covers the same range. */
  isLandscape: boolean
  videoRef: RefObject<HTMLVideoElement | null>
  benchSummary: BenchSummary | null
  benchEstimateKbps: number | null
  benchCode: string | null
  rigStatus: MirrorRigStatus | null
  mirrorActive: boolean
  mirrorZoom: { scale: number; x: number; y: number }
  onZoomToScale: (scale: number) => void
  zoomFollowLocked: boolean
  onZoomFollowLockedChange: (locked: boolean) => void
  zoomFollowToast: boolean
  onDebugLog: (message: string) => void
  onMirrorLoadedMetadata: () => void
  // Touch mode: tapping the mirror image turns the finger into the cursor.
  // `touchModeActive` shows the snackbar; the lock icon on it toggles
  // `touchModeLocked` to keep it up instead of auto-resting.
  touchModeActive: boolean
  touchModeLocked: boolean
  onToggleTouchModeLock: () => void
  trackpadRef: RefObject<HTMLDivElement | null>
  touchDotActive: boolean
  firstSteps: FirstStepsState | null
  /** One entry per finger on the pad, so a multi-finger gesture shows it sees
   *  every finger and not just the one driving the cursor. */
  touchDots: { id: number; x: number; y: number }[]
  micRef: RefObject<HTMLButtonElement | null>
  toast: string
  toastShown: boolean
  toastRunning: boolean
  toastFailed: boolean
  toastOffline: boolean
  toastTappable: boolean
  toastActArming: boolean
  skin: InstallableSkin
  /** Name for a worn REMOTE skin, passed straight through to SettingsBody. */
  wornSkinLabel?: string
  onSkinChange: (value: InstallableSkin) => void
  /** Remote skins already installed on the phone, so the corner-tap cycle
   *  reaches them too. Server-inlined at page load; see stepSkin. */
  installedRemoteSkins: readonly InstallableSkin[]
  onColorSchemeChange: (value: PhoneRemoteColorScheme) => void
  onHandednessChange: (value: PhoneRemoteHandedness) => void
  onKeysPositionChange: (value: PhoneRemoteKeysPosition) => void
  onDeckModeChange: (value: PhoneRemoteDeckMode) => void
  showCursor: boolean
  onShowCursorChange: (value: boolean) => void
  appRing: boolean
  onAppRingChange: (value: boolean) => void
  /** Owned by App.tsx, which binds the pad's own touch handler to the same
   *  node -- the ring sets it so that handler stands down mid-scrub. */
  ringClaimRef: RefObject<boolean>
  ringHitRef: RefObject<((t: { clientX: number; clientY: number }) => boolean) | null>
  /** Drives the summon gesture from the pad's own handler. Null while the ring
   *  is on or unmeasured -- see the effect that publishes it. */
  ringSummonRef: RefObject<RingSummonHandle | null>
  /** Called when the ring's touch ends, so App can release the app list it
   *  froze for the drag. */
  onRingRelease: () => void
  /** Glasses (or a second phone) are attached and showing the picture, so the
   *  outer band becomes a zoom control. Independent of `appRing` -- it is on
   *  the outer ring and answers a different question. */
  zoomTrackOn: boolean
  /** The scale currently published to that viewer. */
  zoomScale: number
  onRingZoom: (scale: number) => void
  /** The mirrored desktop's bounds, for the minimap's aspect. 0 until the Mac
   *  reports them -- this device has no video of its own to measure. */
  viewerScreenW: number
  viewerScreenH: number
  /** Where the minimap says that viewer is aimed, normalized desktop space. */
  minimapCentre: { x: number; y: number }
  onMinimapPan: (point: { x: number; y: number }) => void
  /** Same contract as zoomHitRef, asked before it -- see App.tsx's touchstart. */
  minimapHitRef: RefObject<((t: { clientX: number; clientY: number }) => boolean) | null>
  /** Same contract as ringHitRef, asked before it -- see App.tsx's touchstart. */
  zoomHitRef: RefObject<((t: { clientX: number; clientY: number }) => boolean) | null>
  /** The scroll rail: same claim/summon shape as the ring, opposite edge.
   *  `send` is only needed here -- the rail fires `scroll` messages directly
   *  from its own drag/rate-zone listeners, with no round trip through App. */
  send: (msg: PhoneRemoteMessage) => void
  bus: SocketBus
  sendBinary: (data: ArrayBuffer) => boolean
  railClaimRef: RefObject<boolean>
  railSummonRef: RefObject<RailSummonHandle | null>
  /** Rub-to-mirror's watch, driven by the pad the same way the two above are.
   *  Null while the keys sit at the top -- see the effect that fills it. */
  rubRef: RefObject<RubHandle | null>
  onRenderMarkupChange: (value: boolean) => void
  onCenterCursor: () => void
  startChatGptVoiceWithMic: () => void
  onPaired: () => void
  onDisconnect: () => void
  /** Straight pass-through to SettingsBody -- see EnvSwitcherState there. */
  env: EnvSwitcherState | null
  onEnvChange: (value: SupabaseEnvName) => void
  cameraOn: boolean
  shareAudio: boolean
  onShareAudioChange: (value: boolean) => void
  micOn: boolean
  onMicChange: (value: boolean) => void
  phoneMicStreamRef: RefObject<MediaStream | null>
  systemVolume: number | null
  onSystemVolumeChange: (volume: number) => void
  onRequestSystemVolume: () => void
  onCameraChange: (value: boolean) => void
  // Pointer position in touchpad-local px (the finger's own spot on the
  // phone, not a translated Mac coordinate). Null until a finger has landed.
  cursorPos: { x: number; y: number } | null
  cursorVisible: boolean
  // Comet trail behind the pointer, oldest point first.
  trail: { id: number; x: number; y: number; bornAt: number }[]
  // Frame clock driving each dot's age-based fade.
  trailNow: number
  cursorStyle: { size: number; fill: string; outline: string; animated: boolean }
}): React.JSX.Element {
  const {
    status,
    connState,
    colorScheme,
    handedness,
    keysPosition,
    deckMode,
    splitConcept,
    onSplitConceptChange,
    appSwitchOpen,
    recording,
    chatRecording,
    thoughtRecording,
    micLatched,
    handsFreeSpeaking,
    handsFreeStreamRef,
    disarmHandsFree,
    handsFree,
    transcribing,
    transcribeStage,
    transcribeClipId,
    retryableClip,
    cancelTranscribe,
    retryTranscribe,
    dismissTranscribe,
    micStreamRef,
    toggleAppSwitcher,
    quickSwitchTap,
    quickSwitchPick,
    quickSteps,
    quickAnchor,
    quickPinned,
    micSidePress,
    appList,
    activateApp,
    pressKey,
    openKeyboard,
    keyboardInputRef,
    keyboardText,
    onKeyboardTextChange,
    submitKeyboardText,
    onKeyboardEnter,
    onKeyboardInputFocus,
    keyboardMode,
    nativeKeyboardOpen,
    onSwitchToVirtualKeyboard,
    onSwitchToNativeKeyboard,
    virtualKeyboardOpen,
    onCloseVirtualKeyboard,
    onVirtualKeyboardChar,
    onVirtualKeyboardBackspace,
    onVirtualKeyboardSpecialKey,
    onVirtualKeyboardCombo,
    appContext,
    clipboardHasContent,
    onPasteClipboard,
    onActivateItem,
    onActivatePane,
    onActivateGroup,
    onBrowserSheetOpenChange,
    onBarTap,
    onTmuxAction,
    virtualKeyboardLayoutId,
    settingsOpen,
    setSettingsOpen,
    windowLayoutOpen,
    openWindowLayouts,
    onCloseWindowLayouts,
    hostCaps,
    macName,
    hostDevice,
    onApplyWindowLayout,
    canRestoreWindows,
    historyOpen,
    setHistoryOpen,
    referralOpen,
    onToggleReferral,
    onCloseReferral,
    onRetryReferral,
    referralLink,
    referralCode,
    referredCount,
    referralError,
    inviteState,
    onSendInvite,
    ai,
    chatOpen,
    chatSessions,
    chatThread,
    chatBusy,
    chatSteps,
    chatDictating,
    chatDraftPatch,
    onChatMicDown,
    onChatMicUp,
    onChatDraftConsumed,
    renderMarkup,
    chatStreamed,
    onToggleChat,
    onCloseChat,
    onChatOpenSession,
    onChatNewSession,
    onChatSend,
    onStopChat,
    codeOpen,
    relayPending,
    relayResolved,
    relayDismissed,
    relayLinkOk,
    relayStatus,
    relayRefusal,
    focusedRelayRequestId,
    onFocusedRelayRequestConsumed,
    onRelayTapMissed,
    onRelayTapTrace,
    onToggleCode,
    onCloseCode,
    onRelayRespond,
    onRelayUndismiss,
    sessionPreviews,
    sessionSent,
    onSessionSentGet,
    sessionSuggestions,
    onRequestSuggestions,
    sessionPreviewAges,
    sessionPeekOutcome,
    onSessionPeek,
    onSessionReply,
    onSessionStop,
    onSessionAttach,
    onSessionGoTo,
    onSessionZoom,
    sessionZoomed,
    sessionGoToFailed,
    sessionRevealedAt,
    relayPushFilter,
    relayNotifyLevel,
    relayTurnEndPing,
    onSetRelayPush,
    onSetRelayNotifyLevel,
    onSetRelayTurnEndPing,
    onRequestRelayPush,
    sessionMic,
    relayImageSrc,
    onRelayPickPhoto,
    highlightHistoryId,
    dictations,
    historyHasMore,
    historyLoadingMore,
    onLoadMoreHistory,
    onPasteDictation,
    onActDictation,
    actProgressOpen,
    onHideActProgress,
    onStopActProgress,
    actInstruction,
    actSteps,
    onToastTap,
    onToastHoldStart,
    onToastHoldEnd,
    sensitivity,
    onSensitivityChange,
    onCursorSizeChange,
    onCursorAnimatedChange,
    mirrorOn,
    toggleMirror,
    onMirrorDpadPan,
    onMirrorDpadZoom,
    mirrorQuality,
    onMirrorQualityChange,
    mirrorMode,
    onMirrorModeChange,
    mirrorPlacement,
    onMirrorPlacementChange,
    mirrorPaneRef,
    mirrorPaneHeight,
    isLandscape,
    videoRef,
    benchSummary,
    benchEstimateKbps,
    benchCode,
    rigStatus,
    mirrorActive,
    mirrorZoom,
    onZoomToScale,
    zoomFollowLocked,
    onZoomFollowLockedChange,
    zoomFollowToast,
    onDebugLog,
    onMirrorLoadedMetadata,
    touchModeActive,
    touchModeLocked,
    onToggleTouchModeLock,
    trackpadRef,
    touchDotActive,
    firstSteps,
    touchDots,
    micRef,
    toast,
    toastShown,
    toastRunning,
    toastFailed,
    toastOffline,
    toastTappable,
    toastActArming,
    skin,
    wornSkinLabel,
    onSkinChange,
    installedRemoteSkins,
    onColorSchemeChange,
    onHandednessChange,
    onKeysPositionChange,
    onDeckModeChange,
    showCursor,
    onShowCursorChange,
    appRing: appRingPref,
    onAppRingChange,
    ringClaimRef,
    ringHitRef,
    ringSummonRef,
    onRingRelease,
    zoomTrackOn,
    zoomScale,
    onRingZoom,
    viewerScreenW,
    viewerScreenH,
    minimapCentre,
    onMinimapPan,
    minimapHitRef,
    zoomHitRef,
    send,
    bus,
    sendBinary,
    railClaimRef,
    railSummonRef,
    rubRef,
    onRenderMarkupChange,
    onCenterCursor,
    startChatGptVoiceWithMic,
    onPaired,
    onDisconnect,
    env,
    onEnvChange,
    cameraOn,
    shareAudio,
    onShareAudioChange,
    micOn,
    onMicChange,
    phoneMicStreamRef,
    systemVolume,
    onSystemVolumeChange,
    onRequestSystemVolume,
    onCameraChange,
    cursorPos,
    cursorVisible,
    cursorStyle,
    trail,
    trailNow
  } = props

  // Centers the switcher in what's actually free. The obstruction is whichever
  // keyboard is up, or the control cluster (z41, above the switcher's z40) when
  // neither is -- measure it, don't run the band to the safe area.
  const freeViewport = useFreeViewport(
    virtualKeyboardOpen ? '.virtualKeyboard' : '.proControlsCell'
  )

  // The ring is a continuous-angle DRAG. A cursorless host sends four discrete
  // arrows and nothing else, so the gesture is unexpressable there -- the
  // feature is forced off rather than left painted-but-dead. Every consumer
  // below reads this, never the raw pref, so paint / hit-testing / the summon
  // tracker can never disagree about whether the ring exists.
  const cursorless = useCursorless()
  const appRing = appRingPref && !cursorless

  // TEMPORARY: see fullscreen-mirror.ts. The picture takes the whole HUD, and
  // every deck control hides behind it -- none of them are reachable on a
  // cursorless host anyway, so they are pure occlusion there.
  const exitFullscreenMirror = useCallback(() => toggleMirror(false), [toggleMirror])
  const fullMirror = useFullscreenMirror({
    enabled: cursorless && mirrorOn,
    onExit: exitFullscreenMirror,
    onPan: onMirrorDpadPan,
    onZoom: onMirrorDpadZoom
  })

  const keyGridRef = useRef<HTMLDivElement | null>(null)
  const iconRowRef = useRef<HTMLDivElement | null>(null)
  // The cluster CELL, not its rows -- FloatingContextBar parks off this box's
  // leading edge. Attached to the stacked cell and to split mode's PRIMARY cell,
  // which are never mounted at the same time, so one ref serves both.
  const controlsCellRef = useRef<HTMLDivElement | null>(null)
  // Split mode's SECOND cluster (the off-hand corner). Its own pair of refs
  // because useNotchPath measures real rects and there are genuinely two
  // clusters to measure -- reusing one ref pair would carve one corner twice.
  const keyGridRefB = useRef<HTMLDivElement | null>(null)
  const iconRowRefB = useRef<HTMLDivElement | null>(null)
  // Whether the applied skin paints pictures; a remote skin only declares this
  // once the root carries its data-skin (see readsAsImageSkin). MUST stay a
  // layout effect -- resolving after paint flashes one sculpted frame.
  const rootRef = useRef<HTMLDivElement | null>(null)
  // Aims the focus ring into the sheet on a host where focus IS the cursor --
  // without it, opening Settings leaves focus on the deck behind the sheet.
  const settingsPanelRef = useRef<HTMLDivElement | null>(null)
  const appSwitchBarRef = useRef<HTMLDivElement | null>(null)
  useSheetFocus(settingsOpen, settingsPanelRef)
  useSheetFocus(appSwitchOpen, appSwitchBarRef)
  // Seeded from storage rather than false: the sheet only mounts its filter
  // once opened, so a persisted filter would otherwise show no dot until then.
  const [historyFiltering, setHistoryFiltering] = useState(() => getHiddenKinds().size > 0)
  const [remoteIsImageSkin, setRemoteIsImageSkin] = useState(false)
  useLayoutEffect(() => {
    setRemoteIsImageSkin(readsAsImageSkin(rootRef.current))
    // Re-reads on skin change: the token lives on the skin's own selector, so
    // switching skins changes the answer without remounting.
  }, [skin])
  const imageSkin = isImageSkin(skin) || remoteIsImageSkin
  // Transient "copied" / "copy failed" flash on the debug status line. Local
  // to this component on purpose: it's UI feedback for one tap, nothing else
  // in the app has any reason to know a copy happened.
  const [copied, setCopied] = useState<string | null>(null)

  // Subscribed, not read during render: the flag lives in localStorage, so the
  // plain getter left every JSX-gated overlay mounted at its boot value while
  // the CSS-only tints flipped instantly.
  const debugLayout = useDebugLayout()
  const lazyMode = useLazyMode()
  // Subscribed for the re-render alone: measureLayers() reads live DOM, so the
  // tick's value is never used, only its change.
  useNavTick()

  // Double-tap arming for the hidden skin corners. A ref, not state: a
  // re-render between the two taps would disarm the gesture. Keyed by direction
  // so prev-then-next doesn't read as a double tap on next.
  const skinTapRef = useRef<{ dir: number; at: number } | null>(null)
  function skinCornerTap(dir: number): void {
    const now = Date.now()
    const prev = skinTapRef.current
    if (prev && prev.dir === dir && now - prev.at < CONFIG.PHONE_REMOTE.SKIN_CORNER_DOUBLE_TAP_MS) {
      skinTapRef.current = null
      onSkinChange(stepSkin(skin, dir, installedRemoteSkins))
      hapticTick()
      return
    }
    skinTapRef.current = { dir, at: now }
  }

  // Split mode is landscape-only: portrait has one thumb arc, so there is
  // nothing to split it across.
  const splitDeck = isLandscape && deckMode === 'split'
  const split = SPLIT_CONCEPTS[splitConcept]

  // Does the pad sit BELOW the pane, or the pane inside the pad? ONE flag for
  // all three geometry sites (pane height, zoom bar top, pad top) -- deriving
  // it three times is how they drift into a mirror's worth of dead space.
  // Which of the two possible homes the mirror is mounted in. The deck covers
  // the trackpad instead of unmounting it, so both would otherwise mount and
  // fight over the single videoRef.
  const [deckOpen, setDeckOpen] = useState(false)
  const [drawOpen, setDrawOpen] = useState(false)
  useEffect(
    () =>
      subscribeNativeIntent((event) => {
        if (event.type !== 'openDraw') return
        send({ type: 'debugLog', message: '[draw] openDraw received' })
        setDrawOpen(true)
      }, ['openDraw']),
    [send]
  )
  const [islandOpen, setIslandOpen] = useState(readIslandOpen)
  const [alertsAsk, setAlertsAsk] = useState(0)
  // A third home, same rule: an agent's sheet portals over everything, so when
  // one is open it is the surface the picture belongs on.
  const [sessionDetailOpen, setSessionDetailOpen] = useState(false)
  // Exactly the condition under which the island's node is rendered AND open,
  // so the two recording HUDs can never both be on screen or both be absent.
  const islandRecOwns = islandOpen && deckOpen && !sessionDetailOpen
  const padStacksBelowMirror = isLandscape || mirrorPlacement === 'stacked'

  // Under glass the pane is `pointer-events: none` -- that's what lets a drag
  // pass through the picture onto the trackpad underneath. Badges rendered
  // inside it inherit that and go dead, so they ride the zoom bar instead,
  // which is a pane SIBLING and therefore still live.
  const badgesRideZoomBar = !isLandscape && mirrorPlacement === 'glass'

  // Viewport y of the floating context bar's top, or null when it is not up.
  // The glass block clears it from here rather than from a constant: that bar
  // parks off the cluster's MEASURED rect and rides above the app ring when one
  // is painted, so its line moves with handedness, ring, device and rotation.
  const [contextBarTop, setContextBarTop] = useState<number | null>(null)
  const [zoomBarNode, setZoomBarNode] = useState<HTMLDivElement | null>(null)
  // How far the picture+bar block must rise so its bottom clears the context
  // bar. Measured as an OVERLAP of two live rects, so it is 0 whenever the two
  // already fit and never moves a deck that has no collision.
  const [glassLift, setGlassLift] = useState(0)

  useEffect(() => {
    if (!badgesRideZoomBar || !zoomBarNode || contextBarTop === null) {
      setGlassLift(0)
      return
    }
    // Measure the block's UNLIFTED bottom by adding back whatever lift is
    // currently applied, so the result depends only on the two rects and not on
    // the previous answer. A relative "move it up a bit more" here would keep
    // re-triggering its own ResizeObserver and creep upward every frame.
    setGlassLift((prev) => {
      const unlifted = zoomBarNode.getBoundingClientRect().bottom + prev
      return Math.max(0, unlifted + GLASS_CONTEXT_GAP - contextBarTop)
    })
  }, [badgesRideZoomBar, zoomBarNode, contextBarTop, mirrorPaneHeight])

  // Reads the SAME two axes the notch carve does, never its own derivation --
  // two derivations of one corner is how the notch and cluster drifted apart.
  const ringKeysPosition = isLandscape ? keysPosition : 'bottom'
  const onRingCommit = useCallback(
    (slot: number) => {
      // Map slot -> app HERE, against the same list the ring painted dots for.
      // Sending a slot index for the Mac to re-resolve is the bug quick-switch
      // regressed into three times (see TouchpadControls).
      const target = appList?.[slot]
      if (target) quickSwitchPick(target.bundleId)
    },
    [appList, quickSwitchPick]
  )
  // The band's hit layer. Unclipped, unlike the pad -- see .proAppRingHit.
  const ringHitAreaRef = useRef<HTMLDivElement | null>(null)
  const ring = useAppRing({
    enabled: appRing,
    trackpadRef,
    hitAreaRef: ringHitAreaRef,
    clusterRef: controlsCellRef,
    handedness,
    isLandscape,
    keysPosition: ringKeysPosition,
    appCount: appList?.length ?? 0,
    claimRef: ringClaimRef,
    onCommit: onRingCommit,
    onRelease: onRingRelease,
    // Held at the arc's inner end: put the ring away. The same switch the
    // Settings toggle writes, so the gesture and the setting never disagree.
    onDismiss: useCallback(() => {
      hapticTick()
      onAppRingChange(false)
    }, [onAppRingChange]),
    zoomEnabled: zoomTrackOn,
    zoomScale,
    onZoom: onRingZoom,
    zoomClaimRef: ringClaimRef
  })

  // Publishes the zoom track's claim to the pad, same shape and same reason as
  // the ring's below. Cleared when the track is off so a stale closure cannot
  // swallow a cursor drag out at that radius.
  useEffect(() => {
    zoomHitRef.current = zoomTrackOn ? ring.zoomTakes : null
    return () => {
      zoomHitRef.current = null
    }
  }, [zoomTrackOn, ring.zoomTakes, zoomHitRef])

  // The scroll rail: same claim/summon shape as the ring, no dwell/slots/
  // dismiss-zone -- see useScrollRail.ts. Shares the cluster's side, so it
  // takes the same clusterRef and stops at the buttons' top edge.
  const rail = useScrollRail({
    trackpadRef,
    handedness,
    claimRef: railClaimRef,
    summonRef: railSummonRef,
    clusterRef: controlsCellRef,
    isLandscape,
    send
  })

  // Rub-to-mirror. Published like the rail's summon, but it never claims the
  // touch -- see RubHandle. OFF entirely with the keys at the top, where the
  // ring anchors to the pad's top edge and its summon counts swept arc while
  // IGNORING direction reversals (ring-summon.ts): a rub there would summon
  // the app switcher instead. Reads ringKeysPosition, the ring's own resolved
  // corner, so the two can never disagree about where it sits.
  const rubTraceRef = useRef<RubTrace | null>(null)
  const [rubPop, setRubPop] = useState(0)
  useEffect(() => {
    if (ringKeysPosition === 'top') {
      rubRef.current = null
      return
    }
    // The rect is read per touch, not captured here: this effect must not
    // depend on the pad being mounted the moment it runs (6ef1e72d), and a
    // rect cached across a rotation is the stale-measure bug besides.
    const local = (t: { clientX: number; clientY: number }): RubPoint | null => {
      const r = trackpadRef.current?.getBoundingClientRect()
      if (!r) return null
      return { x: t.clientX - r.left, y: t.clientY - r.top, t: Date.now() }
    }
    rubRef.current = {
      start: (t) => {
        const p = local(t)
        rubTraceRef.current = p ? rubBegin(p) : null
      },
      move: (t) => {
        const trace = rubTraceRef.current
        const p = local(t)
        if (!trace || !p) return false
        const next = rubMove(trace, p)
        rubTraceRef.current = next
        if (!rubQualifies(next)) return false
        // Cleared, not left qualified: without this every later move in the
        // same gesture re-fires the toggle and it flickers under the finger.
        rubTraceRef.current = null
        hapticTick()
        setRubPop((n) => n + 1)
        toggleMirror(!mirrorOn)
        return true
      },
      end: () => {
        rubTraceRef.current = null
      }
    }
    return () => {
      rubRef.current = null
    }
  }, [trackpadRef, ringKeysPosition, rubRef, toggleMirror, mirrorOn])

  // Publishes the ring's hit test to the pad, cleared when off so a stale
  // closure can't swallow a cursor drag. Claiming and STARTING must stay ONE
  // call -- splitting them made the pad stand down for touches nobody adopted.
  useEffect(() => {
    ringHitRef.current = appRing
      ? (t) => {
          if (!ring.claimsTouch(t)) return false
          if ('identifier' in t) ring.beginTouch(t as Touch)
          return true
        }
      : null
    return () => {
      ringHitRef.current = null
    }
  }, [appRing, ring.claimsTouch, ring.beginTouch, ringHitRef])

  // While the ring is OFF, tracing the band it WOULD occupy turns it on and
  // keeps scrubbing. A ref because the pad drives it from inside a touch event,
  // before any re-render -- same reason as ringClaimRef.
  const summonRef = useRef<SummonTrace | null>(null)
  useEffect(() => {
    // Off while the ring is already on (nothing to summon) or unmeasured.
    if (appRing || !ring.anchor || !ring.band) {
      ringSummonRef.current = null
      return
    }
    const anchor = ring.anchor
    const band = ring.band
    const mirrored = handedness === 'left'
    ringSummonRef.current = {
      start: (t) => {
        const p = ring.pointOf(t)
        summonRef.current = p ? summonBegin(p, anchor, band, mirrored) : null
      },
      // Returns true the one time the gesture qualifies. The pad reads that as
      // "this finger is the ring's now" and hands the rest of the touch over.
      move: (t) => {
        const trace = summonRef.current
        const p = trace ? ring.pointOf(t) : null
        if (!trace || !p) return false
        const next = summonMove(trace, p, anchor, band, mirrored)
        summonRef.current = next
        if (!summonQualifies(next, band)) return false
        summonRef.current = null
        hapticTick()
        onAppRingChange(true)
        // The scrub effect mounts with the ring and can't adopt this finger
        // until React flushes. Without the handover the ring appears and then
        // ignores the finger that drew it.
        const adopt = t
        requestAnimationFrame(() => ring.beginTouch(adopt))
        return true
      },
      end: () => {
        summonRef.current = null
      }
    }
    return () => {
      ringSummonRef.current = null
    }
  }, [
    appRing,
    ring.anchor,
    ring.band,
    ring.pointOf,
    ring.beginTouch,
    handedness,
    onAppRingChange,
    ringSummonRef
  ])

  const notchPath = useNotchPath(
    trackpadRef,
    keyGridRef,
    iconRowRef,
    handedness,
    // Only meaningful in landscape; the CSS keeps the cluster at the bottom in
    // portrait regardless, and the hook measures real rects either way.
    isLandscape ? keysPosition : 'bottom',
    NOTCH_PATH_ID,
    // Not read by the hook -- it re-runs the effect so the carve is re-measured
    // for the new box. Without it a bottom-keys deck rotates with no dep change.
    isLandscape,
    // Snaps the carve rather than morphing it while a skin change settles.
    // `imageSkin`, not `skin` -- the second cluster resize hangs off THAT value
    // and flips a frame late, outside a skin-id-keyed window.
    `${skin}:${imageSkin}`
  )

  // The off-hand corner's bite: the SAME hook with handedness inverted, no new
  // geometry. Needs its OWN pathId -- the tween writes via getElementById, so a
  // shared id makes one corner wear the other's shape.
  const notchPathB = useNotchPath(
    trackpadRef,
    keyGridRefB,
    iconRowRefB,
    handedness === 'right' ? 'left' : 'right',
    isLandscape ? keysPosition : 'bottom',
    NOTCH_PATH_B_ID,
    isLandscape,
    `${skin}:${imageSkin}`
  )

  // A voice call has no video track, so MirrorPane would render a black box
  // with a zoom bar and a stats overlay on top of it. Branched here rather than
  // inside MirrorPane because ending the call is `toggleMirror`, which is in
  // scope here and is not a MirrorPane prop.
  const voiceCall = mirrorMode === 'audio'
  const voiceCallPane = (
    <VoiceCallPane
      connected={mirrorActive}
      micOn={micOn}
      onMicChange={onMicChange}
      onEnd={() => toggleMirror(false)}
      micStreamRef={phoneMicStreamRef}
    />
  )

  // One element value, not a component: three surfaces can host the picture and
  // exactly one may mount it at a time, so they share this rather than each
  // spelling the prop list out. Declaring it as a local COMPONENT would give it
  // a fresh type identity every render, which unmounts the <video> and drops the
  // stream -- the same single-videoRef trap the mount gates exist for.
  const onHomePad = mirrorOn && !deckOpen && !sessionDetailOpen
  useEffect(() => {
    if (onHomePad && touchModeLocked) onToggleTouchModeLock()
  }, [onHomePad, touchModeLocked, onToggleTouchModeLock])

  const screenShareLayout = useScreenShareLayout()
  const fullScreenShare =
    onHomePad && !voiceCall && !cursorless && !chatOpen && !codeOpen && screenShareLayout !== 'trackpad'

  const overlayMirror = (
    <MirrorPane
      videoRef={videoRef}
      mirrorPaneRef={mirrorPaneRef}
      mirrorActive={mirrorActive}
      mirrorMode={mirrorMode}
      mirrorZoom={mirrorZoom}
      mirrorPaneHeight={mirrorPaneHeight}
      mirrorPlacement={mirrorPlacement}
      isLandscape={isLandscape}
      fullMirror={fullMirror}
      onMirrorLoadedMetadata={onMirrorLoadedMetadata}
      shareAudio={shareAudio}
      onShareAudioChange={onShareAudioChange}
      systemVolume={systemVolume}
      onSystemVolumeChange={onSystemVolumeChange}
      onRequestSystemVolume={onRequestSystemVolume}
      micOn={micOn}
      onMicChange={onMicChange}
      phoneMicStreamRef={phoneMicStreamRef}
      touchModeActive={touchModeActive}
      touchModeLocked={touchModeLocked}
      onToggleTouchModeLock={onToggleTouchModeLock}
      showTouchMode={false}
      showCursorControl
      zoomFollowLocked={zoomFollowLocked}
      zoomFollowToast={zoomFollowToast}
      benchSummary={benchSummary}
      benchEstimateKbps={benchEstimateKbps}
      benchCode={benchCode}
      rigStatus={rigStatus}
      appContext={appContext}
    />
  )

  const controlIsland = (open = islandOpen): React.JSX.Element => (
    <DeckControlIsland
      open={open}
      pressKey={pressKey}
      openKeyboard={openKeyboard}
      recording={recording}
      micLatched={micLatched}
      micSidePress={micSidePress}
      micStreamRef={micStreamRef}
      chatOpen={chatOpen}
      handsFree={handsFree}
      handsFreeSpeaking={handsFreeSpeaking}
      micRef={micRef}
      toggleAppSwitcher={toggleAppSwitcher}
      appSwitchOpen={appSwitchOpen}
      quickSwitchTap={quickSwitchTap}
      quickSteps={quickSteps}
      settingsOpen={settingsOpen}
      setSettingsOpen={(fn) => {
        setHistoryOpen(() => false)
        setSettingsOpen(fn)
      }}
      openWindowLayouts={openWindowLayouts}
    />
  )

  const appDeck = nativeBridge.canHideDeck()
  const advanced = firstSteps?.advanced === true
  useEffect(() => {
    if (firstSteps) nativeBridge.advancedMode(advanced)
  }, [firstSteps, advanced])
  const lastAiMode = useRef<'chat' | 'code'>('chat')
  useEffect(() => {
    if (chatOpen) lastAiMode.current = 'chat'
    else if (codeOpen) lastAiMode.current = 'code'
  }, [chatOpen, codeOpen])
  const codeProps: CodeProps = {
    onDeckOpenChange: setDeckOpen,
    onSessionDetailOpenChange: setSessionDetailOpen,
    deckScreen: {
      on: mirrorOn,
      // The button owns the STREAM and nothing else -- gated on
      // touchModeLocked it flipped an invisible flag while mirrorOn stayed
      // false and nothing rendered. How a finger behaves on the picture
      // stays where it was: the gesture and the snackbar.
      onToggle: () => toggleMirror(!mirrorOn),
      // Same single stream as the trackpad's: MirrorPane takes the videoRef
      // useMirror already owns. Gated on deckOpen because the trackpad's own
      // mount is gated on !deckOpen -- exactly one of the two exists at any
      // moment, or they fight over that one ref.
      // Only when the deck is the top surface: an agent sheet portals over
      // it and takes the picture with it.
      pane:
        mirrorOn && deckOpen && !sessionDetailOpen
          ? voiceCall
            ? voiceCallPane
            : overlayMirror
          : undefined,
      zoomed: sessionZoomed,
      onZoom: onSessionZoom
    },
    deckIsland: {
      on: islandOpen,
      onToggle: () =>
        setIslandOpen((v) => {
          writeIslandOpen(!v)
          return !v
        }),
      // Built here, where every control handler already lives, and handed
      // down as a node -- the same shape `deckScreen.pane` uses. Gated on
      // deckOpen so its mic is not a second node for use-dictation to bind
      // while the trackpad's own is on screen.
      node: deckOpen && !sessionDetailOpen && islandOpen ? controlIsland() : undefined
    },
    sessionScreen: {
      on: mirrorOn,
      aspect:
        videoRef.current?.videoWidth && videoRef.current?.videoHeight
          ? videoRef.current.videoWidth / videoRef.current.videoHeight
          : 16 / 9,
      onToggle: () => {
        if (!mirrorOn) {
          writeIslandOpen(true)
          setIslandOpen(true)
        }
        toggleMirror(!mirrorOn)
      },
      pane:
        mirrorOn && sessionDetailOpen ? (voiceCall ? voiceCallPane : overlayMirror) : undefined,
      controls:
        sessionDetailOpen && mirrorOn && (mirrorActive || voiceCall) && !settingsOpen
          ? controlIsland(true)
          : undefined
    },
    open: codeOpen,
    pending: relayPending,
    resolved: relayResolved,
    dismissed: relayDismissed,
    linkOk: relayLinkOk,
    status: relayStatus ?? undefined,
    refusal: relayRefusal,
    focusedRequestId: focusedRelayRequestId,
    onFocusedRequestConsumed: onFocusedRelayRequestConsumed,
    onTapMissed: onRelayTapMissed,
    onTapTrace: onRelayTapTrace,
    onRespond: onRelayRespond,
    onUndismiss: onRelayUndismiss,
    sessionPreviews,
    sessionSent,
    onSessionSentGet,
    sessionSuggestions,
    onRequestSuggestions,
    sessionPreviewAges,
    sessionPeekOutcome,
    onSessionPeek,
    onSessionReply,
    onSessionStop,
    onSessionAttach,
    onSessionGoTo,
    onSessionZoom,
    sessionZoomed,
    sessionGoToFailed,
    sessionRevealedAt,
    sessionArchiveSink: {
      mark: (session, change) => send({ type: 'sessionMark', session, change }),
      importLegacy: (entries) => send({ type: 'sessionArchiveImport', entries })
    },
    // A live mirror is never restarted, the sheet simply closes onto the
    // picture already running.
    onOpenScreen: () => {
      if (mirrorOn) return
      writeIslandOpen(true)
      setIslandOpen(true)
      toggleMirror(true)
    },
    mirrorOn,
    pushFilter: relayPushFilter,
    notifyLevel: relayNotifyLevel,
    turnEndPing: relayTurnEndPing,
    onSetPush: onSetRelayPush,
    onSetNotifyLevel: onSetRelayNotifyLevel,
    onSetTurnEndPing: onSetRelayTurnEndPing,
    onRequestPushFilter: onRequestRelayPush,
    sessionMic,
    onClose: onCloseCode,
    imageSrc: relayImageSrc,
    onPickPhoto: onRelayPickPhoto
  }

  return (
    <div
      className="proRoot"
      ref={rootRef}
      /* Skins' tokens are designed over the LIGHT base, so they pin the theme
         until a dark variant exists (Settings hides the theme row for them).
         data-skin is the orthogonal paint axis to this component's layout. */
      data-theme={isLightPinnedSkin(skin) ? 'light' : colorScheme}
      /* 'default' means plain pro: emit NO attribute so only the base cascade
         applies. An attribute of "default" would need a CSS block to match it,
         which is exactly the unstyled state the base already is. */
      data-skin={skin === 'default' ? undefined : skin}
      /* Opts into theme.css's IMAGE SKINS block, which REMOVES the sculpt so a
         picture stands alone. MUST stay absent on sculpted skins -- those
         teardown rules carry no token, so this selector is the only guard. */
      data-img-skin={imageSkin ? '' : undefined}
      data-hand={handedness}
      data-orient={isLandscape ? 'landscape' : 'portrait'}
      /* Vertical twin of data-hand. Landscape-only: portrait deliberately gets
         no choice (DESIGN.md -- one way to do a thing). */
      data-vpos={keysPosition}
      /* Landscape-only third axis beside data-hand and data-vpos: one cluster
         or two. Absent in portrait/stacked, so only the split CSS block needs
         a selector and every shipped rule stays untouched by default. */
      data-deck={splitDeck ? 'split' : undefined}
      data-split={splitDeck ? splitConcept : undefined}
      /* Lets CSS reclaim the mirror's vertical space for the touchpad when
         screen sharing is off -- same hook pattern as data-orient. */
      data-mirror={mirrorOn ? 'on' : 'off'}
      /* Where the pane sits, portrait only. Absent for 'stacked' (same rule as
         data-deck above), so the shipped layout stays the untouched base
         cascade and a bug in the other three cannot reach anyone. */
      data-mirror-placement={padStacksBelowMirror ? undefined : mirrorPlacement}
      /* Outranks data-mirror-placement: on a cursorless host the picture owns
         the whole HUD, whichever placement the pref happens to hold. */
      data-mirror-full={fullMirror.active ? 'on' : undefined}
      data-ai-menu=""
      data-app-deck={appDeck ? '' : undefined}
      /* The durable SETTING, never "the ring is up right now" -- the far skin
         corner resizes off this, and a live value would move it mid-gesture. */
      data-app-ring={appRing ? 'on' : undefined}
      /* Live "finger is on the band". Safe to key on ONLY because its one
         consumer moves no geometry (it drops the camera PiP behind the popout). */
      data-ring-live={ring.activeSlot !== null ? 'on' : undefined}
      style={
        badgesRideZoomBar ? ({ '--pro-glass-lift': `${glassLift}px` } as CSSProperties) : undefined
      }
    >
      <div className="proBlobs" aria-hidden="true" />

      <div className="status proStatus">
        <span className={`statusDot ${connState.kind}`} aria-hidden="true" />
        {/* Debug mode swaps connection state for measured layer heights, tap to
            copy the full dump. The handler MUST sit on this span, not the parent
            .proStatus -- that parent is `pointer-events: none` so taps reach the
            pad, and only its element children re-enable them. */}
        {debugLayout ? (
          <span
            className="debugCopy"
            onClick={() => {
              // Called synchronously inside the tap: iOS only honours a copy
              // that happens in the gesture's own call stack.
              const ok = copyDebugReport()
              setCopied(ok ? 'copied' : 'copy failed')
              window.setTimeout(() => setCopied(null), COPY_FEEDBACK_MS)
            }}
          >
            {copied ?? `${measureLayers()} ⧉`}
          </span>
        ) : (
          status
        )}
      </div>
      {advanced && (
        <Button
          variant="bare"
          type="button"
          className="remoteMenuBtn"
          data-nav-group="chrome"
          data-nav-order="4"
          aria-label={appDeck ? 'Back to chat' : 'Back to chats and agents'}
          onClick={() => {
            setSettingsOpen(() => false)
            setHistoryOpen(() => false)
            if (appDeck) nativeBridge.hideDeck()
            else if (relayPending.length > 0 || lastAiMode.current === 'code') onToggleCode()
            else onToggleChat()
          }}
        >
          <ChevronLeft size={22} strokeWidth={2.5} />
          {!appDeck && relayPending.length > 0 && <span className="codeBtnDot" />}
        </Button>
      )}
      <BrandWatermark onPress={onToggleReferral} navGroup="chrome" navOrder={3} />
      {appDeck && (
        <Button
          variant="bare"
          type="button"
          className={`screenShareBtn${mirrorOn ? ' on' : ''}`}
          aria-label={mirrorOn ? 'Hide the Mac screen' : 'Show the Mac screen here'}
          aria-pressed={mirrorOn}
          onPointerDown={(e) => {
            e.preventDefault()
            hapticTick()
            toggleMirror(!mirrorOn)
          }}
        >
          {mirrorOn ? (
            <MonitorX size={17} strokeWidth={2.5} />
          ) : (
            <MonitorUp size={17} strokeWidth={2.5} />
          )}
        </Button>
      )}

      <Button
        variant="bare"
        className={`historyBtn${historyOpen ? ' open' : ''}`}
        data-nav-order="1"
        data-nav-group="chrome"
        onClick={() => {
          setSettingsOpen(() => false)
          if (chatOpen) onCloseChat()
          setHistoryOpen((v) => !v)
        }}
        aria-label={historyFiltering ? 'History (filtered)' : 'History'}
      >
        <History size={19} strokeWidth={2.25} />
        <span className="proBtnLabel">History</span>
        {historyFiltering && <span className="historyBtnDot" />}
      </Button>

      {advanced && (
        <AiRoot
          code={codeProps}
          ai={ai}
          onOpenCode={onToggleCode}
          alertsAsk={alertsAsk}
          onOpenNotes={() => setHistoryOpen(() => true)}
          onOpenSettings={() => {
            setHistoryOpen(() => false)
            setSettingsOpen(() => true)
          }}
          macName={macName}
          firstSteps={firstSteps}
          send={send}
          chat={{
            open: chatOpen,
            sessions: chatSessions,
            thread: chatThread,
            busy: chatBusy,
            steps: chatSteps,
            streamed: chatStreamed,
            onEnter: onToggleChat,
            onExit: onCloseChat,
            onOpenSession: onChatOpenSession,
            onNewSession: onChatNewSession,
            onSend: onChatSend,
            onStop: onStopChat,
            thoughtRecording,
            mic: {
              onMicDown: onChatMicDown,
              onMicUp: onChatMicUp,
              dictating: chatDictating,
              recording: chatRecording,
              micStreamRef,
              draftPatch: chatDraftPatch,
              onDraftConsumed: onChatDraftConsumed
            }
          }}
        />
      )}

      {fullScreenShare && screenShareLayout === 'mac' && (
        <div className="ai">
          <MacLookView
            pane={overlayMirror}
            device={hostDevice}
            macName={macName}
            isLandscape={isLandscape}
            mic={{
              recording,
              micLatched,
              handsFree,
              handsFreeSpeaking,
              micStreamRef,
              handsFreeStreamRef,
              micSidePress,
              disarmHandsFree
            }}
            layoutId={virtualKeyboardLayoutId}
            send={send}
            onStop={() => toggleMirror(false)}
            onOpenSettings={() => {
              setHistoryOpen(() => false)
              setSettingsOpen(() => true)
            }}
            onChar={onVirtualKeyboardChar}
            onBackspace={onVirtualKeyboardBackspace}
            onSpecialKey={onVirtualKeyboardSpecialKey}
            onCombo={onVirtualKeyboardCombo}
          />
        </div>
      )}
      {fullScreenShare && screenShareLayout !== 'mac' && (
        <div className="ai">
          <ScreenView
            stop
            pane={overlayMirror}
            controls={settingsOpen || !mirrorActive ? undefined : controlIsland(true)}
            macName={macName}
            send={send}
            onBack={() => toggleMirror(false)}
          />
        </div>
      )}

      <HistorySheet
        open={historyOpen}
        entries={dictations}
        hasMore={historyHasMore}
        loadingMore={historyLoadingMore}
        onLoadMore={onLoadMoreHistory}
        onClose={() => setHistoryOpen(() => false)}
        onPaste={onPasteDictation}
        onAct={onActDictation}
        highlightId={highlightHistoryId}
        onFilterChange={setHistoryFiltering}
      />

      <ActProgressSheet
        open={actProgressOpen}
        instruction={actInstruction}
        steps={actSteps}
        onHide={onHideActProgress}
        onStop={onStopActProgress}
      />

      <ReferralSheet
        open={referralOpen}
        link={referralLink}
        code={referralCode}
        referredCount={referredCount}
        error={referralError}
        inviteState={inviteState}
        onSendInvite={onSendInvite}
        onRetry={onRetryReferral}
        onClose={onCloseReferral}
      />

      <KeyboardAccessoryBar
        open={nativeKeyboardOpen}
        onSwitchToVirtual={onSwitchToVirtualKeyboard}
        appContext={appContext}
        clipboardHasContent={clipboardHasContent}
        onPasteClipboard={onPasteClipboard}
        onActivateItem={onActivateItem}
        onActivatePane={onActivatePane}
        onActivateGroup={onActivateGroup}
        onOpenAppSwitcher={toggleAppSwitcher}
        onSheetOpenChange={onBrowserSheetOpenChange}
        onBarTap={onBarTap}
        onTmuxAction={onTmuxAction}
      />

      <VirtualKeyboard
        open={virtualKeyboardOpen}
        onClose={onCloseVirtualKeyboard}
        onChar={onVirtualKeyboardChar}
        onBackspace={onVirtualKeyboardBackspace}
        onSpecialKey={onVirtualKeyboardSpecialKey}
        onCombo={onVirtualKeyboardCombo}
        onSwitchToNative={onSwitchToNativeKeyboard}
        layoutId={virtualKeyboardLayoutId}
        appContext={appContext}
        clipboardHasContent={clipboardHasContent}
        onPasteClipboard={onPasteClipboard}
        onActivateItem={onActivateItem}
        onActivatePane={onActivatePane}
        onActivateGroup={onActivateGroup}
        onOpenAppSwitcher={toggleAppSwitcher}
        onSheetOpenChange={onBrowserSheetOpenChange}
        onBarTap={onBarTap}
        onTmuxAction={onTmuxAction}
      />

      <div className="proCard">
        {mirrorOn && !deckOpen && !sessionDetailOpen && voiceCall && voiceCallPane}
        {mirrorOn && !deckOpen && !sessionDetailOpen && !voiceCall && !fullScreenShare && (
          <MirrorPane
            videoRef={videoRef}
            mirrorPaneRef={mirrorPaneRef}
            mirrorActive={mirrorActive}
            mirrorMode={mirrorMode}
            mirrorZoom={mirrorZoom}
            mirrorPaneHeight={mirrorPaneHeight}
            mirrorPlacement={mirrorPlacement}
            isLandscape={isLandscape}
            fullMirror={fullMirror}
            onMirrorLoadedMetadata={onMirrorLoadedMetadata}
            shareAudio={shareAudio}
            onShareAudioChange={onShareAudioChange}
            systemVolume={systemVolume}
            onSystemVolumeChange={onSystemVolumeChange}
            onRequestSystemVolume={onRequestSystemVolume}
            micOn={micOn}
            onMicChange={onMicChange}
            phoneMicStreamRef={phoneMicStreamRef}
            touchModeActive={touchModeActive}
            touchModeLocked={touchModeLocked}
            onToggleTouchModeLock={onToggleTouchModeLock}
            showTouchMode={false}
            onFullScreen={cursorless ? undefined : () => setScreenShareLayout('full')}
            zoomFollowLocked={zoomFollowLocked}
            zoomFollowToast={zoomFollowToast}
            benchSummary={benchSummary}
            benchEstimateKbps={benchEstimateKbps}
            benchCode={benchCode}
            rigStatus={rigStatus}
            appContext={appContext}
          />
        )}

        {/* Zoom bar rides directly under the video. Only once the stream is
            actually live -- a bar over a "Connecting mirror…" placeholder has
            nothing to zoom and reads as broken. Positioned from the pane's
            measured height for the same reason the touchpad is: the pane's
            height is aspect-derived at runtime, so no static offset works. */}
        {mirrorOn && mirrorActive && !isLandscape && (
          <div
            ref={setZoomBarNode}
            className={`proZoomBarWrap${badgesRideZoomBar ? ' withBadges' : ''}`}
            style={
              padStacksBelowMirror && mirrorPaneHeight && !fullMirror.active
                ? {
                    // --top-banner-h tracks .proMirrorPane, which this bar rides
                    // under: without it a banner moves the pane and leaves the
                    // bar behind, overlapping the video.
                    top: `calc(${CONFIG.PHONE_REMOTE.PRO_MIRROR_PANE_TOP} + ${mirrorPaneHeight}px + var(--top-banner-h, 0px))`
                  }
                : undefined
            }
          >
            {badgesRideZoomBar && (
              <>
                <MicInputBadge
                  micOn={micOn}
                  onMicChange={onMicChange}
                  micStreamRef={phoneMicStreamRef}
                />
                <MirrorAudioBadge
                  shareAudio={shareAudio}
                  onShareAudioChange={onShareAudioChange}
                  systemVolume={systemVolume}
                  onSystemVolumeChange={onSystemVolumeChange}
                  onRequestSystemVolume={onRequestSystemVolume}
                />
                <MirrorTouchModeBadge
                  active={touchModeActive}
                  locked={touchModeLocked}
                  onToggle={onToggleTouchModeLock}
                />
                {!cursorless && <MirrorFullScreenBadge onPress={() => setScreenShareLayout('full')} />}
              </>
            )}
            <ZoomBar
              scale={mirrorZoom.scale}
              onScaleChange={onZoomToScale}
              followLocked={zoomFollowLocked}
              onFollowLockedChange={onZoomFollowLockedChange}
              onDebugLog={onDebugLog}
            />
          </div>
        )}

        {/* Clip path for the touchpad's notch, computed at render time by
            useNotchPath from the REAL rects of the key grid + icon row (see
            that file for why: the two rows are different widths, so a fixed
            hand-authored curve can't hug both tightly). userSpaceOnUse in
            the touchpad's own pixel box, not objectBoundingBox -- the path
            is already built in absolute px to match measured rects. */}
        <svg width="0" height="0" aria-hidden="true" focusable="false">
          <defs>
            <clipPath id="proNotchDynamic" clipPathUnits="userSpaceOnUse">
              {/* Kept mounted once measured so the morph tween can write `d`
                  straight to this node (see useNotchPath) -- unmounting it
                  between shapes would drop the element mid-animation. */}
              {notchPath && <path id={NOTCH_PATH_ID} d={notchPath} />}
            </clipPath>
            {/* Split mode's second bite, INTERSECTED with the first by nesting:
                a clipPath carrying its own clip-path renders the overlap of the
                two, so the pad keeps only what both shapes agree on -- a bite
                out of each bottom corner, with the middle untouched.

                Intersection, not union: two <path> siblings inside ONE clipPath
                would UNION, and the union of two nearly-full-pad shapes is the
                whole pad (each path covers the corner the other bites out), so
                the notch would silently vanish. Verified against a hit-test
                before this shipped, not reasoned about.

                The pad points at proNotchSplit only while data-deck='split', so
                stacked mode never pays for the second clip. */}
            <clipPath
              id="proNotchSplit"
              clipPathUnits="userSpaceOnUse"
              clipPath="url(#proNotchDynamic)"
            >
              {notchPathB && <path id={NOTCH_PATH_B_ID} d={notchPathB} />}
            </clipPath>
          </defs>
        </svg>

        <div
          className={`proTouchpad${mirrorOn ? ' withMirror' : ''}${notchPath ? ' notchReady' : ''}`}
          ref={trackpadRef}
          style={
            // Portrait only -- landscape sits side by side, so this would offset
            // the pad by a height that isn't above it. The fallback covers the
            // toggle→loadedmetadata gap where mirrorPaneHeight is still null.
            padStacksBelowMirror && !isLandscape && mirrorOn
              ? {
                  top: `calc(${CONFIG.PHONE_REMOTE.PRO_MIRROR_PANE_TOP} + ${
                    (mirrorPaneHeight ?? CONFIG.PHONE_REMOTE.PRO_MIRROR_FALLBACK_HEIGHT) +
                    // The zoom bar sits between the two; only reserve its
                    // space once it's actually rendered (mirrorActive), or
                    // the touchpad floats away from a bar that isn't there.
                    (mirrorActive ? CONFIG.PHONE_REMOTE.PRO_ZOOM_BAR_HEIGHT : 0) +
                    CONFIG.PHONE_REMOTE.MIRROR_TRACKPAD_GAP
                  }px)`
                }
              : undefined
          }
        >
          {/* Rub-to-mirror's confirmation, a band flashing along the top the
              rub is read from. Keyed on the counter, never a boolean: React
              reuses the node otherwise and the animation only plays once. */}
          {rubPop > 0 && <div key={rubPop} className="proRubPop" aria-hidden="true" />}

          {/* Sits INSIDE the pad, not in the mirror block: a controller driving
              glasses has no mirror pane at all, so there is no picture to hang
              this off. Same trigger as the zoom track -- both answer "what is
              the viewer showing", and neither is meaningful without one. */}
          {zoomTrackOn && (
            <MirrorMinimap
              screenW={viewerScreenW}
              screenH={viewerScreenH}
              scale={zoomScale}
              centre={minimapCentre}
              onPan={onMinimapPan}
              hitRef={minimapHitRef}
            />
          )}

          {/* Edge treatment traced along the SAME measured notch path: a
              top-left-to-bottom-right sheen, an inset shadow (SVG filter --
              inverted alpha, blurred, recomposited inside the shape), and a
              hairline outline. box-shadow/border can't follow a clip-path,
              so the shape paints its own edges. */}
          {notchPath && (
            <svg className="proPadEdge" aria-hidden="true" focusable="false">
              <defs>
                <linearGradient id="proPadSheen" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" className="proPadSheenA" />
                  <stop offset="0.45" className="proPadSheenMid" />
                  <stop offset="1" className="proPadSheenB" />
                </linearGradient>
                <filter id="proPadInset" x="-20%" y="-20%" width="140%" height="140%">
                  <feComponentTransfer in="SourceAlpha">
                    <feFuncA type="table" tableValues="1 0" />
                  </feComponentTransfer>
                  <feGaussianBlur stdDeviation="6" />
                  <feOffset dx="0" dy="2" result="proPadInsetBlur" />
                  <feFlood className="proPadInsetFlood" />
                  <feComposite operator="in" in2="proPadInsetBlur" />
                  <feComposite operator="in" in2="SourceAlpha" />
                </filter>
              </defs>
              <path d={notchPath} fill="url(#proPadSheen)" />
              <path d={notchPath} fill="#000" filter="url(#proPadInset)" />
              <path d={notchPath} className="proPadEdgeLine" />
              {/* The second corner's edge. The sheen/inset fills are deliberately
                  NOT repeated for it -- they paint the whole pad face and a
                  second copy would double the shading. Only the hairline outline
                  is per-corner, and without this one the split pad reads as one
                  carved corner and one raw cut. The <svg> itself inherits the
                  pad's clip, so this path is trimmed to the visible shape. */}
              {splitDeck && notchPathB && <path d={notchPathB} className="proPadEdgeLine" />}
            </svg>
          )}
          {/* Lazy mode: the phone is lying on the desk being a record button.
              Carries .proMicBtn, so use-dictation's node-identity bind effect
              picks it up and it inherits the WHOLE recorder -- tap, hold, latch,
              Cancel/Stop -- instead of forking a second recording path. That is
              also why it has no onClick.

              A pad child, unlike .proAppRing/.proScrollRail: those are anchored
              to a corner, which is where the notch clip-path carves, and were
              trimmed away as pad children. Dead centre is nowhere near the
              carve. It does not suppress .proHint -- the hint hides itself on
              first touch, and until then "DRAG · TAP · SCROLL" is still true. */}
          {lazyMode && (
            <Button
              variant="bare"
              className={`proMicBtn proLazyMic${recording ? ' recording' : ''}`}
              data-nav-group="primary"
              aria-label={recording ? 'Tap to stop and send' : 'Tap to talk'}
            >
              <Mic size={64} strokeWidth={2} />
            </Button>
          )}
          {firstSteps?.show ? (
            <div className="proHint">
              <FirstSteps state={firstSteps} />
            </div>
          ) : (
            <div className={`proHint${touchDotActive || appSwitchOpen ? ' hidden' : ''}`}>
              <div className="proHintTitle">DRAG · TAP · SCROLL</div>
              <div className="proHintSub">
                Hold Settings to arrange windows.
              </div>
            </div>
          )}
          {/* One dot per finger. Keyed by the browser's touch identifier so a
              finger keeps its own node across moves -- keying by index would
              hand a lifted finger's node to a surviving one and make the dot
              jump across the pad instead of the other simply disappearing. */}
          {touchDots.map((d, i) => (
            <div
              key={d.id}
              className={`touchDot${touchDotActive ? ' active' : ''}${i > 0 ? ' secondary' : ''}`}
              style={{ left: d.x, top: d.y }}
            />
          ))}
          {/* Pointer drawn where the FINGER is on this phone -- same
              touchpad-local px the touch dot uses, no translation from the
              Mac's screen coordinates. */}
          {/* Trail first so the pointer paints over its own tail. */}
          {showCursor && <CursorTrail points={trail} now={trailNow} />}
          {showCursor && cursorPos && (
            <MacCursor
              x={cursorPos.x}
              y={cursorPos.y}
              visible={cursorVisible}
              style={cursorStyle}
            />
          )}
        </div>

        {/* The arc's HIT area, and a card-level sibling for the same reason the
            arc itself is: a clip-path removes hit-testing too, so listeners on
            the pad went dead over exactly the carved corner the band crosses.
            Only mounted with the ring, and only over the band's own bounding
            box -- see .proAppRingHit for why it can't span the card. */}
        {appRing && ring.hitBox && (
          <div className="proAppRingHit" ref={ringHitAreaRef} style={ring.hitBox} />
        )}

        {/* A CARD-level sibling, not a pad child. The pad's notch carve is a
            clip-path, which trims every descendant to the carved shape and
            erased the arc entirely -- it measured and painted correctly the
            whole time, just into a clipped-away region. */}
        {appRing && ring.anchor && ring.band && (
          <AppRing
            anchor={ring.anchor}
            band={ring.band}
            mirrored={handedness === 'left'}
            slots={ringSlotCount(appList?.length ?? 0)}
            activeSlot={ring.activeSlot}
            activeT={ring.activeT}
            apps={appList}
            debugZones={debugLayout}
          />
        )}

        {/* The zoom track, outside the ring and on the same centre. Card-level
            for the same clip-path reason, and gated on its OWN flag: it is live
            whenever a viewer has the picture, whether or not the switcher is
            on. No hit layer of its own -- it sits over live pad, so the pad's
            own radius test concedes it (see App.tsx's touchstart). */}
        {zoomTrackOn && ring.anchor && ring.zoomBand && (
          <RingZoomTrack
            anchor={ring.anchor}
            band={ring.zoomBand}
            mirrored={handedness === 'left'}
            scale={zoomScale}
            active={ring.zoomActive}
          />
        )}

        {/* The scroll rail's island. Card-level, on the HANDEDNESS edge: the
            same side as the cluster and the ring, filling the space ABOVE the
            buttons so the thumb never crosses the pad. Sharing the side is why
            the bottom is a measured inset rather than a CSS percentage -- the
            ring wins a contested touch (App.tsx checks it first). No auto-hide:
            the ✕ is the only way this closes. */}
        {rail.active && (
          <div
            ref={rail.islandRef}
            style={
              rail.bottomInset !== null
                ? ({ '--pro-rail-bottom': `${rail.bottomInset}px` } as CSSProperties)
                : undefined
            }
            className={`proScrollRail proScrollRail${rail.edge === 'left' ? 'Left' : 'Right'}${
              rail.axis === 'x' ? ' proScrollRailFlat' : ''
            }`}
          >
            <div className="proScrollRailGrip" aria-hidden="true" />
            {/* The knob rides the finger so a thumb on the strip can see the
                rail took it -- there is no cursor on the phone, so without
                this a held touch and a dead island look identical. Absolute,
                and OUT of the flex flow: laying it out between the grip and
                the ✕ would move both every time the thumb does. */}
            {rail.knob && (
              <div
                className={`proScrollRailKnob${rail.knob.rate ? ' isRate' : ''}`}
                style={{ '--pro-rail-knob-t': `${rail.knob.t * 100}%` } as CSSProperties}
                aria-hidden="true"
              >
                {rail.knob.dir === 'up' && <ChevronUp size={14} strokeWidth={3} />}
                {rail.knob.dir === 'down' && <ChevronDown size={14} strokeWidth={3} />}
              </div>
            )}
            <Button
              variant="bare"
              type="button"
              className="proScrollRailClose"
              aria-label="Close scroll bar"
              onPointerDown={(e) => {
                e.preventDefault()
                hapticTick()
                rail.dismiss()
              }}
            >
              <X size={14} strokeWidth={2.5} />
            </Button>
          </div>
        )}

        {/* Ring OFF: show where a finger has to trace to bring it back. Same
            gate as the dismiss wedge, so one switch explains both halves of
            the gesture -- hide here, unhide there. */}
        {!appRing && debugLayout && ring.anchor && ring.band && (
          <AppRingSummonZone
            anchor={ring.anchor}
            band={ring.band}
            mirrored={handedness === 'left'}
          />
        )}

        {/* STACKED (shipped): one cell, both rows, on the handedness side. */}
        {!splitDeck && (
          <div className="proControlsCell" ref={controlsCellRef}>
            <KeyPillGrid pressKey={pressKey} openKeyboard={openKeyboard} gridRef={keyGridRef} />
            <BottomIconRow
              recording={recording}
              handsFree={handsFree}
              handsFreeSpeaking={handsFreeSpeaking}
              micRef={micRef}
              toggleAppSwitcher={toggleAppSwitcher}
              appSwitchOpen={appSwitchOpen}
              quickSwitchTap={quickSwitchTap}
              quickSteps={quickSteps}
              settingsOpen={settingsOpen}
              setSettingsOpen={(fn) => {
                // Same one-sheet-at-a-time rule as the history button.
                setHistoryOpen(() => false)
                setSettingsOpen(fn)
              }}
              openWindowLayouts={openWindowLayouts}
              rowRef={iconRowRef}
            />
          </div>
        )}

        {/* SPLIT: one cell per thumb arc. Same two subcomponents, each given
            the half of its controls that belongs to that hand -- so every
            skin's markup, tokens and data-img hooks are the ones already
            shipped, and a skin needs no split-specific art.

            The division is by FREQUENCY, not by which row a control started in:
            the dominant thumb gets mic + keyboard + Enter, the off hand gets
            Esc/Tab and the two app-navigation icons. Splitting by original row
            was measured and rejected -- it leaves each row too long for its own
            arc and strands the same four controls the stacked deck does. */}
        {splitDeck && (
          <>
            <div className="proControlsCell proControlsCellPrimary" ref={controlsCellRef}>
              <KeyPillGrid
                pressKey={pressKey}
                openKeyboard={openKeyboard}
                gridRef={keyGridRef}
                only={split.primary.keys}
              />
              <BottomIconRow
                recording={recording}
                handsFree={handsFree}
                handsFreeSpeaking={handsFreeSpeaking}
                micRef={micRef}
                toggleAppSwitcher={toggleAppSwitcher}
                appSwitchOpen={appSwitchOpen}
                quickSwitchTap={quickSwitchTap}
                quickSteps={quickSteps}
                settingsOpen={settingsOpen}
                setSettingsOpen={(fn) => {
                  setHistoryOpen(() => false)
                  setSettingsOpen(fn)
                }}
                openWindowLayouts={openWindowLayouts}
                rowRef={iconRowRef}
                only={split.primary.icons}
              />
            </div>
            <div className="proControlsCell proControlsCellSecondary">
              <KeyPillGrid
                pressKey={pressKey}
                openKeyboard={openKeyboard}
                gridRef={keyGridRefB}
                only={split.secondary.keys}
              />
              <BottomIconRow
                recording={recording}
                handsFree={handsFree}
                handsFreeSpeaking={handsFreeSpeaking}
                micRef={micRef}
                toggleAppSwitcher={toggleAppSwitcher}
                appSwitchOpen={appSwitchOpen}
                quickSwitchTap={quickSwitchTap}
                quickSteps={quickSteps}
                settingsOpen={settingsOpen}
                setSettingsOpen={(fn) => {
                  setHistoryOpen(() => false)
                  setSettingsOpen(fn)
                }}
                openWindowLayouts={openWindowLayouts}
                rowRef={iconRowRefB}
                only={split.secondary.icons}
              />
            </div>
          </>
        )}
      </div>

      {/* AppContextBar's third host, parked just off the cluster's leading edge
          so tab/terminal switching is reachable with no keyboard up. Mounted
          AFTER the cluster cells so it paints over them if a rotation lands
          mid-measure.

          NOT suppressed while recording, unlike the overlay below. Cancel/Stop
          take the inner slots of the ICON ROW, at the very bottom of the
          cluster; this bar sits above the cluster's top row, so the two never
          share a band. Hiding it there just made the context you were dictating
          into vanish at the moment you were talking about it.

          No keyboard gate either -- floatingBarVisible already requires
          `mode === 'none'`, so either keyboard coming up unmounts this host. */}
      {floatingBarVisible(keyboardMode, appContext?.adapterId ?? null) && (
        <FloatingContextBar
          context={appContext}
          clusterRef={controlsCellRef}
          // Portrait collapses the cluster to the bottom whatever the pref says,
          // exactly as the notch carve reads it at line 592.
          keysPosition={isLandscape ? keysPosition : 'bottom'}
          isLandscape={isLandscape}
          // The arc's outer edge, so the bar parks above it instead of over the
          // icons. Card-local, like the anchor it comes from. Null whenever no
          // ring is painted, which restores the cluster-only rule exactly.
          ringClearanceTop={
            appRing && ring.anchor && ring.band ? ring.anchor.cy - ring.band.rMax : null
          }
          onActivateItem={onActivateItem}
          onActivatePane={onActivatePane}
          onActivateGroup={onActivateGroup}
          onSheetOpenChange={onBrowserSheetOpenChange}
          onTmuxAction={onTmuxAction}
          onBarTap={onBarTap}
          // The arc runs under this bar, so scrubbing the ring hides it rather
          // than picking apps blind behind the tab chips.
          dimmed={ring.activeSlot !== null}
          // TWO consumers now, so this is measured whenever the bar is up: the
          // glass block clears it from below, and the floating Paste button
          // stacks above it. Gated on badgesRideZoomBar it was null on every
          // non-glass deck, which is exactly where Paste needs the line most.
          onTopChange={setContextBarTop}
        />
      )}

      {/* Paste, topmost of the floating stack. Mounted after the context bar so
          a mid-measure frame paints it over the chips rather than under them.

          Gated only on the clipboard having something in it and no keyboard
          being up -- deliberately NOT on the ring or the context bar, so with
          both absent this is the one thing floating over the cluster. Both
          keyboards draw their own Paste, so the keyboard gate is what stops two
          from being on screen at once.

          Suppressed while recording for the same reason as the overlay below:
          Cancel/Stop own the band just above the icon row. */}
      {FLOATING_PASTE_ENABLED && clipboardHasContent && keyboardMode === 'none' && !recording && (
        <FloatingPasteButton
          clusterRef={controlsCellRef}
          keysPosition={isLandscape ? keysPosition : 'bottom'}
          isLandscape={isLandscape}
          ringClearanceTop={
            appRing && ring.anchor && ring.band ? ring.anchor.cy - ring.band.rMax : null
          }
          // Null whenever the context bar is not mounted, which restores the
          // cluster-only rule exactly -- the no-ring, no-bar case.
          floorTop={contextBarTop}
          onPaste={onPasteClipboard}
          dimmed={ring.activeSlot !== null}
        />
      )}

      {/* Suppressed while recording: the Cancel/Stop pair owns the space just
          above the icon row, and a burst preview is meaningless mid-recording
          anyway. Avoids stacking two fixed-position elements in one band. */}
      {!recording && (
        <QuickSwitchOverlay
          steps={quickSteps}
          apps={appList}
          anchor={quickAnchor}
          pinned={quickPinned}
          onPick={quickSwitchPick}
        />
      )}

      {/* Also gated on !chatOpen: this HUD and the composer mic share the SAME
          `recording` flag (one recorder, two entry points -- see App.tsx's
          micDestRef comment), so a chat-composer dictation used to pop this
          fixed Cancel/Stop/waveform trio up behind the chat sheet too -- a
          second, disconnected "recording" surface for the one already visible
          in the composer. The chat sheet's scrim (z-39) sits UNDER these
          buttons (z-40), so they weren't just redundant, they poked through
          and stayed tappable. chatOpen is sufficient rather than "is this
          recording actually the composer's": the scrim blocks the touchpad's
          own mic button while the sheet is open, so a live recording with
          chatOpen true can only be the composer's. */}
      {/* islandRecOwns: the island docks its OWN Cancel/Stop/waveform to the
          plate, so this fixed row would be a second, duplicate recording HUD
          at the screen bottom while the island holds the live one. */}
      {recording && !chatOpen && !codeOpen && !islandRecOwns && (
        <>
          {/* micLatched, not `recording`: these mount at the mic's own position,
              and `recording` flips the moment the mic opens -- which on a fast
              route is still mid-tap, so the pointerup's synthesized click landed
              on Cancel and discarded the clip. Latched means the finger is off. */}
          {micLatched && (
            <>
              <Button
                variant="bare"
                className="micSideBtn micCancel proMicSideBtn"
                onPointerDown={(e) => {
                  e.preventDefault()
                  micSidePress('cancel')
                }}
                aria-label="Cancel recording"
              >
                Cancel
              </Button>
              <Button
                variant="bare"
                className="micSideBtn micStop proMicSideBtn"
                onPointerDown={(e) => {
                  e.preventDefault()
                  micSidePress('stop')
                }}
                aria-label="Stop and send recording"
              >
                Stop
              </Button>
            </>
          )}
          {/* Lives in the ~100px dead zone between Cancel (50% - 76px) and
              Stop (50% + 76px), both 52px wide -- so it can't collide with
              either. Purely visual feedback that the mic is hearing you. */}
          <MicWaveform streamRef={micStreamRef} />
        </>
      )}

      {/* Stop DISARMS the mode, it does not end the clip: the VAD closes each
          utterance on silence by itself. !recording keeps this HUD out of the
          band the press-and-hold one above owns. */}
      {handsFreeSpeaking && !recording && !chatOpen && (
        <>
          <Button
            variant="bare"
            className="micSideBtn micStop proMicSideBtn"
            onClick={disarmHandsFree}
            aria-label="Stop hands-free dictation"
          >
            Stop
          </Button>
          <MicWaveform streamRef={handsFreeStreamRef} />
        </>
      )}

      {/* Deliberately occupies the band the waveform just vacated (same fixed
          bottom offset), so a slow transcribe reads as the mic handing off
          rather than as a new element appearing somewhere else. `recording` is
          already false by the time this can be true -- the two never overlap.
          Not gated on !chatOpen: the composer owns its own indicator and never
          sets this flag (see App.tsx's paste-vs-chat split on release). */}
      <TranscribePill
        className="proMicSideBtn"
        stage={transcribeStage}
        clipId={transcribing ? transcribeClipId : null}
        retryable={retryableClip}
        onCancel={cancelTranscribe}
        onRetry={retryTranscribe}
        onDismiss={dismissTranscribe}
      />

      {/* Tap-off dismiss for the switcher modal. Its OWN scrim, not the sheet
          band's -- this grid sits at the cluster tier, so a sheet-tier scrim
          paints over it instead of under it. Also stops a stray tap landing on
          the touchpad and moving the Mac cursor while you're only closing it. */}
      {appSwitchOpen && <div className="appSwitchScrim" onClick={toggleAppSwitcher} />}

      <div
        ref={appSwitchBarRef}
        data-sheet
        className={`appSwitchBar${appSwitchOpen ? ' open' : ''}`}
        style={{
          top: `${freeViewport.top + freeViewport.height / 2}px`,
          maxHeight: `${Math.max(0, freeViewport.height - FREE_VIEWPORT_MARGIN_PX * 2)}px`
        }}
      >
        <div className="windowLayoutHead">
          <span>Switch to</span>
          <Button variant="bare" className="windowLayoutClose" onClick={toggleAppSwitcher} aria-label="Close">
            <X size={18} />
          </Button>
        </div>
        <AppSwitchGrid
          apps={appList}
          frontBundleId={appContext?.bundleId || null}
          onPick={activateApp}
          onRetry={() => send({ type: 'appSwitchOpen' })}
        />
      </div>

      {/* Same scrim + free-viewport sizing as the switcher above: this sheet can
          also be open with a keyboard up, so it sizes against the free band and
          never `vh`. Unmounted rather than class-toggled -- unlike the switcher
          it holds slot state, and a stale pick should not survive a close. */}
      {windowLayoutOpen && <div className="appSwitchScrim" onClick={onCloseWindowLayouts} />}
      {windowLayoutOpen && (
        <div
          data-sheet
          className="appSwitchBar open"
          style={{
            top: `${freeViewport.top + freeViewport.height / 2}px`,
            maxHeight: `${Math.max(0, freeViewport.height - FREE_VIEWPORT_MARGIN_PX * 2)}px`
          }}
        >
          <WindowLayoutSheet
            apps={appList}
            frontBundleId={appContext?.bundleId || null}
            canRestore={canRestoreWindows}
            onApply={onApplyWindowLayout}
            onClose={onCloseWindowLayouts}
          />
        </div>
      )}

      {/* Visually hidden, not display:none -- an input needs real layout to
          receive focus and pop the phone's native keyboard on iOS Safari.
          Which is also why it must be DISABLED while the virtual board is up:
          a focusable field that summons the native keyboard is exactly what a
          closing dropdown restores focus to -- which is how tapping a cmux
          dropdown row used to swap the board out from under the user. */}
      <input
        ref={keyboardInputRef}
        className="keyboardInput"
        type="text"
        // Invisible but focusable, so in a swipe order it is a dead stop --
        // focus vanishes under the controls and the deck reads as "navigation
        // skips", and arrows then move the caret instead of the ring. -1 still
        // allows the programmatic .focus() that IS how iOS raises its keyboard,
        // so nothing is lost. Ungated: a host that resizes after load latched
        // `isPointerlessHost` false and put this stop back.
        tabIndex={-1}
        disabled={virtualKeyboardOpen}
        value={keyboardText}
        onChange={(e) => onKeyboardTextChange(e.target.value)}
        onKeyDown={(e) => {
          // preventDefault so iOS does not also insert a newline into our
          // buffer -- the Return already went to the Mac as a keypress, and a
          // local newline would come back through the diff as typed text.
          if (e.key === 'Enter') {
            e.preventDefault()
            onKeyboardEnter()
          }
        }}
        onFocus={onKeyboardInputFocus}
        onBlur={submitKeyboardText}
        enterKeyHint="enter"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />

      {/* Tap-anywhere-off dismiss. Stops a stray tap landing on the touchpad
          and moving the Mac's cursor while you're only trying to put the sheet
          away. */}
      {settingsOpen && (
        <div className="settingsScrim" onClick={() => setSettingsOpen(() => false)} />
      )}

      {/* data-sheet scopes arrow traversal to this panel -- without it a swipe
          inside Settings walks straight out onto the deck behind it. See
          scopeRoot() in arrow-focus-nav.ts. */}
      <div
        ref={settingsPanelRef}
        data-sheet
        className={`settingsPanel${settingsOpen ? ' open' : ''}`}
      >
        <PhoneRemoteTitleBar
          className="settingsHeader"
          title={<span className="settingsTitle">Settings</span>}
          actions={
            <Button
              variant="bare"
              className="settingsCloseBtn"
              type="button"
              aria-label="Close settings"
              onClick={() => setSettingsOpen(() => false)}
            >
              <X size={19} strokeWidth={2.25} />
            </Button>
          }
        />
        <SettingsBody
          onOpenDraw={() => {
            setSettingsOpen(() => false)
            setDrawOpen(true)
          }}
          sensitivity={sensitivity}
          hostCaps={hostCaps}
          onSensitivityChange={onSensitivityChange}
          cursorSize={cursorStyle.size}
          onCursorSizeChange={onCursorSizeChange}
          cursorAnimated={cursorStyle.animated}
          onCursorAnimatedChange={onCursorAnimatedChange}
          mirrorOn={mirrorOn}
          toggleMirror={toggleMirror}
          mirrorQuality={mirrorQuality}
          onMirrorQualityChange={onMirrorQualityChange}
          mirrorMode={mirrorMode}
          onMirrorModeChange={onMirrorModeChange}
          shareAudio={shareAudio}
          onShareAudioChange={onShareAudioChange}
          glassesAttached={zoomTrackOn}
          skin={skin}
          wornSkinLabel={wornSkinLabel}
          onSkinChange={onSkinChange}
          colorScheme={colorScheme}
          onColorSchemeChange={onColorSchemeChange}
          handedness={handedness}
          onHandednessChange={onHandednessChange}
          keysPosition={keysPosition}
          onKeysPositionChange={onKeysPositionChange}
          deckMode={deckMode}
          onDeckModeChange={onDeckModeChange}
          hostDevice={hostDevice}
          splitConcept={splitConcept}
          mirrorPlacement={mirrorPlacement}
          onMirrorPlacementChange={onMirrorPlacementChange}
          onSplitConceptChange={onSplitConceptChange}
          isLandscape={isLandscape}
          showCursor={showCursor}
          onShowCursorChange={onShowCursorChange}
          appRing={appRing}
          onAppRingChange={onAppRingChange}
          onCenterCursor={onCenterCursor}
          startChatGptVoiceWithMic={startChatGptVoiceWithMic}
          onPaired={onPaired}
          onDisconnect={onDisconnect}
          onOpenAlerts={() => {
            setSettingsOpen(() => false)
            if (!codeOpen && !chatOpen) onToggleCode()
            setAlertsAsk((n) => n + 1)
          }}
          env={env}
          onEnvChange={onEnvChange}
          sheetOpen={settingsOpen}
          onRequestClose={() => setSettingsOpen(() => false)}
          cameraOn={cameraOn}
          onCameraChange={onCameraChange}
          renderMarkup={renderMarkup}
          onRenderMarkupChange={onRenderMarkupChange}
        />
      </div>

      {/* Hidden skin quick-switch. The home-indicator band is the one strip of
          this screen with no touch target in it: .proTouchpad and
          .proControlsCell both stop at --pro-safe-bottom precisely so drags
          started down here aren't stolen by iOS's swipe-up. That makes it free
          real estate for a TAP, which the system gesture doesn't claim.

          Corners, not halves: a full-width pair would put a live target
          directly under the mic ball and the Esc pill, one slip away from a
          mis-drop changing your skin. The corners are the part of the band no
          control sits above.

          Deliberately invisible -- no label, no chrome. It's a hidden feature,
          and the skin itself changing IS the feedback.

          DOUBLE tap, not single: this band is where a thumb rests and where a
          mis-aimed reach for the mic lands, and a single tap would change the
          skin on both.

          pointerdown rather than onClick, same reason QuickSwitchOverlay's
          tiles use it: a click here has to survive iOS's synthetic-click path
          right at the screen edge, and pointerdown is the event that reliably
          arrives.

          Suppressed whenever a sheet is up: those render over the card, so a
          tap near the bottom edge belongs to the sheet, not to a control
          underneath it.

          Both corners survive the ring now. The arc's t=0 end terminates over
          the far corner and at z-index 13 that corner wins the touch, which is
          the ring's first icon -- so the corner SHRINKS to the strip below the
          band (data-app-ring, see .skinCornerPrev) rather than unmounting.
          Unmounting it is what silently killed skin switching for anyone with
          the ring on (37666ff2), twice; a target that moves out of the way
          keeps both features. */}
      {/* Not rendered at all on a cursorless host: both corners are driven by a
          DOUBLE-TAP on an invisible region, which a band that sends four arrows
          and a pinch cannot express. Skins are switchable from Settings. */}
      {!cursorless &&
        !settingsOpen &&
        !historyOpen &&
        !chatOpen &&
        !appSwitchOpen &&
        !recording && (
          <>
            <Button
              variant="bare"
              className="skinCorner skinCornerPrev"
              aria-label="Previous skin"
              // Out of the focus order on EVERY host, not just cursorless ones.
              // Both corners are invisible pointer-only targets driven by a
              // double-tap and act on pointerdown, never on click -- so focus can
              // land on them but can never activate them, on any host. They were
              // gated on `isPointerlessHost`, which is evaluated before first
              // paint and latches false whenever the host resizes after load;
              // that put two blank stops back in the swipe order, observed live
              // as ArrowDown landing on "Next skin".
              tabIndex={-1}
              aria-hidden
              onPointerDown={() => skinCornerTap(-1)}
            />
            <Button
              variant="bare"
              className="skinCorner skinCornerNext"
              aria-label="Next skin"
              tabIndex={-1}
              aria-hidden
              onPointerDown={() => skinCornerTap(1)}
            />
          </>
        )}

      {/* Root level, outside every surface gate: the pane is mounted by
          whichever of the three hosts is on screen, and all three can be gone
          while the call is still running. */}
      {voiceCall && mirrorOn && (
        <VoiceCallBanner
          micOn={micOn}
          connected={mirrorActive}
          onMicChange={onMicChange}
          onEnd={() => toggleMirror(false)}
        />
      )}

      <TranscriptToast
        text={toast}
        shown={toastShown}
        running={toastRunning}
        failed={toastFailed}
        offline={toastOffline}
        tappable={toastTappable}
        actArming={toastActArming}
        onTap={onToastTap}
        onHoldStart={onToastHoldStart}
        onHoldEnd={onToastHoldEnd}
      />
      {drawOpen &&
        createPortal(
          <DrawPage bus={bus} send={send} sendBinary={sendBinary} onClose={() => setDrawOpen(false)} />,
          document.body
        )}
    </div>
  )
}

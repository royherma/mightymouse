import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import { CONFIG } from '@shared/config'
import { PHONE_AUDIO_TO } from '@shared/types'

import {
  drivesCursor,
  isHeld,
  transition,
  type TouchMode,
  type TouchModeEvent
} from '../touch-mode'
import type { AppContext } from '@shared/app-context'
import type { HostCapabilities } from '@shared/phone-remote-protocol'
import { setNavTraceObserver, setNavTraceSink } from '../nav-trace'
import { setWidthProbeSink, probeGlobalCards } from '../width-probe'
import { bumpNavTick } from '../debug-layout'
import { formatCapReset, type RemoteCapState } from '@shared/phone-remote-limits'
import { micSourceForMirror } from '../hands-free-rules'
import { useCursorless, hostTag, isCursorless } from '../cursorless-host'
import { clampCoverPan, coverPanForCursor, coverPanStep } from '../cover-pan'
import { useFirstSteps } from '../FirstSteps'
import { capabilities } from '../host-capabilities'
import { useDelayedFlag } from '../useDelayedFlag'
import { useTopBannerOffset } from '../useTopBannerOffset'
import { runningLabel } from '../chat-steps'
import { nativeBridge, nativeMicClaimed, subscribeNativeIntent, subscribeNativeMicClaim } from '../native-bridge'
import { useConnection } from '../hooks/use-connection'
import { useDictation } from '../hooks/use-dictation'
import { useChat } from '../hooks/use-chat'
import { useRelay } from '../hooks/use-relay'
import { usePhotos } from './use-photos'
import { useActProgress } from '../hooks/use-act-progress'
import { useReferral } from '../hooks/use-referral'
import { useEnv } from '../hooks/use-env'
import { useApproval } from '../hooks/use-approval'
import { useKeyboard } from '../hooks/use-keyboard'
import { useLayoutPrefs } from '../hooks/use-layout-prefs'
import { useMedia } from '../hooks/use-media'
import { useNativeIntents } from '../hooks/use-native-intents'
import { useViewerControls } from '../hooks/use-viewer-controls'
import { useTrackpad } from '../hooks/use-trackpad'
import { BLOCKED_REASON_INFO } from '../../connection-state'
import { createSocketBus } from '../socket-bus'
import type { RingSummonHandle } from '../ring-summon'
import type { RailSummonHandle } from '../scroll-rail'
import type { RubHandle } from '../rub-toggle'
import { hapticTick, hapticDragRelease } from '../haptics'

// iOS-only, not in lib.dom.d.ts: true when launched standalone from the
// Home Screen icon (no Safari chrome, so no URL bar to tap a cert warning
// through -- this is exactly what Layer 4's stranded guard checks for).
declare global {
  interface Window {
    __MM_APP_CONTEXT__?: AppContext
  }
}

const RECONNECT_BANNER_DELAY_MS = 2500

import {
  MIRROR_MODE_DEFAULT,
  preferCodecOrder,
  qualityForHost,
  type MirrorMode,
  type MirrorQuality
} from '../mirror-quality'
import { useBench } from './use-bench'
import { useToast, TOAST_ACT_HOLD_MS } from './use-toast'
import { useAppSwitcher, useAppSwitcherState } from './use-app-switcher'
import { useMirrorPane } from './use-mirror-pane'
import { useMirrorGestures } from './use-mirror-gestures'
import { useMirrorDebugSinks } from './use-mirror-debug-sinks'
import { mirrorStatsOverlayEnabled } from '../mirror-stats-flag'
import { useAiSession } from '../ai/use-ai-session'
import { useScreenShareLayout } from '../screen-share-layout'

export function capToast(cap: RemoteCapState | null, now = Date.now()): string | null {
  if (!cap) return null
  const COPY = CONFIG.PHONE_REMOTE.LIMITS
  const resets = formatCapReset(cap.resetsAt, now)
  const when = resets ? `${COPY.RESETS_PREFIX} ${resets}.` : COPY.RESETS_UNKNOWN
  return `${COPY.LIMIT_TITLE[cap.reason]}. ${COPY.STILL_WORKS} ${when}`
}

export const PREVIEW_MODE =
  new URLSearchParams(window.location.search).get(CONFIG.PHONE_REMOTE.PREVIEW_PARAM) === '1' ||
  (window as Window & { __MM_PREVIEW__?: boolean }).__MM_PREVIEW__ === true

export interface AppProps {
  /** Retires the pre-React boot splash (index.html). Called once React has a
   *  frame of its own on screen, so the splash never uncovers a white page. */
  onReady?: () => void
}

export function useMirror({ onReady }: AppProps = {}) {
  const {
    connState,
    handoffLabel,
    conflict,
    reconnectAttempt,
    searching,
    tunnelReach,
    send,
    sendBinary,
    retryNow,
    forceRediscover,
    takeControl,
    role,
    viewer,
    disconnectNow: disconnectConnection,
    onMessage
  } = useConnection()
  const bus = useMemo(() => createSocketBus(), [])
  useEffect(() => onMessage((msg) => bus.dispatch(msg)), [onMessage])
  const ai = useAiSession({ bus, send, sendBinary })
  const [status, setStatus] = useState('Connecting…')
  // Mirrors the hook's state into the free-text status line the rest of the
  // app reads (mic states etc. also write it) -- connState.kind is the source
  // of truth, this is just its current English sentence.
  useEffect(() => {
    if (connState.kind === 'connected') setStatus('Live')
    else if (connState.kind === 'connecting')
      setStatus(searching ? 'Looking for your Mac…' : 'Connecting…')
    else if (connState.kind === 'blocked') setStatus(BLOCKED_REASON_INFO[connState.reason].summary)
    else if (connState.kind === 'awaitingApproval') setStatus('Waiting for approval…')
  }, [connState, searching])
  // First connect of this load only -- a mid-session drop must keep the deck
  // and show ReconnectBanner instead of yanking the user back to a splash.
  const [everConnected, setEverConnected] = useState(false)
  useEffect(() => {
    if (connState.kind === 'connected') setEverConnected(true)
  }, [connState])
  // Read by the native-event handler, which closes over the first render and
  // would otherwise see 'connecting' for the rest of the session. The offline
  // clip UI keys on this: a queued clip on a LIVE socket is an ordinary
  // recording that happens to take the queue path, not an offline one.
  const connectedRef = useRef(false)
  connectedRef.current = connState.kind === 'connected'
  const {
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
  } = useToast()
  const [settingsOpen, setSettingsOpen] = useState(false)
  useEffect(() => {
    onReady?.()
  }, [onReady])
  // Chat. A fresh session lands on the list; after that the sheet resumes
  // whatever thread you left open, since closing it is pocketing the phone,
  // not leaving the conversation.
  const [chatOpen, setChatOpen] = useState(false)
  // True from "composer mic released" until the transcript (or a failure) comes
  // back. Distinct from `recording`: the mic is already closed here, and what
  // the composer shows is a wait, not a live level meter.
  const [chatDictating, setChatDictating] = useState(false)
  const [codeOpen, setCodeOpen] = useState(false)
  // Off by default (PRD decision: opt-in, phone-side toggle). Quality flag
  // only matters once mirroring is on, but it's kept independent so choosing
  // native/capped doesn't itself start/stop the stream.
  const [mirrorOn, setMirrorOn] = useState(false)
  const [mirrorQuality, setMirrorQuality] = useState<MirrorQuality>('capped')
  // Mirror vs extended is deliberately NOT persisted: extended asks the Mac to
  // create a second display, so a fresh session should start in the harmless
  // mode rather than silently rearranging the user's desktop on connect.
  const [mirrorMode, setMirrorMode] = useState<MirrorMode>(MIRROR_MODE_DEFAULT)
  // The mirror SESSION: true from the track landing until the mirror is stopped
  // or errors out. A stalled picture does NOT clear it -- audio and PiP holds
  // key on this, and a 10ms frame gap must not tear down an audio session.
  const [mirrorActive, setMirrorActive] = useState(false)
  // The PICTURE, separately: false while a capture stall has outlived its
  // grace. Only the connecting overlay reads it.
  const [mirrorPictureLive, setMirrorPictureLive] = useState(false)
  // A capture stall recovers in ~10ms (macOS mutes the getDisplayMedia track on
  // app activation), so reacting to 'mirrorStalled' immediately flashed the
  // MirrorConnecting overlay on every app switch. Hold the overlay back until a
  // stall has outlived a recovery; every other picture writer clears this.
  const stallOverlayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearStallOverlayTimer = useCallback(() => {
    if (stallOverlayTimerRef.current === null) return
    clearTimeout(stallOverlayTimerRef.current)
    stallOverlayTimerRef.current = null
  }, [])
  // Pinch-to-zoom/pan on the mirror video -- pure client-side CSS transform,
  // doesn't touch the WebRTC stream or the trackpad's own gesture handling
  // (separate DOM subtree, see .mirrorPane vs .trackpad in theme.css).
  const [mirrorZoom, setMirrorZoom] = useState({ scale: 1, x: 0, y: 0 })
  const [zoomFollowLocked, setZoomFollowLocked] = useState(false)
  const zoomFollowLockedRef = useRef(false)
  // Transient confirmation pill for the toggle above. Separate from the lock
  // state itself because the pill must auto-rest while the lock stays on.
  const [zoomFollowToast, setZoomFollowToast] = useState(false)
  const zoomFollowToastTimerRef = useRef<number | null>(null)
  // One enum, one transition -- see touch-mode.ts for why this is not two
  // booleans. `active`/`locked` below are derived views for the pill and the
  // gesture layer, never independent state.
  const [touchMode, setTouchMode] = useState<TouchMode>('pan')
  const dispatchTouchMode = useCallback((event: TouchModeEvent) => {
    setTouchMode((s) => transition(s, event))
  }, [])
  const touchModeActive = drivesCursor(touchMode)
  const touchModeLocked = isHeld(touchMode)
  const touchModeActiveRef = useRef(false)
  useEffect(() => {
    touchModeActiveRef.current = touchModeActive
  }, [touchModeActive])
  const touchModeLockedRef = useRef(false)
  useEffect(() => {
    touchModeLockedRef.current = touchModeLocked
  }, [touchModeLocked])
  const touchModeRestTimerRef = useRef<number | null>(null)
  const mirrorPanHandoffRef = useRef<{
    suppress: () => void
    release: (clientX: number, clientY: number) => void
  } | null>(null)
  const {
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
  } = useLayoutPrefs({ send, onMessage })
  // Null until the Mac states it. NOT part of connState: the socket is healthy
  // here, so folding it into the connection machine would make a permission
  // problem retry a connection that was never broken.
  const [macControlBlocked, setMacControlBlocked] = useState(false)
  const [macAccountId, setMacAccountId] = useState<string | null>(null)
  // Away Mode notices ('covered' = the Mac's screen went black to the room,
  // 'ended' = someone touched the Mac and it relocked). Auto-hides; 'ended'
  // stays longer because it means the remote just lost the desktop.
  const [awayNotice, setAwayNotice] = useState<'covered' | 'ended' | null>(null)
  // The Mac's real macOS lock — the phone can't open it (Apple blocks it), so
  // this shows a persistent banner instead of a login window with no explanation.
  const [macLocked, setMacLocked] = useState(false)
  // What the host OS can do at all; null until the first hostStatus arrives.
  const [hostCaps, setHostCaps] = useState<HostCapabilities | null>(null)
  const [macName, setMacName] = useState<string | null>(null)
  // Publishes --top-banner-h so the header row and the pad drop below whichever
  // banner is up, instead of the banner painting over the Chat/History buttons.
  useTopBannerOffset(!PREVIEW_MODE)
  const awayNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showAwayNotice = (kind: 'covered' | 'ended'): void => {
    if (awayNoticeTimerRef.current) clearTimeout(awayNoticeTimerRef.current)
    setAwayNotice(kind)
    awayNoticeTimerRef.current = setTimeout(
      () => setAwayNotice(null),
      kind === 'covered' ? 6_000 : 12_000
    )
  }
  const ringClaimRef = useRef(false)
  const ringHitRef = useRef<((t: { clientX: number; clientY: number }) => boolean) | null>(null)
  // The zoom track's claim, same contract as ringHitRef and asked before it.
  const zoomHitRef = useRef<((t: { clientX: number; clientY: number }) => boolean) | null>(null)
  // The minimap's claim, same contract again. It MUST go through this ref and
  // not React's stopPropagation: the pad's gesture handler is a NATIVE listener
  // on the pad element, so by the time a synthetic event bubbles to the React
  // root the cursor has already moved. That is exactly the bug this fixes.
  const minimapHitRef = useRef<((t: { clientX: number; clientY: number }) => boolean) | null>(null)
  // Drives the summon gesture: while the ring is OFF, the pad feeds this every
  // touch so a finger tracing the band the ring would occupy can turn it on
  // mid-gesture. Null whenever there is nothing to summon.
  const ringSummonRef = useRef<RingSummonHandle | null>(null)
  // True only while a finger is actually ON the ring. Distinct from
  // ringClaimRef, which stays true after lift so the pad's touchend can read
  // it -- freezing the app list on that would freeze it forever.
  const ringDraggingRef = useRef(false)
  // Lets the pad push back a pending MRU refresh from inside a touch event,
  // where the callback itself is out of scope. Assigned once it is defined.
  const deferRingRefreshRef = useRef<(() => void) | null>(null)
  // Same, for the WS handler that stashes a refresh and must start the clock.
  const applyRingRefreshWhenIdleRef = useRef<(() => void) | null>(null)
  // Scroll rail: same shape as the ring's own claim/summon pair, one edge
  // strip instead of an arc. "Island is up" state lives inside useScrollRail
  // (TouchpadLayout), not here -- same split as the ring's own activeSlot.
  // `railClaimRef` stands the pad's handler down while the rail owns the
  // touch, mirroring ringClaimRef exactly.
  const railClaimRef = useRef(false)
  const railSummonRef = useRef<RailSummonHandle | null>(null)
  // Rub-to-mirror: a left-right-left scrub along the pad's top toggles screen
  // share. No claim ref beside it, unlike the ring and rail -- the rub never
  // takes the touch, so the cursor keeps moving through and past the toggle.
  const rubRef = useRef<RubHandle | null>(null)
  const micRef = useRef<HTMLButtonElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [paneNode, setPaneNode] = useState<HTMLDivElement | null>(null)
  const mirrorPaneRef = useMemo<MutableRefObject<HTMLDivElement | null>>(() => {
    let node: HTMLDivElement | null = null
    return {
      get current() {
        return node
      },
      set current(next) {
        node = next
        setPaneNode(next)
      }
    }
  }, [])
  const mirrorPcRef = useRef<RTCPeerConnection | null>(null)
  // The live mic track parked on the mirror's audio transceiver. Held in a ref
  // because muting is a track.enabled flip, not a React render.
  const micTrackRef = useRef<MediaStreamTrack | null>(null)
  // The same mic as a stream, for MicWaveform's analyser. Reusing the parked
  // stream matters on iOS: a second getUserMedia re-prompts and can interrupt
  // the live track.
  const phoneMicStreamRef = useRef<MediaStream | null>(null)
  // The mirror's audio transceiver, negotiated at mirror start and held so the
  // FIRST mic tap can replaceTrack onto its sender. The m-line exists from the
  // outset; only the track arrives late.
  const micTransceiverRef = useRef<RTCRtpTransceiver | null>(null)
  // Guards against a second getUserMedia while the permission prompt is still
  // up: on iOS a double-tap on the badge would otherwise open two streams.
  const micOpeningRef = useRef(false)
  // Resolver for the in-flight 'mirrorGetIceServers' round-trip. A ref, not
  // state, because the WS onmessage handler must reach the CURRENT waiter
  // without re-subscribing on every render.
  const pendingIceResolveRef = useRef<((servers: RTCIceServer[]) => void) | null>(null)
  // A start still waiting on ICE servers when a newer one began must not open a second mirror.
  const mirrorAttemptRef = useRef(0)
  // The last list the Mac sent, INCLUDING one that arrived too late to be used.
  // A late reply used to be dropped, so a retry re-ran the same slow round-trip
  // and timed out identically -- the glasses never got past a STUN-only attempt
  // (08-11). Holding it means the next attempt starts with the relay in hand.
  const lastIceServersRef = useRef<RTCIceServer[] | null>(null)
  const mirrorCapRef = useRef<RemoteCapState | null>(null)
  // Fires if the peer connection never reaches `connected`. Cleared on success
  // and on teardown. See MIRROR_CONNECT_TIMEOUT_MS for why a timeout is needed
  // at all (WebRTC can sit in `checking` indefinitely without ever failing).
  const mirrorConnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cursorPosRef = useRef<{ x: number; y: number } | null>(null)
  // zoomToScale + the live scale, held as refs so the cursorPos handler can
  // re-aim a follow-lock without re-subscribing the WS on every zoom change.
  const zoomToScaleRef = useRef<((scale: number) => void) | null>(null)
  // The controller's minimap, arriving here. Held as a ref for the same reason
  // zoomToScaleRef is: the WS handler is set up once and must not re-subscribe
  // every time the pan changes.
  const applyViewerPanRef = useRef<((x: number, y: number) => void) | null>(null)
  const mirrorZoomScaleRef = useRef(1)
  const mirrorZoomRef = useRef({ scale: 1, x: 0, y: 0 })
  const lastFollowLogAtRef = useRef(0)
  // The scale zoomToScale last settled on, so it can tell a real zoom CHANGE
  // from the many replays at an unchanged scale -- every cursor move re-runs it
  // at the same number, and treating those as a zoom would cancel a manual pan
  // on the very next mouse twitch.
  const userZoomBeforeRef = useRef(1)
  // The ring knob's setter, reached from the WS handler above the state it
  // writes. Same ref bridge as zoomToScaleRef, for the same reason: the handler
  // subscribes once and must not re-subscribe when the knob moves.
  const setRingZoomScaleValueRef = useRef<((scale: number) => void) | null>(null)
  // Set while applying a scale that ARRIVED from the controller, so zoomToScale
  // knows not to report it straight back. Without it every relayed zoom returns
  // as a change, the controller repaints and re-sends, and the dial oscillates
  // between the two ends for as long as the socket is up.
  const applyingRelayedZoomRef = useRef(false)
  // The zoom the USER asked for. On a cursorless host mirrorZoom.scale carries
  // the fill baseline folded in, so re-aiming a follow-lock must replay this
  // one -- feeding the effective scale back in would multiply the baseline
  // again on every cursor move and run the zoom away.
  const userZoomRef = useRef(1)
  // Where the glasses' D-pad has panned the view to, in screen px. Null means
  // "no manual pan" -- the view follows the Mac cursor, which is what a
  // cursorless host boots into. Set, it OUTRANKS cursor-follow: taking manual
  // control of the view is the user saying stop chasing the pointer.
  const manualPanRef = useRef<{ x: number; y: number } | null>(null)
  // Fade-out timer for the Show cursor overlay, restarted on every movement so
  // the cursor only fades once the Mac pointer has actually been still.

  useMirrorDebugSinks(send)

  // Same pipe, for any component that needs to report on-device gesture
  // behavior the Mac can actually read (grep the dev log for the prefix).
  // Tagged with the host type because the Mac cannot derive it: the glasses
  // identify as desktop Chrome, so a UA-based label in the dev log calls them a
  // laptop. detectCursorless() reads the live viewport, which is the one thing
  // the host can't misreport. Read per-call, not captured -- a host that sizes
  // its frame after load would otherwise latch the boot-time answer.
  const remoteLog = useCallback(
    (message: string) => send({ type: 'debugLog', message: `[${hostTag()}] ${message}` }),
    [send]
  )

  // Held in a ref so the trackpad effect can log without taking `remoteLog` as
  // a dep -- that would rebind every touch listener on each render, which is
  // exactly the kind of churn a gesture trace is meant to observe, not cause.
  const remoteLogRef = useRef(remoteLog)
  remoteLogRef.current = remoteLog

  // `stopMirror` is defined far below this socket handler, so it is reached
  // through a ref rather than by moving either one.
  const stopMirrorRef = useRef<(reason: string) => void>(() => {})

  // Arrow traversal is installed at boot, outside React, so it has no way to
  // reach this pipe on its own -- without the handoff the trace is trapped in
  // the page and can only leave by being read off the screen by hand.
  useEffect(() => {
    setNavTraceSink((line) => remoteLogRef.current(line))
    setNavTraceObserver(bumpNavTick)
    setWidthProbeSink((line) => remoteLogRef.current(line))
    // Which bundle this phone is actually RUNNING. Vite hashes the filename, so
    // the script src IS the build id -- without it, "did the phone reload after
    // the rebuild" stays a guess, which is what made a whole mic-tap diagnosis
    // unfalsifiable. Deferred because remoteLog drops on a socket that is not
    // OPEN yet, and mount always beats the connect.
    const bootLog = window.setTimeout(() => {
      const src = document.querySelector<HTMLScriptElement>('script[type=module]')?.src ?? '?'
      remoteLogRef.current(`boot bundle=${src.split('/').pop()}`)
    }, 4000)
    // Whole-document sweep on a timer: the SessionList-local probe measured a
    // display:none mount while the screen showed live cards, so the sweep runs
    // regardless of which component thinks it owns the visible list.
    const globalProbe = window.setInterval(() => probeGlobalCards(), 2000)
    return () => {
      setNavTraceSink(null)
      setNavTraceObserver(null)
      setWidthProbeSink(null)
      window.clearTimeout(bootLog)
      window.clearInterval(globalProbe)
    }
  }, [])

  // Which BUNDLE the device is actually running, stated once per connection.
  // The page is pre-built and mobile Safari caches it hard, so a stale bundle
  // is indistinguishable from a broken fix in every other trace -- both look
  // like "the code is right and the device disagrees". Logged from the socket
  // so it lands in the same dev log as the [nav] hops it has to be read beside.
  useEffect(() => {
    if (connState.kind !== 'connected') return
    remoteLogRef.current(`[build] ${__PHONE_REMOTE_BUILD__}`)
  }, [connState])

  // Undefined off the native shell, so the back arrow never renders where it
  // would go nowhere: in Safari or an installed PWA this page IS the app, and
  // the only "behind" it has is the Home Screen, which iOS already provides.
  const backToPairing = useMemo(
    () => (capabilities.shell === 'native' ? () => nativeBridge.exitToPairing() : undefined),
    []
  )

  const disconnectAndLeave = useMemo(
    () =>
      backToPairing &&
      (() => {
        disconnectConnection()
        backToPairing()
      }),
    [disconnectConnection, backToPairing]
  )

  const disconnectFromSettings =
    disconnectAndLeave ??
    (() => {
      disconnectConnection()
      location.assign(CONFIG.WEB_CHAT_URL)
    })

  // Non-connect message dispatch (chat, mirror, history, env-switch, ...).
  // useConnection() owns the socket and its own message types (takenOver);
  // everything else lands here via its onMessage passthrough.
  useEffect(
    () =>
      onMessage((msg) => {
        if (msg.type === 'mirrorAnswer') {
          mirrorPcRef.current?.setRemoteDescription({ type: 'answer', sdp: msg.sdp }).catch(() => {
            showToast('Mirror failed')
          })
        } else if (msg.type === 'mirrorIceCandidate') {
          mirrorPcRef.current
            ?.addIceCandidate({
              candidate: msg.candidate,
              sdpMid: msg.sdpMid ?? undefined,
              sdpMLineIndex: msg.sdpMLineIndex ?? undefined
            })
            .catch(() => {
              // A candidate arriving after the peer connection was already torn
              // down (mirror toggled off mid-negotiation) is safe to drop.
            })
        } else if (msg.type === 'mirrorIceServers') {
          // A ref, not state: read only when a connection attempt gives up, and a
          // re-render here would land mid-negotiation for a value nothing draws
          // until then. Absent `cap` clears it — the allowance came back.
          mirrorCapRef.current = msg.cap ?? null
          // Hands the list to whichever startMirror() call is waiting on it.
          const resolve = pendingIceResolveRef.current
          pendingIceResolveRef.current = null
          // waiting=false is the whole diagnostic: the Mac logs what it SENT and
          // the phone logs what it USED, and those disagreed with no round-trip
          // between them. Either this never arrives (reply lost) or it arrives
          // with nobody waiting (resolved early by the timeout, or arrived
          // before startMirror registered its resolver) -- three different bugs
          // that are indistinguishable from the Mac's side alone.
          {
            const list = (msg.iceServers ?? []) as RTCIceServer[]
            const creds = list.filter((s) => !!s?.credential).length
            // Keep a relay-bearing list even with nobody waiting: that IS the late
            // arrival, and the next attempt can start from it instead of STUN.
            if (creds > 0) lastIceServersRef.current = list
            remoteLog(
              `mirrorIceServers rx n=${list.length} creds=${creds} waiting=${!!resolve} cap=${msg.cap?.reason ?? 'none'}`
            )
          }
          // `unknown[]` on the wire: the shared protocol file must not name a
          // DOM-only type like RTCIceServer, so the cast lands here, on the one
          // side that has a DOM.
          resolve?.(msg.iceServers as RTCIceServer[])
        } else if (msg.type === 'mirrorError') {
          if (mirrorConnectTimerRef.current) {
            clearTimeout(mirrorConnectTimerRef.current)
            mirrorConnectTimerRef.current = null
          }
          mirrorPcRef.current?.close()
          mirrorPcRef.current = null
          if (videoRef.current) videoRef.current.srcObject = null
          clearStallOverlayTimer()
          setMirrorOn(false)
          setMirrorActive(false)
          setMirrorPictureLive(false)
          setMirrorPaneHeight(null)
          showToast('Mirror: ' + msg.reason)
        } else if (msg.type === 'mirrorAudioError') {
          // Video keeps running -- only the audio toggle resets. The pref goes
          // back too, or the next mirrorStart re-requests audio that already
          // failed and toasts again on every restart.
          setShareAudioPref(false)
          showToast('Computer audio: ' + msg.reason)
        } else if (msg.type === 'mirrorStalled') {
          // Only the PICTURE drops -- the peer connection, mirrorOn and the
          // mirror session are untouched, so the audio session and PiP holds
          // survive a stall. This used to clear `mirrorActive`, which cascaded
          // through the audio/PiP effect cleanups and deactivated the audio
          // session on every stall: that is why a backgrounded mirror in PiP
          // played silent. Deferred: a recovery inside the grace window paints
          // nothing at all, leaving the last frame up for the ~10ms gap.
          if (stallOverlayTimerRef.current === null) {
            stallOverlayTimerRef.current = setTimeout(() => {
              stallOverlayTimerRef.current = null
              remoteLog('mirror stall grace expired -- overlay back')
              setMirrorPictureLive(false)
            }, CONFIG.PHONE_REMOTE.MIRROR_STALL_OVERLAY_GRACE_MS)
          }
        } else if (msg.type === 'voiceCallEnded') {
          // Siri ended the call on the Mac. Tearing the session down is what
          // releases the mic track and the iOS audio hold with it -- otherwise
          // the phone keeps listening to a call that no longer exists.
          stopMirrorRef.current('voiceCallEnded')
          // Only the never-started case carries one. A call that ran and ended
          // needs no toast -- the user is the one who ended it.
          if (msg.reason) showToast(msg.reason)
        } else if (msg.type === 'mirrorRecovered') {
          clearStallOverlayTimer()
          setMirrorPictureLive(true)
        } else if (msg.type === 'mirrorSwitchProbe') {
          // Echo the id back on the next PAINTED frame, so the Mac can measure
          // how long its app switch took to appear here.
          //
          // requestVideoFrameCallback, not a timer or an event: it fires when a
          // frame has actually been composited for display, which is the only
          // thing the user's complaint is about. `framesDecoded` would answer
          // too early (decoded is not painted) and a rAF answers on the next
          // repaint whether or not a new frame arrived, which on a static screen
          // is immediately -- reporting ~16ms for a switch that has not shown up.
          //
          // No fallback when the API is missing (older WebKit): a silent probe
          // reports nothing, which the Mac already treats as unanswered. Faking
          // the number with a timer would be worse than having none.
          const v = videoRef.current
          const probeId = msg.id
          if (v && typeof v.requestVideoFrameCallback === 'function') {
            v.requestVideoFrameCallback(() => {
              send({ type: 'mirrorDiag', detail: `switch-painted ${probeId}` })
            })
          }
        } else if (msg.type === 'mirrorViewerZoom') {
          // The controller's thumb, arriving on the device that has the
          // picture. zoomToScale is the single writer -- it clamps, sets
          // userZoomRef, and re-aims the pan -- so this hands it the scale
          // and nothing else. The Mac relays only to a viewer, so a phone
          // driving its own zoom never receives its own message back.
          // Flagged so zoomToScale does not echo the controller's own number
          // back. Cleared in a finally -- zoomToScale can bail early, and a
          // stuck flag mutes every later real zoom on this device.
          applyingRelayedZoomRef.current = true
          try {
            zoomToScaleRef.current?.(msg.scale)
          } finally {
            applyingRelayedZoomRef.current = false
          }
        } else if (msg.type === 'mirrorViewerZoomRequest') {
          // A controller just attached and wants the zoom this device is at.
          // Answered straight off userZoomRef rather than by re-running
          // zoomToScale: nothing is changing here, and zoomToScale only reports
          // on a CHANGE, so routing the answer through it would send nothing.
          send({ type: 'mirrorViewerZoomChanged', scale: userZoomRef.current })
        } else if (msg.type === 'mirrorViewerZoomChanged') {
          // The glasses turned the dial. Repaint the ring knob to match; this
          // is a report of something already applied there, so it must NOT be
          // relayed onward -- that is the echo loop from the other side.
          setRingZoomScaleValueRef.current?.(msg.scale)
        } else if (msg.type === 'mirrorViewerPan') {
          // The controller's minimap drag. Same one-way contract as the zoom
          // above: the phone decided where to look, this device just obeys and
          // never reports a pan back.
          applyViewerPanRef.current?.(msg.x, msg.y)
        } else if (msg.type === 'pipStreamConfig') {
          // Straight through: only Swift can decode what follows, and this page
          // keeps no state about a picture it never draws.
          nativeBridge.pipConfig(msg.width, msg.height, msg.frameRate)
        } else if (msg.type === 'pipAudioConfig') {
          nativeBridge.pipAudioConfig(msg.sampleRate, msg.channels)
        } else if (msg.type === 'pipStreamEnded') {
          nativeBridge.pipEnded(msg.reason)
          // The Mac's capture is gone, so the mirror is over -- closing only the
          // PiP window would leave `mirrorActive` true over a dead stream, which
          // holds the audio session and never fires the cleanup that releases it.
          stopMirrorRef.current('pipStreamEnded')
        } else if (msg.type === 'cursorPos') {
          cursorPosRef.current = { x: msg.x, y: msg.y }
          // Throttled: cursorPos fires at CURSOR_STREAM_POLL_MS while the mouse
          // moves, and one line per tick buries the log it is meant to explain.
          const now = Date.now()
          if (isCursorless() && now - lastFollowLogAtRef.current > 1000) {
            lastFollowLogAtRef.current = now
            remoteLogRef.current(
              `mirror follow cur=${msg.x.toFixed(2)},${msg.y.toFixed(2)}` +
                ` locked=${zoomFollowLockedRef.current} userZoom=${userZoomRef.current}` +
                ` manual=${manualPanRef.current ? 'yes' : 'no'}` +
                ` pan=${Math.round(mirrorZoomRef.current.x)},${Math.round(mirrorZoomRef.current.y)}`
            )
          }
          if (zoomFollowLockedRef.current) zoomToScaleRef.current?.(userZoomRef.current)
        } else if (msg.type === 'permissionState') {
          setMacControlBlocked(!msg.granted)
        } else if (msg.type === 'awayCovered') {
          showAwayNotice('covered')
        } else if (msg.type === 'awayEnded') {
          showAwayNotice('ended')
        } else if (msg.type === 'macLockState') {
          setMacLocked(msg.locked)
        } else if (msg.type === 'hostStatus') {
          setHostCaps(msg.capabilities)
          setMacName(msg.hostname || null)
          setMacAccountId(msg.accountId ?? null)
          // No React state: the widget (a separate process) is the only
          // consumer, reading whatever NativeBridge.swift persists below.
          nativeBridge.hostStatus({
            batteryPercent: msg.batteryPercent,
            charging: msg.charging,
            hostname: msg.hostname,
            at: msg.at
          })
          // The debug column is the second consumer. Gated so a viewer never
          // pays a re-render for a corner that is not painted.
          if (mirrorStatsOverlayEnabled()) {
            const { batteryPercent, charging } = msg
            setRigStatus((prev) =>
              prev
                ? { ...prev, macBatteryPct: batteryPercent, macCharging: charging }
                : {
                    macBatteryPct: batteryPercent,
                    macCharging: charging,
                    rttMs: -1,
                    jitterMs: -1,
                    route: '?',
                    glassesLink: null,
                    glassesThermal: null,
                    glassesName: null,
                    glassesBatteryCritical: false
                  }
            )
          }
        }
      }),
    [onMessage]
  )

  const attachMicTrack = useCallback(async (): Promise<MediaStreamTrack | null> => {
    if (micTrackRef.current) return micTrackRef.current
    const transceiver = micTransceiverRef.current
    if (!transceiver || !navigator.mediaDevices?.getUserMedia) return null
    if (micOpeningRef.current) return null
    micOpeningRef.current = true
    try {
      // CLONE when borrowing: stopMirror stops whatever track it was given, and
      // stopping the VAD's own would kill dictation mid-sentence.
      const shared = handsFreeMicRef.current?.getSharedStream() ?? null
      const borrow = micSourceForMirror(shared !== null) === 'share-handsfree'
      const stream =
        borrow && shared ? shared : await navigator.mediaDevices.getUserMedia({ audio: true })
      const source = stream.getAudioTracks()[0]
      const track = borrow ? (source?.clone() ?? null) : (source ?? null)
      if (!track) return null
      // A mirror torn down while the permission prompt was up leaves nothing to
      // attach to -- stop the track rather than leaking an open mic.
      if (!mirrorPcRef.current) {
        track.stop()
        return null
      }
      micTrackRef.current = track
      phoneMicStreamRef.current = stream
      await transceiver.sender.replaceTrack(track)
      remoteLogRef.current(
        `phone-mic attached label="${track.label}" muted=${track.muted} state=${track.readyState}`
      )
      return track
    } catch {
      // Denied or unavailable. The badge must come back OFF or it pulses red
      // over a mic that is streaming nothing.
      micTrackRef.current = null
      phoneMicStreamRef.current = null
      setMicOn(false)
      return null
    } finally {
      micOpeningRef.current = false
    }
  }, [])

  const {
    benchSummary,
    benchEstimateKbps,
    benchCode,
    rigStatus,
    setRigStatus,
    formatMmBench,
    startBench,
    stopBench
  } = useBench(remoteLogRef)
  const {
    cameraOn,
    onCameraChange,
    shareAudio,
    onShareAudioChange: setShareAudioPref,
    micOn,
    setMicOn,
    systemVolume,
    onSystemVolumeChange,
    onRequestSystemVolume
  } = useMedia({ onMessage, send, formatMmBench })

  // The Mac half of the speaker badge. Lost in fd46778b: without it the SCK
  // helper keeps capturing after the badge goes off, and the AAC feed to
  // Swift's PiP renderer -- which has no mute of its own -- never stops.
  const onShareAudioChange = useCallback(
    (value: boolean) => {
      setShareAudioPref(value)
      if (mirrorOn) send({ type: 'mirrorSetAudio', on: value })
    },
    [setShareAudioPref, mirrorOn, send]
  )

  const {
    mirrorPaneHeight,
    setMirrorPaneHeight,
    isLandscape,
    sizeMirrorPaneRef,
    onMirrorLoadedMetadata
  } = useMirrorPane({
    videoRef,
    mirrorPaneRef,
    remoteLogRef,
    zoomFollowLockedRef,
    zoomToScaleRef,
    userZoomRef
  })

  const stopMirror = useCallback(
    (reason: string) => {
      remoteLogRef.current(`stopMirror ${reason}`)
      stopBench()
      if (mirrorConnectTimerRef.current) {
        clearTimeout(mirrorConnectTimerRef.current)
        mirrorConnectTimerRef.current = null
      }
      micTrackRef.current?.stop()
      micTrackRef.current = null
      phoneMicStreamRef.current = null
      micTransceiverRef.current = null
      micOpeningRef.current = false
      setMicOn(false)
      mirrorPcRef.current?.close()
      mirrorPcRef.current = null
      if (videoRef.current) videoRef.current.srcObject = null
      clearStallOverlayTimer()
      setMirrorActive(false)
      setMirrorPictureLive(false)
      setMirrorPaneHeight(null)
    },
    [clearStallOverlayTimer, stopBench]
  )
  stopMirrorRef.current = stopMirror

  /** Glasses only, and best-effort: setCodecPreferences is unsupported on some
   *  browsers and throws on an unexpected list, and a codec preference is an
   *  optimisation -- never a reason to fail a mirror that would otherwise run. */
  const preferMirrorCodec = (transceiver: RTCRtpTransceiver, quality: MirrorQuality): void => {
    if (quality !== 'glasses') return
    try {
      const caps = RTCRtpReceiver.getCapabilities('video')
      if (!caps?.codecs || typeof transceiver.setCodecPreferences !== 'function') return
      const ordered = preferCodecOrder(caps.codecs)
      transceiver.setCodecPreferences(ordered)
      // Log what this host can actually DECODE alongside what we asked for: the
      // preference is a request, and a codec absent from this list silently
      // negotiates to something else. Read both halves before concluding a
      // codec change did or did not take.
      const offered = [...new Set(caps.codecs.map((c) => c.mimeType))].join(' ')
      remoteLog(`mirror codec preference ${ordered[0]?.mimeType ?? 'none'} | decodes: ${offered}`)
    } catch (err) {
      remoteLog(`mirror codec preference failed (default order): ${String(err)}`)
    }
  }

  /** Hold the receiver's jitter buffer to a small fixed target.
   *
   *  This was 0 -- the buffer trades latency for smoothness, and steering a
   *  cursor makes a held frame felt directly as lag. That is right on a LAN and
   *  wrong on the transport the glasses actually get: measured rtt=2168ms over
   *  the tunnel, where frames arrive unevenly and a zero buffer plays each one
   *  the instant it lands, converting arrival jitter straight into visible
   *  stutter. GLASSES_JITTER_TARGET_MS is the headroom to absorb that.
   *
   *  Glasses only, and the reason is not just consistency -- a phone on a lossy
   *  tunnel needs a full-size buffer, and clamping it there would buy stutter
   *  for latency nobody asked to trade. Both properties are best-effort:
   *  unsupported on older Chromium, and a rejected assignment must never fail a
   *  mirror that would otherwise run. */
  const minimizeJitterBuffer = (transceiver: RTCRtpTransceiver, quality: MirrorQuality): void => {
    if (quality !== 'glasses') return
    try {
      // Indexed, not an optional-prop cast: `'x' in obj` narrows an optional
      // property to always-present, which makes the else-if branch `never` and
      // fails the build.
      const receiver = transceiver.receiver as unknown as Record<string, unknown>
      const targetMs = CONFIG.PHONE_REMOTE.MIRROR_GLASSES_JITTER_TARGET_MS
      // jitterBufferTarget is milliseconds, playoutDelayHint is SECONDS -- same
      // intent, different units, and the older name is the fallback rather than
      // a second knob to set alongside it.
      if ('jitterBufferTarget' in receiver) {
        receiver.jitterBufferTarget = targetMs
        remoteLog(`mirror jitterBufferTarget=${targetMs}`)
      } else if ('playoutDelayHint' in receiver) {
        receiver.playoutDelayHint = targetMs / 1000
        remoteLog(`mirror playoutDelayHint=${targetMs / 1000}s (fallback)`)
      } else {
        remoteLog('mirror jitter buffer not adjustable on this host')
      }
    } catch (err) {
      remoteLog(`mirror jitter buffer set failed (default): ${String(err)}`)
    }
  }

  const startMirror = useCallback(
    async (picked: MirrorQuality, audioWanted: boolean, mode: MirrorMode) => {
      // Resolved HERE rather than at the five call sites, so a new one cannot
      // forget it and silently ship the glasses a 1280x800 stream again.
      // isCursorless() is read live (not the hook) because the verdict can flip
      // after mount and this runs at click time, not render time.
      const quality = qualityForHost(picked, isCursorless())
      if (mirrorPcRef.current) send({ type: 'mirrorStop', cause: 'restart' })
      stopMirror('restart')
      const attempt = ++mirrorAttemptRef.current

      const iceServers = await new Promise<RTCIceServer[]>((resolve) => {
        // A relay that arrived too late for a PREVIOUS attempt beats bare STUN:
        // the credentials are minted for 2h, so one that missed its deadline is
        // still valid now. Without this the retry is bit-identical to the
        // attempt that just failed.
        const fallback = (lastIceServersRef.current ?? [
          ...CONFIG.PHONE_REMOTE.MIRROR_ICE_SERVERS
        ]) as RTCIceServer[]
        const waiter = (servers: RTCIceServer[]): void => {
          clearTimeout(timer)
          resolve(servers?.length ? servers : fallback)
        }
        const timer = setTimeout(() => {
          if (pendingIceResolveRef.current === waiter) pendingIceResolveRef.current = null
          // Names the STUN-only fallback as a TIMEOUT rather than a choice --
          // from the Mac's log the two are identical, and they need opposite fixes.
          const relays = fallback.filter((s) => !!s?.credential).length
          remoteLog(`mirrorIceServers TIMEOUT -> fallback creds=${relays}`)
          resolve(fallback)
        }, CONFIG.PHONE_REMOTE.MIRROR_TURN.CLIENT_WAIT_MS)
        pendingIceResolveRef.current = waiter
        remoteLog('mirrorGetIceServers tx')
        send({ type: 'mirrorGetIceServers' })
      })

      if (attempt !== mirrorAttemptRef.current) {
        remoteLog(`mirror start superseded attempt=${attempt} now=${mirrorAttemptRef.current}`)
        return
      }
      const pc = new RTCPeerConnection({ iceServers })

      if (mirrorConnectTimerRef.current) clearTimeout(mirrorConnectTimerRef.current)
      mirrorConnectTimerRef.current = setTimeout(() => {
        mirrorConnectTimerRef.current = null
        if (mirrorPcRef.current !== pc) return // superseded by a newer attempt
        if (pc.connectionState === 'connected') return
        send({ type: 'mirrorDiag', detail: `connect timeout in ${pc.connectionState}` })
        // Name the real cause when we know it. Without the relay, an exhausted
        // allowance and a blocked network are the same failure to WebRTC, so the
        // generic copy was actively misleading for anyone who hit a limit.
        showToast(
          capToast(mirrorCapRef.current) ?? "Screen mirror couldn't connect on this network"
        )
        setMirrorOn(false)
        send({ type: 'mirrorStop', cause: 'connect-timeout' })
        stopMirror('connect-timeout')
      }, CONFIG.PHONE_REMOTE.MIRROR_CONNECT_TIMEOUT_MS)
      send({
        type: 'mirrorDiag',
        detail: `using ${iceServers.length} ICE entries (${iceServers.filter((s) => !!s.credential).length} with credentials)`
      })
      mirrorPcRef.current = pc
      // Audio mode (hands-free voice, no screen) skips the video transceiver
      // entirely -- mirrorPcRef still gets set above, so attachMicTrack's
      // guard still holds and the mic-only offer never touches getDisplayMedia
      // on the Mac side.
      if (mode !== 'audio') {
        const videoTransceiver = pc.addTransceiver('video', { direction: 'recvonly' })
        // The glasses were decoding only ~14fps of the ~30 the Mac sent, on VP8 --
        // which nothing in the app ever chose, it is just what SDP negotiation
        // lands on. VP8 has no hardware decoder on this class of device, so every
        // frame costs CPU the glasses do not have. That measurement is why this
        // call exists at all; which codec it names is MIRROR_PREFERRED_CODEC's
        // job. Receiver-side because we are the offerer, so this is what decides
        // the codec for the whole session.
        preferMirrorCodec(videoTransceiver, quality)
        minimizeJitterBuffer(videoTransceiver, quality)
      }
      micTransceiverRef.current = pc.addTransceiver('audio', { direction: 'sendrecv' })

      pc.ontrack = (e) => {
        const el = videoRef.current
        remoteLog(`mirror ontrack kind=${e.track.kind} el=${!!el}`)
        if (!el) return
        const existing = el.srcObject instanceof MediaStream ? el.srcObject : null
        if (!existing) {
          el.srcObject = new MediaStream([e.track])
        } else if (!existing.getTracks().includes(e.track)) {
          existing.addTrack(e.track)
        }
        // The audio m-line is always negotiated, so an audio track arrives
        // even when the toggle is off -- keep the element muted to match, or
        // sound would start on its own the moment the mirror connects.
        // Muted for the play() itself even when sound is wanted: a track lands
        // outside any tap, and iOS rejects an unmuted autoplay with
        // `NotAllowedError` -- which lands in the catch below, so the pane never
        // sizes, `mirrorReady` stays false and the connecting overlay never
        // lifts on a perfectly healthy stream. Unmuted once it is playing.
        el.muted = true
        // A track added to an already-playing element doesn't always start on
        // its own; iOS in particular needs the nudge. Ignore rejection -- the
        // element is already playing in that case.
        void el
          .play()
          .then(() => {
            // The audio m-line is always negotiated, so an audio track arrives
            // even when the toggle is off -- match the toggle here, or sound
            // would start on its own the moment the mirror connects.
            el.muted = !audioWanted
            remoteLog(`mirror play ok muted=${el.muted} dims=${el.videoWidth}x${el.videoHeight}`)
            // loadedmetadata can land BEFORE videoWidth/Height are populated on
            // iOS, and it is the only other caller -- without this the pane
            // never sizes, mirrorReady stays false and the connecting overlay
            // never lifts on a perfectly healthy stream.
            sizeMirrorPaneRef.current()
          })
          .catch((err) => {
            remoteLog(`mirror play rejected: ${err?.name ?? err}`)
            // Frames are decoding whatever playback thinks: a refused play() is
            // no reason to hold the user on "Connecting to your Mac…" forever.
            sizeMirrorPaneRef.current()
          })
        clearStallOverlayTimer()
        setMirrorActive(true)
        setMirrorPictureLive(true)
      }
      pc.onicecandidate = (e) => {
        if (e.candidate) {
          const type = e.candidate.candidate.split(' typ ')[1]?.split(' ')[0] ?? 'unknown'
          send({ type: 'mirrorDiag', detail: `ICE candidate typ=${type}` })
          send({
            type: 'mirrorIceCandidate',
            candidate: e.candidate.candidate,
            sdpMid: e.candidate.sdpMid,
            sdpMLineIndex: e.candidate.sdpMLineIndex
          })
        } else {
          send({ type: 'mirrorDiag', detail: 'ICE gathering complete' })
        }
      }
      pc.oniceconnectionstatechange = () => {
        send({ type: 'mirrorDiag', detail: `iceConnectionState=${pc.iceConnectionState}` })
      }
      pc.onconnectionstatechange = () => {
        send({ type: 'mirrorDiag', detail: `connectionState=${pc.connectionState}` })
        // Connected: cancel the give-up timer.
        if (pc.connectionState === 'connected') {
          if (mirrorConnectTimerRef.current) {
            clearTimeout(mirrorConnectTimerRef.current)
            mirrorConnectTimerRef.current = null
          }
          startBench(pc, quality)
        }
        if (pc.connectionState === 'failed') {
          const isLanIp = /^\d+\.\d+\.\d+\.\d+$/.test(location.hostname)
          showToast(
            isLanIp
              ? 'Mirror connection failed'
              : "Screen mirror can't connect on this network. Controls still work."
          )
          setMirrorOn(false)
          send({ type: 'mirrorStop', cause: 'ice-failed' })
          stopMirror('ice-failed')
        }
      }

      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer).then(() => offer))
        .then((offer) => {
          if (mirrorPcRef.current !== pc) return
          if (offer.sdp)
            send({ type: 'mirrorStart', sdp: offer.sdp, quality, shareAudio: audioWanted, mode })
        })
        .catch(() => {
          if (mirrorPcRef.current !== pc) return
          showToast('Mirror failed to start')
          send({ type: 'mirrorStop', cause: 'offer-failed' })
          stopMirror('offer-failed')
        })
    },
    [send, showToast, stopMirror, remoteLog]
  )

  const toggleMirror = useCallback(
    (on: boolean) => {
      setMirrorOn(on)
      if (on) {
        startMirror(mirrorQuality, shareAudio, mirrorMode)
      } else {
        send({ type: 'mirrorStop', cause: 'user' })
        stopMirror('user')
      }
    },
    [startMirror, mirrorQuality, shareAudio, mirrorMode, send, stopMirror]
  )

  // TEMPORARY: see CursorlessMirrorPrompt. Only on a host that has no other way
  // to reach the Settings checkbox.
  const cursorless = useCursorless()
  const [mirrorAsked, setMirrorAsked] = useState(false)
  const askMirror = cursorless && !mirrorAsked && !mirrorOn && connState.kind === 'connected'
  const answerMirror = useCallback(
    (share: boolean) => {
      setMirrorAsked(true)
      if (share) toggleMirror(true)
    },
    [toggleMirror]
  )
  // The latch is per-mirror-session, NOT per page load. Every path that clears
  // `mirrorOn` -- connect timeout, ICE failure, the Mac stopping it, a dropped
  // socket -- would otherwise strand the glasses on a deck with no picture and
  // no way back: this prompt is the only mirror control a cursorless host can
  // reach, so a spent latch is an unrecoverable state rather than a stale one.
  useEffect(() => {
    if (!mirrorOn) setMirrorAsked(false)
  }, [mirrorOn])

  const onMirrorQualityChange = useCallback(
    (quality: MirrorQuality) => {
      setMirrorQuality(quality)
      if (mirrorOn) startMirror(quality, shareAudio, mirrorMode)
    },
    [mirrorOn, startMirror, shareAudio, mirrorMode]
  )

  /** Flipping mirror<->extended changes WHAT the Mac captures, so it needs a
   *  full restart (same shape as a quality switch) -- the Mac has to add or
   *  drop the virtual display before it can pick a capture source. */
  const onMirrorModeChange = useCallback(
    (mode: MirrorMode) => {
      setMirrorMode(mode)
      if (mirrorOn) startMirror(mirrorQuality, shareAudio, mode)
    },
    [mirrorOn, startMirror, mirrorQuality, shareAudio]
  )

  const onMicChange = useCallback(
    (value: boolean) => {
      setMicOn(value)
      const track = micTrackRef.current
      if (!track && value) {
        // First time on: open the mic now rather than at mirror start.
        // setMicOn already ran, so the badge is live while the prompt is up and
        // attachMicTrack resets it on denial.
        void attachMicTrack().then((opened) => {
          if (opened) opened.enabled = true
        })
      } else if (track) {
        track.enabled = value
      }
      // The Mac cannot infer this: the flip is local, so "no PCM arriving" is
      // indistinguishable from a stalled connection. It needs the state to duck
      // computer audio and to show the live indicator.
      send({ type: 'phoneMicSet', on: value })
      // Reported on the tap, not at mount: `send` drops silently on a socket
      // that isn't OPEN yet, and a muted track is indistinguishable from a
      // missing one in the Mac's peak log.
      remoteLog(
        track
          ? `phone-mic tap on=${value} enabled=${track.enabled} muted=${track.muted} state=${track.readyState} label="${track.label}"`
          : `phone-mic tap on=${value} opening (no track yet)`
      )
    },
    [attachMicTrack, remoteLog, send]
  )

  /** Bring an audio-only session up with the phone as the microphone, then ask
   *  the Mac to start ChatGPT voice mode.
   *
   *  The ORDER is the whole function. ChatGPT reads its input device when the
   *  session opens, so pressing its button before `claimDefaultInput` has
   *  switched the Mac over (main/capture/phone-mic-device.ts) opens the call on
   *  the built-in mic -- the exact failure this feature exists to avoid. The
   *  flag rides `phoneMicSet` rather than being a message of its own so the Mac
   *  cannot observe the mic going live and the request to press separately.
   *
   *  Shared by Siri and the in-app control: one path, so the two cannot drift.  */
  const startChatGptVoiceWithMic = useCallback(async () => {
    // The session comes FIRST. attachMicTrack returns null without a peer
    // connection to hang the track on, and the phone is the only side that can
    // open one -- the Mac has no "start mirroring" verb.
    if (!mirrorPcRef.current) {
      // setMirrorMode too, not just the startMirror argument: the pane reads the
      // STATE to decide it is a voice call rather than a black video box, and
      // the two drifting is a session that connects but renders as a mirror.
      setMirrorMode('audio')
      setMirrorOn(true)
      startMirror(mirrorQuality, false, 'audio')
    } else {
      // A video mirror is already up, so the call rides that session. Both flags
      // still have to be stated: `mirrorOn` can be false with a live pc (a
      // stalled session keeps the connection), and leaving `mirrorMode` on
      // 'video' renders the picture with no sign a call is running. Flipping to
      // 'audio' drops the picture -- the call is what the user asked for.
      setMirrorMode('audio')
      setMirrorOn(true)
    }
    if (!micTrackRef.current) {
      const opened = await attachMicTrack()
      if (opened) opened.enabled = true
    } else {
      micTrackRef.current.enabled = true
    }
    setMicOn(true)
    send({ type: 'phoneMicSet', on: true, startChatGptVoice: true })
    remoteLog('phone-mic startChatGptVoiceWithMic requested')
  }, [attachMicTrack, mirrorQuality, remoteLog, send, setMicOn, setMirrorMode, startMirror])

  // Siri's cold-launch path. Replayable (native-bridge.ts REPLAYABLE_INTENTS),
  // so an intent that fired while this hook was still mounting is delivered
  // here rather than dropped.
  useEffect(() => {
    return subscribeNativeIntent((intent) => {
      if (intent.type === 'startChatGptVoiceWithMic') void startChatGptVoiceWithMic()
    }, ['startChatGptVoiceWithMic'])
  }, [startChatGptVoiceWithMic])

  // Tell the native shell when the mirror is genuinely making noise, so it can
  // keep running with the screen off and put the Live Activity up. Gated on
  // BOTH flags: a connected mirror with audio off is silent, and holding the
  // phone awake for it would be the battery lie the whole design refuses
  // (`prds/active/2026-08-08-1786192267-ios-background-mode.md` §4).
  // `micOn` is the THIRD case and does not fit that pair: `shareAudio` is the
  // Mac's audio coming HERE, and a voice call is this phone's mic going THERE.
  // Without it, pocketing the phone mid-call drops the hold and kills the mic --
  // which is the entire point of the feature.
  // No cleanup emit: this effect re-runs whenever either flag changes, and a
  // cleanup would send `false` immediately before the new `true`. Swift reads
  // that pair as "the mirror ended" and deactivates the audio session -- mid-PiP
  // that played the whole window in silence. The next run states the truth, and
  // the unmount case is covered by `releaseHoldsForTeardown` on the Swift side.
  useEffect(() => {
    nativeBridge.audioActivity(mirrorActive && shareAudio)
    nativeBridge.phoneMicActivity(mirrorActive && micOn)
  }, [mirrorActive, shareAudio, micOn])

  // Lets the PiP effect below key on `mirrorActive` alone -- see its comment for
  // why re-running on a new socket identity was destructive.
  const sendRef = useRef(send)
  sendRef.current = send

  // The second H.264 stream that feeds Swift's PiP layer. Native shell only:
  // no other client can decode it, and asking for it would cost the Mac a real
  // encoder for nothing (prds/active/2026-08-09-*-native-pip.md).
  // Keyed on `mirrorActive` ALONE. `send` is a useCallback that changes identity
  // with the socket, and this effect's cleanup tells Swift the PiP stream ended:
  // re-running it on a reconnect emitted pipActivity(false)+(true) milliseconds
  // apart, which deactivated the audio session under a live PiP window.
  useEffect(() => {
    if (capabilities.shell !== 'native' || !mirrorActive) return
    sendRef.current({ type: 'pipStreamStart' })
    // Taken HERE, not on backgrounding: iOS grants auto-PiP only to an app that
    // already holds an active AVAudioSession, and it judges that at the moment
    // the app leaves the screen. Held for the stream's whole life so the session
    // is up long before then -- without it iOS declines silently, with no PiP
    // and no delegate callback at all (verified on device 2026-08-09).
    nativeBridge.pipActivity(true)
    return () => {
      // Told directly, not just via the Mac's pipStreamEnded: on a dead socket
      // that message never arrives, and Swift would keep a frozen PiP window up.
      nativeBridge.pipEnded('mirror stopped')
      nativeBridge.pipActivity(false)
      sendRef.current({ type: 'pipStreamStop' })
    }
  }, [mirrorActive])

  // Read by the appActive handler, which subscribes once and must not re-bind
  // on every mirror toggle just to see whether there is a picture to pop out.
  const mirrorActiveRef = useRef(mirrorActive)
  mirrorActiveRef.current = mirrorActive
  // Same reason: the PiP handler needs the user's audio choice to know whether
  // the silent keepalive is required, and to restore the right `muted` on return.
  const shareAudioRef = useRef(shareAudio)
  shareAudioRef.current = shareAudio
  const mirrorRestartRef = useRef({ quality: mirrorQuality, audio: shareAudio, mode: mirrorMode })
  mirrorRestartRef.current = { quality: mirrorQuality, audio: shareAudio, mode: mirrorMode }

  useEffect(() => {
    if (connState.kind === 'connected' && mirrorOn) {
      const { quality, audio, mode } = mirrorRestartRef.current
      startMirror(quality, audio, mode)
    } else if (connState.kind !== 'connected') {
      stopMirror('disconnect')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connState])

  useEffect(() => () => stopMirror('unmount'), [stopMirror])

  // Reset zoom/pan whenever the mirror is toggled off or restarted, so
  // re-enabling it doesn't come back stuck zoomed in on a fresh stream.
  useEffect(() => {
    manualPanRef.current = null
    if (!mirrorOn) {
      setMirrorZoom({ scale: 1, x: 0, y: 0 })
      setZoomFollowLocked(false)
      return
    }
    // Cursorless hosts start FOLLOWING, because the alternative is a picture
    // permanently centred on a desktop it only shows part of. There is no
    // touch here to long-press the zoom knob with, so the lock cannot be the
    // opt-in gesture it is on a phone. They also start zoomed IN: a whole
    // desktop scaled into 600px is legible only in the middle. Zooming to the
    // 1.0 floor is how you get that whole-desktop view back deliberately.
    if (isCursorless()) {
      setZoomFollowLocked(true)
      userZoomRef.current = CONFIG.PHONE_REMOTE.MIRROR_ZOOM_CURSORLESS_BASE
      // The effective scale needs the pane and the video's intrinsic size,
      // neither of which exists yet -- sizeMirrorPane replays this the moment
      // loadedmetadata lands.
      zoomToScaleRef.current?.(CONFIG.PHONE_REMOTE.MIRROR_ZOOM_CURSORLESS_BASE)
    }
  }, [mirrorOn])

  // Don't leave a fade timer running past unmount -- it would fire setState on
  // a dead component.
  useEffect(() => {
    return () => {
      if (touchModeRestTimerRef.current !== null) window.clearTimeout(touchModeRestTimerRef.current)
    }
  }, [])

  const zoomToScale = useCallback((next: number) => {
    const pane = mirrorPaneRef.current
    if (!pane) return
    const scale = Math.min(
      CONFIG.PHONE_REMOTE.MIRROR_ZOOM_MAX,
      Math.max(CONFIG.PHONE_REMOTE.MIRROR_ZOOM_MIN, next)
    )
    // Report a zoom this device decided on back to the controller, so the ring
    // knob tracks the glasses instead of only ever driving them. Compared
    // against the PREVIOUS userZoomRef because this function re-runs at an
    // unchanged scale on every cursor move -- reporting those would be a
    // steady message per mouse twitch, for a value that did not move.
    //
    // Guarded on the relay flag, not on role: a controller mirroring to itself
    // has no viewer, and the Mac drops the message anyway, so role would be a
    // second rule that can disagree with the server's.
    if (scale !== userZoomRef.current && !applyingRelayedZoomRef.current) {
      sendRef.current({ type: 'mirrorViewerZoomChanged', scale })
    }
    userZoomRef.current = scale
    const rect = pane.getBoundingClientRect()
    const c = cursorPosRef.current ?? { x: 0.5, y: 0.5 }

    // 1x is a HONEST 1x on a cursorless host: the whole desktop, letterboxed
    // into the square panel. It used to multiply by the cover baseline so 1
    // meant "fill", which cropped a third of a 16:10 desktop at the very
    // bottom of the range and made the pill's number a lie. The contain-style
    // clamp below measures the pane box, which would let a pan slide into the
    // black bars; cover-pan.ts measures the rendered content instead.
    if (isCursorless()) {
      const v = videoRef.current
      const vw = v?.videoWidth ?? 0
      const vh = v?.videoHeight ?? 0
      // Zooming RE-ARMS cursor-follow, and this is the only place it can: the
      // glasses' D-pad and the phone's ring knob are two entry points that both
      // funnel through here, so re-arming in either one would fix that one and
      // silently miss the other. Panning parks the follow (mirrorDpadPan), and
      // on a host with no touch there is no long-press to switch it back on --
      // so one D-pad swipe used to strand the picture for the whole session.
      // Changing the zoom is the unambiguous "re-aim at what I'm doing", and
      // it is the one gesture glasses always have.
      // setZoomFollow is not called here: it lives below and calls back into
      // this function, and it exists to SNAP to the cursor -- which the lines
      // right after this already do on the same pass. Writing the flag is the
      // whole job; re-entering would just recompute the pan a second time.
      if (scale !== userZoomBeforeRef.current && manualPanRef.current) {
        manualPanRef.current = null
        zoomFollowLockedRef.current = true
        setZoomFollowLocked(true)
      }
      userZoomBeforeRef.current = scale
      // A manual pan is re-clamped at every zoom rather than kept verbatim:
      // zooming OUT shrinks the pannable extent, so an offset that was legal at
      // 3x would expose a black gutter at 1.5x.
      const { x, y } = manualPanRef.current
        ? clampCoverPan(rect.width, rect.height, vw, vh, scale, manualPanRef.current)
        : coverPanForCursor(rect.width, rect.height, vw, vh, scale, c)
      manualPanRef.current = manualPanRef.current && { x, y }
      setMirrorZoom((z) => (z.scale === scale && z.x === x && z.y === y ? z : { scale, x, y }))
      return
    }

    const rawX = (0.5 - c.x) * rect.width * (scale - 1)
    const rawY = (0.5 - c.y) * rect.height * (scale - 1)
    // Same clamp the pinch path uses: never pan past the video's own edges,
    // or you get empty gutters beside a zoomed-in image.
    const maxX = (rect.width * (scale - 1)) / 2
    const maxY = (rect.height * (scale - 1)) / 2
    const x = Math.min(maxX, Math.max(-maxX, rawX))
    const y = Math.min(maxY, Math.max(-maxY, rawY))
    setMirrorZoom((z) => (z.scale === scale && z.x === x && z.y === y ? z : { scale, x, y }))
  }, [])

  // Keep the refs the WS handler reads in step with the live values.
  useEffect(() => {
    zoomToScaleRef.current = zoomToScale
  }, [zoomToScale])
  useEffect(() => {
    mirrorZoomScaleRef.current = mirrorZoom.scale
    mirrorZoomRef.current = mirrorZoom
  }, [mirrorZoom])
  useEffect(() => {
    zoomFollowLockedRef.current = zoomFollowLocked
  }, [zoomFollowLocked])

  // Locking snaps to the cursor immediately rather than waiting for the next
  // move -- otherwise a lock on a parked cursor looks like it did nothing.
  const setZoomFollow = useCallback(
    (locked: boolean) => {
      setZoomFollowLocked(locked)
      // Re-locking hands the view back to the cursor, so the manual offset has
      // to go -- left set it would outrank the follow it just re-armed.
      if (locked) {
        manualPanRef.current = null
        zoomToScale(userZoomRef.current)
      }
      // Re-show on every toggle, restarting the rest timer, so a quick
      // lock-unlock-lock doesn't leave the pill stuck from the first one.
      setZoomFollowToast(true)
      if (zoomFollowToastTimerRef.current !== null) {
        window.clearTimeout(zoomFollowToastTimerRef.current)
      }
      zoomFollowToastTimerRef.current = window.setTimeout(() => {
        setZoomFollowToast(false)
        zoomFollowToastTimerRef.current = null
      }, CONFIG.PHONE_REMOTE.MIRROR_TOUCH_SNACKBAR_REST_MS)
    },
    [zoomToScale]
  )

  // The glasses' D-pad, pan half. Seeds the offset from wherever the picture
  // already sits, so the first swipe nudges the current view instead of jumping
  // from centre -- at the cursorless base zoom the view is normally parked on
  // the cursor, several hundred px off centre.
  const mirrorDpadPan = useCallback(
    (dx: number, dy: number) => {
      const pane = mirrorPaneRef.current
      if (!pane) return
      const rect = pane.getBoundingClientRect()
      const v = videoRef.current
      const vw = v?.videoWidth ?? 0
      const vh = v?.videoHeight ?? 0
      const from = manualPanRef.current ?? { x: mirrorZoom.x, y: mirrorZoom.y }
      manualPanRef.current = coverPanStep(
        rect.width,
        rect.height,
        vw,
        vh,
        userZoomRef.current,
        from,
        dx,
        dy
      )
      // Panning IS "stop chasing the pointer" -- without this the next Mac
      // cursor move recomputes the pan from cursorPosRef and erases the swipe.
      // setZoomFollow re-runs zoomToScale itself, so don't call it twice.
      if (zoomFollowLockedRef.current) setZoomFollow(false)
      zoomToScale(userZoomRef.current)
    },
    [mirrorZoom.x, mirrorZoom.y, setZoomFollow, zoomToScale]
  )

  // The zoom half. Multiplicative; zoomToScale owns the clamp and the re-clamp
  // of any manual pan, so this must never touch setMirrorZoom itself.
  const mirrorDpadZoom = useCallback(
    (factor: number) => {
      zoomToScale(userZoomRef.current * factor)
    },
    [zoomToScale]
  )

  // Aim the picture at a normalized desktop point, sent by the controller's
  // minimap. Reuses coverPanForCursor -- the same function cursor-follow uses --
  // rather than converting to px on the phone: the two devices have different
  // pane sizes, so px would mean different things at each end, and a second pan
  // rule here could disagree with follow at the desktop edges.
  const applyViewerPan = useCallback(
    (x: number, y: number) => {
      const pane = mirrorPaneRef.current
      if (!pane) return
      const rect = pane.getBoundingClientRect()
      const v = videoRef.current
      manualPanRef.current = coverPanForCursor(
        rect.width,
        rect.height,
        v?.videoWidth ?? 0,
        v?.videoHeight ?? 0,
        userZoomRef.current,
        { x, y }
      )
      // Being aimed IS "stop chasing the pointer", exactly as a D-pad swipe is.
      // Without this the next Mac cursor move recomputes the pan from
      // cursorPosRef and erases what the controller just asked for.
      if (zoomFollowLockedRef.current) setZoomFollow(false)
      zoomToScale(userZoomRef.current)
    },
    [setZoomFollow, zoomToScale]
  )
  useEffect(() => {
    applyViewerPanRef.current = applyViewerPan
  }, [applyViewerPan])

  // Don't leave the rest timer running past unmount.
  useEffect(() => {
    return () => {
      if (zoomFollowToastTimerRef.current !== null) {
        window.clearTimeout(zoomFollowToastTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    // Cursorless is exempt. 1x does show the whole desktop here, so there is
    // nothing left to follow -- but dropping the lock would turn follow OFF,
    // and there is no touch on glasses to switch it back on. It would stay off
    // for the rest of the session, stranding the picture the moment you zoom
    // back in. Following a cursor that is always on screen is a no-op; losing
    // the mode is not. `coverPanForCursor` clamps to zero pan at 1x anyway.
    if (isCursorless()) return
    if (mirrorZoom.scale > CONFIG.PHONE_REMOTE.MIRROR_ZOOM_MIN) return
    if (zoomFollowLockedRef.current) setZoomFollow(false)
  }, [mirrorZoom.scale, setZoomFollow])

  useEffect(() => {
    const el = videoRef.current
    const pc = mirrorPcRef.current
    if (!paneNode || !el || !pc || el.srcObject) return
    const tracks = pc.getReceivers().map((r) => r.track).filter((t) => t.readyState === 'live')
    if (tracks.length === 0) return
    el.srcObject = new MediaStream(tracks)
    void el.play().catch(() => undefined)
  }, [paneNode])

  useMirrorGestures({
    mirrorOn,
    paneNode,
    mirrorPaneRef,
    videoRef,
    mirrorPanHandoffRef,
    touchModeActiveRef,
    touchModeLockedRef,
    touchModeRestTimerRef,
    dispatchTouchMode,
    setMirrorZoom,
    send
  })

  const exitTouchMode = useCallback(() => {
    if (touchModeRestTimerRef.current !== null) {
      window.clearTimeout(touchModeRestTimerRef.current)
      touchModeRestTimerRef.current = null
    }
    // `rest` is a no-op while held, so the lock check the old boolean needed
    // here now lives in the transition instead of at the call site.
    dispatchTouchMode({ type: 'rest' })
  }, [dispatchTouchMode])

  const toggleTouchModeLock = useCallback(() => {
    // `toggleHold` unlocks straight to `pan`, so there is no rest clock to
    // start on the way out any more -- the old boolean needed one because
    // unlocking left `active` true with nothing scheduled to clear it.
    if (touchModeRestTimerRef.current !== null) {
      window.clearTimeout(touchModeRestTimerRef.current)
      touchModeRestTimerRef.current = null
    }
    dispatchTouchMode({ type: 'toggleHold' })
    hapticTick()
  }, [dispatchTouchMode])

  // Settings open/close is toggled inline by both layouts (setSettingsOpen),
  // so the tick rides the state change instead of a handler -- one home
  // covers Classic and Pro. Ref-gated so the mount render doesn't tick.
  const settingsTickArmedRef = useRef(false)
  useEffect(() => {
    if (!settingsTickArmedRef.current) {
      settingsTickArmedRef.current = true
      return
    }
    hapticTick()
  }, [settingsOpen])

  const {
    quickSteps,
    setQuickSteps,
    quickStepsRef,
    quickAnchor,
    setQuickAnchor,
    quickAnchorRef,
    quickPinned,
    setQuickPinned
  } = useAppSwitcherState()

  const {
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
  } = useKeyboard({
    bus,
    send,
    connState,
    hostKeyboard,
    setQuickAnchor,
    quickAnchorRef,
    quickStepsRef,
    appRingRef,
    applyRingRefreshWhenIdleRef
  })

  const ringRefreshTimerRef = useRef<number | null>(null)
  const applyRingRefreshWhenIdle = useCallback(() => {
    if (ringRefreshTimerRef.current) clearTimeout(ringRefreshTimerRef.current)
    ringRefreshTimerRef.current = window.setTimeout(() => {
      ringRefreshTimerRef.current = null
      // Re-checked at fire time, not at arm time: a finger can land during the
      // wait, and reordering under it is the reshuffle this all exists to stop.
      if (!pendingAppListRef.current || ringDraggingRef.current) return
      setAppList(pendingAppListRef.current)
      appListRef.current = pendingAppListRef.current
      pendingAppListRef.current = null
    }, CONFIG.PHONE_REMOTE.APP_RING_REFRESH_IDLE_MS)
  }, [])
  applyRingRefreshWhenIdleRef.current = applyRingRefreshWhenIdle

  // A new ring touch means the user is still going -- push the refresh back so
  // it can never land between two gestures in a run.
  const deferRingRefresh = useCallback(() => {
    if (ringRefreshTimerRef.current) {
      clearTimeout(ringRefreshTimerRef.current)
      ringRefreshTimerRef.current = null
    }
  }, [])
  deferRingRefreshRef.current = deferRingRefresh

  // A refresh still owed when the deck goes away is just dropped -- the next
  // appSwitchList rebuilds it, and a timer outliving the component would call
  // setState on an unmounted tree.
  useEffect(() => {
    return () => {
      if (ringRefreshTimerRef.current) clearTimeout(ringRefreshTimerRef.current)
    }
  }, [])

  const {
    actProgressOpen,
    setActProgressOpen,
    actRunId,
    actInstruction,
    actSteps,
    onRunDone,
    onActDictation,
    onHideActProgress,
    onStopActProgress
  } = useActProgress({
    bus,
    send,
    showToast
  })

  const {
    referralOpen,
    referralLink,
    referralCode,
    referredCount,
    referralError,
    inviteState,
    onToggleReferral,
    onCloseReferral,
    onRetryReferral,
    onSendInvite
  } = useReferral({
    bus,
    send
  })

  const { envState, envSwitchingTo, onEnvChange } = useEnv({
    bus,
    send
  })

  const { approvalRequest, answerApproval } = useApproval({
    bus,
    send
  })

  // The mic scan below re-runs per render; the Mac look mounts a mic from a layout switch.
  useScreenShareLayout()
  const {
    recording,
    recordingTo,
    micLatched,
    micLabel,
    handsFree: handsFreeState,
    handsFreeSpeaking,
    handsFreeStreamRef,
    disarmHandsFree,
    transcribing,
    transcribeStage,
    inFlightClipId,
    inFlightClipRef,
    retryableClip,
    cancelTranscribe,
    retryTranscribe,
    dismissTranscribe,
    micSidePress,
    micStreamRef,
    historyOpen,
    setHistoryOpen,
    highlightHistoryId,
    setHighlightHistoryId,
    dictations,
    historyHasMore,
    historyLoadingMore,
    onLoadMoreHistory,
    onPasteDictation,
    micDown,
    micUp,
    settleClip,
    handsFreeMicRef,
    recordingElapsed
  } = useDictation({
    bus,
    send,
    sendBinary,
    showToast,
    setStatus,
    connectedRef,
    connState,
    chatOpen,
    remoteLog,
    closeAppSwitcher,
    setChatDictating,
    onRunDone,
    schedulePhoneTextWatchdog
  })
  const chatRecording = recording && recordingTo === PHONE_AUDIO_TO.chat
  const thoughtRecording = recording && recordingTo === PHONE_AUDIO_TO.note

  const {
    chatSessions,
    chatThread,
    chatBusy,
    chatSteps,
    chatStreamed,
    chatDraftPatch,
    onChatMicDown,
    onChatMicUp,
    onChatDraftConsumed,
    sessionMic,
    onToggleChat,
    onCloseChat,
    onChatOpenSession,
    onChatNewSession,
    onChatSend,
    onStopChat,
    nativeChatHandlerRef,
    nativeOpenChatRef
  } = useChat({
    bus,
    send,
    showToast,
    setStatus,
    settleClip,
    inFlightClipRef,
    micDown,
    micUp,
    recording: chatRecording,
    micStreamRef,
    setChatOpen,
    chatOpen,
    connState,
    chatDictating,
    setChatDictating
  })

  const {
    relayPending,
    relayResolved,
    relayDismissed,
    relaySnapshotSeen,
    relayRefusal,
    relayStatus,
    relayPushFilter,
    relayNotifyLevel,
    relayTurnEndPing,
    sessionPreviews,
    sessionSent,
    onSessionSentGet,
    sessionSuggestions,
    sessionPreviewAges,
    sessionPeekOutcome,
    sessionGoToFailed,
    sessionRevealedAt,
    sessionZoomed,
    focusedRelayRequestId,
    nativeOpenRelayRef,
    onRelayRespond,
    onRelayTapTrace,
    onFocusedRelayRequestConsumed,
    onRelayTapMissed,
    onRelayUndismiss,
    onSessionPeek,
    onRequestSuggestions,
    onSetRelayPush,
    onSetRelayNotifyLevel,
    onSetRelayTurnEndPing,
    onRequestRelayPush,
    onSessionReply,
    onSessionStop,
    onSessionAttach,
    onSessionGoTo,
    onSessionZoom,
    onRelayPickPhoto,
    relayImageSrc
  } = useRelay({
    bus,
    send,
    sendBinary,
    showToast
  })

  // Answers the Mac's photos* events. No return value: it owns no state, and
  // nothing on the deck renders because of a search.
  usePhotos(bus, send, sendBinary)

  const {
    sensitivity,
    onSensitivityChange,
    onCursorSizeChange,
    onCursorAnimatedChange,
    trackpadRef,
    touchDotActive,
    touchDots,
    cursorPos,
    cursorVisible,
    cursorStyle,
    trail,
    trailNow
  } = useTrackpad({
    bus,
    send,
    showCursor,
    closeAppSwitcher,
    exitTouchMode,
    cursorSurfaceEnabled: mirrorOn && mirrorActive && mirrorMode !== 'audio',
    touchModeLockedRef,
    remoteLogRef,
    ringClaimRef,
    ringHitRef,
    zoomHitRef,
    minimapHitRef,
    ringSummonRef,
    ringDraggingRef,
    deferRingRefreshRef,
    railClaimRef,
    railSummonRef,
    rubRef,
    appSwitchOpenRef
  })

  useNativeIntents({
    send,
    remoteLog,
    remoteLogRef,
    activateApp,
    stopMirror,
    setRigStatus,
    setStatus,
    setCodeOpen,
    setMirrorOn,
    mirrorPcRef,
    nativeChatHandlerRef,
    nativeOpenChatRef,
    nativeOpenRelayRef
  })

  const { quickSwitchTap, quickSwitchPick, onRingRelease } = useAppSwitcher({
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
  })

  // WebKit pauses the inline <video> on BOTH edges of a PiP trip. Entering:
  // backgrounding pauses the element, which kills the mirror's audio -- the
  // AUDIO IN toggle only ever "fixed" this because its handler calls `play()`.
  // Returning: the picture was handed to the native PiP layer and nothing
  // hands it back, so it sits paused on a black frame. Same nudge both ways;
  // no gesture needed (`mediaTypesRequiringUserActionForPlayback = []`).
  useEffect(() => {
    const resume = (edge: string): void => {
      const el = videoRef.current
      if (!el || !mirrorActiveRef.current) return
      const wantSound = shareAudioRef.current && !nativeMicClaimed()
      // Muted FIRST, unconditionally. These resumes run on a visibility or PiP
      // edge, never inside a tap, and iOS rejects an unmuted play() with no
      // gesture behind it -- `NotAllowedError`, the element stays paused, and
      // WebKit paints its play button over a black pane. Sound is restored
      // after the element is already playing, which needs no gesture at all.
      el.muted = true
      void el
        .play()
        .then(() => {
          el.muted = !wantSound
          remoteLog(
            `mirror ${edge} play ok muted=${el.muted} dims=${el.videoWidth}x${el.videoHeight}`
          )
        })
        .catch((err) => remoteLog(`mirror ${edge} play rejected: ${err?.name ?? err}`))
    }
    const onVis = (): void => {
      if (!videoRef.current || !mirrorActiveRef.current) return
      const visible = document.visibilityState === 'visible'
      // Auto-PiP stays armed for the stream's whole life (pipActivity). It
      // cannot be armed here on the hide edge: iOS starts the window BEFORE
      // WebKit sees this event -- `pip: willStart` always precedes `mirror
      // background play ok` in the log -- so a flag set here lands too late and
      // nothing floats. The window the user comes back to is simply the one
      // still open from the trip out; closing it is what stops the mirror
      // showing twice, not disarming.
      if (visible) nativeBridge.pipStopWindow()
      resume(visible ? 'resume' : 'background')
    }
    // AVKit finishes closing the window AFTER the resume above has already run,
    // and WebKit pauses the element as it goes -- leaving iOS's play button over
    // a black pane. Replaying here is what actually un-pauses it.
    const offDidStop = subscribeNativeIntent((intent) => {
      if (intent.type === 'pipDidStop') resume('pip-stopped')
    }, [])
    // An unmuted mirror video takes the audio session back from the recorder, which then records nothing.
    const offMicClaim = subscribeNativeMicClaim((claimed) => {
      const el = videoRef.current
      if (!el || !mirrorActiveRef.current) return
      el.muted = claimed || !shareAudioRef.current
      remoteLog(`mirror mic-claim=${claimed} muted=${el.muted}`)
    })
    // The element's OWN pause event, not another guessed edge. Every fix before
    // this one picked a moment to call play() -- visibility, PiP stop, ontrack --
    // and iOS pauses this element at moments none of them cover: the connect-time
    // play() is refused while dims are still 0x0, and nothing ever retries, so
    // the mirror sits paused over a live 17fps stream until the user taps the
    // speaker button (a gesture, which is why that "fixes" it). Frames decoding
    // is the only thing that decides whether the picture should be playing.
    const onPause = (e: Event): void => {
      // Document-wide capture catches every media element on the page, and the
      // camera PiP has its own; only this one is the mirror's business.
      if (e.target !== videoRef.current || !mirrorActiveRef.current) return
      resume('auto-unpause')
    }
    // Captured on the document rather than the element: this effect runs before
    // the <video> mounts and never re-runs to catch it, and `pause` does not
    // bubble -- a direct addEventListener here would silently bind to nothing.
    // A connect-time play() refused with `NotAllowedError` leaves an element
    // that never started, so `pause` never fires and the retry above cannot
    // reach it; the mirror sits under iOS's play button until the speaker
    // button runs play() inside a tap. Any touch is that tap: play() inside a
    // gesture lifts WebKit's restriction for the element's life, so the first
    // trackpad touch heals it. Only while paused, so a healthy stream costs
    // nothing per touch. Must stay synchronous -- the gesture token does not
    // survive an await.
    const onGesture = (): void => {
      const el = videoRef.current
      if (!el || !mirrorActiveRef.current || !el.paused) return
      resume('gesture-retry')
    }
    document.addEventListener('pause', onPause, true)
    document.addEventListener('visibilitychange', onVis)
    document.addEventListener('pointerdown', onGesture, true)
    document.addEventListener('touchend', onGesture, true)
    return () => {
      offDidStop()
      offMicClaim()
      document.removeEventListener('pause', onPause, true)
      document.removeEventListener('visibilitychange', onVis)
      document.removeEventListener('pointerdown', onGesture, true)
      document.removeEventListener('touchend', onGesture, true)
    }
  }, [remoteLog])

  const onToastTap = useCallback(() => {
    if (actRunId) {
      hapticTick()
      setActProgressOpen((v) => !v)
      return
    }
    if (!toastHistoryId) return
    // A completed hold already ran Act; the pointerup that ends it must not
    // also open History behind the run.
    if (toastActFiredRef.current) {
      toastActFiredRef.current = false
      return
    }
    hapticTick()
    setHighlightHistoryId(toastHistoryId)
    setHistoryOpen(() => true)
    setToastShown(false)
  }, [actRunId, toastHistoryId])

  // Hold the transcript toast to Act on it. Starts the arming animation
  // immediately so the hold is VISIBLE from the first moment -- an invisible
  // one-second wait is indistinguishable from a dead control.
  const onToastHoldStart = useCallback(() => {
    if (!toastHistoryId) return
    cancelToastHold()
    setToastActArming(true)
    toastHoldTimerRef.current = setTimeout(() => {
      toastHoldTimerRef.current = null
      setToastActArming(false)
      toastActFiredRef.current = true
      // Deferred past touchend on purpose: iOS fires no haptic while a touch
      // sequence is live (see haptics.ts). This is the only tick that can
      // actually land to confirm the hold took.
      hapticDragRelease()
      onActDictation(toastHistoryId)
    }, TOAST_ACT_HOLD_MS)
  }, [toastHistoryId, cancelToastHold, onActDictation])

  // Released (or dragged off) before the hold completed -- abandon it. The
  // tap handler still fires on a genuine short tap, which is the intent.
  const onToastHoldEnd = useCallback(() => {
    if (toastHoldTimerRef.current) {
      clearTimeout(toastHoldTimerRef.current)
      toastHoldTimerRef.current = null
    }
    setToastActArming(false)
  }, [])

  const onCloseCode = useCallback(() => {
    setCodeOpen(false)
  }, [])

  const onToggleCode = useCallback(() => {
    setCodeOpen((v) => !v)
  }, [])

  const zoomTrackOn = viewer?.kind === 'receiving'
  const { ringZoomScaleValue, onRingZoom, minimapCentre, onMinimapPan } = useViewerControls({
    send,
    zoomTrackOn,
    setRingZoomScaleValueRef
  })

  const onCenterCursor = useCallback(() => {
    send({ type: 'centerCursor' })
    hapticTick()
    showToast('Cursor centered')
  }, [send, showToast])

  const mirrorReady =
    mirrorActive && mirrorPictureLive && (isLandscape || mirrorPaneHeight !== null)

  // The overlay gate. `mirrorActive` true with `mirrorReady` false means either
  // the track landed but the pane never sized, or the picture stalled past its
  // grace -- indistinguishable on glass, which is why each half is logged.
  useEffect(() => {
    remoteLog(
      `mirror gate ready=${mirrorReady} active=${mirrorActive} picture=${mirrorPictureLive} landscape=${isLandscape} paneH=${mirrorPaneHeight}`
    )
  }, [mirrorReady, mirrorActive, mirrorPictureLive, isLandscape, mirrorPaneHeight, remoteLog])

  const firstSteps = useFirstSteps(onMessage)

  // Same treatment for the reconnect banner: a drop that heals inside the
  // window never paints one.
  const reconnectSlow = useDelayedFlag(
    connState.kind === 'disconnected' || connState.kind === 'connecting',
    RECONNECT_BANNER_DELAY_MS
  )

  const sharedLayoutProps = {
    ai,
    status: recordingElapsed ? `${status} ${recordingElapsed}` : status,
    connState,
    appSwitchOpen,
    recording,
    chatRecording,
    thoughtRecording,
    micLatched,
    handsFree: handsFreeState,
    handsFreeSpeaking,
    handsFreeStreamRef,
    disarmHandsFree,
    transcribing,
    transcribeStage,
    transcribeClipId: inFlightClipId,
    retryableClip,
    cancelTranscribe,
    retryTranscribe,
    dismissTranscribe,
    quickSwitchTap,
    quickSwitchPick,
    quickSteps,
    quickAnchor,
    quickPinned,
    micSidePress,
    micStreamRef,
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
    virtualKeyboardLayoutId,
    onCloseVirtualKeyboard,
    onVirtualKeyboardChar,
    onVirtualKeyboardBackspace,
    onVirtualKeyboardSpecialKey,
    onVirtualKeyboardCombo,
    appContext,
    clipboardHasContent,
    onPasteClipboard,
    onActivateItem,
    onActivateGroup,
    onActivatePane,
    onTmuxAction,
    onBrowserSheetOpenChange,
    onBarTap,
    settingsOpen,
    setSettingsOpen,
    windowLayoutOpen,
    // A host without layouts (Windows) makes the Settings hold a no-op.
    openWindowLayouts: hostCaps?.windowLayout === false ? () => {} : openWindowLayouts,
    toggleAppSwitcher: hostCaps?.appSwitcher === false ? () => {} : toggleAppSwitcher,
    onCloseWindowLayouts,
    onApplyWindowLayout: applyWindowLayout,
    hostCaps,
    macName,
    hostDevice,
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
    chatOpen,
    chatSessions,
    chatThread,
    chatBusy,
    chatSteps,
    chatStreamed,
    chatDictating,
    chatDraftPatch,
    onChatMicDown,
    onChatMicUp,
    onChatDraftConsumed,
    sessionMic,
    renderMarkup,
    onRenderMarkupChange,
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
    relayLinkOk: connState.kind === 'connected' && relaySnapshotSeen,
    relayStatus,
    relayRefusal,
    focusedRelayRequestId,
    onFocusedRelayRequestConsumed: onFocusedRelayRequestConsumed,
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
    sessionGoToFailed,
    sessionRevealedAt,
    sessionZoomed,
    relayPushFilter,
    relayNotifyLevel,
    relayTurnEndPing,
    onSetRelayPush,
    onSetRelayNotifyLevel,
    onSetRelayTurnEndPing,
    onRequestRelayPush,
    onRelayPickPhoto,
    relayImageSrc,
    highlightHistoryId,
    onToastTap,
    onToastHoldStart,
    onToastHoldEnd,
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
    sensitivity,
    onSensitivityChange,
    onCursorSizeChange,
    onCursorAnimatedChange,
    mirrorOn,
    toggleMirror,
    startChatGptVoiceWithMic,
    onMirrorDpadPan: mirrorDpadPan,
    onMirrorDpadZoom: mirrorDpadZoom,
    mirrorQuality,
    onMirrorQualityChange,
    mirrorMode,
    onMirrorModeChange,
    mirrorPaneRef,
    mirrorPaneHeight,
    isLandscape,
    videoRef,
    benchSummary,
    benchEstimateKbps,
    benchCode,
    rigStatus,
    mirrorActive: mirrorReady,
    mirrorZoom,
    onZoomToScale: zoomToScale,
    zoomFollowLocked,
    onZoomFollowLockedChange: setZoomFollow,
    zoomFollowToast,
    onDebugLog: remoteLog,
    touchModeActive,
    touchModeLocked,
    onToggleTouchModeLock: toggleTouchModeLock,
    onMirrorLoadedMetadata,
    trackpadRef,
    touchDotActive,
    firstSteps,
    touchDots,
    micRef,
    // A live run's toast reads the phase off the same step list the expanded
    // card renders, so the collapsed and open views can't tell different
    // stories about what the Mac is doing.
    toast: toastRunning ? runningLabel(actSteps, toast) : toast,
    toastShown,
    toastRunning,
    toastFailed,
    toastOffline,
    toastTappable: toastHistoryId !== null || actRunId !== null,
    toastActArming,
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
    showCursor,
    onShowCursorChange,
    appRing,
    onAppRingChange,
    ringClaimRef,
    ringHitRef,
    ringSummonRef,
    onRingRelease,
    zoomTrackOn,
    zoomScale: ringZoomScaleValue,
    onRingZoom,
    viewerScreenW: viewer?.screenW ?? 0,
    viewerScreenH: viewer?.screenH ?? 0,
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
    onCenterCursor,
    // Same recovery the stranded guard runs: a reload reconnects with the
    // credential the form just stored.
    onPaired: retryNow,
    onDisconnect: disconnectFromSettings,
    env: envState,
    onEnvChange,
    cameraOn,
    onCameraChange,
    shareAudio,
    onShareAudioChange,
    micOn,
    onMicChange,
    phoneMicStreamRef,
    systemVolume,
    onSystemVolumeChange,
    onRequestSystemVolume,
    cursorPos,
    cursorVisible,
    cursorStyle,
    trail,
    trailNow
  }

  return {
    connState,
    handoffLabel,
    conflict,
    reconnectAttempt,
    searching,
    tunnelReach,
    send,
    retryNow,
    forceRediscover,
    takeControl,
    role,
    cursorless,
    everConnected,
    backToPairing,
    disconnectAndLeave,
    reconnectSlow,
    envSwitchingTo,
    macControlBlocked,
    macAccountId,
    handsFreeState,
    askMirror,
    answerMirror,
    approvalRequest,
    answerApproval,
    macLocked,
    awayNotice,
    sharedLayoutProps,
    micLabel,
    cameraOn,
    onCameraChange,
    envState,
    remoteLog,
    startChatGptVoiceWithMic
  }
}

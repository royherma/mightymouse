/**
 * The only module that knows about the WKWebView message-handler API.
 *
 * Safari and the installed PWA simply get an unavailable bridge. The native
 * shell adds the handler before the bundle boots, so capability detection can
 * stay feature-based instead of relying on user-agent strings.
 */

import type { PhoneAudioDestination } from '@shared/types'

export type NativeHapticStyle = 'light' | 'medium' | 'rigid'

/** One source at a time, per feature. Never both. */
export type GlassesSource = 'phone' | 'glasses'

export type NativeMessage =
  | { t: 'haptic'; style: NativeHapticStyle }
  | { t: 'hapticWarm'; style: NativeHapticStyle }
  | { t: 'storeCredential'; key: string; value: string }
  | { t: 'removeCredential'; key: string }
  | { t: 'scanQr' }
  /** Diagnostics into the device log. Pairing runs before any socket exists, so
   *  `remoteLog` (a WS send) drops silently on exactly the path that needs it. */
  | { t: 'log'; text: string; level?: 'info' | 'error' }
  | { t: 'exitToPairing'; outcome?: 'notFound' }
  | { t: 'hideDeck' }
  | { t: 'advancedMode'; on: boolean }
  /** Ask Swift for the live notification grant, answered as a `pushStatus`
   *  intent. Read on demand rather than cached: the user can revoke it in iOS
   *  Settings while we're backgrounded, and come back to a stale "Alerts on". */
  | { t: 'pushStatusQuery' }
  /** Deep-link into this app's iOS notification settings. Only Settings can
   *  flip a denied grant back on, so there is no in-app retry to offer. */
  | { t: 'pushSettingsOpen' }
  /** The WebView is the connection authority; this is the only thing Swift
   *  knows about connection state, and it uses it only to time the launch
   *  cover (PRD §2.4/§2.5). Sent on every ConnState transition, no exceptions. */
  | { t: 'connState'; state: string; reason?: string }
  /** Swift deletes its queued clip only on this ack, never speculatively. */
  | { t: 'clipDelivered'; clipId: string }
  /** Persisted into the App Group so the widget (a separate process) can read
   *  it -- see NativeBridge.swift's `hostStatus` case. No `asleep` field: the
   *  widget derives that from `at`'s age, same reasoning as PhoneRemoteEvent's
   *  `hostStatus` (ios/CLAUDE.md: Swift owns no connection state). */
  | { t: 'hostStatus'; batteryPercent: number | null; charging: boolean; hostname: string; at: number }
  /** "The mirror is making noise." Lets the native shell stay awake with the
   *  screen off, and puts the Live Activity up. Only the page can know this --
   *  Swift never inspects the peer connection (ios/CLAUDE.md). */
  | { t: 'audioActivity'; active: boolean }
  /** "This phone's mic is going TO the Mac" -- the opposite direction from
   *  `audioActivity`, which is the Mac's sound arriving here. Its own message
   *  because the Live Activity reads the two as different sentences: a voice
   *  call must say "Hearing you", never "Playing sound from your Mac". */
  | { t: 'phoneMicActivity'; active: boolean }
  /** Separate from `audioActivity` because it must hold the session even with
   *  the Mac's audio OFF -- no audio track means WebKit holds no session, so
   *  the page suspends and the PiP window freezes on its last frame. */
  | { t: 'pipActivity'; active: boolean }
  /** The native PiP layer's H.264 feed. base64 because WKScriptMessage carries
   *  no raw bytes -- Swift decodes, this page never does. */
  | { t: 'pipFrame'; b64: string }
  | { t: 'pipConfig'; width: number; height: number; frameRate: number }
  | { t: 'pipEnded'; reason: string }
  /** Closes the floating window only. The decoder and its feed stay up. */
  | { t: 'pipStopWindow' }
  /** The audio half of the same feed, same base64 reason as pipFrame. */
  | { t: 'pipAudio'; b64: string }
  | { t: 'pipAudioConfig'; sampleRate: number; channels: number }
  /** Meta glasses as a source. DAT runs on the phone, so every one of these is
   *  a Swift-side call the page can neither make nor observe itself. */
  | { t: 'glassesProbe' }
  | { t: 'glassesRegister' }
  | { t: 'glassesMicSource'; source: GlassesSource }
  | { t: 'glassesCameraStart' }
  | { t: 'glassesCameraStop' }
  /** Native capture, because WebKit mutes a getUserMedia track the moment the
   *  app backgrounds. The deck still owns the button, HUD and Stop. */
  /** `macAway` turns on the phone's own transcription for this clip. Sent at
   *  START because that is when the page knows, and the answer cannot change
   *  the clip's fate mid-recording. */
  | { t: 'nativeMicStart'; to: PhoneAudioDestination; macAway: boolean }
  | { t: 'nativeMicStop'; discard: boolean }
  /** "I actually stopped." Swift releases the mirror hold and ends the Live
   *  Activity only on this, never optimistically -- the Stop button's own emit
   *  can be dropped by a backgrounded webview, and ending the activity anyway
   *  is what made Stop look like it worked while the sound kept playing. */
  | { t: 'stopAcknowledged' }
  /** Which relay request card the user is looking at RIGHT NOW, or null for
   *  none. Swift suppresses the foreground banner for exactly this id -- a
   *  banner about the card already filling the screen is pure noise. Only the
   *  page can know this (ios/CLAUDE.md: Swift owns no state), and it must be
   *  sent on every change including back to null, or a stale id would keep
   *  swallowing the one notification the user needed. */
  | { t: 'visibleRelayRequest'; requestId: string | null }
  /** The page ACTED on a tapped notification -- Swift may now forget it. Swift
   *  holds `pendingRelayRequestId` until this arrives rather than clearing it on
   *  emit, because an emit only proves the intent left Swift, not that anything
   *  received it: the bridge exists from `makeUIView`, long before React mounts
   *  a subscriber, so "sent" and "delivered" are different events. */
  | { t: 'relayIntentHandled'; requestId: string }
  /** Photo library, answered as a `photosSearchResult` intent. `requestId` is
   *  echoed back untouched: two searches can be in flight, and arrival order
   *  is not answer order once one of them has to hit iCloud. */
  | {
      t: 'photosSearch'
      requestId: string
      after?: string
      before?: string
      isScreenshot?: boolean
      limit?: number
    }
  /** Only ever sent after a search has already come back `scope: 'none'`, so
   *  the system prompt lands on a user who just saw why it is being asked. */
  | { t: 'photosRequestAccess'; requestId: string }
  /** One photo's bytes, by an id `photosSearch` minted. Answered as
   *  `photosGetResult` -- base64, same reason as pipFrame. */
  | { t: 'photosGet'; requestId: string; id: string }

export type NativeIntent =
  | { type: 'typeText'; text: string }
  /** Answer to `pushStatusQuery`. 'notDetermined' means the grant was never
   *  asked for, which is a different card from a denial -- tapping it can still
   *  raise the system prompt, where a denial can only open Settings. */
  | { type: 'pushStatus'; status: 'authorized' | 'denied' | 'notDetermined' }
  | { type: 'chatSend'; text: string }
  /** The Ask Mighty control button. Carries no text: a ControlWidgetButton
   *  can't collect any, so the sheet's own composer asks. */
  | { type: 'openChat' }
  /** The chat page's Draw button, relayed by Swift once the deck is connected. */
  | { type: 'openDraw' }
  /** The Record control button. Drives the deck's OWN recording rather than a
   *  second recorder, so a Control Center tap and a mic tap are the same
   *  recording with the same waveform and the same Stop. */
  | { type: 'startRecording' }
  /** Siri asked to talk to ChatGPT with the phone as the microphone. Carries no
   *  fields: the page owns every decision about how to bring audio up, and
   *  Swift owns no connection state (ios/CLAUDE.md). */
  | { type: 'startChatGptVoiceWithMic' }
  /** Swift's capture actually opened. The deck waits for this instead of
   *  assuming, so a denied mic can't leave the HUD saying "Recording…".
   *  `source` is what the route ACTUALLY is -- asking for the glasses and
   *  silently getting the phone is the documented HFP failure. */
  | { type: 'nativeMicStarted'; source?: GlassesSource; requested?: GlassesSource }
  /** Whether the glasses can be a source, and the stated reason when not.
   *  `message` is shown verbatim -- the page never composes its own. */
  | { type: 'glassesAvailability'; available: boolean; reason: string; message: string }
  | { type: 'glassesUnavailable'; reason: string; message: string }
  | { type: 'glassesState'; state: 'idle' | 'starting' | 'streaming' | 'stopped' }
  /** The debug HUD's glasses row. No battery percentage because DAT has none --
   *  `batteryCritical` is the whole of what the SDK ever says about the battery,
   *  and only at the moment it ends the session. */
  | {
      type: 'glassesStatus'
      link: string
      name: string
      thermal: string
      batteryCritical: boolean
    }
  /** One base64 JPEG from the wearer's camera, same reason as pipFrame. */
  | { type: 'glassesFrame'; b64: string }
  /** `transcribing` only on a KEPT clip: the phone is writing out the words and
   *  they land seconds later on `clipPhoneText`. Absent on every discard. */
  | { type: 'nativeMicStopped'; discarded: boolean; durationMs?: number; transcribing?: boolean }
  | { type: 'nativeMicFailed'; reason: string }
  /** 0..1, ~10Hz. The waveform's only input when Swift holds the mic: there is
   *  no MediaStream to tap on this path. */
  | { type: 'nativeMicLevel'; level: number }
  /** The Live Activity's Stop button was pressed from outside the app. */
  | { type: 'nativeStopRequested'; stopMirror?: boolean }
  /** The PiP window's play/pause button. It is the one PiP control AVKit
   *  will not let us hide, so it stops the Mac's encoder rather than freezing
   *  a stream both machines keep paying for. */
  | { type: 'pipSetPlaying'; playing: boolean }
  /** Swift diagnostics relayed to the MAC's dev log. Reading the device log
   *  needs a cable and a 40s stream, so a Swift-side gap is otherwise invisible
   *  from the machine that logs the other half of the same pipe. */
  | { type: 'nativeLog'; text: string }
  /** Leaving the screen (`.inactive`) or coming back. From Swift, not
   *  `visibilitychange` -- WKWebView fires that only AFTER the app is
   *  backgrounded, too late for PiP to ever draw. */
  | { type: 'appActive'; active: boolean }
  /** The PiP window has FINISHED closing. AVKit's teardown is async, so this is
   *  the only edge at which the inline <video> is free to be resumed -- a
   *  play() issued when the stop was requested loses the race and leaves the
   *  element paused on iOS's play button. */
  | { type: 'pipDidStop' }
  | { type: 'appSwitchActivate'; bundleId: string }
  | { type: 'openRemote' }
  /** null when the user backed out, so a waiting form can stop waiting. */
  | { type: 'qrScanned'; value: string | null }
  /** A widget-armed recording queued on the phone; native has no websocket. */
  | {
      type: 'queuedClip'
      clipId: string
      durationMs: number
      to: PhoneAudioDestination
      audioBase64: string
      /** What the PHONE heard while it waited, for display only -- the Mac
       *  re-transcribes this same audio and its text is what gets pasted.
       *  Absent when recognition was denied, unavailable, or heard nothing. */
      phoneText?: string
      /** The Mac was unreachable when this was RECORDED. Every native recording
       *  drains through this route, live ones included, so this is the only
       *  thing separating "spoke minutes ago" from "just spoke". */
      macAway?: boolean
    }
  /** The phone finished writing out a queued clip, seconds after saving it.
   *  Separate from `queuedClip` because it fires while the Mac is still
   *  unreachable -- that is the whole point of it. */
  | { type: 'clipPhoneText'; clipId: string; text: string }
  /** The phone couldn't write the clip out. The recording itself is saved and
   *  will still be typed out when the Mac is back -- only the preview is gone. */
  | {
      type: 'clipPhoneTextFailed'
      clipId: string
      reason: 'denied' | 'unsupported' | 'failed' | 'heardNothing'
    }
  /** A relay push (ask/approve/show/notify) was tapped -- open the Code sheet
   *  straight to this request's card instead of wherever the deck was. Fired
   *  live for a warm app, and replayed from `AppModel.drainPendingRelayOpen`
   *  on the deck's `connected` edge for a cold launch. */
  | { type: 'openRelayRequest'; requestId: string }
  /** A lock-screen answer could not be delivered to the Mac. `reason` says which
   *  fix applies, because the two are opposite: `unauthorized` means this phone's
   *  credential is gone and only pairing again recovers it, while `unreachable`
   *  is a sleeping Mac or a dead tunnel that fixes itself. Previously BOTH ended
   *  at an os_log line nobody reads, so a tapped button did nothing at all and
   *  gave no way to find out why (Roy, on device: "I click and it won't work"). */
  | { type: 'relayAnswerFailed'; requestId: string; reason: 'unauthorized' | 'unreachable' }
  /** Metadata only, never pixels -- the whole point of the search half is that
   *  an agent can narrow a library down without any photo leaving the phone.
   *  `scope: 'none'` is not an error: it is the one signal that the permission
   *  card should be offered. */
  | {
      type: 'photosSearchResult'
      requestId: string
      scope: 'none' | 'limited' | 'full'
      matched: number
      photos: PhotoMatch[]
    }
  /** Answer to `photosRequestAccess`. Still `'none'` if the user declined, and
   *  iOS will not ask twice -- from there only Settings can change it. */
  | { type: 'photosAccessResult'; requestId: string; scope: 'none' | 'limited' | 'full' }
  /** Exactly one of `b64` / `error`. `expired` is the ordinary case, not a
   *  fault: ids die when the app backgrounds, so an agent that thought for a
   *  while gets told to search again rather than handed a stale handle. */
  | {
      type: 'photosGetResult'
      requestId: string
      b64?: string
      error?: 'expired' | 'missing' | 'failed'
    }

/** One row of a `photosSearch` answer. `id` is minted per foreground session --
 *  never the PHAsset localIdentifier, which is stable across launches and would
 *  hand the far end a durable handle on someone's library. */
export interface PhotoMatch {
  id: string
  takenAt: string
  isScreenshot: boolean
  w: number
  h: number
  favorite: boolean
}

interface NativeMessageHandler {
  postMessage(message: NativeMessage): void
}

interface NativeWindow extends Window {
  webkit?: {
    messageHandlers?: {
      mightymouse?: NativeMessageHandler
    }
  }
  __MM_NATIVE_BOOTSTRAP__?: {
    credentials?: Record<string, string>
    /** Hardware the page cannot ask the browser about -- see `nativeDevice()`. */
    device?: {
      model?: string
      osVersion?: string
      appBuild?: string
    }
    features?: string[]
    accountId?: string
  }
  __mmNative?: {
    emit(event: NativeIntent): void
  }
}

const intentSubscribers = new Set<(event: NativeIntent) => void>()

/** Intents that represent a USER DECISION and are still worth acting on late.
 *  Everything else (mic levels, connection chatter) is worthless stale and must
 *  not be replayed -- a buffered `nativeMicLevel` would paint a waveform for
 *  audio that finished minutes ago. */
const REPLAYABLE_INTENTS: ReadonlySet<NativeIntent['type']> = new Set([
  'openRelayRequest',
  'relayAnswerFailed',
  'openChat',
  'openDraw',
  'startRecording',
  // Dropped silently, this leaves capture live with the button painted idle --
  // and no trace anywhere, which is what made the 2026-08-15 regression cost a
  // session to diagnose. Replaying it is safe: the handler is idempotent.
  'nativeMicStarted',
  // MUST be here: a Siri launch emits this while the app is still booting, so
  // there are no subscribers yet and a non-replayable intent is dropped on the
  // floor -- which is every cold-start use of the phrase, the only one that
  // matters.
  'startChatGptVoiceWithMic'
])

/** Bounded: a page that never mounts a subscriber must not grow this forever,
 *  and only the most recent taps are worth honoring anyway. */
const MAX_PENDING_INTENTS = 16

/** Emits that arrived before any subscriber existed. Swift sets
 *  `NativeIntentRouter.bridge` in `makeUIView` -- before the page loads, let
 *  alone before React mounts -- so `emit` reaching an empty subscriber set is
 *  the NORMAL cold-launch ordering, not an edge case. Without this the forEach
 *  below iterated nothing and the tap was gone with no error. */
let pendingIntents: NativeIntent[] = []

/** Told when a buffered intent is evicted unreplayed, so the drop can be
 *  journaled instead of vanishing. Set by App.tsx once it can reach the WS. */
let onIntentDropped: ((event: NativeIntent) => void) | null = null

export function setIntentDropReporter(report: (event: NativeIntent) => void): void {
  onIntentDropped = report
}

type IntentType = NativeIntent['type']
// `claims` omitted = catch-all; an app subscriber lists the replayable types it acts on, or a buffered tap goes to whoever mounts first and is lost.
const intentClaims = new Map<(event: NativeIntent) => void, ReadonlySet<IntentType> | null>()

function claimed(event: NativeIntent): boolean {
  for (const claims of intentClaims.values()) if (!claims || claims.has(event.type)) return true
  return false
}

export function subscribeNativeIntent(
  subscriber: (event: NativeIntent) => void,
  claims?: readonly IntentType[]
): () => void {
  const claimSet = claims ? new Set(claims) : null
  intentSubscribers.add(subscriber)
  intentClaims.set(subscriber, claimSet)
  const mine = pendingIntents.filter((event) => !claimSet || claimSet.has(event.type))
  if (mine.length > 0) {
    pendingIntents = pendingIntents.filter((event) => !mine.includes(event))
    mine.forEach((event) => subscriber(event))
  }
  return () => {
    intentSubscribers.delete(subscriber)
    intentClaims.delete(subscriber)
  }
}

let latestMicLevel = 0

let micClaimed = false
const micClaimSubscribers = new Set<(claimed: boolean) => void>()

/** True from the mic press until Swift's recorder reports stopped or failed. */
export function nativeMicClaimed(): boolean {
  return micClaimed
}

export function subscribeNativeMicClaim(subscriber: (claimed: boolean) => void): () => void {
  micClaimSubscribers.add(subscriber)
  return () => micClaimSubscribers.delete(subscriber)
}

export function setNativeMicClaim(claimed: boolean): void {
  if (micClaimed === claimed) return
  micClaimed = claimed
  micClaimSubscribers.forEach((subscriber) => subscriber(claimed))
}

/** Linear amplitude, the unit `MicWaveform` already reads off a MediaStream.
 *  A module value rather than a prop: there is exactly one native recorder, and
 *  the alternative is threading a level through five layouts to reach one view. */
export function nativeMicLevel(): number {
  return latestMicLevel
}

function installNativeEventSink(): void {
  if (typeof window === 'undefined') return
  const target = window as NativeWindow
  target.__mmNative = {
    emit(event) {
      if (event.type === 'nativeMicLevel') latestMicLevel = event.level
      if (event.type === 'nativeMicStopped') latestMicLevel = 0
      if (event.type === 'nativeMicStopped' || event.type === 'nativeMicFailed') setNativeMicClaim(false)
      if (REPLAYABLE_INTENTS.has(event.type) && !claimed(event)) {
        intentSubscribers.forEach((subscriber) => subscriber(event))
        pendingIntents.push(event)
        // Oldest first: a newer tap is what the user is waiting on.
        while (pendingIntents.length > MAX_PENDING_INTENTS) {
          const dropped = pendingIntents.shift()
          if (dropped) onIntentDropped?.(dropped)
        }
        return
      }
      intentSubscribers.forEach((subscriber) => subscriber(event))
    }
  }
}

installNativeEventSink()

function getHandler(): NativeMessageHandler | null {
  if (typeof window === 'undefined') return null
  return (window as NativeWindow).webkit?.messageHandlers?.mightymouse ?? null
}

export const nativeBridge = {
  get available(): boolean {
    return getHandler() !== null
  },

  haptic(style: NativeHapticStyle): void {
    getHandler()?.postMessage({ t: 'haptic', style })
  },

  /** Spin the Taptic Engine up before a burst of ticks, so the first detent of
   *  a drag lands as crisply as the tenth. No-op off the native shell. */
  hapticWarm(style: NativeHapticStyle): void {
    getHandler()?.postMessage({ t: 'hapticWarm', style })
  },

  storeCredential(key: string, value: string): void {
    getHandler()?.postMessage({ t: 'storeCredential', key, value })
  },

  removeCredential(key: string): void {
    getHandler()?.postMessage({ t: 'removeCredential', key })
  },

  /** Opens the native Vision scanner; the result arrives as a `qrScanned`
   *  intent. No web equivalent exists -- iOS ships no BarcodeDetector. */
  scanQr(): void {
    getHandler()?.postMessage({ t: 'scanQr' })
  },

  /** Photo library, all three answered as intents carrying the same
   *  `requestId`. No-op off the native shell: Safari has no library API, so a
   *  web-shell phone simply never answers and the Mac times out. */
  photosSearch(query: {
    requestId: string
    after?: string
    before?: string
    isScreenshot?: boolean
    limit?: number
  }): void {
    getHandler()?.postMessage({ t: 'photosSearch', ...query })
  },

  photosRequestAccess(requestId: string): void {
    getHandler()?.postMessage({ t: 'photosRequestAccess', requestId })
  },

  photosGet(requestId: string, id: string): void {
    getHandler()?.postMessage({ t: 'photosGet', requestId, id })
  },

  /** Into the device log, under the `pairing` category. No-op off native. */
  log(text: string, level?: 'info' | 'error'): void {
    getHandler()?.postMessage({ t: 'log', text, level })
  },

  /** Leave the deck for the native onboarding/pair screen. Native-only: no
   *  other shell has anywhere to go back TO -- the web app is the whole app. */
  exitToPairing(outcome?: 'notFound'): void {
    getHandler()?.postMessage(outcome ? { t: 'exitToPairing', outcome } : { t: 'exitToPairing' })
  },

  canExitNotFound(): boolean {
    if (typeof window === 'undefined') return false
    return (window as NativeWindow).__MM_NATIVE_BOOTSTRAP__?.features?.includes('exitNotFound') === true
  },

  canHideDeck(): boolean {
    if (typeof window === 'undefined') return false
    return (window as NativeWindow).__MM_NATIVE_BOOTSTRAP__?.features?.includes('hideDeck') === true
  },

  hideDeck(): void {
    getHandler()?.postMessage({ t: 'hideDeck' })
  },

  isSimpleApp(): boolean {
    if (typeof window === 'undefined') return false
    return (window as NativeWindow).__MM_NATIVE_BOOTSTRAP__?.features?.includes('simple') === true
  },

  advancedMode(on: boolean): void {
    getHandler()?.postMessage({ t: 'advancedMode', on })
  },

  pushStatusQuery(): void {
    getHandler()?.postMessage({ t: 'pushStatusQuery' })
  },

  pushSettingsOpen(): void {
    getHandler()?.postMessage({ t: 'pushSettingsOpen' })
  },

  connState(state: string, reason?: string): void {
    getHandler()?.postMessage({ t: 'connState', state, reason })
  },

  clipDelivered(clipId: string): void {
    getHandler()?.postMessage({ t: 'clipDelivered', clipId })
  },

  hostStatus(status: { batteryPercent: number | null; charging: boolean; hostname: string; at: number }): void {
    getHandler()?.postMessage({ t: 'hostStatus', ...status })
  },

  /** Idempotent on the Swift side, so callers may re-assert freely. */
  audioActivity(active: boolean): void {
    getHandler()?.postMessage({ t: 'audioActivity', active })
  },

  /** Idempotent on the Swift side, so callers may re-assert freely. */
  phoneMicActivity(active: boolean): void {
    getHandler()?.postMessage({ t: 'phoneMicActivity', active })
  },

  pipFrame(b64: string): void {
    getHandler()?.postMessage({ t: 'pipFrame', b64 })
  },

  pipConfig(width: number, height: number, frameRate: number): void {
    getHandler()?.postMessage({ t: 'pipConfig', width, height, frameRate })
  },

  pipEnded(reason: string): void {
    getHandler()?.postMessage({ t: 'pipEnded', reason })
  },

  pipStopWindow(): void {
    getHandler()?.postMessage({ t: 'pipStopWindow' })
  },

  pipAudio(b64: string): void {
    getHandler()?.postMessage({ t: 'pipAudio', b64 })
  },

  pipAudioConfig(sampleRate: number, channels: number): void {
    getHandler()?.postMessage({ t: 'pipAudioConfig', sampleRate, channels })
  },

  /** Idempotent on the Swift side, so callers may re-assert freely. */
  pipActivity(active: boolean): void {
    getHandler()?.postMessage({ t: 'pipActivity', active })
  },

  /** Idempotent on the Swift side, so callers may re-assert freely. */
  visibleRelayRequest(requestId: string | null): void {
    getHandler()?.postMessage({ t: 'visibleRelayRequest', requestId })
  },

  /** Sent whether the card opened or turned out to be gone: both mean this tap
   *  is finished and must not re-arm on the next launch. */
  relayIntentHandled(requestId: string): void {
    getHandler()?.postMessage({ t: 'relayIntentHandled', requestId })
  },

  /** Ask whether the glasses can be a source. Answered by `glassesAvailability`
   *  -- never inferred from silence. */
  glassesProbe(): void {
    getHandler()?.postMessage({ t: 'glassesProbe' })
  },

  /** Leaves the app for the Meta AI approval screen, so only fire on a tap. */
  glassesRegister(): void {
    getHandler()?.postMessage({ t: 'glassesRegister' })
  },

  glassesMicSource(source: GlassesSource): void {
    getHandler()?.postMessage({ t: 'glassesMicSource', source })
  },

  glassesCameraStart(): void {
    getHandler()?.postMessage({ t: 'glassesCameraStart' })
  },

  glassesCameraStop(): void {
    getHandler()?.postMessage({ t: 'glassesCameraStop' })
  },

  nativeMicStart(to: PhoneAudioDestination, macAway: boolean): void {
    setNativeMicClaim(true)
    getHandler()?.postMessage({ t: 'nativeMicStart', to, macAway })
  },

  nativeMicStop(discard: boolean): void {
    getHandler()?.postMessage({ t: 'nativeMicStop', discard })
  },

  /** Idempotent on the Swift side: a duplicate ack (the emit landed AND the
   *  App Group flag drained) releases already-released holds, which no-ops. */
  stopAcknowledged(): void {
    getHandler()?.postMessage({ t: 'stopAcknowledged' })
  },

  phoneAccountId(): string | null {
    if (typeof window === 'undefined') return null
    return (window as NativeWindow).__MM_NATIVE_BOOTSTRAP__?.accountId ?? null
  },

  bootstrapCredential(key: string): string | null {
    if (typeof window === 'undefined') return null
    return (window as NativeWindow).__MM_NATIVE_BOOTSTRAP__?.credentials?.[key] ?? null
  },

  /** The shell injected its bootstrap, whether or not the message handler is
   *  attached yet. Only the native app ever sets this, so it is a second proof
   *  of a native launch for the one check that must not get it wrong. */
  bootstrapPresent(): boolean {
    if (typeof window === 'undefined') return false
    return (window as NativeWindow).__MM_NATIVE_BOOTSTRAP__ != null
  },

  /**
   * The raw hardware identifier (`iPhone17,1`) and OS version, or nulls off the
   * native shell. The Mac maps the identifier to a marketing name -- doing it
   * there means a phone released after this build still gets named.
   *
   * Empty strings are normalized to null: `CFBundleVersion` can be absent, and
   * an empty value would erase a good stored one on the Mac's latch.
   */
  device(): { deviceModel: string | null; osVersion: string | null } {
    if (typeof window === 'undefined') return { deviceModel: null, osVersion: null }
    const device = (window as NativeWindow).__MM_NATIVE_BOOTSTRAP__?.device
    return { deviceModel: device?.model || null, osVersion: device?.osVersion || null }
  }
}

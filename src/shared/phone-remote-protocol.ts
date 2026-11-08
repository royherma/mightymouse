/** Shared phone↔Mac WebSocket messages. Keep this file type-only for both bundles. */
import type {
  InstallableSkin,
  PhoneRemoteColorScheme,
  PhoneRemoteHandedness,
  PhoneRemoteKeysPosition,
  PhoneRemoteDeckMode,
  PhoneRemoteSplitConcept,
  PhoneRemoteMirrorPlacement,
  PhoneAudioDestination,
  RunFailReason,
  RunState,
  AgentRelayStatus,
  AgentRelaySessionInfo,
  SessionMark,
  AgentChecklist,
  AgentHelper,
  AgentToolUse,
  AgentTranscriptTurn,
  CheckpointResult,
  TurnUndoState,
  RepoPull
} from './types'
import type { ProjectIdea } from './project-ideas'
import type {
  PhoneRemoteKeyName,
  PhoneRemoteModifier,
  HostKeyboard,
  HostDevice,
  PadGesture,
  TmuxAction
} from './phone-remote-keys'
import type { RemoteCapState } from './phone-remote-limits'
import type { AppContext } from './app-context'
import type { RelayInterviewAnswer, RelayQuestion } from './relay-interview'
import type { DecisionWire } from './decision-score'
import type { Suggestion } from './swipe-suggest'
import type { PulseScope, PulseState } from './session-pulse'
import type { Capabilities as HostCapabilities } from '../main/platform/contract'
import type { InkOp, InkSendTarget } from './ink'

/** Code agent relay wire shapes. Deliberately NOT imported from
 *  main/agent-relay/store.ts -- that module pulls in Node's fs/crypto, which
 *  the phone bundle (browser build) can't carry. Kept structurally identical
 *  to RelayRequestParams/RelayResponse/RelayVerb so server.ts can pass a
 *  RelayRequest through with only a shape cast, no field-by-field mapping. */
export type RelayVerbWire = 'notify' | 'ask' | 'approve' | 'show' | 'photos_get'

/** `restore` is not geometry -- it replays the rects stashed before the last
 *  layout. Same union so the Mac's exhaustiveness check covers it. */
export type WindowLayoutKind =
  | 'left'
  | 'right'
  | 'top'
  | 'bottom'
  | 'full'
  | 'leftRight'
  | 'topBottom'
  | 'quarters'
  | 'restore'

export interface RelayRequestParamsWire {
  from?: string
  /** Where the calling agent runs. Was an untyped `...rest` spread field --
   *  present in the JSON, absent from the type -- until the HUD needed it. */
  cwd?: string
  test?: boolean
  title?: string
  body?: string
  level?: 'info' | 'success' | 'warn' | 'error'
  /** notify only. progress = still working, done = just finished. Absent = done. */
  state?: 'done' | 'progress'
  /** 0-1, how far through the whole job. Rides as a plain number -- the phone
   *  draws it as a ring or a bar, and multiplies by 100 itself. */
  progress?: number
  question?: string
  options?: string[]
  /** A multi-question `ask`, whole array up front. ADDITIVE: `question`/`options`
   *  still carry question 0 so every existing surface renders an N>1 card as a
   *  single-question one until it learns to step. Absent for N=1. */
  questions?: RelayQuestion[]
  /** Answers collected so far, one per question index. Rides the wire so a card
   *  opened on a second surface resumes at the right question instead of
   *  restarting the interview. */
  buffered?: RelayInterviewAnswer[]
  /** Whether the Mac can READ the terminal this came from (a tmux pane id). The
   *  derived boolean, not the origin: it is the only fact the card needs, and
   *  the phone has no business holding pane ids. Decides whether an interview
   *  can be finished here or hands back after Q1 (PRD §5). */
  canReadPane?: boolean
  context?: string
  decision?: DecisionWire
  action?: string
  detail?: string
  risk?: 'low' | 'high'
  /** Mac-only: it renders the file through media://. Stripped for the phone,
   *  which can't read the Mac's filesystem -- use `hasImage` there. */
  imagePath?: string
  /** Both surfaces: "this card carries a picture". The phone has no path to
   *  test, so without it every image-bearing card rendered as text only. */
  hasImage?: boolean
  caption?: string
  waitForAck?: boolean
  /** notify only. The Notification hook's "this agent is waiting" ping, which
   *  settles on send and must open the session sheet rather than Needs you. */
  idle?: boolean
}

export type SessionGitOp = 'status' | 'open' | 'merge'

/** Every way a card can stop being open. A superset of what a phone may SEND:
 *  'screen' and 'timeout' are outcomes the Mac produces on its own, so they can
 *  be reported back on a resolved card but never arrive as an answer. Declared
 *  here rather than in the store because it now crosses the wire -- the store
 *  imports this one rather than keeping a second copy that could drift. */
/** One row of a photo search. Mirrors PhotoMatch in the phone's native-bridge,
 *  which is where the values originate; duplicated rather than imported because
 *  this file is shared with the Mac and must not pull in phone-only code. */
export interface PhotoMatchWire {
  /** Minted per foreground session on the phone -- never a PHAsset identifier,
   *  which is stable across launches and would outlive the user's intent. */
  id: string
  takenAt: string
  isScreenshot: boolean
  w: number
  h: number
  favorite: boolean
}

/** What an agent may narrow a photo search by. Date + type only (PRD decision
 *  3): album and location were cut because both leak far more than the one
 *  photo the agent is actually after. */
export interface PhoneMatchQuery {
  /** Inclusive, `YYYY-MM-DD` or full ISO-8601. */
  after?: string
  /** EXCLUSIVE, so `before: '2026-04-01'` means "through March 31". */
  before?: string
  isScreenshot?: boolean
  limit?: number
}

export type RelayResolvedViaWire = 'chip' | 'typed' | 'screen' | 'timeout' | 'note' | 'dismiss'

/** Phone -> Mac only. `via` is which control on the card produced the answer
 *  -- the server can't infer it from the payload shape alone (a typed answer
 *  and a tapped chip both just set `answer`). */
export interface RelayResponseWire {
  answer?: string
  /** Which question of a multi-question ask this answers. The card states its
   *  own cursor rather than letting the Mac re-derive it -- two derivations of
   *  one decision is the bug that shipped three times in app-switching. */
  questionIndex?: number
  /** This answer REPLACES the one already held for `questionIndex` -- set only
   *  by a card that stepped BACK onto a question it can see is answered. The
   *  Mac cannot tell a deliberate change from two surfaces racing, so the
   *  surface that navigated states it. */
  revise?: boolean
  /** 0-based option rows for a multiSelect question, alongside `answer`'s joined labels. */
  picks?: number[]
  approved?: boolean
  note?: string
  acked?: boolean
  /** Clear the card without answering it. Carries no answer by construction --
   *  the whole point is that the agent learns nobody chose anything, so any
   *  answer field alongside this would be contradictory. */
  dismissed?: boolean
  via: 'chip' | 'typed' | 'note' | 'dismiss'
}

/** Mac -> phone only: an already-settled response echoed back on a resolved
 *  card. No `via` -- that's an input the phone SENT, never a fact about a
 *  card it's merely displaying. */
export type RelayResponseEcho = Omit<RelayResponseWire, 'via'>

/** What both Code sheets render: the phone gets it in a `relayPending` WS
 *  event, the Mac panel over IPC. One shape, because both show the same cards
 *  off the same store. */
export interface RelaySnapshotWire {
  pending: RelayRequestWire[]
  resolved: RelayRequestWire[]
  /** Cleared without an answer. Its own list, not part of `resolved`: "what I
   *  answered" and "what I threw away" are different questions. */
  dismissed: RelayRequestWire[]
}

/** Where a notification tap ended up: opened the card, the id was in neither
 *  list, or the sheet was shut. All three are "tapping did nothing" in the
 *  hand, so they are separate values. Read them with `make phone-log`. */
/** `dropped` is the one that means the phone never got to decide: the intent was
 *  buffered before any subscriber existed and aged out. Without it a lost tap
 *  produces NO journal row at all, which reads as "no tap happened" and sends
 *  the next debugger at the wrong half of the pipe. */
export const RELAY_TAP_OUTCOMES = [
  'detail',
  'session',
  'not-in-list',
  'sheet-closed',
  'dropped'
] as const

/** Derived from the array so the Mac's runtime check cannot fall behind it. */
export type RelayTapOutcome = (typeof RELAY_TAP_OUTCOMES)[number]

/** Why a tap reached the sheet but landed on nothing. Separate from
 *  `RelayTapOutcome` because these two share the journal's `session` outcome --
 *  the tab switch succeeded either way, only the selection failed. */
export type RelayTapMissReason = 'not-in-list' | 'session-gone'

export interface RelayRequestWire {
  id: string
  verb: RelayVerbWire
  params: RelayRequestParamsWire
  createdAt: number
  /** How long the Mac will honour this request. A fact about the card, not an
   *  input the phone sends -- the countdown must expire when the Mac stops
   *  waiting, so the phone reads this rather than assuming the 600s default. */
  timeoutMs: number
  status: 'pending' | 'resolved' | 'timedout' | 'dismissed'
  response: RelayResponseEcho | null
  /** Epoch ms this stopped being open. The store has always held it; without it
   *  on the wire a Previous card could only date itself by when it was ASKED,
   *  which is the one timestamp the reader already knows. Null while pending. */
  resolvedAt?: number | null
  /** Which surface ended it. Lets a Previous card say where the answer came
   *  from -- an answer given on the phone looks identical to one given on the
   *  Mac otherwise, and "did I already deal with this?" is the usual question. */
  resolvedVia?: RelayResolvedViaWire | null
  /** A dismiss the agent has not been told about yet, so it can still be taken
   *  back. Absent once the window closes -- at which point the agent's call has
   *  already returned and there is nothing left to undo. */
  undoable?: boolean
  /** Label of the open session sharing this card's pane; survives an agent rename. */
  sessionLabel?: string
}
/**
 * Why the mirror picture stopped. Closed set: on a cursorless host every one of
 * these re-arms the "See your Mac here?" prompt identically, so the prompt
 * coming back says nothing about which happened. Only 'user' and 'restart' are
 * expected during normal use -- the rest are the picture failing.
 */
export type MirrorStopCause =
  /** The user answered No, or toggled the mirror off. */
  | 'user'
  /** A quality/mode switch is restarting the stream on purpose. */
  | 'restart'
  /** WebRTC never reached `connected` before MIRROR_CONNECT_TIMEOUT_MS. */
  | 'connect-timeout'
  /** The peer connection reported `failed` after having been up. */
  | 'ice-failed'
  /** The Mac stopped the capture (its own error path, or the source vanished). */
  | 'mac-stopped'
  /** The control socket dropped, which tears the mirror down with it. */
  | 'disconnected'
  /** `createOffer`/`setLocalDescription` threw before an offer ever went out. */
  | 'offer-failed'

/** Flat discriminated union keeps every handler exhaustive. */
export type ModelScope = 'chat' | 'code'
export type ModelOptionWire = { id: string; label: string; icon: string }

export type PhoneRemoteMessage =
  | { type: 'move'; dx: number; dy: number }
  | { type: 'tap' }
  | { type: 'doubleTap' }
  | { type: 'twoFingerTap' }
  | { type: 'dragStart' }
  | { type: 'dragMove'; dx: number; dy: number }
  | { type: 'dragEnd' }
  | { type: 'centerCursor' }
  | { type: 'mirrorWarp'; nx: number; ny: number; snap?: boolean }
  | { type: 'ink'; ink: InkOp }
  | { type: 'scroll'; dx: number; dy: number }
  | { type: 'debugLog'; message: string }
  | { type: 'setSensitivity'; value: number }
  | { type: 'getSensitivity' }
  | { type: 'setCursorSize'; value: number }
  | { type: 'setCursorAnimated'; value: boolean }
  | { type: 'getEnv' }
  | { type: 'setEnv'; value: 'staging' | 'prod' }
  /** The paired phone's verdict on a device waiting to be let in. `id` scopes it
   *  to the request the phone was actually shown -- a stale tap arriving after
   *  that request expired must not admit whoever is waiting now. */
  | { type: 'approvalVerdict'; id: string; allow: boolean }
  // Carries no device id on purpose: the Mac revokes whichever credential THIS
  // socket authenticated with, so a phone can never evict another device.
  | { type: 'unpairSelf' }
  | { type: 'getLayoutPrefs' }
  | { type: 'setSkin'; value: InstallableSkin }
  | { type: 'setColorScheme'; value: PhoneRemoteColorScheme }
  | { type: 'setHandedness'; value: 'left' | 'right' }
  | { type: 'setKeysPosition'; value: PhoneRemoteKeysPosition }
  | { type: 'setDeckMode'; value: PhoneRemoteDeckMode }
  | { type: 'setSplitConcept'; value: PhoneRemoteSplitConcept }
  | { type: 'setMirrorPlacement'; value: PhoneRemoteMirrorPlacement }
  | { type: 'setShowCursor'; value: boolean }
  | { type: 'setAppRing'; value: boolean }
  | { type: 'setRenderMarkup'; value: boolean }
  // Arrange one or two apps' windows. Bundle ids are in slot order and the
  // handler validates every one against the switchable-apps list.
  | { type: 'windowLayout'; kind: WindowLayoutKind; bundleIds: string[] }
  | { type: 'appSwitchOpen' }
  | { type: 'appSwitchActivate'; bundleId: string }
  // `steps` is clamped server-side.
  | { type: 'appSwitchQuick'; steps: number }
  | { type: 'appSwitchMru' }
  // Item and group ids are opaque strings issued by the Mac.
  | { type: 'appContext' }
  | { type: 'appActivateItem'; itemId: string }
  | { type: 'appActivateGroup'; groupId: string }
  // A tmux pane id (`%47`), issued by tmux and echoed back untouched.
  | { type: 'appActivatePane'; paneId: string }
  // Clipboard contents never cross the tunnel.
  | { type: 'clipboardState' }
  | { type: 'pasteClipboard' }
  // The handler validates both fields at runtime.
  | { type: 'pressKey'; key: PhoneRemoteKeyName; modifiers?: PhoneRemoteModifier[] }
  | { type: 'padGesture'; gesture: PadGesture }
  // Signed notch count, + = zoom in. Clamped host-side, never trusted raw.
  | { type: 'padZoom'; steps: number }
  | { type: 'tmuxAction'; action: TmuxAction }
  | { type: 'typeText'; text: string }
  | { type: 'deleteText'; count: number }
  | {
      type: 'audioMeta'
      durationMs: number
      to?: PhoneAudioDestination
      id?: string
      /** Only on a clip the phone queued while offline: what IT heard. The Mac
       *  re-transcribes the audio anyway and that result wins -- this is for
       *  diagnosing a mismatch, never for pasting. */
      phoneText?: string
      /** This clip was recorded while the Mac was away and is draining now, so
       *  it is NOT live: the user spoke minutes ago and is looking at some other
       *  app. It transcribes silently -- no HUD, no auto-paste -- and lands in
       *  History, which is the only place a late transcript can go without
       *  typing into whatever happens to be frontmost. */
      queued?: boolean
    }
  | { type: 'audioCancel'; id: string }
  /** Answer to a `photosSearch` event. Metadata only -- no photo has left the
   *  phone at this point, which is the whole reason search and fetch are two
   *  steps. `scope` is the permission the phone actually has, and 'none' is a
   *  normal answer that offers the upgrade card rather than an error. */
  | {
      type: 'photosSearchResult'
      requestId: string
      scope: 'none' | 'limited' | 'full'
      matched: number
      photos: PhotoMatchWire[]
    }
  /** Answer to `photosRequestAccess`: the scope AFTER the user decided. */
  | { type: 'photosAccessResult'; requestId: string; scope: 'none' | 'limited' | 'full' }
  /** A `photosFetch` that produced no bytes. The success path sends imageMeta
   *  plus the blob instead, so this exists only to end the Mac's wait -- without
   *  it a denied or expired id burns the full timeout for a known answer. */
  | {
      type: 'photosFetchFailed'
      requestId: string
      reason: 'expired' | 'missing' | 'failed' | 'unsupported'
    }
  /** Precedes the image bytes on the binary channel, same one-shot stash as
   *  `audioMeta`. `submit` presses Return after the paste lands: it rides the
   *  message because the surface that knows the user's intent is the one that
   *  states it, and pasting into the wrong window is recoverable where sending
   *  is not. */
  | {
      type: 'imageMeta'
      mime: string
      byteLength: number
      name?: string
      submit?: boolean
      /** Set when this image ANSWERS a photos_get card rather than being pushed
       *  from the share sheet. Routes the bytes to that pending request instead
       *  of the Mac's cursor -- an agent asked for this one, so pasting it into
       *  whatever window happens to be frontmost would be wrong. */
      requestId?: string
      /** Set when the user attached this to a reply they are composing to an
       *  agent. The Mac holds the written path against this label until the
       *  `relaySessionReply` arrives, then types it into the pane ahead of the
       *  message -- a CLI reads an image by reading the path.
       *
       *  A LABEL, never a path: the file lives on the Mac, and the rule at the
       *  top of this file (a Mac path must not ride the wire) applies to the
       *  return leg too. The phone names the conversation; the Mac keeps the
       *  filesystem to itself. */
      replyToLabel?: string
      /** Set by the Draw page: the bytes are the finished drawing, copied (and opened) on the Mac, never pasted. */
      ink?: InkSendTarget
    }
  // Optional fields preserve compatibility with cached phone bundles.
  | {
      type: 'mirrorStart'
      sdp: string
      // 'glasses' is host-selected, not user-picked -- see
      // react/mirror-quality.ts. An older cached phone bundle can still send
      // only the first two, which is why this stays a plain union here.
      quality: 'capped' | 'native' | 'glasses'
      shareAudio?: boolean
      mode?: 'mirror' | 'extended' | 'audio'
    }
  | { type: 'mirrorSetAudio'; on: boolean }
  // The phone's own mic. Toggling is local (track.enabled), so this message
  // exists only to tell the Mac -- which needs to know to open the virtual
  // input device, show the live indicator, and optionally duck computer audio.
  /** `startChatGptVoice` rides this message instead of being one of its own so
   *  the Mac cannot observe the mic going live and the request to press apart:
   *  ChatGPT reads its input device when the session opens, so the press must
   *  happen strictly after the phone mic is claimed. */
  | { type: 'phoneMicSet'; on: boolean; startChatGptVoice?: boolean }
  // The MAC's output volume, not the phone's playback level: iOS Safari ignores
  // programmatic volume on a media element, so the slider has to move the
  // source. 0-100, validated Mac-side before it reaches osascript.
  | { type: 'setSystemVolume'; volume: number }
  | { type: 'getSystemVolume' }
  | { type: 'mirrorIceCandidate'; candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }
  /** `cause` is journalled, so it is a closed set rather than free text: the
   *  question it answers is "was that my rebuild or a real drop", which needs
   *  counting, not prose. Optional because a plain user toggle carries none. */
  | { type: 'mirrorStop'; cause?: MirrorStopCause }
  | { type: 'mirrorDiag'; detail: string }
  | { type: 'mirrorGetIceServers' }
  // Native PiP (prds/active/2026-08-09-*-native-pip.md). iOS-app only -- the
  // web deck can't decode what these start.
  | { type: 'pipStreamStart' }
  | { type: 'pipStreamStop' }
  /** The floating window's play/pause. Distinct from `pipStreamStop`: the
   *  window stays up and the phone keeps its audio session, so resuming needs
   *  no new PiP grant from iOS -- only the encoder stops and restarts. */
  | { type: 'pipStreamSetPlaying'; playing: boolean }
  | { type: 'getDictationHistory'; offset?: number }
  // `id`, never the text: the server only re-types something it transcribed
  // itself, so the phone cannot inject arbitrary keystrokes into the Mac.
  | { type: 'pasteDictation'; id: string }
  | { type: 'getReferralCode' }
  | { type: 'sendInvite'; email: string }
  | { type: 'actDictation'; id: string }
  | { type: 'stopRun'; runId: string }
  | { type: 'chatListSessions'; offset?: number }
  | { type: 'chatGetSession'; id: string }
  | { type: 'chatSend'; sessionId?: string; text: string; projectId?: string }
  | { type: 'sessionMark'; session: AgentRelaySessionInfo; change: SessionMark }
  | { type: 'sessionArchiveImport'; entries: unknown }
  | { type: 'chatStop'; sessionId: string }
  | { type: 'modelsGet'; scope: ModelScope }
  | { type: 'modelsSet'; scope: ModelScope; id: string }
  // Code agent relay (PRD 2026-08-12-1786501335 §6b): answer a pending
  // notify/ask/approve/show card from the phone's Code sheet.
  | { type: 'relayRespond'; requestId: string; response: RelayResponseWire }
  // Put a cleared card back in the inbox. Only honoured while the dismiss is
  // still `undoable` -- past that the agent has already been told, so the Mac
  // refuses rather than staging a card whose answer is long gone.
  | { type: 'relayUndismiss'; requestId: string }
  // Where a notification tap actually landed. Diagnostic only -- the Mac just
  // journals it. A tap that opens the wrong screen leaves no other trace: the
  // phone is the only side that knows whether the card was even in its list.
  | { type: 'relayTapTrace'; requestId: string; outcome: RelayTapOutcome }
  // Which kinds of message may buzz this phone. Mac-owned because it gates the
  // SEND, so this asks rather than setting a local pref.
  | { type: 'relayGetPushFilter' }
  | { type: 'relaySetPushFilter'; verb: RelayVerbWire; on: boolean }
  // The severity floor under `notify`. Its own message, not a fifth verb: it
  // narrows one switch rather than toggling one.
  | { type: 'relaySetNotifyLevel'; level: 'all' | 'problems' }
  // Opt-in ping when an agent's turn ends. Not a fifth verb either: it is
  // fired by a Claude Code Stop hook, not by an agent choosing to speak.
  | { type: 'relaySetTurnEndPing'; on: boolean }
  /** Last lines of this agent's pane, for the session sheet when it has no
   *  relay card yet. Label is the session's own, never re-derived. */
  | { type: 'relaySessionPeek'; label: string }
  /** Type into this agent's pane. Same label join as peek. */
  | { type: 'relaySessionReply'; label: string; text: string }
  /** Interrupt this agent mid-turn (Esc into its pane). */
  | { type: 'relaySessionStop'; label: string }
  /** What have I already said to this agent? Asked when the thread opens, so a
   *  reloaded phone gets its own half of the conversation back. */
  | { type: 'relaySessionSentGet'; label: string }
  /** Raise this agent's window ON THE MAC. Same label join as reply -- the
   *  origin never rides the wire, main looks it up in its own list. */
  | { type: 'relaySessionReveal'; label: string }
  /** Zoom this agent's tmux pane on the Mac. `on` is the WANTED state, not a
   *  toggle: `resize-pane -Z` toggles, so a double-tap would undo itself. */
  | { type: 'relaySessionZoom'; label: string; on: boolean }
  /** End this agent: ask it to finish, then close it. Same label join again --
   *  a pid off the wire would let a phone name any process on the Mac. */
  | { type: 'relaySessionWrap'; label: string }
  | { type: 'relaySessionGit'; label: string; op: SessionGitOp }
  /** Undo the files back to before the message at `at`, or put them back if it is already undone. */
  | { type: 'relaySessionUndo'; label: string; at: number }
  /** Project by id, never a folder: the Mac maps it to a path. `attachLabel` claims a photo sent with that `replyToLabel`. */
  | {
      type: 'relayStartSession'
      requestId: string
      projectId: string
      text: string
      harness?: 'claude' | 'codex'
      attachLabel?: string
    }
  | { type: 'relayProjects' }
  | { type: 'relayProjectIdeas'; projectId: string; mode?: 'cached' | 'generate' | 'refresh' }
  | { type: 'relaySessionTranscript'; label: string }
  | { type: 'relaySessionInfo'; label: string }
  | { type: 'pulseGet'; label: string }
  | { type: 'pulseScore'; label: string; force?: boolean }
  | { type: 'pulseSetScope'; label: string; scope: PulseScope }
  /** Ask the Mac what this idle agent might be told next. `tldr` rides along as
   *  the cache key the phone already has, so a skip-cycle back to the same card
   *  cannot spawn a second CLI for text that has not changed. */
  | {
      type: 'relaySuggest'
      label: string
      tldr: string
      /** Throw away the cached answer for this key and ask again. The user
       *  looked at the chips and wanted different ones, which the cache — keyed
       *  on text that has not changed — would otherwise replay forever. */
      refresh?: boolean
    }
  // Opens the Accessibility pane on the MAC. The phone can't do this itself,
  // and the user is holding the phone -- so the blocked screen's button has to
  // travel over the wire to be worth offering at all.
  | { type: 'openAccessibilitySettings' }
  | { type: 'micDenied' }
  | { type: 'welcomePick'; pick: PhoneWelcomePick }
  /** "Control this Mac" -- the viewer asks to swap roles with the controller.
   *  Carries no target: the sender IS the target, and the server is the only
   *  layer that knows which socket a message arrived on. Sending an id here
   *  would be the re-derived-identity bug that hit appSwitchActivate 3x. */
  | { type: 'requestControl' }
  /** Scrub the zoom of the picture on the WATCHING device (the glasses), from
   *  the controller's ring. Relayed by the Mac, which owns the socket map.
   *
   *  Carries the resolved SCALE, never a delta or a notch count: the phone has
   *  already decided the zoom level, and a stream of deltas leaves the two ends
   *  permanently disagreeing the first time one is dropped. Same rule that
   *  makes appSwitchActivate send a bundleId. */
  | { type: 'mirrorViewerZoom'; scale: number }
  /** The watching device reporting the zoom it just settled on, so the ring's
   *  knob reads what the glasses actually show. A report of an applied value,
   *  never a request -- the controller repaints and must NOT relay it back out,
   *  and the glasses suppress it for a scale that arrived as `mirrorViewerZoom`.
   *  Either omission is the echo loop. */
  | { type: 'mirrorViewerZoomChanged'; scale: number }
  /** Controller asking the watching device what zoom it is at, on attach.
   *  Carries no scale on purpose: pushing one here reset glasses that were
   *  already zoomed. The answer returns as `mirrorViewerZoomChanged`. */
  | { type: 'mirrorViewerZoomRequest' }
  /** Aim the picture on the WATCHING device, from the controller's minimap.
   *
   *  Carries the normalized point of the DESKTOP the view should centre on
   *  (0..1, same space as `cursorPos`), never a px offset: the two devices have
   *  different pane sizes, so px would mean different things at each end. The
   *  glasses feed it straight to `coverPanForCursor`, which is the clamp
   *  cursor-follow already uses -- one pan rule, not a second one that can
   *  disagree with it at the desktop edges. */
  | { type: 'mirrorViewerPan'; x: number; y: number }


export interface DictationEntry {
  id: string
  text: string
  kind: string
  at: number
  /** Omitted, never `false`: a per-row boolean on every page is tunnel weight. */
  failed?: true
  /** Both only ever present alongside `failed`. */
  reason?: RunFailReason
  detail?: string
  /** Absent on a settled failure, which is the plain "it failed" case. */
  runState?: RunState
}

export type ChatProjectWire = { name: string; icon?: string; imageBase64?: string }

export type RelayProjectWire = ChatProjectWire & { id: string; pinned?: boolean; folderName: string }

export type PhoneRemoteEvent =
  | { type: 'transcribeStage'; id: string; stage: 'received' | 'transcribing' | 'done' }
  | { type: 'transcribeFailed'; id: string; reason: string; retryable: boolean }
  /** An image send that never reached the clipboard. Carries no id: one image is
   *  in flight at a time, so the phone has nothing to disambiguate against. */
  | { type: 'imageFailed'; reason: string }
  | { type: 'imagePasted'; name: string; submitted: boolean }
  | { type: 'inkSent'; ok: boolean }
  | { type: 'inkBackdrop'; image: string | null; width: number; height: number }
  /** `reason`/`detail` ride only a failure, and are read back off the history row
   *  the run just wrote so the toast and the History row can't disagree. */
  | {
      type: 'runDone'
      ok: boolean
      summary: string
      historyId?: string
      reason?: RunFailReason
      detail?: string
    }
  | { type: 'actProgress'; runId: string; phase: string; detail?: string }
  | { type: 'takenOver'; label: string | null }
  /** Someone touched the Mac, so it relocked and Away Mode ended. The phone
   *  stays connected and usable — this is not a disconnect — so the copy must
   *  say the Mac was taken back, never that the connection dropped. */
  | { type: 'awayEnded' }
  /** Away Mode covered the Mac's screen (black to the room, live on the phone).
   *  Sent so the user sees "your screen is now black" instead of silence. */
  | { type: 'awayCovered' }
  /** The Mac's real macOS lock, which the phone cannot open (Apple blocks it).
   *  Sent on change and at connect so a phone facing a login window is told
   *  plainly instead of appearing to connect to a Mac it can't use. */
  | { type: 'macLockState'; locked: boolean }
  | { type: 'sensitivity'; value: number; min: number; max: number }
  | {
      type: 'env'
      isAdmin: boolean
      current: 'staging' | 'prod'
      buildDefault: 'staging' | 'prod'
    }
  | { type: 'envSwitching'; to: 'staging' | 'prod' }
  /** The Mac ended the ChatGPT voice call, so the phone must drop the mic it
   *  was holding. Without this the AX press closes the session while the phone
   *  keeps an open microphone and a Live Activity saying "Hearing you" -- and
   *  the user who ended the call by voice is not looking at the phone to
   *  notice. */
  /** `reason` is set only when the call never STARTED -- ChatGPT wasn't running,
   *  or its voice button couldn't be found. Same message because the phone's
   *  job is identical either way (drop the mic it opened); the string is what
   *  turns a silent hang-up into a toast the user can act on. */
  | { type: 'voiceCallEnded'; reason?: string }
  | {
      type: 'layoutPrefs'
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
      hostKeyboard: HostKeyboard
      hostDevice?: HostDevice
      /** See getLayoutPrefs.wornSkinLabel. Rides the push too, so installing a
       *  skin from the store names it without waiting for a reload. */
      wornSkinLabel?: string
    }
  | {
      type: 'appSwitchList'
      apps: { name: string; bundleId: string; iconPngBase64: string }[]
      anchorBundleId?: string | null
    }
  /** Whether a layout has run this session, so the sheet can show Restore.
   *  The stash is session-lifetime and one generation deep -- a rect from an
   *  earlier run points at a window the user has since moved. */
  | { type: 'windowLayoutState'; canRestore: boolean }
  | { type: 'appContextState'; context: AppContext }
  | { type: 'clipboardStateResult'; hasContent: boolean }
  /** Search the phone's photo library. The only Mac->phone event that expects an
   *  answer, so it carries its own `requestId`: an agent can have two searches
   *  in flight and iCloud makes arrival order unreliable. Answered by a
   *  `photosSearchResult` message, or by nothing at all if the phone is an
   *  older build -- the Mac times out rather than waiting forever. */
  | {
      type: 'photosSearch'
      requestId: string
      after?: string
      before?: string
      isScreenshot?: boolean
      limit?: number
    }
  /** Raise the iOS photo permission prompt. Sent only after a search already
   *  came back `scope: 'none'`, never speculatively (PRD decision 1). */
  | { type: 'photosRequestAccess'; requestId: string }
  /** Fetch one photo's bytes by an id a previous search minted. The bytes come
   *  back over the existing imageMeta+binary path, not in a JSON field. */
  | { type: 'photosFetch'; requestId: string; id: string }
  /** A device is waiting at the door with no credential, and this phone is the
   *  one being asked to vouch for it. Sent to the CONTROLLER only -- a viewer
   *  cannot admit a third device, and the glasses are the usual thing waiting.
   *
   *  `label` is parsed from the arriving User-Agent and is DISPLAY ONLY: it is
   *  self-reported and trivially forged, so it names what to expect on screen
   *  and never decides anything. The user's own tap is the actual authorization.
   *
   *  `expiresAt` rides along so the phone counts down to the same instant the
   *  Mac stops honouring the verdict, rather than offering a button that has
   *  already gone dead. */
  | { type: 'approvalRequest'; id: string; label: string; expiresAt: number }
  /** Sent to the WAITING device the moment the phone allows it: the durable
   *  credential it would otherwise have earned by typing a 6-digit code. It
   *  stores this and reconnects with it, so approval costs no trip to /pair.
   *
   *  This is the one event carrying a secret, and it is only ever sent on the
   *  single socket that was parked waiting for it -- never broadcast. */
  | { type: 'approved'; credential: string }
  /** The waiting device gave up, was denied, or timed out -- take the prompt
   *  down. Carries `id` so a late resolution cannot clear a newer request. */
  | { type: 'approvalResolved'; id: string }
  /** Sent to the WAITING device: its socket is parked while the paired phone is
   *  asked to vouch. Without it the device shows the generic pairing-code form
   *  and looks refused, while the answer is being tapped elsewhere. */
  | { type: 'approvalPending'; expiresAt: number }
  // Which device this one is when two are connected. Sent on connect and on any
  // change, to BOTH devices. Deliberately not a ConnState kind: a viewer is
  // genuinely `connected`, so folding it into that union would fork every
  // `kind === 'connected'` consumer for a device that is connected.
  | { type: 'role'; role: 'controller' | 'viewer' }
  /** What the watching device -- glasses, or any cursorless wearable -- is
   *  doing. Sent to the CONTROLLER, which cannot otherwise tell: `role` says
   *  what THIS device is, so a lone phone and a phone driving glasses both read
   *  `controller`. The ring's zoom track keys on `receiving`.
   *
   *  `screenW`/`screenH` are the mirrored display's bounds, carried because the
   *  controller has NO video element of its own (it isn't mirroring locally --
   *  the glasses are the screen), so it cannot measure the desktop's aspect the
   *  way the viewer can. The minimap needs it to draw a frame shaped like the
   *  real screen rather than a guess. Carried by `receiving` alone.
   *
   *  ONE field: the old `attached`/`mirroring` pair made an impossible fourth
   *  state representable, and stranded the zoom track on a departed viewer. */
  | { type: 'viewer'; viewer: 'none' }
  | { type: 'viewer'; viewer: 'connected' }
  | { type: 'viewer'; viewer: 'receiving'; screenW: number; screenH: number }
  /** The relayed scale, arriving at the watching device. Same variant name as
   *  the message on purpose -- it is the same fact travelling one more hop. */
  | { type: 'mirrorViewerZoom'; scale: number }
  /** The glasses' own zoom, arriving at the CONTROLLER. Same variant name as
   *  the message for the same reason as the zoom above: one fact, one more hop.
   *
   *  Travels the opposite direction to every other mirror control here, which
   *  is the point -- the dial is shared, so either end may turn it. */
  | { type: 'mirrorViewerZoomChanged'; scale: number }
  /** The attach question, arriving at the watching device. It answers with
   *  `mirrorViewerZoomChanged`, carrying the zoom it is already at. */
  | { type: 'mirrorViewerZoomRequest' }
  /** The relayed aim point, arriving at the watching device. Same variant name
   *  as the message for the same reason as the zoom above. */
  | { type: 'mirrorViewerPan'; x: number; y: number }
  | { type: 'mirrorAnswer'; sdp: string }
  | { type: 'mirrorIceCandidate'; candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }
  | { type: 'mirrorError'; reason: string }
  | { type: 'mirrorAudioError'; reason: string }
  // Precedes the first binary frame, so Swift sizes its layer without parsing
  // SPS. Every binary frame until 'pipStreamEnded' belongs to this stream.
  | { type: 'pipStreamConfig'; width: number; height: number; frameRate: number }
  // AAC-LC parameters for the audio half of the PiP pipe. Sent before the first
  // audio chunk, and again whenever the encoder restarts -- Swift cannot infer
  // either value from an AAC frame without parsing its header.
  | { type: 'pipAudioConfig'; sampleRate: number; channels: number }
  // Terminal. Without it a stopped stream and a stalled one look identical.
  | { type: 'pipStreamEnded'; reason: string }
  // Capture stopped producing frames (e.g. the Mac's display slept) and the
  // capture window is re-acquiring it -- the peer connection survives, so this
  // is NOT mirrorError. The phone shows the reconnecting placeholder instead
  // of the frozen last frame until 'mirrorRecovered' arrives.
  | { type: 'mirrorStalled' }
  | { type: 'mirrorRecovered' }
  // Switch-latency probe. Sent the moment the Mac learns the screen is about to
  // change; the viewer answers on its next PAINTED frame via mirrorDiag, and the
  // Mac subtracts against its own clock. Deliberately one-way-with-an-echo
  // rather than the phone timing it: the two devices' clocks are unrelated, so
  // any delta computed across them measures skew as much as latency.
  //
  // Dev-only and glasses-only at the sender. `id` rather than a timestamp so
  // nothing has to trust the phone's wall clock.
  | { type: 'mirrorSwitchProbe'; id: number }
  // `volume: null` means the output device doesn't report one (some AirPlay
  // targets) — the phone hides the slider rather than showing a fake 0.
  | { type: 'systemVolume'; volume: number | null; muted: boolean }
  | { type: 'mirrorIceServers'; iceServers: unknown[]; cap?: RemoteCapState }
  | { type: 'cursorAppearance'; size: number; fill: string; outline: string; animated: boolean }
  | { type: 'cursorPos'; x: number; y: number }
  | { type: 'dictationHistory'; entries: DictationEntry[]; offset: number; hasMore: boolean }
  | { type: 'referralCode'; code?: string; link?: string; referredCount?: number; error?: string }
  | { type: 'inviteResult'; ok?: boolean; error?: string }
  | {
      type: 'chatSessions'
      sessions: {
        id: string
        title: string
        updated: string
        messageCount: number
        preview: string
        running: boolean
        project?: ChatProjectWire
        group: number
        pinned?: boolean
      }[]
      offset: number
      hasMore: boolean
    }
  | {
      type: 'chatSession'
      id: string
      title: string
      turns: {
        fromPhone: boolean
        q: string
        a: string
        ts: string
        ok: boolean
        // Media this turn carries, as INDICES into the Mac's stored turn --
        // `item` is what /chat-media resolves back to a path. Sending the path
        // itself would hand the phone a filesystem it must never learn.
        media?: {
          turn: number
          item: number
          kind: 'image' | 'video'
          name: string
          mine: boolean
        }[]
      }[]
      truncated: boolean
      running: boolean
    }
  | { type: 'chatTurnStart'; sessionId: string; title: string }
  | { type: 'chatChunk'; sessionId: string; phase?: string; detail?: string; chunk?: string }
  | { type: 'chatTurnDone'; sessionId: string; ok: boolean; reply: string }
  | { type: 'chatSessionChanged'; sessionId: string }
  | { type: 'models'; scope: ModelScope; current: string; options: ModelOptionWire[] }
  /** The phase a running session is on right now, for the thread LIST.
   *  Separate from `chatChunk` because that one is gated to the open thread by
   *  design (a background run must not bleed into the thread on screen), and
   *  the list's whole job is the threads you're NOT looking at. Carries no
   *  reply text for the same reason. */
  | { type: 'chatSessionPhase'; sessionId: string; phase: string; detail?: string }
  | { type: 'chatTranscript'; ok: boolean; text: string; reason?: string }
  // Code agent relay: full snapshot of pending cards plus a short resolved
  // tail (§6b: "plus the last few resolved ones, grayed out"). Pushed on
  // connect and on every store change -- the sheet never polls.
  | ({ type: 'relayPending' } & RelaySnapshotWire)
  // The store threw an answer away -- already resolved on the Mac, or the agent
  // stopped waiting. Sent ONLY on refusal: a successful answer is already
  // evident from the card leaving the next `relayPending` snapshot, and an ack
  // for the normal case would be a round-trip that changes nothing on screen.
  | { type: 'relayRefused'; requestId: string; kind: 'already-resolved' | 'unknown' }
  // Who is connected right now, for the sheet's header strip and Sessions tab.
  // Separate from `relayPending` because the two change on different events: a
  // session opening or closing moves this and leaves the card list untouched,
  // and an answered card moves the cards while every session stays open.
  | { type: 'relayStatus'; status: AgentRelayStatus }
  // A Record, not RelayPushFilter -- that type's module imports THIS one.
  // Both halves travel together: they are one screen and one stored file.
  | {
      type: 'relayPushFilter'
      filter: Record<RelayVerbWire, boolean>
      notifyLevel: 'all' | 'problems'
      turnEndPing: boolean
    }
  /** `changedAt` is when this text last DIFFERED from the previous poll, not
   *  when it was captured -- a capture stamp would read "just now" forever. */
  /** `outcome` is stated, not inferred: the phone cannot tell an unchanged pane
   *  from a failed capture by watching `changedAt` sit still. Absent on the
   *  background poll, which nobody is waiting on. */
  | {
      type: 'relaySessionPreview'
      label: string
      preview: string
      changedAt?: number
      outcome?: 'changed' | 'unchanged' | 'unavailable'
    }
  /** What YOU sent this agent, echoed back from the Mac so the thread keeps
   *  both halves of the conversation.
   *
   *  Held Mac-side rather than in the phone's React state, which is the whole
   *  point: a reply typed into a tmux pane leaves no card, so before this the
   *  only record of it was a local `useState` that a reload threw away -- the
   *  screen went back to showing the agent talking to nobody. Survives a phone
   *  reload, not a Mac restart; it is a conversation, not an audit log. */
  | { type: 'relaySessionSent'; label: string; turns: { text: string; at: number }[] }
  /** Answers `relaySessionReveal`. The phone cannot see the window it raised,
   *  so a silent failure is indistinguishable from a success. */
  | { type: 'relaySessionRevealed'; label: string; ok: boolean }
  /** Echoes the zoom state the pane ACTUALLY landed on, so the button reflects
   *  the Mac rather than the tap that was optimistically applied. */
  | { type: 'relaySessionZoomed'; label: string; on: boolean; ok: boolean }
  | {
      type: 'relaySessionGitState'
      label: string
      op: SessionGitOp
      github: boolean
      dirty: number
      pull: RepoPull | null
      files: number
      added: number
      removed: number
      error?: string
    }
  /** Answers `relaySessionWrap`, and only for the ask -- the close behind it
   *  takes up to a minute, and the row disappearing is what confirms that. */
  | { type: 'relaySessionWrapped'; label: string; ok: boolean; reason?: string }
  | { type: 'relaySessionUndone'; label: string; at: number; result: CheckpointResult }
  /** Answers `relaySuggest`. `tldr` echoes back so a reply that arrives after
   *  the agent restated itself is dropped rather than rendered under the new
   *  subject. An empty array is a valid answer -- the card keeps the canned
   *  three, which is why nothing here reports a failure. */
  | { type: 'relaySuggestions'; label: string; tldr: string; suggestions: Suggestion[] }
  | { type: 'relaySessionStarted'; requestId: string; ok: boolean; reason?: string; startedAt?: number }
  | { type: 'relayProjectList'; projects: RelayProjectWire[] }
  | { type: 'relayNoteDone'; id: string; ok: boolean; text?: string; reason?: string }
  | { type: 'relayIdeas'; projectId: string; ideas: ProjectIdea[]; at?: number; stale?: boolean }
  /** `media` counts the images on a turn; /chat-media?label=&at=&item= fetches one. */
  | {
      type: 'relayTranscript'
      label: string
      turns: { role: AgentTranscriptTurn['role']; at: number; text: string; recap?: string; media?: number; videos?: number[]; undo?: TurnUndoState }[]
      reason?: 'no-session' | 'no-transcript'
    }
  | { type: 'pulseState'; label: string; state: PulseState }
  | {
      type: 'relayInfo'
      label: string
      checklist?: AgentChecklist
      helpers: AgentHelper[]
      tools: { name: string; kind: AgentToolUse['kind']; calls: number; lastAt: number }[]
      mcpList: { name: string; scope: string }[]
    }
  // Pushed on connect and on battery/AC change (throttled). No `asleep`
  // field: `powerMonitor`'s `suspend` races the socket closing, so a bool
  // here would read false at the exact moment it matters -- the widget
  // derives "asleep" from age + connection liveness instead (ios/CLAUDE.md:
  // Swift owns no connection state). `batteryPercent` is null on a Mac with
  // no battery (Mini/Studio/Mac Pro) -- never a sentinel 0 or 100.
  // `capabilities` is the host OS's platform.capabilities -- the phone hides a
  // control whose flag is false (a Windows host has no window layouts).
  | {
      type: 'hostStatus'
      batteryPercent: number | null
      charging: boolean
      hostname: string
      at: number
      capabilities: HostCapabilities
      accountId: string | null
    }
  // The phone cannot infer this: a Mac silently refusing every input looks
  // exactly like a healthy idle socket. Stated, never derived.
  | { type: 'permissionState'; permission: 'accessibility'; granted: boolean }
  | ({ type: 'firstSteps'; show: boolean; welcome: boolean; advanced: boolean; micBlocked: boolean } & Record<PhoneFirstStep, boolean>)

export const PHONE_FIRST_STEPS = ['move', 'tap', 'talk'] as const
export type PhoneFirstStep = (typeof PHONE_FIRST_STEPS)[number]
export const PHONE_WELCOME_PICKS = ['chat', 'code', 'trackpad', 'dismiss'] as const
export type PhoneWelcomePick = (typeof PHONE_WELCOME_PICKS)[number]

export type { HostCapabilities }

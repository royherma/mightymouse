import { CHANNELS } from '../../shared/ipc'
import { PREFS } from '../store/prefs'
import { PERMISSIONS, input } from '../platform'
import { sendToSettingsRenderer } from '../settings-window'
import { track, getAnalyticsUser } from '../analytics'
import { ANALYTICS_EVENT, PHONE_TRANSPORT } from '../../shared/analytics-events'
import { trackChecklistStep } from '../activation-checklist'
import { devLog } from '../../shared/env'
import { onRelayStoreChanged } from '../agent-relay/store'
import { currentStatus } from './agent-relay'
import { relaySnapshot } from '../agent-relay/wire'
import { sendToWebClients, setWebClientSeeder, webClients } from '../phone-remote/web-client'
import type { PhoneRemoteEvent } from '../../shared/phone-remote-protocol'
import {
  startPhoneRemoteServer,
  isPhoneConnected,
  sendToPhone,
  setHistoryReader,
  sendDictationHistory,
  type PhoneRemoteMessage
} from '../phone-remote/server'
import {
  sendHostStatusToPhone,
  sendPasswordScreenStateToPhone,
  startHostStatusWatch
} from '../phone-remote/host-status'
import { armIdleLockRearm, cancelIdleLockRearm } from '../phone-remote/stay-awake'
import { armIdleRevert, cancelIdleRevert } from '../phone-remote/clamshell'
import {
  beginAwayMode,
  isAwayModeHeld,
  armCurtainOnPhoneGone,
  cancelCurtainOnPhoneGone
} from '../phone-remote/away-mode'
import { noteAppGeneratedInput } from '../phone-remote/local-input-watch'
import { getTunnelStatus } from '../phone-remote/cloudflare-tunnel'
import { stopScreenStream, noteScreenStreamInput } from '../capture/screen-stream'
import {
  cancelGlide,
  endDrag,
  getTrackedPosition,
  isDragHeld,
  stopCursorStream
} from './phone-remote-pointer'
import {
  flushPhoneSession,
  resetPhoneSession,
  readHistoryPageForPhone,
  handlePhoneAudio
} from './phone-remote-audio'
import { dispatchPhoneMessage } from './phone-remote-dispatch'
import { handleShareText, handlePhoneImage } from './phone-remote-share'
import { handleInkImage, closeInkOverlay } from './phone-remote-ink'
import { watchFrontmostForPhone, unwatchFrontmostForPhone } from './phone-remote-context'
import { sendRelayPending, countPhoneMessage } from './phone-remote-chat'
import {
  sendSensitivityToPhone,
  warmHostKeyboardType,
  warmHostDevice,
  layoutPrefsSnapshot,
  sendLayoutPrefsToPhone,
  sendCursorAppearanceToPhone
} from './phone-remote-prefs'
import { broadcastPhoneStatus, broadcastPhoneDevices } from './phone-remote-pairing-ui'
// True once a phone has paired at least once since this server started, so
// phone_paired can tell a genuine first pair from the reconnect storm a single
// real session produces (Wi-Fi blip, screen lock, Safari tab eviction).
let phoneHasPairedThisRun = false

/** Which client the dev log's phone lines belong to. Set on every inbound
 *  message (not just onConnect) so concurrent clients -- glasses joining as a
 *  viewer alongside a controlling phone -- stay attributed to whichever socket
 *  actually sent the line, not whichever connected last. */
let connectedLabel = 'phone'

/** Exported for phone-remote-dispatch.ts's debugLog handler wiring -- a live
 *  read, not a snapshot, since connectedLabel is mutated on every message. */
export function getConnectedLabel(): string {
  return connectedLabel
}

// Re-announce at most this often. A denied drag is ~60 refusals a second and
// each one would otherwise be a socket write plus a TCC call.
const PERMISSION_NAG_MS = 3_000
let lastPermissionNagAt = 0
let lastPermissionGranted: boolean | null = null

// Subscribed for the lifetime of a phone connection so the Code sheet gets a
// live push on every relay mint/resolve/timeout, never a poll. Unsubscribed
// on disconnect -- the listener would otherwise leak across reconnects and
// push to a socket that's already gone.
let unsubscribeRelayStore: (() => void) | null = null

/** Never prompts: the dialog lands on a Mac nobody is looking at, and `move`
 *  alone would fire it dozens of times a second. */
export function phoneMayControlMac(): boolean {
  const granted = PERMISSIONS.hasAccessibility(false)
  const now = Date.now()
  // Edge-triggered on grant, repeated on denial -- a phone that connected
  // since the last one would otherwise never hear about it.
  if (granted && lastPermissionGranted !== true) {
    sendToPhone({ type: 'permissionState', permission: 'accessibility', granted: true })
  } else if (!granted && now - lastPermissionNagAt > PERMISSION_NAG_MS) {
    lastPermissionNagAt = now
    sendToPhone({ type: 'permissionState', permission: 'accessibility', granted: false })
    startPermissionPoll()
  }
  lastPermissionGranted = granted
  if (granted) stopPermissionPoll()
  return granted
}

// Runs only while DENIED: macOS has no grant notification and a blocked phone
// sends no input, so nothing else would ever notice the fix.
const PERMISSION_POLL_MS = 1_000
let permissionPollTimer: NodeJS.Timeout | null = null

function stopPermissionPoll(): void {
  if (permissionPollTimer === null) return
  clearInterval(permissionPollTimer)
  permissionPollTimer = null
}

function startPermissionPoll(): void {
  if (permissionPollTimer !== null) return
  permissionPollTimer = setInterval(() => {
    if (!isPhoneConnected()) {
      stopPermissionPoll()
      return
    }
    if (PERMISSIONS.hasAccessibility(false)) {
      sendPermissionState()
      stopPermissionPoll()
    }
  }, PERMISSION_POLL_MS)
}

/** Pushed on connect: the deck must know it's dead BEFORE the user taps
 *  anything, not after a gesture is swallowed. Exported for
 *  phone-remote-dispatch.ts's getLayoutPrefs handler wiring. */
export function sendPermissionState(): void {
  const granted = PERMISSIONS.hasAccessibility(false)
  lastPermissionGranted = granted
  sendToPhone({ type: 'permissionState', permission: 'accessibility', granted })
  if (granted) stopPermissionPoll()
  else startPermissionPoll()
}

/** Messages that synthesize input, i.e. the ones about to repaint the Mac.
 *  Deliberately NOT every message: a settings read or a history fetch would
 *  otherwise hold the mirror at half resolution while nothing on screen moved.
 *  Cursor motion counts because the glasses draw their own cursor by panning
 *  the video, so a bare 'move' changes every pixel of the panel. */
const CHANGES_THE_SCREEN: ReadonlySet<PhoneRemoteMessage['type']> = new Set([
  'move',
  'scroll',
  'tap',
  'doubleTap',
  'twoFingerTap',
  'dragStart',
  'dragMove',
  'dragEnd',
  'centerCursor',
  'mirrorWarp',
  'ink',
  'pressKey',
  'padGesture',
  'padZoom',
  'tmuxAction',
  'typeText',
  'deleteText',
  'pasteClipboard',
  'appSwitchActivate',
  'appSwitchQuick',
  'windowLayout',
  'appSwitchMru',
  'appActivateItem',
  'appActivateGroup',
  'relaySessionReply',
  'relaySessionStop',
  'relaySessionWrap'
])

function handlePhoneMessage(msg: PhoneRemoteMessage, senderLabel: string): void {
  countPhoneMessage(msg.type)
  // 'move' is its own source so bare cursor moves skip the motion downscale,
  // matching the physical mouse (which has no herald at all). Everything else
  // in the set genuinely repaints and always hints.
  if (CHANGES_THE_SCREEN.has(msg.type)) {
    noteScreenStreamInput(msg.type === 'move' ? 'cursor' : 'input')
  }
  // Unconditional, not gated on isAwayModeHeld(): the watch is armed BEFORE the
  // hold flips on, so a gate here leaves every message during acquisition
  // unattributed — which ended the session before the hold was ever taken.
  noteAppGeneratedInput()
  // Per-socket label from server-runtime.ts's labelForSocket, not onConnect's
  // stale snapshot -- keeps concurrent clients (glasses viewer + controlling
  // phone) each attributed to their own line instead of whichever connected last.
  connectedLabel = senderLabel
  // Every message type resolves in the dispatch table (phone-remote-dispatch.ts).
  dispatchPhoneMessage(msg)
}

let unsubscribeWebRelay: (() => void) | null = null

function pushRelayToWeb(): void {
  if (webClients().size === 0) return
  const events: PhoneRemoteEvent[] = [
    { type: 'relayPending', ...relaySnapshot() },
    { type: 'relayStatus', status: currentStatus() }
  ]
  for (const event of events) sendToWebClients(event, JSON.stringify(event))
}

function seedWebClients(): void {
  pushRelayToWeb()
  unsubscribeWebRelay ??= onRelayStoreChanged(pushRelayToWeb)
}

export function phoneRemoteCallbacks(): Parameters<typeof startPhoneRemoteServer>[0] {
  setWebClientSeeder(seedWebClients)
  // Inject the History reader rather than letting server.ts import the store --
  // that file deliberately knows nothing about MightyMouse's domain.
  setHistoryReader(readHistoryPageForPhone)
  return {
    onMessage: handlePhoneMessage,
    onAudio: (data, durationMs, to, clipId, queued) =>
      void handlePhoneAudio(data, durationMs, to, clipId, queued),
    onImage: (data, mime, name, submit, requestId, replyToLabel, ink) =>
      void (ink ? handleInkImage(data, ink) : handlePhoneImage(data, mime, name, submit, requestId, replyToLabel)),
    onShareText: (text, submit) => void handleShareText(text, submit),
    // Read while serving index.html so the phone paints the right layout on
    // frame 1. Same snapshot the WS push uses -- one source, no drift.
    getLayoutPrefs: layoutPrefsSnapshot,
    // Handed to the phone at /pair so it inherits this Mac's account rather
    // than signing in for itself.
    getAccountId: getAnalyticsUser,
    // Lets the server start with no LAN address when the tunnel can carry the
    // session on its own -- a Mac on remote desktop, guest Wi-Fi, or no Wi-Fi.
    isTunnelEnabled: () => PREFS.getPhoneRemoteTunnelEnabled(),
    onDevicePaired: (identity, totalDevices) => {
      track(ANALYTICS_EVENT.phone_device_paired, {
        shell: identity.shell,
        kind: identity.kind,
        model_known: identity.modelKnown,
        os: identity.os,
        os_version: identity.osVersion ?? '',
        total_devices: totalDevices
      })
      if (totalDevices === 1) trackChecklistStep('phone')
      // onConnect's broadcastPhoneStatus carries only a boolean, so without
      // this the new row waits for the next Settings open. The one caller that
      // consumed the code, hence the only one that may re-mint it.
      broadcastPhoneDevices(true)
    },
    // The glasses join as a viewer, so onConnect never fires for them. Both
    // pushes are idempotent and reach the new socket via sendToPhone's viewer
    // fan-out; without them the debug HUD's battery row reads `--` until an
    // unrelated background change happens to fire.
    onViewerAttach: () => {
      sendHostStatusToPhone()
      sendPasswordScreenStateToPhone()
    },
    onConnect: (identity) => {
      // Every phone log line prints the literal string "phone" otherwise, so
      // glasses / iPhone / a desktop test tab are indistinguishable in
      // /tmp/mightymouse-dev.log -- which cost a whole session of reading the
      // wrong client's mirror attempts on 08-11. handlePhoneMessage overwrites
      // this per-message from the more precise per-socket label, so this is
      // just the seed before the first message arrives.
      connectedLabel =
        [identity.kind, identity.browser, identity.shell].filter(Boolean).join('/') || 'phone'
      resetPhoneSession()
      track(ANALYTICS_EVENT.phone_paired, {
        transport: getTunnelStatus().state === 'up' ? PHONE_TRANSPORT.tunnel : PHONE_TRANSPORT.lan,
        reconnect: phoneHasPairedThisRun,
        // Empty string rather than null for the string dimensions: they group
        // in the dashboard, and a null column reads as "event predates this
        // field" where '' honestly means "we looked and couldn't tell".
        shell: identity.shell,
        kind: identity.kind,
        browser: identity.browser,
        browser_version: identity.browserVersion ?? '',
        os: identity.os,
        os_version: identity.osVersion ?? ''
      })
      phoneHasPairedThisRun = true
      // Phone is back — stand down the clamshell watchdog (layer 3) so a
      // reconnect within the grace window keeps the lid-closed session alive.
      cancelIdleRevert()
      // Same for the display-sleep block: a reconnect inside the grace window
      // is a continuing session, so the panel should stay lit.
      cancelIdleLockRearm()
      // ...and Away Mode's own grace window, so a phone that blips off Wi-Fi
      // doesn't come back to a covered Mac it left uncovered.
      cancelCurtainOnPhoneGone()
      // Per-session by design (never held while merely enabled), so this is
      // where it's acquired. Fire-and-forget: the rest of connect must not wait
      // on it, and a refusal just means the session runs without it.
      if (PREFS.getPhoneRemoteAwayMode()) {
        void beginAwayMode({
          onEndedByHuman: () => {
            // A human took the Mac back. Tell the phone so it can say so, rather
            // than the user watching their remote go dead with no explanation.
            sendToPhone({ type: 'awayEnded' })
            sendToSettingsRenderer(CHANNELS.phoneRemoteAwayState, false)
          },
          onCovered: () => {
            sendToPhone({ type: 'awayCovered' })
          }
        }).then((res) => {
          if (!res.ok) devLog.warn('Phone Remote: Away Mode not acquired —', res.reason)
          sendToSettingsRenderer(CHANNELS.phoneRemoteAwayState, isAwayModeHeld())
        })
      }
      broadcastPhoneStatus(true)
      sendSensitivityToPhone()
      sendLayoutPrefsToPhone()
      void warmHostKeyboardType()
      void warmHostDevice()
      // Pointer style is read once per connect, not streamed — it only changes
      // when the user edits System Settings, and a stale style is a cosmetic
      // mismatch rather than a broken cursor.
      sendCursorAppearanceToPhone()
      // Seed the history sheet up front so opening it is instant, and so a
      // reconnected phone doesn't show an empty list for dictations it made
      // before the drop.
      sendDictationHistory()
      // Cheap to hold open (one resident helper, no polling) and it must already
      // be listening before the user's first app switch, not after it.
      watchFrontmostForPhone()
      // Unconditional: a freshly (re)connected phone has never seen a value,
      // so this bypasses the background-change throttle on purpose.
      sendHostStatusToPhone()
      sendPasswordScreenStateToPhone()
      startHostStatusWatch()
      sendRelayPending()
      // Who is connected, seeded once here. Every later change arrives from
      // broadcastStatus() in ipc/agent-relay.ts -- but that only fires when a
      // session opens or closes, so a phone connecting into a steady state
      // would otherwise show "no agents" until one happened to move.
      sendToPhone({ type: 'relayStatus', status: currentStatus() })
      unsubscribeRelayStore?.()
      // Status rides along with the cards: a session's `waiting` count is
      // derived from the pending list, so answering a card moves the strip's
      // per-session dot without any session opening or closing.
      unsubscribeRelayStore = onRelayStoreChanged(() => {
        sendRelayPending()
        sendToPhone({ type: 'relayStatus', status: currentStatus() })
      })
    },
    onDisconnect: () => {
      unsubscribeRelayStore?.()
      unsubscribeRelayStore = null
      flushPhoneSession()
      // Nothing left to notify -- stop the helper rather than leaving it resident
      // for a phone that may never come back.
      unwatchFrontmostForPhone()
      stopPermissionPoll()
      // A reconnecting phone gets a fresh push from getLayoutPrefs; leaving the
      // old verdict cached would suppress it as "unchanged".
      lastPermissionGranted = null
      cancelGlide()
      {
        const { x: tx, y: ty } = getTrackedPosition()
        if (isDragHeld() && tx !== null && ty !== null) {
          input.dragUpFast(tx, ty)
        }
      }
      endDrag()
      stopScreenStream()
      stopCursorStream()
      closeInkOverlay()
      broadcastPhoneStatus(false)
      // Start the countdown to dropping the machine-wide sleep flag. No-op
      // unless clamshell is actually held, and cancelled if the phone returns
      // within the window -- so an ordinary Wi-Fi blip costs nothing.
      armIdleRevert()
      // While held, away-mode.ts owns the phone-gone reaction and NEVER releases
      // the display block — a release re-arms the idle lock. Only unheld does
      // the block get its own release countdown.
      if (isAwayModeHeld()) {
        armCurtainOnPhoneGone()
      } else {
        armIdleLockRearm()
      }
    }
  }
}

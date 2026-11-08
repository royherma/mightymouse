import { useCallback, useEffect, useRef, useState } from 'react'
import { CONFIG } from '@shared/config'
import type { PhoneRemoteMessage, PhoneRemoteEvent } from '@shared/phone-remote-protocol'
import { PIP_BINARY_KIND, readPipBinary } from '@shared/phone-remote-keys'
import type { TunnelReach } from '@shared/types'
import { type ConnState, type BlockedReason, transition } from '../../connection-state'
import { capabilities, isInstalled } from '../host-capabilities'
import { deviceHints } from '../device-hints'
import { detectCursorless } from '../cursorless-host'
import {
  discoverHost,
  rememberHost,
  rememberTunnelHost,
  currentDeviceCredential,
  rememberDeviceCredential,
  clearDeviceCredential,
  retireTombstones,
  exchangePairingCode
} from '../useHostDiscovery'
import { spendUrlPairingCode } from '../qr-pair-target'
import { nativeBridge } from '../native-bridge'
import { drainAttempts, flushAttemptsToHost, formatAttempt, recordAttempt } from '../connect-log'

// Survives the reload that take-control performs, and dies with the tab -- a
// takeover must never be replayed by a later cold launch.
const TAKEOVER_FLAG_KEY = 'mm-remote-takeover'

/** Cumulative WS traffic THIS phone has sent. The mirror bench diffs it per
 *  BENCH line so input traffic can be correlated with an fps collapse --
 *  module-level because the bench reads deltas, not React state. */
export const wsTxMeter = { msgs: 0, bytes: 0 }

/** 4409 (conflict) reasons don't fit the 5-value BlockedReason -- a conflict
 *  is never unreachable/unauthorized, it's a live Mac that picked the other
 *  phone. 'superseded' means THIS phone's own newer socket won, so it is not
 *  a block at all: the old tab should go quiet, not show a screen. Fails
 *  toward 'mac-busy' (never a retry) for any reason this doesn't recognize --
 *  see eviction-war.test.ts, "the war cannot restart". */
/** Chunked because `String.fromCharCode(...bytes)` blows the argument limit on
 *  a keyframe -- one apply of ~40k args is a RangeError, not a slow path. */
function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

function forwardPipBinary(data: unknown): void {
  if (!(data instanceof ArrayBuffer)) return
  const frame = readPipBinary(data)
  if (!frame) return
  if (frame.kind === PIP_BINARY_KIND.video) nativeBridge.pipFrame(toBase64(frame.payload))
  else nativeBridge.pipAudio(toBase64(frame.payload))
}

export function conflictReason(reason: string): BlockedReason | 'superseded' {
  if (reason === CONFIG.PHONE_REMOTE.CLOSE_REASON_SUPERSEDED) return 'superseded'
  return 'mac-busy'
}

/** Which conflict produced a `mac-busy`. Beside `connState`, never inside it:
 *  `BlockedReason` is the server's closed five-value vocabulary with one screen
 *  each, and this only picks the COPY on one of those screens.
 *
 *  'no-room' is the viewer slot being full, which is the only conflict a
 *  cursorless host can hit -- it is refused as a second viewer, having never
 *  been eligible to control anything. Distinct from 'evicted' because on the
 *  glasses "you lost control" describes a state they were never in. */
export type ConflictKind = 'evicted' | 'no-room'

export function conflictKind(reason: string): ConflictKind {
  return reason === CONFIG.PHONE_REMOTE.CLOSE_REASON_BUSY ? 'no-room' : 'evicted'
}

/** A revoke arrives on an OPEN session. The same reason on a socket that never
 *  opened is a reachability fault, and deleting there is unrecoverable: the
 *  tombstone blocks the Keychain read-back too, leaving only a QR scan. */
export function shouldClearCredential(
  reason: BlockedReason,
  everOpened: boolean,
  presentedCredential: boolean
): boolean {
  if (!everOpened) return false
  // `no-credential` is the Mac's verdict on what ARRIVED, so a dial that sent
  // nothing earns it without the stored copy being wrong. Deleting there is
  // the unrecoverable case: `removeCredential` wipes the Keychain and reinjects
  // an empty bootstrap, so the read that failed once now has nothing to find
  // ever again -- and `retireTombstones()` cannot undo it, having only ever
  // cleared an in-memory flag. Only a credential the Mac saw and refused is
  // known bad; a missing one means the read failed, not that the secret died.
  if (!presentedCredential) return false
  return reason === 'credential-revoked' || reason === 'no-credential'
}

/** `connected` is present but showing nothing; `receiving` holds the picture,
 *  so zooming it means something. One field, never two booleans -- see the
 *  `viewer` event in phone-remote-protocol.ts. */
export interface ViewerState {
  kind: 'none' | 'connected' | 'receiving'
  /** The mirrored display's bounds, set on `receiving` only. The controller has
   *  no video element of its own -- the wearable is the screen -- so this is the
   *  only way it can know the desktop's aspect, which the minimap needs. */
  screenW?: number
  screenH?: number
}

export interface UseConnectionResult {
  connState: ConnState
  /** Who holds the Mac, for the mac-busy screen. Null when the Mac couldn't
   *  name them (a session-token phone has no stored label). */
  handoffLabel: string | null
  /** Which conflict caused the current `mac-busy`, for that screen's copy.
   *  Null until one happens. */
  conflict: ConflictKind | null
  /** Which device this one is when two are connected. Beside `connState`, not
   *  inside it: a viewer IS `connected` by every existing definition, so it is
   *  not a fifth ConnState kind. Null until the Mac says (one round trip). */
  role: 'controller' | 'viewer' | null
  /** Whether a SECOND device is attached, and whether it holds the picture.
   *  `role` can't answer this: it says what THIS device is, so a lone phone
   *  and a phone driving glasses both read `controller`. Null until the Mac
   *  says. */
  viewer: ViewerState | null
  reconnectAttempt: number
  searching: boolean
  tunnelReach: TunnelReach | null
  send: (msg: PhoneRemoteMessage) => boolean
  /** Raw payload send, for the audio blob following an `audioMeta` message --
   *  the one non-JSON frame on this wire. Returns whether it was actually
   *  sent, so a clip in flight when the socket drops can tell and keep itself. */
  sendBinary: (buf: ArrayBuffer) => boolean
  /** Full reload: re-runs discovery and backoff from scratch with no state to
   *  keep in sync with this hook's own closures. */
  retryNow: () => void
  /** Same-page rediscovery sweep, bypassing the backoff ladder. Distinct from
   *  `retryNow`: a reload re-fetches the page from its CURRENT origin, which
   *  on the native shell is baked into the WKWebView's URL and is exactly the
   *  dead cached host this exists to escape -- reloading it repeats the same
   *  doomed dial forever. This instead reopens a WebSocket to whatever
   *  `discoverHost()` finds, same mechanism the ladder's own escalation uses. */
  forceRediscover: () => void
  takeControl: () => void
  disconnectNow: () => void
  /** Non-connect messages (chat, mirror, history, env-switch, ...) that this
   *  hook doesn't own. App.tsx keeps its own dispatch for these. */
  onMessage: (handler: (msg: PhoneRemoteEvent) => void) => () => void
}

/**
 * Owns every connect concern: candidate
 * racing, connect/reconnect/backoff, credential presentation, and the
 * `connState` bridge emit to Swift on every transition. Drives `ConnState`
 * exclusively through `transition()` -- nothing here assigns a state literal.
 *
 * Non-connect message types (chat, mirror, history, env-switch, ...) are
 * hers to receive but not to interpret: `onMessage` hands the raw parsed
 * event to whoever subscribes, same shape as `subscribeNativeIntent`.
 */
export function useConnection(): UseConnectionResult {
  const [connState, setConnStateRaw] = useState<ConnState>({ kind: 'connecting' })
  const [handoffLabel, setHandoffLabel] = useState<string | null>(null)
  const [conflict, setConflict] = useState<ConflictKind | null>(null)
  const [role, setRole] = useState<'controller' | 'viewer' | null>(null)
  const [viewer, setViewer] = useState<ViewerState | null>(null)
  const [reconnectAttempt, setReconnectAttempt] = useState(0)
  const [searching, setSearching] = useState(false)
  const [tunnelReach, setTunnelReach] = useState<TunnelReach | null>(null)

  const wsRef = useRef<WebSocket | null>(null)
  const wsReadyRef = useRef(false)
  const parkedRef = useRef(false)
  const messageSubscribers = useRef(new Set<(msg: PhoneRemoteEvent) => void>())
  // Read inside onVisible, which is registered once on mount and would
  // otherwise close over the first render's (stale) connState forever.
  const connStateRef = useRef(connState)
  // Set by the connect-effect on every mount, read by forceRediscover -- a
  // ref because forceRediscover is a stable useCallback with no reason to
  // depend on (and re-run) the connect effect itself.
  const escalateNowRef = useRef<(() => void) | null>(null)

  // Bridge emit fires on every transition, no exceptions -- done
  // here, once, rather than at each call site that might forget it.
  const dispatch = useCallback((event: Parameters<typeof transition>[1]) => {
    setConnStateRaw((prev) => {
      const next = transition(prev, event)
      connStateRef.current = next
      if (next !== prev) {
        nativeBridge.connState(next.kind, next.kind === 'blocked' ? next.reason : undefined)
        // The event too, not just the resulting state: `blocked/mac-unreachable`
        // is reached from a close, a refusal and a timeout, and which one it was
        // is the difference between a cert problem and a wrong host.
        nativeBridge.log(
          `conn ${prev.kind} → ${next.kind}` +
            (next.kind === 'blocked' ? `/${next.reason}` : '') +
            ` on ${event.type}`
        )
      }
      return next
    })
  }, [])

  const answerOutboxRef = useRef<PhoneRemoteMessage[]>([])
  const send = useCallback((msg: PhoneRemoteMessage): boolean => {
    const ws = wsRef.current
    if (!wsReadyRef.current || !ws || ws.readyState !== WebSocket.OPEN) {
      if (msg.type !== 'relayRespond') return false
      answerOutboxRef.current.push(msg)
      return true
    }
    const payload = JSON.stringify(msg)
    wsTxMeter.msgs++
    wsTxMeter.bytes += payload.length
    ws.send(payload)
    return true
  }, [])

  const sendBinary = useCallback((buf: ArrayBuffer): boolean => {
    const ws = wsRef.current
    if (!wsReadyRef.current || !ws || ws.readyState !== WebSocket.OPEN) return false
    wsTxMeter.msgs++
    wsTxMeter.bytes += buf.byteLength
    ws.send(buf)
    return true
  }, [])

  const onMessage = useCallback((handler: (msg: PhoneRemoteEvent) => void) => {
    messageSubscribers.current.add(handler)
    return () => messageSubscribers.current.delete(handler)
  }, [])

  const retryNow = useCallback(() => location.reload(), [])

  const forceRediscover = useCallback(() => escalateNowRef.current?.(), [])

  const takeControl = useCallback(() => {
    sessionStorage.setItem(TAKEOVER_FLAG_KEY, '1')
    location.reload()
  }, [])

  // Both credentials go first: whatever races the close must find nothing to
  // reconnect with. The ref goes up before the close too -- setState wouldn't
  // have flushed by the time onclose reads it.
  const disconnectNow = useCallback(() => {
    // Who called this is the whole question: it deletes the credential, and a
    // tap is only ONE of its paths in.
    nativeBridge.log(
      `UNPAIR SELF called — stack: ${new Error().stack?.replace(/\s+/g, ' ').slice(0, 500)}`,
      'error'
    )
    recordAttempt('unpaired-self', {
      host: location.host,
      hadCredential: !!currentDeviceCredential()
    })
    void flushAttemptsToHost(location.host)
    send({ type: 'unpairSelf' })
    clearDeviceCredential()
    parkedRef.current = true
    wsRef.current?.close(CONFIG.PHONE_REMOTE.CLOSE_CODE_LEFT, 'left')
  }, [send])

  useEffect(() => {
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let attempt = 0
    // Start of the current never-connected stretch. Cleared on the first
    // `onopen`: once a phone has reached the Mac, a later drop is a network
    // blip and must retry indefinitely -- the budget only exists to stop a
    // phone that has never got anywhere from spinning with no terminal screen.
    let budgetStartedAt = Date.now()

    /** True once a phone that has never connected has spent its whole budget.
     *  Checked before scheduling, not inside the timer, so the terminal state
     *  lands instead of one more doomed attempt. */
    function budgetSpent(): boolean {
      return Date.now() - budgetStartedAt >= CONFIG.PHONE_REMOTE.CONNECT_BUDGET_MS
    }

    function scheduleRetry(target?: { host: string; port: number; tunnelHost?: string }): void {
      // Every host gets a terminal state now. Safari previously reached one
      // only via the cert branch below, and the native shell and PWA -- which
      // have no Safari to escape to -- reached none at all and looped forever.
      if (budgetSpent()) {
        // The one entry that says the phone STOPPED. Every other outcome is
        // followed by another try, so without this the log ends mid-ladder
        // and cannot distinguish giving up from the page being closed.
        const gaveUpHost = target ? `${target.host}:${target.port}` : location.host
        recordAttempt('gave-up', {
          detail: `budget ${CONFIG.PHONE_REMOTE.CONNECT_BUDGET_MS}ms spent`,
          host: gaveUpHost,
          hadCredential: !!currentDeviceCredential(),
          attempt
        })
        void flushAttemptsToHost(gaveUpHost)
        dispatch({ type: 'socketClosed', reason: 'mac-unreachable' })
        return
      }
      const ladder = CONFIG.PHONE_REMOTE.RECONNECT_BACKOFF_MS
      const delay = ladder[Math.min(attempt, ladder.length - 1)]
      attempt += 1
      setReconnectAttempt(attempt)
      dispatch({ type: 'retry' })
      retryTimer = setTimeout(() => { void connect(target) }, delay)
    }

    // Every known candidate raced in parallel, first answer wins --
    // no priority order, no cache-staleness heuristic. `discoverHost` already
    // does this internally for the tunnel/mDNS/last-known/subnet rungs; this
    // wraps it as the single retry-vs-stranded decision point.
    async function escalateToDiscovery(): Promise<void> {
      if (cancelled) return
      setSearching(true)
      const found = await discoverHost()
      setSearching(false)
      if (cancelled) return
      if (found) {
        attempt = 0
        if (found.tunnelReach) setTunnelReach(found.tunnelReach)
        void connect(found)
      } else {
        // A sweep that found nothing used to be terminal ONLY where Safari's
        // cert escape exists -- the inverse of what the capability means, and
        // the reason the native shell retried forever. Now every host lands
        // here and `scheduleRetry` decides via the budget.
        recordAttempt('no-host-found', { hadCredential: !!currentDeviceCredential(), attempt })
        void flushAttemptsToHost(location.host)
        scheduleRetry()
      }
    }

    // One shot per page load: the QR's ?c= is single-use, and a retry
    // must not POST it again after the first spend already stripped it.
    let urlPairTried = false

    async function connect(target?: { host: string; port: number; tunnelHost?: string }): Promise<void> {
      if (cancelled) return
      if (!urlPairTried) {
        urlPairTried = true
        const outcome = await spendUrlPairingCode({
          href: location.href,
          hasCredential: !!currentDeviceCredential(),
          replaceHref: (next) => history.replaceState(null, '', next),
          exchange: exchangePairingCode
        })
        if (cancelled) return
        if (outcome === 'spent') nativeBridge.log('pair → OK from URL, credential stored')
        else if (outcome === 'failed') nativeBridge.log('pair → FAILED from URL', 'error')
      }
      if (cancelled) return
      dispatch({ type: 'connectAttemptStarted' })
      const host = target ? `${target.host}:${target.port}` : location.host
      const credential = currentDeviceCredential()
      // Recorded at DIAL time, not from the server's refusal: a phone with
      // nothing stored dials anyway, so the Mac's 'no-credential' is the only
      // other evidence -- and it never arrives when the Mac is unreachable
      // too. This separates "never paired / storage wiped" from "the Mac said
      // no", which are the same screen and completely different fixes.
      if (!credential) recordAttempt('no-stored-credential', { host, attempt })
      const params = new URLSearchParams()
      if (credential) params.set(CONFIG.PHONE_REMOTE.DEVICE_CREDENTIAL_PARAM, credential)
      // Spent on read: one tap evicts once. Leaving it set would make every
      // later reconnect on this tab an eviction, which is the kick war again.
      if (sessionStorage.getItem(TAKEOVER_FLAG_KEY) === '1') {
        sessionStorage.removeItem(TAKEOVER_FLAG_KEY)
        params.set(CONFIG.PHONE_REMOTE.TAKEOVER_PARAM, '1')
      }
      if (isInstalled()) params.set(CONFIG.PHONE_REMOTE.STANDALONE_PARAM, '1')
      // detectCursorless(), not the cached isCursorless(): a reconnect can fire
      // before the resize watch has settled, and a glasses socket that fails to
      // declare itself takes the session as controller.
      if (detectCursorless()) params.set(CONFIG.PHONE_REMOTE.CURSORLESS_PARAM, '1')
      params.set(CONFIG.PHONE_REMOTE.SHELL_PARAM, capabilities.shell)
      const hints = deviceHints()
      if (hints.deviceModel) params.set(CONFIG.PHONE_REMOTE.DEVICE_MODEL_PARAM, hints.deviceModel)
      if (hints.osVersion) params.set(CONFIG.PHONE_REMOTE.OS_VERSION_PARAM, hints.osVersion)
      const search = params.toString() ? `?${params}` : ''
      // wss (not ws): the page loads over https, so a plain ws:// socket would
      // be mixed-content-blocked by Safari.
      // Presence only, never the values -- these authorize the socket.
      nativeBridge.log(`ws dial wss://${host} cred=${credential ? 'yes' : 'no'}`)
      // The credential's identity, so a phone reconnecting on a DIFFERENT one
      // than it paired with is visible. A prefix cannot reconstruct the secret.
      if (credential) nativeBridge.log(`ws cred fingerprint ${credential.slice(0, 6)}`)
      const ws = new WebSocket('wss://' + host + search)
      ws.binaryType = 'arraybuffer'
      wsRef.current = ws
      // Per-socket, not per-hook: `onclose` needs to know whether THIS dial
      // ever reached the Mac, which is what separates a failure worth logging
      // from an ordinary mid-session drop.
      let everOpened = false

      ws.onopen = () => {
        everOpened = true
        wsReadyRef.current = true
        attempt = 0
        // A reached Mac retires the budget for good: every later drop on this
        // page is a blip on a phone that demonstrably CAN connect, and must
        // keep retrying rather than parking on a dead-end screen.
        budgetStartedAt = Infinity
        // Same evidence retires the tombstones: a socket that opened proves
        // any earlier refusal was transient, so the Keychain copy must become
        // readable again rather than staying blocked for the whole launch.
        retireTombstones()
        setReconnectAttempt(0)
        setSearching(false)
        dispatch({ type: 'socketOpened' })
        for (const held of answerOutboxRef.current.splice(0)) ws.send(JSON.stringify(held))
        rememberHost(target ? target.host : location.hostname)
        rememberTunnelHost(target?.tunnelHost)
        // The failed attempts that led here, now that there is finally a
        // socket to carry them. Sent before the pref burst so they land even
        // if something in that round trip goes wrong.
        for (const entry of drainAttempts()) {
          send({ type: 'debugLog', message: `CONNECTLOG ${formatAttempt(entry)}` })
        }
        send({ type: 'getSensitivity' })
        send({ type: 'getLayoutPrefs' })
        send({ type: 'getEnv' })
        send({ type: 'appSwitchMru' })
      }

      ws.onclose = (event) => {
        wsReadyRef.current = false
        // The Mac assigns this on every connect, so a stale value across a
        // reconnect would let a device act as the role it USED to hold.
        setRole(null)
        setViewer(null)
        if (parkedRef.current) {
          dispatch({ type: 'socketClosed', reason: null })
          return
        }
        // The server states the reason directly now -- no client
        // inference. A bare 4401 with no BlockedReason string is stale/unknown
        // and treated as unreachable rather than guessed at.
        if (event.code === 4401) {
          const reason = (event.reason as BlockedReason) || 'mac-unreachable'
          recordAttempt('rejected', {
            detail: reason,
            host,
            hadCredential: !!credential,
            attempt,
            opened: everOpened
          })
          if (shouldClearCredential(reason, everOpened, !!credential)) {
            recordAttempt('cleared-credential', {
              detail: reason,
              host,
              hadCredential: !!credential,
              attempt,
              opened: everOpened
            })
            clearDeviceCredential()
          }
          void flushAttemptsToHost(host)
          dispatch({ type: 'socketClosed', reason })
          return
        }
        if (event.code === CONFIG.PHONE_REMOTE.CLOSE_CODE_CONFLICT) {
          const conflict = conflictReason(event.reason)
          // This phone's own newer socket retired this one (LAN vs tunnel) --
          // showing a blocked screen here would cover a live session with a
          // prompt to take control back from itself.
          if (conflict === 'superseded') return
          recordAttempt('conflict', {
            detail: event.reason || null,
            host,
            hadCredential: !!credential,
            attempt,
            opened: everOpened
          })
          void flushAttemptsToHost(host)
          setConflict(conflictKind(event.reason))
          dispatch({ type: 'socketClosed', reason: conflict })
          return
        }
        if (event.code === 4429) {
          recordAttempt('rate-limited', {
            host,
            hadCredential: !!credential,
            attempt,
            opened: everOpened
          })
          void flushAttemptsToHost(host)
          dispatch({ type: 'socketClosed', reason: 'rate-limited' })
          return
        }
        // Only a socket that never opened is an unexplained failure. A close
        // on a session that WAS connected is an ordinary drop, and recording
        // those would bury the never-connected attempts this log exists for.
        if (!everOpened) {
          recordAttempt('dial-failed', {
            detail: `close ${event.code}`,
            host,
            hadCredential: !!credential,
            attempt,
            opened: false
          })
          void flushAttemptsToHost(host)
        }
        if (attempt >= CONFIG.PHONE_REMOTE.RECONNECT_ESCALATE_AFTER) {
          dispatch({ type: 'socketClosed', reason: null })
          void escalateToDiscovery()
        } else {
          dispatch({ type: 'socketClosed', reason: null })
          scheduleRetry(target)
        }
      }

      ws.onerror = () => {
        wsReadyRef.current = false
      }

      ws.onmessage = (event) => {
        // Binary is the native app's PiP media. It only crosses to Swift --
        // this page has no decoder, and parsing it as JSON would throw 20x a
        // second.
        if (typeof event.data !== 'string') {
          forwardPipBinary(event.data)
          return
        }
        let msg: PhoneRemoteEvent
        try {
          msg = JSON.parse(event.data)
        } catch {
          return
        }
        // Arrives just before the 4409 close -- only the label is set here,
        // the close handler owns the state change, so there is one path in.
        if (msg.type === 'takenOver') {
          setHandoffLabel(msg.label)
          return
        }
        // The paired phone let this device in. Reload rather than reusing this
        // socket: it was never authorized, so the Mac has assigned it no role
        // and none of the connect-time state exists on it. A reload dials back
        // with `?d=` and arrives as an ordinary paired device -- the same
        // recovery the pairing form runs, rather than a second way to be
        // connected that every later `role`/`viewer` consumer would have to
        // know about.
        if (msg.type === 'approved') {
          rememberDeviceCredential(msg.credential)
          location.reload()
          return
        }
        // Parked pending the phone's verdict. Stated by the Mac, never inferred
        // from the socket being open-but-quiet -- same discipline as the close
        // reasons.
        if (msg.type === 'approvalPending') {
          dispatch({ type: 'approvalPending', expiresAt: msg.expiresAt })
          return
        }
        // Owned here for the same reason `takenOver` is: one path in, so no
        // subscriber can disagree with the hook about which device this is.
        if (msg.type === 'role') {
          setRole(msg.role)
          return
        }
        // Same reason as `role`: this is a fact about who is connected, and
        // the Mac is the only one who can see both sockets.
        if (msg.type === 'viewer') {
          setViewer(
            msg.viewer === 'receiving'
              ? { kind: 'receiving', screenW: msg.screenW, screenH: msg.screenH }
              : { kind: msg.viewer }
          )
          return
        }
        messageSubscribers.current.forEach((subscriber) => subscriber(msg))
      }
    }

    // Picking the phone up is a strong "try now" signal -- reset the backoff
    // ladder and retry immediately instead of waiting out whatever delay was
    // in flight from before the screen locked/backgrounded. A blocked state
    // (busy/revoked/rate-limited) must NOT auto-retry here: that's the kick
    // war this state machine exists to prevent, and its own screen's button
    // is the only way out.
    function onVisible(): void {
      if (document.visibilityState !== 'visible') return
      if (wsRef.current?.readyState === WebSocket.OPEN) return
      if (parkedRef.current) return
      // A blocked state normally means "no credential" or "another device has
      // it" -- its own screen's button is the only way out, or picking the
      // phone back up would silently re-enter the kick war a button exists to
      // prevent. mac-unreachable is the one exception: nothing to confirm or
      // take control of, so "try now" is exactly what picking the phone up means.
      const current = connStateRef.current
      const retriable =
        current.kind === 'disconnected' ||
        (current.kind === 'blocked' && current.reason === 'mac-unreachable')
      if (!retriable) return
      dispatch({ type: 'retry' })
      attempt = 0
      // Picking the phone up is an explicit "try now", so a phone that never
      // connected gets its budget back -- otherwise the first 45s would be the
      // only 45s this page ever spends trying, and every later pickup would
      // fall straight back to the dead-end screen without attempting anything.
      if (budgetStartedAt !== Infinity) budgetStartedAt = Date.now()
      setReconnectAttempt(0)
      if (retryTimer) clearTimeout(retryTimer)
      void connect()
    }
    document.addEventListener('visibilitychange', onVisible)

    // The banner's "Retry now" button, and the ONE thing a doomed cached host
    // can actually be rescued by. A plain `location.reload()` re-fetches the
    // page from its CURRENT origin -- on the native shell that origin is the
    // exact dead host baked into the WKWebView's URL, so a reload can only
    // repeat the same failed dial forever. This instead cancels whatever the
    // ladder is doing and runs the same discovery sweep the ladder itself
    // would eventually escalate to, immediately, over the LIVE page.
    function forceRediscoverNow(): void {
      if (parkedRef.current) return
      if (retryTimer) clearTimeout(retryTimer)
      attempt = 0
      if (budgetStartedAt !== Infinity) budgetStartedAt = Date.now()
      void escalateToDiscovery()
    }
    escalateNowRef.current = forceRediscoverNow

    void connect()
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisible)
      if (retryTimer) clearTimeout(retryTimer)
      escalateNowRef.current = null
      wsRef.current?.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return {
    connState,
    handoffLabel,
    conflict,
    role,
    viewer,
    reconnectAttempt,
    searching,
    tunnelReach,
    send,
    sendBinary,
    retryNow,
    forceRediscover,
    takeControl,
    disconnectNow,
    onMessage
  }
}

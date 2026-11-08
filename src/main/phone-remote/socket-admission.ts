import type { IncomingMessage } from 'http'
import { WebSocket } from 'ws'
import { CONFIG } from '../../shared/config'
import { IS_DEV, devLog } from '../../shared/env'
import { parseDeviceIdentity } from './device-identity'
import { recordJournal } from './connection-journal'
import { beginSession } from './session-meter'
import { getTunnelHostname } from './cloudflare-tunnel'
import type { BlockedReason } from './connection-state'
import type { PhoneRemoteMessage, PhoneRemoteEvent } from '../../shared/phone-remote-protocol'
import { createPendingFrame, handleSocketMessage } from './socket-messages'
import {
  isDeviceCredentialValid,
  describeAuthFailure,
  deviceIdFor,
  labelForCredential,
  rememberDeviceIdentity,
  clampClientString,
  asHostShell
} from './device-credentials'
import { requestApproval } from './approval'
import { admitWebClient, isWebClientRequest } from './web-client'
import { isRateLimited, recordFailedAttempt, type AttemptEntry } from './rate-limit'
import { publishViewerState } from './viewer-state'
import {
  paramFromRequestUrl,
  withWornSkinLabel,
  getLayoutPrefsProvider,
  type PhoneRemoteCallbacks
} from './server-runtime'

/**
 * Admitting one WebSocket: rate limit, credential, then the role it gets.
 *
 * Split out of `startPhoneRemoteServer`, which was 410 lines with this handler
 * as 364 of them. The session state it decides against -- who holds control,
 * who is watching, who owns the mirror -- stays in server-runtime.ts and is
 * reached through `AdmissionPort`, because those `let`s have readers there
 * (swapControl, sendToPhone, stopPhoneRemoteServer) that narrow them.
 */

/** Everything outside this socket the admission decision reads or moves. */
export interface AdmissionPort {
  callbacks: PhoneRemoteCallbacks
  wsAttempts: Map<string, AttemptEntry>
  /** The socket holding control, or null. Bind to a const before dereferencing. */
  controller: () => WebSocket | null
  setController: (ws: WebSocket | null) => void
  controllerCredential: () => string | null
  setControllerCredential: (credential: string | null) => void
  lastInputAt: () => number
  setLastInputAt: (at: number) => void
  /** The watching device (glasses), or null. Same const rule as `controller`. */
  viewer: () => WebSocket | null
  setViewer: (ws: WebSocket | null) => void
  mirrorPeer: () => WebSocket | null
  /** Claim the slot AND declare the media live. Only `mirrorStart` may. */
  claimMirrorPeer: (ws: WebSocket) => void
  /** The picture ended. Clears the slot and the media flag together. */
  stopMirrorPeer: () => void
  /** This socket dropped. Frees the slot but LEAVES the media flag alone -- a
   *  dropped socket is usually reconnecting and its peer keeps streaming. */
  dropMirrorPeer: (ws: WebSocket) => void
  /** Files this socket's credential so a later role swap can carry identity. */
  rememberCredential: (credential: string) => void
  releaseMirrorSlot: (ws: WebSocket | null) => void
  swapControl: (asking: WebSocket) => void
  endSession: () => void
  /** Reaches the controller AND every observer, so an eviction notice lands. */
  sendToPhone: (event: PhoneRemoteEvent) => void
}

// Kept OUTSIDE activeSocket on purpose: the takeover gate keys on that
// variable, so an observer cannot evict the live phone by any code path.
const observerSockets = new Set<WebSocket>()

/** Each live socket's log tag, so a message is attributed to the device that
 *  actually sent it rather than to whoever connected as controller last. */
const socketLabels = new WeakMap<WebSocket, string>()

/** Falls back to 'phone' for a socket that connected before identity was read. */
function labelForSocket(ws: WebSocket): string {
  return socketLabels.get(ws) ?? 'phone'
}

/** Gates on what THIS request arrived on, not whether the tunnel exists.
 *  `cloudflared` dials the origin as localhost, so tunnel traffic looks
 *  loopback and only the Host header separates them. */
export function decideObserver(input: {
  observeRequested: boolean
  isDev: boolean
  isLoopback: boolean
  requestHost: string | null
  tunnelHostname: string | null
}): boolean {
  if (!input.observeRequested || !input.isDev || !input.isLoopback) return false
  if (!input.tunnelHostname) return true
  // Port-stripped: the tunnel forwards Host verbatim, local clients send :17771.
  const host = (input.requestHost ?? '').toLowerCase().split(':')[0]
  return host !== input.tunnelHostname.toLowerCase()
}

/** Messages an observer may send. Enforced here, not in the React app: a
 *  client-side rule is one the client can simply not follow. */
const OBSERVER_ALLOWED_MESSAGES = new Set<PhoneRemoteMessage['type']>([
  'getSensitivity',
  'getLayoutPrefs',
  'getEnv'
])

export function isLoopbackAddress(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
}
export function decideTakeover(input: {
  msSinceIncumbentInput: number
  takeoverRequested: boolean
  incumbentDeviceId?: string | null
  candidateDeviceId?: string | null
}): 'admit' | 'reconnect' | 'refuse' {
  const { incumbentDeviceId, candidateDeviceId } = input
  if (incumbentDeviceId && candidateDeviceId && incumbentDeviceId === candidateDeviceId) {
    return 'reconnect'
  }
  if (input.takeoverRequested) return 'admit'
  return input.msSinceIncumbentInput < CONFIG.PHONE_REMOTE.TAKEOVER_GRACE_MS ? 'refuse' : 'admit'
}

// Messages a phone sends without the user doing anything: the connect-time
// state fetch, plus keepalive-ish polls. These must not make an idle phone
// look in-use, or a backgrounded tab would hold the Mac against a real one.
const IDLE_MESSAGE_TYPES = new Set<PhoneRemoteMessage['type']>([
  'getSensitivity',
  'getLayoutPrefs',
  'getEnv',
  'appSwitchMru',
  'clipboardState',
  'appContext'
])

/** Every live observer socket, for the outbound fan-out in server-runtime. */
export function observers(): ReadonlySet<WebSocket> {
  return observerSockets
}

export { labelForSocket }

function credentialFromRequestUrl(reqUrl: string | undefined): string | null {
  return paramFromRequestUrl(reqUrl, CONFIG.PHONE_REMOTE.DEVICE_CREDENTIAL_PARAM)
}

export function admitSocket(ws: WebSocket, req: IncomingMessage, port: AdmissionPort): void {
  const remoteIp = req.socket.remoteAddress || 'unknown'
  const candidateCredential = credentialFromRequestUrl(req.url)
  const credentialAuthorized = isDeviceCredentialValid(candidateCredential)

  // A valid credential skips the limiter: every tunnel caller shares the loopback IP's budget.
  if (!credentialAuthorized && isRateLimited(port.wsAttempts, remoteIp)) {
    devLog.warn('[phone-remote] ws connection rate-limited', { from: remoteIp })
    recordJournal('rate-limited', { detail: 'ws-upgrade' })
    ws.close(4429, 'rate-limited' satisfies BlockedReason)
    return
  }

  if (isWebClientRequest(req.url)) {
    admitWebClient(ws, req, port.callbacks, port.wsAttempts)
    return
  }

  if (!credentialAuthorized) {
    const reason = describeAuthFailure(candidateCredential)
    // A device with NO credential can be vouched for by the paired phone --
    // one tap there beats reading digits off the Mac and typing them on a
    // device you are wearing. A REVOKED one is excluded on purpose: that
    // credential was taken away deliberately, and offering to wave it back
    // in would undo the revoke with a prompt the user is likely to accept.
    if (reason === 'no-credential' && requestApproval(ws, req, remoteIp)) return
    devLog.warn('[phone-remote] ws connection rejected', { from: remoteIp, reason })
    recordJournal('rejected', {
      deviceId: candidateCredential ? deviceIdFor(candidateCredential) : null,
      detail: reason
    })
    recordFailedAttempt(port.wsAttempts, remoteIp)
    ws.close(4401, reason)
    return
  }

  devLog.log('[phone-remote] ws connection', { from: remoteIp })

  // Stamped before the observer/viewer/controller branches split, so every
  // socket has a tag no matter which one it takes. Request-scoped: the UA
  // header and the URL params are gone by the time a message arrives.
  {
    const shell = asHostShell(paramFromRequestUrl(req.url, CONFIG.PHONE_REMOTE.SHELL_PARAM))
    const id = parseDeviceIdentity(
      req.headers['user-agent'],
      paramFromRequestUrl(req.url, CONFIG.PHONE_REMOTE.STANDALONE_PARAM) === '1',
      shell
    )
    socketLabels.set(ws, [id.kind, id.browser, shell].filter(Boolean).join('/') || 'phone')
  }

  // Branches out BEFORE the takeover gate below -- that ordering IS the
  // guarantee that an observer never disturbs the live phone.
  if (
    decideObserver({
      observeRequested:
        paramFromRequestUrl(req.url, CONFIG.PHONE_REMOTE.OBSERVE_PARAM) === '1',
      isDev: IS_DEV,
      isLoopback: isLoopbackAddress(remoteIp),
      requestHost: req.headers.host ?? null,
      tunnelHostname: getTunnelHostname()
    })
  ) {
    observerSockets.add(ws)
    devLog.log('[phone-remote] ws connected as observer', { from: remoteIp })
    // Unprompted: the client's own request burst races its connect, and
    // without prefs it sits on the boot gate instead of painting a deck.
    const prefs = getLayoutPrefsProvider()?.()
    if (prefs) ws.send(JSON.stringify(withWornSkinLabel({ type: 'layoutPrefs', ...prefs })))
    ws.on('message', (data, isBinary) => {
      if (isBinary) return
      try {
        const msg = JSON.parse(data.toString()) as PhoneRemoteMessage
        if (!OBSERVER_ALLOWED_MESSAGES.has(msg.type)) {
          devLog.warn('[phone-remote] observer sent a write message, dropped', {
            type: msg.type
          })
          return
        }
        port.callbacks.onMessage?.(msg, labelForSocket(ws))
      } catch (err) {
        devLog.warn('Phone Remote: malformed observer message', err)
      }
    })
    ws.on('close', () => observerSockets.delete(ws))
    ws.on('error', () => observerSockets.delete(ws))
    return
  }

  // A cursorless host has no touch surface, so it is the viewer or nothing --
  // never the controller, whatever the arrival order.
  const declaresCursorless =
    paramFromRequestUrl(req.url, CONFIG.PHONE_REMOTE.CURSORLESS_PARAM) === '1'
  const incumbent = port.controller()
  const incumbentCredential = port.controllerCredential()
  if (declaresCursorless || (incumbent && incumbent !== ws)) {
    const claimed = credentialAuthorized ? candidateCredential : null
    // The refused phone has no socket to send a message on, so its "take
    // control" rides the reconnect URL -- the same channel already carrying
    // the credential, and it lands in this one gate rather than a second path.
    // Never honoured for the glasses: a stale takeover flag in their storage
    // would hand them a session they cannot drive.
    const takeoverGranted =
      !declaresCursorless &&
      paramFromRequestUrl(req.url, CONFIG.PHONE_REMOTE.TAKEOVER_PARAM) === '1'
    // Only meaningful against a live incumbent. The glasses can reach this
    // branch with the session empty, where there is nothing to take over.
    const admit =
      incumbent && incumbent !== ws
        ? decideTakeover({
            msSinceIncumbentInput: Date.now() - port.lastInputAt(),
            takeoverRequested: takeoverGranted,
            incumbentDeviceId: incumbentCredential ? deviceIdFor(incumbentCredential) : null,
            candidateDeviceId: claimed ? deviceIdFor(claimed) : null
          })
        : 'refuse'
    // A DIFFERENT device joins as a viewer whether or not the incumbent is
    // idle. PRD §8.4 originally scoped this to 'refuse' only, to preserve
    // idle-handover -- on-device that was wrong: glasses sit idle by nature
    // (you are looking, not touching), so the phone connecting 2 minutes
    // later hit 'admit' and evicted them, which is the exact behavior this
    // feature exists to remove. Idle-handover still owns the two cases that
    // are genuinely a handover and not a second device:
    //   - the same device reconnecting ('reconnect', matched by device id)
    //   - an explicit "take control" tap (takeoverGranted)
    const wantsControl = takeoverGranted || admit === 'reconnect'
    if (!wantsControl) {
      const seated = port.viewer()
      if (seated && seated !== ws && seated.readyState === WebSocket.OPEN) {
        // Second viewer. One viewer is the cap (PRD §9), and refusing the
        // NEWCOMER is what keeps the incumbent pair undisturbed.
        recordJournal('rejected', {
          deviceId: claimed ? deviceIdFor(claimed) : null,
          detail: 'busy: a controller and a viewer are already connected'
        })
        ws.close(CONFIG.PHONE_REMOTE.CLOSE_CODE_CONFLICT, CONFIG.PHONE_REMOTE.CLOSE_REASON_BUSY)
        return
      }
      port.setViewer(ws)
      if (candidateCredential) port.rememberCredential(candidateCredential)
      recordJournal('joined-as-viewer', {
        deviceId: claimed ? deviceIdFor(claimed) : null,
        label: claimed ? labelForCredential(claimed) : null,
        detail: 'second device joined without evicting the controller'
      })
      devLog.log('[phone-remote] ws connected as viewer', { from: remoteIp })
      // Unprompted, same reason as the observer branch above: the client's
      // own request burst races its connect, and without prefs it sits on the
      // boot gate instead of painting a deck.
      const viewerPrefs = getLayoutPrefsProvider()?.()
      if (viewerPrefs) {
        ws.send(JSON.stringify(withWornSkinLabel({ type: 'layoutPrefs', ...viewerPrefs })))
      }
      ws.send(JSON.stringify({ type: 'role', role: 'viewer' } satisfies PhoneRemoteEvent))
      // After the role: these fan out via sendToPhone, which reaches this
      // socket only now that viewerSocket points at it.
      port.callbacks.onViewerAttach?.()
      const clearViewer = (): void => {
        // Guarded: a late close from a viewer that was already replaced must
        // not null out the CURRENT one.
        if (port.viewer() !== ws) return
        port.setViewer(null)
        // Frees the slot but leaves `mirrorMediaLive` alone: a viewer whose
        // socket dropped is usually reconnecting, and its peer keeps
        // streaming. Only an explicit mirrorStop means the picture ended.
        port.dropMirrorPeer(ws)
        publishViewerState()
      }
      ws.on('close', clearViewer)
      ws.on('error', clearViewer)
      // After the role message, so the controller learns of the viewer only
      // once the viewer itself is fully wired.
      publishViewerState()
      // Deliberately NOT returning: the viewer falls through to the shared
      // message + ping wiring below, so its input is validated by the exact
      // same path as the controller's (PRD v2 step 4) and a dead viewer is
      // detected by the same keepalive. Returning here is what made viewer
      // input a no-op and left the socket with no liveness check at all.
    }
    // A socket that just joined as a viewer fell through here for the shared
    // message + ping wiring, and must skip the eviction chain entirely --
    // otherwise it lands in the final `else` and closes the very controller
    // it was admitted alongside.
    if (port.viewer() === ws || !incumbent) {
      // Nothing to evict: two devices, both welcome -- or, for a cursorless
      // host arriving to an empty server, no incumbent to evict at all.
    } else if (admit === 'reconnect') {
      // close() is async, so the reconnecting phone's own mirrorStart can
      // arrive while the dead socket still reads OPEN and holds the slot.
      port.releaseMirrorSlot(incumbent)
      // The same phone on a second route. Closing 'evicted' would send it
      // down the conflict path and pop a "take control" button against
      // itself, so retire the stale socket quietly and keep the session.
      recordJournal('evicted-previous', {
        deviceId: claimed ? deviceIdFor(claimed) : null,
        detail: 'same device reconnected on another transport'
      })
      incumbent.close(
        CONFIG.PHONE_REMOTE.CLOSE_CODE_CONFLICT,
        CONFIG.PHONE_REMOTE.CLOSE_REASON_SUPERSEDED
      )
    } else {
      // Journalled because from the evicted phone's side this is otherwise
      // indistinguishable from a network drop. Evictions in `make phone-log`
      // mean the single-socket handoff, not a network fault.
      // Same reason as the reconnect branch above: an evicted controller
      // must not keep the mirror slot across an async close.
      port.releaseMirrorSlot(incumbent)
      recordJournal('evicted-previous', {
        deviceId: incumbentCredential ? deviceIdFor(incumbentCredential) : null,
        detail: takeoverGranted ? 'takeover requested' : 'replaced while idle'
      })
      // Named before the close so the incumbent can say WHO took over rather
      // than showing a bare disconnect. Sent on the old socket, still open here.
      port.sendToPhone({
        type: 'takenOver',
        label: claimed ? labelForCredential(claimed) : null
      })
      incumbent.close(
        CONFIG.PHONE_REMOTE.CLOSE_CODE_CONFLICT,
        CONFIG.PHONE_REMOTE.CLOSE_REASON_EVICTED
      )
    }
  }
  // A viewer reaches here by falling through the branch above, to pick up the
  // shared message + ping wiring. It must NOT claim the session: assigning
  // activeSocket here would silently promote the watcher to the controller,
  // which is the one thing the two-device split exists to prevent.
  const isViewer = port.viewer() === ws
  if (!isViewer) {
    port.setController(ws)
    port.setLastInputAt(Date.now())
    port.setControllerCredential(candidateCredential)
    if (candidateCredential) port.rememberCredential(candidateCredential)
    // Stated, never inferred -- the same discipline the close reasons follow.
    // A controller that reconnects while a viewer is attached must hear it is
    // the controller, or it has no way to tell which device it became.
    ws.send(JSON.stringify({ type: 'role', role: 'controller' } satisfies PhoneRemoteEvent))
    // A controller arriving to glasses that are ALREADY watching gets no
    // other signal that they exist -- the viewer's own join fired before
    // this socket was the controller, so without this the zoom track would
    // stay dark until the glasses reconnected.
    publishViewerState()
  }
  // Stamp last-seen and backfill the UA here rather than at /pair only: a
  // device paired before identity capture existed has no UA on file, and its
  // next connect is the one chance to learn one without a re-pair.
  const connectStandalone =
    paramFromRequestUrl(req.url, CONFIG.PHONE_REMOTE.STANDALONE_PARAM) === '1'
  const connectShell = asHostShell(paramFromRequestUrl(req.url, CONFIG.PHONE_REMOTE.SHELL_PARAM))
  // All session-claiming side effects, controller-only. A viewer that ran
  // these would double-bill the tunnel via beginSession, write a second
  // 'connected' line that makes one person's two devices read as two
  // sessions, and fire onConnect -- which drives the Mac's "phone connected"
  // UI and would announce the glasses as a replacement for the phone.
  // Its own arrival is already journalled as 'joined-as-viewer'.
  const heldCredential = port.controllerCredential()
  if (!isViewer) {
    if (heldCredential) {
      rememberDeviceIdentity(
        heldCredential,
        req.headers['user-agent'],
        connectStandalone,
        connectShell,
        clampClientString(paramFromRequestUrl(req.url, CONFIG.PHONE_REMOTE.DEVICE_MODEL_PARAM)),
        clampClientString(paramFromRequestUrl(req.url, CONFIG.PHONE_REMOTE.OS_VERSION_PARAM))
      )
    }
    recordJournal('connected', {
      deviceId: heldCredential ? deviceIdFor(heldCredential) : null,
      label: heldCredential ? labelForCredential(heldCredential) : null,
      // Which credential got it in: a phone that only ever connects on the
      // session token has not actually enrolled, and will strand the moment
      // that token expires or the server restarts.
      detail: credentialAuthorized ? 'device-credential' : 'session-token'
    })
    // Off-LAN sessions are billed by wall-clock time; same-Wi-Fi is free and
    // no-ops inside. Read the Host header here — it's request-scoped and gone
    // by the time the close handler runs.
    beginSession(req.headers.host ?? null)
    // Parsed here, not in the callback: the UA header and the URL params are
    // request-scoped and gone by the time anything downstream runs.
    const connectIdentity = parseDeviceIdentity(
      req.headers['user-agent'],
      connectStandalone,
      connectShell
    )
    // Chrome 110+ freezes the Android version in the UA to a literal "10" for
    // every device, so the UA is the WORST source here -- the client's own
    // platformVersion is the real one. Same precedence as pairing.ts:220.
    const connectOsVersion = clampClientString(
      paramFromRequestUrl(req.url, CONFIG.PHONE_REMOTE.OS_VERSION_PARAM)
    )
    port.callbacks.onConnect?.({
      shell: connectShell,
      kind: connectIdentity.kind,
      browser: connectIdentity.browser,
      browserVersion: connectIdentity.browserVersion,
      os: connectIdentity.os,
      osVersion: connectOsVersion ?? connectIdentity.osVersion,
      modelKnown:
        clampClientString(
          paramFromRequestUrl(req.url, CONFIG.PHONE_REMOTE.DEVICE_MODEL_PARAM)
        ) !== null
    })
  }

  const pending = createPendingFrame()
  ws.on('message', (data, isBinary) =>
    handleSocketMessage(data, isBinary, {
      ws,
      callbacks: port.callbacks,
      pending,
      isControllerInput: () => port.controller() === ws,
      markInput: () => {
        port.setLastInputAt(Date.now())
      },
      mirrorHolder: () => port.mirrorPeer(),
      claimMirror: () => {
        port.claimMirrorPeer(ws)
        publishViewerState()
      },
      releaseMirror: () => {
        if (port.mirrorPeer() !== ws) return
        port.stopMirrorPeer()
        publishViewerState()
      },
      requestControlSwap: () => port.swapControl(ws),
      labelForSocket,
      isIdleMessage: (type) => IDLE_MESSAGE_TYPES.has(type)
    })
  )

  let alive = true
  ws.on('pong', () => {
    alive = true
  })
  const pingTimer = setInterval(() => {
    if (!alive) {
      devLog.warn('[phone-remote] ws unresponsive to ping, terminating')
      ws.terminate()
      return
    }
    alive = false
    ws.ping()
  }, CONFIG.PHONE_REMOTE.WS_PING_MS)

  ws.on('close', (code, reason) => {
    clearInterval(pingTimer)
    devLog.log('[phone-remote] ws closed', { code, reason: reason.toString() })
    const wasViewerAtClose = port.controller() !== ws && isViewer
    if (port.controller() === ws) {
      const closingCredential = port.controllerCredential()
      recordJournal('disconnected', {
        deviceId: closingCredential ? deviceIdFor(closingCredential) : null,
        detail: `close ${code}`
      })
      port.endSession()
      port.setController(null)
      port.setControllerCredential(null)
      port.setLastInputAt(0)
    }
    // Outside the activeSocket branch on purpose: the mirror peer may be the
    // VIEWER, whose close leaves the controller's session running. A stale
    // peer here would send the next mirror's frames to a dead socket.
    port.dropMirrorPeer(ws)
    // The viewer's own close already published via clearViewer; this covers
    // the case it does not -- a peer whose mirror died while it stays
    // attached, which flips `mirroring` without touching `viewerSocket`.
    publishViewerState()
    // A viewer leaving is not a disconnect: the phone is still driving, and
    // firing this would tell the Mac its controller went away. Read live
    // rather than trusting the admission-time `isViewer`: a viewer that
    // adopted the empty slot IS the controller now, and its close must fire.
    if (!wasViewerAtClose) port.callbacks.onDisconnect?.()
  })
  ws.on('error', (err) => {
    devLog.log('[phone-remote] ws error', err)
  })
}

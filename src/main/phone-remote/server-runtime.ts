/**
 * Phone Remote transport — a local HTTPS + WebSocket server that serves the
 * static remote-control page and carries touch/tap messages + one binary audio
 * blob per recording. Deliberately DOMAIN-FREE: this file knows nothing about
 * runInput/whisper/runHudRun — it just serves bytes and hands typed messages to
 * whatever callbacks src/main/ipc/phone-remote.ts wires up. That file owns the
 * glue to the rest of the app; this one stays reusable/testable on its own.
 *
 * Binds 0.0.0.0 (not 127.0.0.1) ONLY while the toggle is on, so a phone on the
 * same Wi-Fi can reach it — that's the whole feature. Port is fixed (see
 * CONFIG.PHONE_REMOTE.PORT) with a small retry range for the "port already
 * taken" edge case; there is no dynamic port because the QR payload needs a
 * stable, predictable target to embed.
 *
 * HTTPS, not HTTP: iOS Safari (and every modern browser) only exposes
 * `navigator.mediaDevices.getUserMedia` on a secure context (https:// or
 * localhost). A LAN IP served over plain http:// makes `mediaDevices` itself
 * `undefined` — the mic button was silently dead on every phone, with no OS
 * permission prompt ever appearing, regardless of Settings toggles. Fix: serve
 * a self-signed cert (generated once, cached under PATHS.ROOT) over https:// +
 * wss://. The phone eats one "not private" Safari warning per new cert; after
 * that, getUserMedia works and the real OS mic prompt appears like any other
 * HTTPS site.
 *
 * EXCEPT the icon: iOS Safari silently refuses to fetch apple-touch-icon/
 * favicon over a self-signed HTTPS cert, even once the user has trusted it
 * for page loads — the touch-icon fetch path doesn't honor that per-site
 * trust the way normal page/asset loads do. So `startIconServer()` below runs
 * a second, plain-HTTP-only listener on ICON_PORT just for the icon file;
 * index.html points its <link> tags at that port instead of a relative path.
 */
import { createServer as createHttpsServer, type Server as HttpsServer } from 'https'
import type { Server as HttpServer } from 'http'
import { networkInterfaces } from 'os'
import { WebSocketServer, WebSocket } from 'ws'
import { remoteSkinLabel } from './remote-skins'
import { capabilities } from '../platform'
import { CONFIG } from '../../shared/config'
import type { InkSendTarget } from '../../shared/ink'
import { devLog } from '../../shared/env'
import { parseDeviceIdentity, formatDeviceLabel } from './device-identity'
import { recordJournal } from './connection-journal'
import { endSession } from './session-meter'
import type { PhoneRemoteDeviceKind } from '../../shared/types'
import { startMdnsAdvertisement, stopMdnsAdvertisement } from './mdns'
import type {
  InstallableSkin,
  PhoneRemoteColorScheme,
  PhoneRemoteHandedness,
  PhoneRemoteKeysPosition,
  PhoneRemoteDeckMode,
  PhoneRemoteSplitConcept,
  PhoneRemoteMirrorPlacement,
  PhoneAudioDestination,
  HostShell
} from '../../shared/types'

// tls-cert.ts owns cert generation/reuse; re-exported here so server.ts's
// public API (and its import of certCoversLanIp) doesn't change.
export { certCoversLanIp } from './tls-cert'
import { loadOrCreateCert } from './tls-cert'
import {
  admitSocket,
  decideObserver,
  decideTakeover,
  isLoopbackAddress,
  observers
} from './socket-admission'
// Re-exported so relay-http.ts, server.ts and the observer/eviction tests keep
// importing these from here, the path they have always used.
export { decideObserver, decideTakeover, isLoopbackAddress }
import { RATE_LIMIT_WINDOW_MS, rateLimitBucket, allRateLimitBuckets } from './rate-limit'
import { loadDeviceCredentials, deviceIdFor } from './device-credentials'
// Re-exported (not just imported) so server.ts's facade -- which imports
// these from server-runtime -- doesn't need to change.
export {
  forgetPairedDevices,
  getPairedDeviceCount,
  listPairedDevices,
  revokePairedDevice,
  revokeActiveDevice
} from './device-credentials'
import { clearPairingCode } from './pairing'
// Re-exported (not just imported) so server.ts's facade -- which imports
// these from server-runtime -- doesn't need to change.
export {
  issuePairingCode,
  currentPairingCode,
  currentPairingCodeExpiresAt,
  clearPairingCode
} from './pairing'
// Re-exported for the same reason -- server.ts imports these from server-runtime.
export { openApprovalWindow, closeApprovalWindow, resolveApproval } from './approval'
import {
  serveStatic,
  startIconServer as startIconServerImpl
} from './http-handlers'
import { publishViewerState } from './viewer-state'
import { sendToWebClients } from './web-client'

import type {
  PhoneRemoteKeyName,
  PhoneRemoteModifier,
  HostKeyboard,
  HostDevice,
  PipBinaryKind
} from '../../shared/phone-remote-keys'
export type { PhoneRemoteKeyName, PhoneRemoteModifier }

/** The wire protocol both sides speak. Declared once in src/shared so the phone
 *  bundle imports the SAME union this server switches on -- re-exported here
 *  because several modules import these types from server.ts today. */
import type {
  PhoneRemoteMessage,
  PhoneRemoteEvent,
  DictationEntry
} from '../../shared/phone-remote-protocol'
export type { PhoneRemoteMessage, PhoneRemoteEvent, DictationEntry }

export interface ConnectedDeviceIdentity {
  shell: HostShell | null
  kind: PhoneRemoteDeviceKind
  browser: string
  browserVersion: string | null
  os: string
  osVersion: string | null
  /** The client named its own hardware -- the native app always can, Chromium
   *  can via high-entropy hints, iOS Safari never can. The model itself stays
   *  out of analytics; only whether we HAVE one crosses this boundary. */
  modelKnown: boolean
}

export interface PhoneRemoteCallbacks {
  /** `label` names the socket the message arrived on -- glasses and phone are
   *  both live at once, and a module-global written only at controller connect
   *  relabelled the viewer's own lines as the phone's. */
  onMessage?: (msg: PhoneRemoteMessage, label: string) => void
  onAudio?: (
    data: Buffer,
    durationMs: number,
    to: PhoneAudioDestination,
    clipId: string,
    queued: boolean
  ) => void
  onImage?: (
    data: Buffer,
    mime: string,
    name: string,
    submit: boolean,
    /** Present only when the image answers a photos_get card. */
    requestId?: string,
    /** Present only when the user attached it to a reply in progress. */
    replyToLabel?: string,
    ink?: InkSendTarget
  ) => void
  /** Text arriving from the iOS share sheet (a URL from Safari, a selection).
   *  Separate from onImage because the Mac types it rather than pasting an
   *  image, and separate from the WS text path because this one can submit. */
  onShareText?: (text: string, submit: boolean) => void
  onConnect?: (identity: ConnectedDeviceIdentity) => void
  onDevicePaired?: (identity: ConnectedDeviceIdentity, totalDevices: number) => void
  onDisconnect?: () => void
  /** A second device attached to watch. Distinct from onConnect, which is
   *  controller-only on purpose -- but the connect-time seeds that fire there
   *  (host status, lock state) are pushes, not replies, so a viewer that never
   *  triggers one waits for the next background change. Battery moves every
   *  few minutes at best, which is how the glasses HUD sat on `--` for a whole
   *  session. */
  onViewerAttach?: () => void
  /** The signed-in Mac account's user id, read synchronously while replying to
   *  /pair so the phone inherits it instead of signing in for itself. Null when
   *  signed out. Never the JWT -- an identity claim, not a credential. */
  getAccountId?: () => string | null
  /** Whether off-Wi-Fi access is on, read at start to decide whether a missing
   *  LAN address is fatal. Passed rather than read here for the same reason as
   *  getLayoutPrefs: PREFS lives above this layer. Absent = treat as off. */
  isTunnelEnabled?: () => boolean
  getLayoutPrefs?: () => {
    skin: InstallableSkin
    colorScheme: PhoneRemoteColorScheme
    handedness: PhoneRemoteHandedness
    /** Landscape-only cluster placement + distribution. Inlined with the rest so
     *  a landscape first paint lands on the right deck instead of re-laying out
     *  once the socket answers. */
    keysPosition: PhoneRemoteKeysPosition
    deckMode: PhoneRemoteDeckMode
    splitConcept: PhoneRemoteSplitConcept
    /** Portrait-only mirror placement. Inlined for the same reason as the rest:
     *  the pane must be in the right place the first time it appears. */
    mirrorPlacement: PhoneRemoteMirrorPlacement
    showCursor: boolean
    /** The MRU-scrubbing arc around the button cluster. Inlined so an enabled
     *  ring is on the first paint rather than popping in a beat later. */
    appRing: boolean
    /** Shared with the Mac's Mighty window (PREFS.getMightyRenderMarkup), not a
     *  phone-local pref -- one concept, one switch. */
    renderMarkup: boolean
    /** Which physical keyboard the HOST has, so the virtual keyboard can mirror
     *  it (always 'mac' today -- the app is macOS-only). */
    hostKeyboard: HostKeyboard
    hostDevice?: HostDevice
  }
}

export type PhoneRemoteStartResult =
  | { ok: true; port: number }
  | { ok: false; reason: 'no-lan' | 'port-busy' | 'unsupported' }

let httpServer: HttpsServer | null = null
let iconServer: HttpServer | null = null
let wss: WebSocketServer | null = null
let activeSocket: WebSocket | null = null
// WHICH device credential holds the live session, so revoking an idle phone
// doesn't kick the one in the user's hand. Null for a session-token session.
let activeSocketCredential: string | null = null
// When the live session last sent input. A newcomer may only take an ACTIVE
// session by explicit request; an idle one is handed over silently.
let activeSocketLastInputAt = 0
// Accessors for device-credentials.ts, which revokes/forgets devices and must
// close + clear the live session without owning these `let`s itself.
export function getActiveSocket(): WebSocket | null {
  return activeSocket
}
export function getActiveSocketCredential(): string | null {
  return activeSocketCredential
}
export function getActiveSocketLastInputAt(): number {
  return activeSocketLastInputAt
}
export function setActiveSocketLastInputAt(value: number): void {
  activeSocketLastInputAt = value
}
export function clearActiveSocket(): void {
  activeSocket = null
  activeSocketCredential = null
}
// Accessors for http-handlers.ts's startIconServer, which lazily starts (and
// checks the existing) icon server without owning the `let` itself --
// stopPhoneRemoteServer here still tears it down alongside wss/httpServer.
export function getIconServer(): HttpServer | null {
  return iconServer
}
export function setIconServer(server: HttpServer | null): void {
  iconServer = server
}

// The device WATCHING (glasses). Same reason it sits outside activeSocket: it
// is not the recipient of the 64 sendToPhone() call sites, so none of them has
// to learn it exists. Singular -- one person, two devices.
let viewerSocket: WebSocket | null = null

export function getViewerSocket(): WebSocket | null {
  return viewerSocket
}

export function getMirrorPeerSocket(): WebSocket | null {
  return mirrorPeerSocket
}

/** Each live socket's credential, so a role swap can carry identity with it.
 *  `activeSocketCredential` only ever tracks the controller, and after a swap
 *  the new controller's credential is no longer reachable from anywhere else. */
const socketCredentials = new WeakMap<WebSocket, string>()


// Held at module scope because serveStatic() runs per-request and isn't handed
// the callbacks object the way the WS handlers are.
let layoutPrefsProvider: PhoneRemoteCallbacks['getLayoutPrefs'] = undefined
// Same reason: handlePair() is a per-request handler, not a closure over the
// callbacks object.
let devicePairedListener: PhoneRemoteCallbacks['onDevicePaired'] = undefined
let accountIdProvider: PhoneRemoteCallbacks['getAccountId'] = undefined
// Accessors for pairing.ts's handlePair(), which reads these but doesn't own
// them -- they're set/cleared by start/stopPhoneRemoteServer here.
export function getDevicePairedListener(): PhoneRemoteCallbacks['onDevicePaired'] {
  return devicePairedListener
}
export function getAccountIdProvider(): PhoneRemoteCallbacks['getAccountId'] {
  return accountIdProvider
}
// Same reason again: /share is served by serveStatic, not the WS handler, so
// the share extension's two sinks have to be reachable from module scope.
let shareImageListener: PhoneRemoteCallbacks['onImage'] = undefined
let shareTextListener: PhoneRemoteCallbacks['onShareText'] = undefined
// Accessors for http-handlers.ts's handleShare/injectLayoutPrefs, same reason
// as the pair above -- set/cleared by start/stopPhoneRemoteServer here.
export function getLayoutPrefsProvider(): PhoneRemoteCallbacks['getLayoutPrefs'] {
  return layoutPrefsProvider
}
export function getShareImageListener(): PhoneRemoteCallbacks['onImage'] {
  return shareImageListener
}
export function getShareTextListener(): PhoneRemoteCallbacks['onShareText'] {
  return shareTextListener
}

export function paramFromRequestUrl(reqUrl: string | undefined, param: string): string | null {
  if (!reqUrl) return null
  try {
    // Base doesn't matter -- only used to parse the query string off a
    // relative WS/HTTP request path.
    const url = new URL(reqUrl, 'https://phone-remote.local')
    return url.searchParams.get(param)
  } catch {
    return null
  }
}



const wsAttempts = rateLimitBucket()

export function clearWsRateLimit(ip: string): void {
  wsAttempts.delete(ip)
}

export function withWornSkinLabel<T extends { skin: InstallableSkin }>(
  prefs: T
): T & { wornSkinLabel?: string } {
  const label = remoteSkinLabel(prefs.skin)
  return label === null ? prefs : { ...prefs, wornSkinLabel: label }
}

export function getLanAddress(): string | null {
  const ifaces = networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family !== 'IPv4' || iface.internal) continue
      // RFC 3927 link-local: unroutable by definition. A phone tethered for
      // Xcode raises one on en5, which enumerates ahead of en0.
      if (iface.address.startsWith('169.254.')) continue
      return iface.address
    }
  }
  return null
}

/** Try to bind `port`; resolves the bound port or null on EADDRINUSE/other error. */
function tryListen(server: HttpsServer, port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const onError = (): void => {
      server.removeListener('error', onError)
      resolve(null)
    }
    server.once('error', onError)
    server.listen(port, '0.0.0.0', () => {
      server.removeListener('error', onError)
      resolve(port)
    })
  })
}

export async function startPhoneRemoteServer(
  callbacks: PhoneRemoteCallbacks
): Promise<PhoneRemoteStartResult> {
  // Every pointer verb the phone sends throws off macOS, and onConnect runs
  // outside the socket's try/catch — accepting a pairing on Windows killed the
  // app rather than degrading. One gate here beats a guard per verb.
  if (!capabilities.pointerControl) return { ok: false, reason: 'unsupported' }
  if (httpServer) {
    const addr = httpServer.address()
    if (addr && typeof addr === 'object') return { ok: true, port: addr.port }
  }
  // No LAN address is fatal only without a tunnel: cloudflared dials the origin
  // as loopback, so a Mac on remote desktop or no Wi-Fi at all still pairs.
  const lanIp = getLanAddress()
  if (lanIp === null && !callbacks.isTunnelEnabled?.()) {
    return { ok: false, reason: 'no-lan' }
  }
  const certIp = lanIp ?? '127.0.0.1'

  layoutPrefsProvider = callbacks.getLayoutPrefs
  devicePairedListener = callbacks.onDevicePaired
  accountIdProvider = callbacks.getAccountId
  shareImageListener = callbacks.onImage
  shareTextListener = callbacks.onShareText

  const { key, cert } = loadOrCreateCert(certIp)
  const server = createHttpsServer({ key, cert }, serveStatic)
  let boundPort: number | null = null
  for (let i = 0; i < CONFIG.PHONE_REMOTE.PORT_RANGE_SIZE; i++) {
    const candidate = CONFIG.PHONE_REMOTE.PORT + i
    boundPort = await tryListen(server, candidate)
    if (boundPort !== null) break
  }
  if (boundPort === null) return { ok: false, reason: 'port-busy' }

  httpServer = server
  if (lanIp !== null) startMdnsAdvertisement(lanIp, boundPort)
  startIconServerImpl()
  // Drop stale rate-limit entries periodically -- the maps otherwise only ever
  // grow for as long as the server (tunnel-reachable, long-lived) is up.
  rateLimitSweepTimer = setInterval(sweepRateLimitBuckets, RATE_LIMIT_WINDOW_MS)
  wss = new WebSocketServer({ server })

  wss.on('connection', (ws, req) =>
    admitSocket(ws, req, {
      callbacks,
      wsAttempts,
      controller: () => activeSocket,
      setController: (next) => {
        activeSocket = next
      },
      controllerCredential: () => activeSocketCredential,
      setControllerCredential: (next) => {
        activeSocketCredential = next
      },
      lastInputAt: () => activeSocketLastInputAt,
      setLastInputAt: (at) => {
        activeSocketLastInputAt = at
      },
      viewer: () => viewerSocket,
      setViewer: (next) => {
        viewerSocket = next
      },
      mirrorPeer: () => mirrorPeerSocket,
      claimMirrorPeer: (next) => {
        mirrorPeerSocket = next
        mirrorMediaLive = true
      },
      stopMirrorPeer: () => {
        mirrorPeerSocket = null
        mirrorMediaLive = false
      },
      dropMirrorPeer: (dropped) => {
        if (mirrorPeerSocket === dropped) mirrorPeerSocket = null
      },
      rememberCredential: (credential) => socketCredentials.set(ws, credential),
      releaseMirrorSlot,
      swapControl,
      endSession,
      sendToPhone
    })
  )

  return { ok: true, port: boundPort }
}

// Every per-IP rate-limit map, for the TTL sweep + full clear below.
// recordFailedAttempt only ever .set()s, so without this the maps grow
// unbounded for as long as the (tunnel-reachable, long-lived) server is up.

// An entry is stale once both its rolling window AND its cooldown (if any)
// have elapsed -- either alone could still be read by isRateLimited/recordFailedAttempt.
function sweepRateLimitBuckets(): void {
  const now = Date.now()
  for (const bucket of allRateLimitBuckets()) {
    for (const [ip, entry] of bucket) {
      if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS && now >= entry.blockedUntil) {
        bucket.delete(ip)
      }
    }
  }
}

let rateLimitSweepTimer: NodeJS.Timeout | null = null

export function stopPhoneRemoteServer(): void {
  // Drop the PREFS closure with the server, so a stopped server holds no
  // reference into the store layer.
  layoutPrefsProvider = undefined
  devicePairedListener = undefined
  accountIdProvider = undefined
  shareImageListener = undefined
  shareTextListener = undefined
  // Outstanding pairing code dies with the server (it's a live, on-screen
  // secret). Device credentials deliberately SURVIVE -- outliving a restart
  // is the entire reason they exist; only forgetPairedDevices() clears them.
  clearPairingCode()
  for (const bucket of allRateLimitBuckets()) bucket.clear()
  if (rateLimitSweepTimer) {
    clearInterval(rateLimitSweepTimer)
    rateLimitSweepTimer = null
  }
  stopMdnsAdvertisement()
  if (activeSocket) {
    activeSocket.close()
    activeSocket = null
    activeSocketCredential = null
  }
  if (viewerSocket) {
    viewerSocket.close()
    viewerSocket = null
  }
  mirrorPeerSocket = null
  mirrorMediaLive = false
  if (wss) {
    wss.close()
    wss = null
  }
  if (httpServer) {
    httpServer.close()
    httpServer = null
  }
  if (iconServer) {
    iconServer.close()
    iconServer = null
  }
}

export function isPhoneRemoteRunning(): boolean {
  return httpServer !== null
}

export function isPhoneConnected(): boolean {
  return activeSocket !== null
}

/** The connected controller's device id, or null if none — for attributing a
 *  Code-sheet resolve() to the phone that actually sent it. */
export function activeDeviceId(): string | null {
  return activeSocketCredential ? deviceIdFor(activeSocketCredential) : null
}

/** A re-pair leaves the old record behind, so the live socket's credential may hold no token
 *  while a sibling record of the SAME handset does -- hence the model match before the fallback. */
export function choosePushTarget<
  T extends { cred: string; rec: { deviceModel: string | null; pairedAt: number } }
>(
  withToken: readonly T[],
  liveCred: string | null,
  liveModel: string | null
): T {
  const newestFirst = (a: T, b: T): number => b.rec.pairedAt - a.rec.pairedAt
  return (
    withToken.find((e) => e.cred === liveCred) ??
    (liveModel === null
      ? undefined
      : [...withToken].filter((e) => e.rec.deviceModel === liveModel).sort(newestFirst)[0]) ??
    [...withToken].sort(newestFirst)[0]
  )
}

/** For the agent-relay MCP send path: who to
 *  push to and their token, or a stated reason there's nobody. */
export function pushableDevice():
  | { deviceId: string; label: string; pushToken: string; credential: string }
  | { deviceId: null; reason: 'no-device' | 'no-token' } {
  const creds = loadDeviceCredentials()
  if (creds.size === 0) return { deviceId: null, reason: 'no-device' }
  // Only records that HOLD a token are candidates. Preferring the live socket
  // outright meant one phone holding two credentials (a re-pair leaves the old
  // record behind) reported no-token forever: it connects on the new one and
  // uploaded its token on the other, and neither is wrong on its own.
  const withToken = [...creds.entries()].flatMap(([c, r]) =>
    r.pushToken ? [{ cred: c, rec: r, pushToken: r.pushToken }] : []
  )
  if (withToken.length === 0) {
    devLog.warn('[phone-remote] pushableDevice: no record holds a token', { records: creds.size })
    return { deviceId: null, reason: 'no-token' }
  }
  const liveCred = activeSocketCredential
  const pick = choosePushTarget(
    withToken,
    liveCred,
    (liveCred ? creds.get(liveCred)?.deviceModel : null) ?? null
  )
  return {
    deviceId: deviceIdFor(pick.cred),
    label: formatDeviceLabel(
      parseDeviceIdentity(pick.rec.userAgent, pick.rec.standalone, pick.rec.shell),
      pick.rec.deviceModel
    ),
    pushToken: pick.pushToken,
    // The cloud answer path's shared secret. This phone already holds it (it is
    // the credential it authenticates every request with), so no new secret has
    // to be minted or delivered. NEVER log or transmit it in the clear -- only
    // its HMAC leaves this machine.
    credential: pick.cred
  }
}

const PHONE_RUN_PREFIX = 'phone:'

/** One page of history, plus whether older rows exist behind it. */
export interface DictationPage {
  entries: DictationEntry[]
  /** Rows already served before this page -- the phone echoes back
   *  offset + entries.length to ask for the next one. */
  offset: number
  hasMore: boolean
}

/** How many rows one page carries. Small on purpose: each row can hold a full
 *  LLM result, so a 30-row page is a fat payload to push at a phone over a
 *  tunnel. The sheet pages instead of loading everything up front. */
export const DICTATION_PAGE_SIZE = 20

/** Reads one page of history. Injected by the IPC glue rather than imported,
 *  so this transport file keeps knowing nothing about the History store. */
let readHistoryPage: ((offset: number, limit: number) => DictationPage) | null = null

export function setHistoryReader(fn: (offset: number, limit: number) => DictationPage): void {
  readHistoryPage = fn
}

/** Push one page to the phone. Page 0 on connect and after each completed run;
 *  later pages only when the phone asks. No-ops if no reader is wired. */
export function sendDictationHistory(offset = 0): void {
  if (!readHistoryPage) return
  sendToPhone({ type: 'dictationHistory', ...readHistoryPage(offset, DICTATION_PAGE_SIZE) })
}

/** Whether a runId belongs to a phone-triggered voice run — lets hud-window.ts
 *  push the same "run finished" signal to the phone that isCheeseRun() already
 *  gets to a cheese marker, without either file importing the other. */
export function isPhoneRun(runId: string): boolean {
  return runId.startsWith(PHONE_RUN_PREFIX)
}

/** The mirror is ONE encoder session negotiating with ONE peer, so these six
 *  must never be broadcast: fanning them out delivers the controller's SDP and
 *  ICE to the viewer and vice versa, crossing two devices' negotiation. Named
 *  here rather than checked at the six call sites so a seventh mirror event
 *  can't be added without landing in this set. */
const MIRROR_PEER_EVENTS = new Set<PhoneRemoteEvent['type']>([
  'mirrorAnswer',
  'mirrorIceCandidate',
  'mirrorError',
  'mirrorAudioError',
  'mirrorStalled',
  'mirrorRecovered'
])

/** Whoever sent `mirrorStart` owns the negotiation and the frames. Claimed in
 *  the message handler, released on mirrorStop or that socket's close. Null in
 *  the ordinary one-device case, where it falls back to the controller. */
let mirrorPeerSocket: WebSocket | null = null

/** The MEDIA is up, independently of which signalling socket carries it. A
 *  WebRTC peer survives its signalling socket closing, so `mirrorPeerSocket`
 *  going null on a viewer reconnect does NOT mean the picture stopped -- that
 *  is what blanked the ring for 20s while frames kept arriving. */
let mirrorMediaLive = false
/** Drop `ws`'s claim on the mirror slot and TELL the phone. Freeing it silently
 *  leaves the controller on a stale `mirroring`, stranding the zoom track. */
function releaseMirrorSlot(ws: WebSocket | null): void {
  if (!ws || mirrorPeerSocket !== ws) return
  mirrorPeerSocket = null
  publishViewerState()
}

/** The Mac tore the picture down, so no reconnect will bring it back. Only
 *  path that clears the media flag from outside -- a dropped socket must not,
 *  because that is the reconnect case the flag exists to survive. */
export function markMirrorMediaEnded(): void {
  if (!mirrorMediaLive) return
  mirrorMediaLive = false
  publishViewerState()
}

export function getMirrorMediaLive(): boolean {
  return mirrorMediaLive
}

/**
 * Hand control to the asking socket and demote the incumbent to viewer.
 *
 * Deliberately a pure pointer swap: `mirrorPeerSocket` is untouched, so a
 * mirror already running on the glasses keeps streaming to the glasses after
 * the phone takes the controls back. Tying the mirror to the controller role
 * would black out the screen at the exact moment the user reaches for it.
 */
function swapControl(asking: WebSocket): void {
  // Only the viewer can ask. Anything else is a no-op rather than an error: a
  // stale button on a reconnected socket must not displace the live session.
  if (viewerSocket !== asking || activeSocket === asking) return
  // An EMPTY slot is an adoption, not a displacement: the controller closed
  // and left this viewer stranded holding a pill it could never dismiss,
  // because every requestControl died on the old `!activeSocket` guard.
  const previousController = activeSocket
  if (previousController && previousController.readyState !== WebSocket.OPEN) return
  activeSocket = asking
  viewerSocket = previousController
  // Credential follows the socket, or the journal and the takeover gate would
  // keep attributing the session to the device that just gave it up.
  activeSocketCredential = socketCredentials.get(asking) ?? null
  activeSocketLastInputAt = Date.now()
  recordJournal('joined-as-viewer', {
    deviceId: activeSocketCredential ? deviceIdFor(activeSocketCredential) : null,
    detail: previousController
      ? 'roles swapped on request: viewer took control'
      : 'viewer adopted the empty controller slot on request'
  })
  previousController?.send(
    JSON.stringify({ type: 'role', role: 'viewer' } satisfies PhoneRemoteEvent)
  )
  asking.send(JSON.stringify({ type: 'role', role: 'controller' } satisfies PhoneRemoteEvent))
  // The roles moved, so who needs this changed. Without it the new controller
  // would paint no zoom track while watching a device that has the picture.
  publishViewerState()
}

export function sendToPhone(event: PhoneRemoteEvent): void {
  const out = event.type === 'layoutPrefs' ? withWornSkinLabel(event) : event
  const payload = JSON.stringify(out)
  // Point-to-point: one negotiation, one peer. Falls back to the controller so
  // a mirror started before this existed still lands somewhere.
  if (MIRROR_PEER_EVENTS.has(event.type)) {
    const peer = mirrorPeerSocket ?? activeSocket
    if (peer && peer.readyState === WebSocket.OPEN) peer.send(payload)
    return
  }
  if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
    activeSocket.send(payload)
  }
  // The watching device gets everything the controller does except the mirror
  // negotiation above -- prefs, host status, lock state.
  if (viewerSocket && viewerSocket.readyState === WebSocket.OPEN) {
    viewerSocket.send(payload)
  }
  // Fanned out here so no sender has to know observers exist.
  for (const observer of observers()) {
    if (observer.readyState === WebSocket.OPEN) observer.send(payload)
  }
  sendToWebClients(event, payload)
}

/** ~2 encoded frames. Past this the link is slower than the encoder, so the
 *  queue only grows. */
const PIP_BACKPRESSURE_BYTES = 256 * 1024

/** Native PiP's media pipe. Binary is still the only non-JSON on this socket,
 *  but no longer a single stream, so `kind` goes on the front of every frame --
 *  taking it as an argument is what stops a caller shipping an untagged one.
 *  Never fanned out to observers: they read text only. */
export function sendBinaryToPhone(kind: PipBinaryKind, payload: Buffer): void {
  // Follows the mirror peer, not activeSocket: when the glasses are the screen,
  // the frames belong to them. Falls back to the controller for the
  // ordinary one-device case.
  const target = mirrorPeerSocket ?? activeSocket
  if (!target || target.readyState !== WebSocket.OPEN) return
  // Drop rather than buffer -- also keeps a stalled tunnel from growing the
  // heap. Read off THIS socket: a stalled viewer must not drop the
  // controller's frames, so the check can never be hoisted over both.
  if (target.bufferedAmount > PIP_BACKPRESSURE_BYTES) return
  const tagged = Buffer.allocUnsafe(payload.length + 1)
  tagged[0] = kind
  payload.copy(tagged, 1)
  target.send(tagged)
}

import type { IncomingMessage } from 'http'
import { randomBytes } from 'crypto'
import { WebSocket } from 'ws'
import { CONFIG } from '../../shared/config'
import { devLog } from '../../shared/env'
import { parseDeviceIdentity } from './device-identity'
import { recordJournal } from './connection-journal'
import type { HostShell } from '../../shared/types'
import type { PhoneRemoteEvent } from '../../shared/phone-remote-protocol'
import type { BlockedReason } from './connection-state'
import { asHostShell, mintDeviceCredential, deviceIdFor, labelForCredential } from './device-credentials'
import {
  getActiveSocket,
  getActiveSocketLastInputAt,
  setActiveSocketLastInputAt,
  clearWsRateLimit,
  isLoopbackAddress,
  paramFromRequestUrl
} from './server-runtime'

/** A socket parked at the door waiting on the paired phone's verdict.
 *
 *  Single-slot on purpose. Two devices waiting would mean two prompts racing on
 *  one phone, and the newcomer is the one refused -- same reasoning as the
 *  one-viewer cap, and it bounds how much a stranger on the tunnel can put in
 *  front of the user at once. */
interface PendingApproval {
  id: string
  ws: WebSocket
  remoteIp: string
  userAgent: string | null
  standalone: boolean
  shell: HostShell | null
  expiresAt: number
  timer: NodeJS.Timeout
}

let pendingApproval: PendingApproval | null = null

/** When the user last asked the Mac to admit a device, or 0.
 *
 *  An approval prompt is only raised inside this window. Without it ANY socket
 *  arriving with no credential raises a prompt, so anyone holding the tunnel
 *  URL can buzz the phone at will -- the per-IP limiter does not help, since it
 *  only trips after several failures and the first one is already on screen.
 *  Caught by ws-auth-gate's "unauthenticated connect must not evict" test.
 *
 *  The pairing code works this way for the same reason: it exists only while
 *  the user is looking at both screens, not permanently. */
let approvalWindowOpenedAt = 0

/** Open the window in which a waiting device may ask the phone to admit it.
 *  Driven by the same Settings action that shows a pairing code -- the user
 *  saying "I am adding a device right now". */
export function openApprovalWindow(): void {
  approvalWindowOpenedAt = Date.now()
}

/** Shut the window early, BOTH halves of it -- the explicit open and the
 *  presence one, by backdating the controller's last input past the presence
 *  cutoff. Clearing only the explicit half would leave the window open on any
 *  live phone and make the name a lie. The toggle-off path uses this for the
 *  same reason it drops the pairing code, and it lets a test assert the
 *  unsolicited case without waiting out either TTL. */
export function closeApprovalWindow(): void {
  approvalWindowOpenedAt = 0
  setActiveSocketLastInputAt(Date.now() - CONFIG.PHONE_REMOTE.APPROVAL_PRESENCE_MS - 1)
}

function approvalWindowOpen(viaTunnel: boolean): boolean {
  if (approvalWindowOpenedAt && Date.now() - approvalWindowOpenedAt <= CONFIG.PHONE_REMOTE.PAIR_CODE_TTL_MS) {
    return true
  }
  // Presence proves the user is holding the phone, not that the internet caller is their device.
  if (viaTunnel) return false
  // A phone touched in the last few minutes is a user who is present and holding
  // the screen the prompt lands on -- so the glasses can ask without a trip to
  // the Mac, which was the whole point of one-tap approval. Gating on the socket
  // ALONE would leave the window open permanently (a phone left connected on a
  // desk), which is the buzz-at-will case above.
  const activeSocket = getActiveSocket()
  if (!activeSocket || activeSocket.readyState !== WebSocket.OPEN) return false
  return Date.now() - getActiveSocketLastInputAt() <= CONFIG.PHONE_REMOTE.APPROVAL_PRESENCE_MS
}

/** cloudflared dials the origin over loopback with the public hostname as Host. */
function arrivedViaTunnel(req: IncomingMessage, remoteIp: string): boolean {
  if (!isLoopbackAddress(remoteIp)) return false
  const host = (req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '')
  return host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]'
}

/** Take the prompt off the phone and forget the request. Does NOT close the
 *  waiting socket -- the caller decides that, because approve() keeps it open
 *  and every other path closes it. */
function clearPendingApproval(): void {
  if (!pendingApproval) return
  const { id, timer } = pendingApproval
  clearTimeout(timer)
  pendingApproval = null
  const activeSocket = getActiveSocket()
  if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
    activeSocket.send(JSON.stringify({ type: 'approvalResolved', id } satisfies PhoneRemoteEvent))
  }
}

/**
 * Park an uncredentialed socket and ask the paired phone to vouch for it.
 *
 * Returns false when there is nobody to ask (no controller) or the slot is
 * taken -- the caller then falls back to the plain 4401 close, so a first-ever
 * device with no phone attached still reaches the pairing-code form exactly as
 * it did before this existed.
 */
export function requestApproval(
  ws: WebSocket,
  req: IncomingMessage,
  remoteIp: string
): boolean {
  // Unsolicited arrivals never reach the phone -- see approvalWindowOpenedAt.
  if (!approvalWindowOpen(arrivedViaTunnel(req, remoteIp))) return false
  const activeSocket = getActiveSocket()
  if (!activeSocket || activeSocket.readyState !== WebSocket.OPEN) return false
  if (pendingApproval) return false

  const id = randomBytes(9).toString('base64url')
  const expiresAt = Date.now() + CONFIG.PHONE_REMOTE.APPROVAL_TTL_MS
  const userAgent = req.headers['user-agent'] ?? null
  const standalone = paramFromRequestUrl(req.url, CONFIG.PHONE_REMOTE.STANDALONE_PARAM) === '1'
  const shell = asHostShell(paramFromRequestUrl(req.url, CONFIG.PHONE_REMOTE.SHELL_PARAM))
  const identity = parseDeviceIdentity(userAgent, standalone, shell)
  // A cursorless host SAYS it is glasses, which beats the UA guess: the Display
  // ships an Android UA with no 'mobile' token, so parseDeviceIdentity reads it
  // as "Android tablet" -- asking the user to admit a device that is not the one
  // in front of them. Declared facts over sniffed ones.
  const cursorless = paramFromRequestUrl(req.url, CONFIG.PHONE_REMOTE.CURSORLESS_PARAM) === '1'
  const label = cursorless ? 'your glasses' : identity.model

  const timer = setTimeout(() => {
    // Expiry closes the same way a denial does, so the waiting device's copy
    // never has to distinguish "refused" from "you were too slow".
    clearPendingApproval()
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(CONFIG.PHONE_REMOTE.CLOSE_CODE_APPROVAL_DENIED, 'no-credential' satisfies BlockedReason)
    }
    recordJournal('rejected', { detail: 'approval timed out with no answer from the phone' })
  }, CONFIG.PHONE_REMOTE.APPROVAL_TTL_MS)

  pendingApproval = { id, ws, remoteIp, userAgent, standalone, shell, expiresAt, timer }

  // A device that hangs up while waiting must take its own prompt down, or the
  // phone is left offering to admit something that is no longer there.
  ws.on('close', () => {
    if (pendingApproval?.ws === ws) clearPendingApproval()
  })

  activeSocket.send(
    JSON.stringify({
      type: 'approvalRequest',
      id,
      label,
      expiresAt
    } satisfies PhoneRemoteEvent)
  )
  // The waiting device must say it is WAITING. Without this it fell through to
  // the generic 'connect your Mac' code form -- so the one device the user was
  // looking at was the only one with no idea a prompt existed.
  ws.send(JSON.stringify({ type: 'approvalPending', expiresAt } satisfies PhoneRemoteEvent))
  devLog.log('[phone-remote] approval requested', { from: remoteIp, label })
  recordJournal('rejected', { detail: `waiting on phone approval (${label})` })
  return true
}

/**
 * The paired phone answered. Allow mints a credential and hands it down the
 * waiting socket, which stores it and reconnects with it like any paired
 * device; deny closes as 'no-credential' so the code form is still the way in.
 *
 * `id` must match the outstanding request: the phone can be showing a prompt
 * that expired while it was in a pocket, and honouring that tap would admit
 * whoever happens to be waiting now instead of who the user actually saw.
 */
export function resolveApproval(id: string, allow: boolean): void {
  const pending = pendingApproval
  if (!pending || pending.id !== id) return
  const { ws, remoteIp, userAgent, standalone, shell } = pending
  clearPendingApproval()

  if (!allow) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(CONFIG.PHONE_REMOTE.CLOSE_CODE_APPROVAL_DENIED, 'no-credential' satisfies BlockedReason)
    }
    devLog.log('[phone-remote] approval denied', { from: remoteIp })
    recordJournal('rejected', { detail: 'denied by the paired phone' })
    return
  }

  const credential = mintDeviceCredential({
    userAgent,
    standalone,
    shell,
    deviceModel: null,
    osVersion: null,
    iosAppBuild: null
  })
  // The credential rides the socket the device is already holding, so approval
  // costs it no round trip to /pair -- it stores this and reconnects with it.
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'approved', credential } satisfies PhoneRemoteEvent))
  }
  // Its pre-approval retries earned a cooldown that would refuse the reconnect
  // it is about to make -- same reason /pair clears it.
  clearWsRateLimit(remoteIp)
  devLog.log('[phone-remote] approval granted', { from: remoteIp })
  recordJournal('paired', {
    deviceId: deviceIdFor(credential),
    label: labelForCredential(credential),
    detail: 'admitted by the paired phone'
  })
}

import type { IncomingMessage, ServerResponse } from 'http'
import { randomBytes, randomInt } from 'crypto'
import { CONFIG } from '../../shared/config'
import { devLog } from '../../shared/env'
import { parseDeviceIdentity } from './device-identity'
import { recordJournal } from './connection-journal'
import type { HostShell } from '../../shared/types'
import {
  isRateLimited,
  recordFailedAttempt,
  timingSafeEqualStr,
  rateLimitBucket
} from './rate-limit'
import {
  loadDeviceCredentials,
  saveDeviceCredentials,
  deviceIdFor,
  labelForCredential,
  asHostShell,
  clampClientString
} from './device-credentials'
import {
  openApprovalWindow,
  clearWsRateLimit,
  getDevicePairedListener,
  getAccountIdProvider
} from './server-runtime'

/** The pending pairing code, or null when none is outstanding. Single-slot:
 *  showing a new code invalidates the previous one, so a code left on screen
 *  from an abandoned attempt can't be reused later. */
let pairingCode: string | null = null
let pairingCodeIssuedAt = 0

/** Mint a fresh pairing code for the user to read off the Mac. Replaces any
 *  outstanding code. Digits only -- it gets typed on a phone keypad. */
export function issuePairingCode(): string {
  const max = 10 ** CONFIG.PHONE_REMOTE.PAIR_CODE_LENGTH
  // randomInt is rejection-sampled, so no modulo bias across the digit range.
  pairingCode = String(randomInt(0, max)).padStart(CONFIG.PHONE_REMOTE.PAIR_CODE_LENGTH, '0')
  pairingCodeIssuedAt = Date.now()
  return pairingCode
}

/** The live code, minting one only if none is outstanding or it has expired.
 *
 *  The QR and the on-screen digits are fetched by two independent IPC calls,
 *  and `pairingCode` is single-slot -- so if both called `issuePairingCode()`
 *  the second mint would silently invalidate the first, and the QR would
 *  encode a code the Mac is no longer accepting. Both read through here. */
export function currentPairingCode(): string {
  // Showing a code IS the user saying "I am adding a device now", which is the
  // same permission an approval prompt needs -- so a device that can reach the
  // Mac gets the one-tap path and the code stays there for one that cannot.
  openApprovalWindow()
  if (pairingCode && Date.now() - pairingCodeIssuedAt <= CONFIG.PHONE_REMOTE.PAIR_CODE_TTL_MS) {
    return pairingCode
  }
  return issuePairingCode()
}

/** Epoch ms the live code dies at, so a surface counts down to the SAME instant
 *  the Mac stops accepting it. Mints first: a countdown for a code nobody can
 *  see is worse than no countdown. */
export function currentPairingCodeExpiresAt(): number {
  currentPairingCode()
  return pairingCodeIssuedAt + CONFIG.PHONE_REMOTE.PAIR_CODE_TTL_MS
}

/** Drop any outstanding pairing code (toggle-off, or after a successful
 *  exchange -- a code is single-use). */
export function clearPairingCode(): void {
  pairingCode = null
  pairingCodeIssuedAt = 0
}

export function isPairingCodeValid(candidate: string): boolean {
  if (!pairingCode) return false
  if (Date.now() - pairingCodeIssuedAt > CONFIG.PHONE_REMOTE.PAIR_CODE_TTL_MS) return false
  return candidate.length === pairingCode.length && timingSafeEqualStr(candidate, pairingCode)
}

/** Max bytes accepted on a /pair body. The real payload is a ~30-byte JSON
 *  object; anything larger is malformed or hostile, and this bounds memory
 *  before parsing on an internet-reachable endpoint. */
const PAIR_BODY_LIMIT_BYTES = 512

export const pairAttempts = rateLimitBucket()

export function handlePair(req: IncomingMessage, res: ServerResponse): void {
  const remoteIp = req.socket.remoteAddress || 'unknown'
  const reply = (status: number, body: Record<string, unknown>): void => {
    // The preflight's ACAO alone is not enough: WebKit also requires it on the
    // actual POST response, or fetch throws "Load failed" AFTER the server has
    // already paired -- the phone never learns the credential it now owns.
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    })
    res.end(JSON.stringify(body))
  }

  // Safari preflights the cross-origin pair POST; a 405 here blocks it and reads
  // as "can't reach your Mac". `*` is safe -- /pair is unauthenticated, single-use
  // and sets no cookie; echoing the Origin WITH credentials would not be.
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    })
    res.end()
    return
  }
  if (req.method !== 'POST') {
    reply(405, { error: 'method-not-allowed' })
    return
  }
  if (isRateLimited(pairAttempts, remoteIp)) {
    devLog.warn('[phone-remote] pair attempt rate-limited', { from: remoteIp })
    reply(429, { error: 'rate-limited' })
    return
  }

  let body = ''
  let aborted = false
  req.on('data', (chunk) => {
    if (aborted) return
    body += chunk
    if (body.length > PAIR_BODY_LIMIT_BYTES) {
      aborted = true
      reply(413, { error: 'too-large' })
      req.destroy()
    }
  })
  req.on('end', () => {
    if (aborted) return
    // Re-checked here: requests opened in parallel all passed the gate above before any failed.
    if (isRateLimited(pairAttempts, remoteIp)) {
      reply(429, { error: 'rate-limited' })
      return
    }
    let code: unknown
    let standalone = false
    let shell: HostShell | null = null
    let deviceModel: string | null = null
    let clientOsVersion: string | null = null
    let iosAppBuild: string | null = null
    try {
      const parsed = JSON.parse(body) as {
        code?: unknown
        standalone?: unknown
        shell?: unknown
        deviceModel?: unknown
        osVersion?: unknown
        appBuild?: unknown
      }
      code = parsed.code
      // Display metadata only -- never trusted for authorization, so an
      // attacker gains nothing by lying about it beyond a wrong row label.
      standalone = parsed.standalone === true
      shell = asHostShell(parsed.shell)
      deviceModel = clampClientString(parsed.deviceModel)
      clientOsVersion = clampClientString(parsed.osVersion)
      iosAppBuild = clampClientString(parsed.appBuild)
    } catch {
      reply(400, { error: 'bad-request' })
      return
    }
    if (typeof code !== 'string' || !isPairingCodeValid(code)) {
      recordFailedAttempt(pairAttempts, remoteIp)
      devLog.warn('[phone-remote] pair rejected: invalid/expired code', { from: remoteIp })
      recordJournal('rejected', { detail: 'pair-code-invalid (wrong, expired, or already used)' })
      reply(401, { error: 'invalid-code' })
      return
    }
    clearPairingCode()
    const credential = randomBytes(32).toString('base64url')
    const creds = loadDeviceCredentials()
    // The UA on the /pair POST is the phone's own -- it's a same-origin fetch
    // from the page the user just typed the code into. Captured here so the
    // device is named in Settings before it ever opens a socket.
    creds.set(credential, {
      pairedAt: Date.now(),
      lastSeenAt: null,
      userAgent: req.headers['user-agent'] ?? null,
      standalone,
      shell,
      deviceModel,
      osVersion: clientOsVersion,
      iosAppBuild,
      pushToken: null
    })
    // Persist immediately: an unwritten credential is one app quit away from
    // stranding the device that just paired.
    saveDeviceCredentials()
    // This IP just proved itself, so drop any WS cooldown its pre-pairing
    // retries earned -- otherwise the reconnect it is about to make gets
    // refused for up to 30s and reads as "pairing didn't work".
    clearWsRateLimit(remoteIp)
    devLog.log('[phone-remote] device paired', { total: creds.size })
    // The map identity too: a count that jumps 11 -> 1 between two pairs means
    // either a different Map object or a mutation with no logged caller.
    devLog.warn('[phone-remote] PAIR MAP', {
      total: creds.size,
      sameObject: creds === loadDeviceCredentials(),
      ua: req.headers['user-agent']?.slice(0, 60)
    })
    recordJournal('paired', {
      deviceId: deviceIdFor(credential),
      label: labelForCredential(credential),
      detail: `${creds.size} device(s) now paired`
    })
    const pairedIdentity = parseDeviceIdentity(req.headers['user-agent'], standalone, shell)
    getDevicePairedListener()?.(
      {
        shell,
        kind: pairedIdentity.kind,
        browser: pairedIdentity.browser,
        browserVersion: pairedIdentity.browserVersion,
        // The client's own answer beats the UA's, and it is the only one that
        // exists for native -- WKWebView's stock Safari UA has no build in it.
        os: pairedIdentity.os,
        osVersion: clientOsVersion ?? pairedIdentity.osVersion,
        modelKnown: deviceModel !== null
      },
      creds.size
    )
    // The pairing IS the proof of identity: typing this code required physical
    // access to a signed-in Mac, which is stronger evidence than an emailed
    // code. So the phone inherits the account instead of signing in for itself.
    reply(200, { credential, accountId: getAccountIdProvider()?.() ?? null })
  })
}

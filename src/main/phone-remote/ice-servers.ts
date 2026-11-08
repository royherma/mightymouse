// ice-servers.ts — fetch + cache TURN credentials for the screen mirror.
//
// Lives in MAIN, not in either renderer, because the Supabase JWT lives here:
// the phone bundle is served to a browser with no auth of its own, and the
// hidden capture window shouldn't hold credentials either. Main fetches once,
// caches until near expiry, and hands the resulting iceServers array to BOTH
// peers (phone over WS, Mac over IPC) so the two ends always agree.
//
// Degrades on purpose: any failure — not signed in, TURN not configured (501),
// Cloudflare error, timeout — returns CONFIG.PHONE_REMOTE.MIRROR_ICE_SERVERS,
// the plain STUN list. The mirror then behaves exactly as it did before TURN
// existed (works on LAN and permissive networks, stalls on symmetric-NAT
// cellular) rather than failing outright. TURN is an upgrade, never a
// dependency.
//
// ONE failure is no longer silent: a free account that has used up its relay
// allowance gets the same empty list, but `capped: true` with the window that ran
// out. That still degrades to STUN — the phone keeps working on the home network
// — but the user can now be TOLD why the off-LAN path stopped, instead of reading
// a limit as an outage. Everything else stays deliberately indistinguishable;
// "TURN is down" is not a fact worth explaining to a user.

import { CONFIG } from '../../shared/config'
import { devLog, IS_DEV, envVar } from '../../shared/env'
import { toRemoteCapState, type RemoteCapState } from '../../shared/phone-remote-limits'
import { getSupabase } from '../supabase'

/** RTCIceServer, restated locally — this is main-process (Node) code, so the
 *  DOM lib's type isn't in scope. Structurally identical to what both
 *  RTCPeerConnection constructors accept. */
export interface IceServer {
  urls: string | string[]
  username?: string
  credential?: string
}

/** Cached credentials + when they stop being usable for NEW connections. */
let cached: { iceServers: IceServer[]; expiresAt: number } | null = null

/**
 * The list the last getMirrorIceServers() call actually returned — which on a
 * degrade path is NOT `cached`. The Mac reads this so both peers negotiate
 * against the same servers; see getCachedMirrorIceServers().
 */
let lastServed: IceServer[] | null = null

/**
 * The last capped verdict, or null when the relay is available.
 *
 * Deliberately NOT part of `cached`: a cap means there are no credentials to
 * cache, and clearing credentials on sign-out must not erase the reason the last
 * attempt was refused. Cleared only by a successful fetch or clearMirrorIceServers().
 */
let capState: RemoteCapState | null = null

/** The no-TURN answer: plain STUN, no credentials, always available. */
function fallback(): IceServer[] {
  return [...CONFIG.PHONE_REMOTE.MIRROR_ICE_SERVERS]
}

/**
 * Credentials we already hold, even if they're inside the refresh margin.
 *
 * A failed re-fetch is NOT a reason to drop a relay that is still valid: the
 * margin exists to refresh EARLY, so at that moment the cached credentials have
 * minutes-to-hours of life left. Returning plain STUN there took a working
 * mirror off the relay because one HTTPS round-trip hiccuped -- the exact
 * failure in the 08-11 glasses logs, where the phone reported "0 with
 * credentials" while the Mac was still using a cached relay from before.
 */
function stillValidCache(): IceServer[] | null {
  if (cached && Date.now() < cached.expiresAt) return cached.iceServers
  return null
}

/** Same degrade, but prefer real credentials we already hold over bare STUN. */
function degrade(why: string): IceServer[] {
  const usable = stillValidCache()
  if (usable) {
    devLog.log(`[mirror] ${why}; reusing cached TURN credentials`)
    return usable
  }
  devLog.log(`[mirror] ${why}; STUN-only`)
  return fallback()
}

/**
 * ICE servers for a NEW mirror peer connection. Returns TURN-backed servers
 * when available, plain STUN otherwise. Never throws and never returns empty —
 * callers can use the result unconditionally.
 *
 * Wraps resolve() so `lastServed` is recorded on EVERY path in one place: the
 * Mac reads it back synchronously at mirrorStart, and a return that forgot to
 * set it would silently hand the two peers different ICE configs.
 */
export async function getMirrorIceServers(): Promise<IceServer[]> {
  const iceServers = await resolveMirrorIceServers()
  lastServed = iceServers
  const relays = iceServers.filter((s) => !!s.credential).length
  devLog.log(`[mirror] serving ${iceServers.length} ICE entries (${relays} with credentials)`)
  return iceServers
}

async function resolveMirrorIceServers(): Promise<IceServer[]> {
  const { FN, FETCH_TIMEOUT_MS, REFRESH_MARGIN_MS } = CONFIG.PHONE_REMOTE.MIRROR_TURN

  // DEV-ONLY escape hatch: `MM_NO_TURN=1 make restart` forces the STUN-only
  // path so you can check whether a network actually needs the relay, WITHOUT
  // unsetting the deployed Edge secrets (which would affect every install and
  // have to be restored). Gated on IS_DEV so it can never disable TURN in a
  // packaged build. Added after the ICE-ordering fix made TURN look possibly
  // unnecessary -- this answers that question reversibly.
  if (IS_DEV && envVar('MM_NO_TURN') === '1') {
    devLog.log('[mirror] MM_NO_TURN=1 -- forcing STUN-only (no relay)')
    return fallback()
  }

  // Reuse while comfortably clear of expiry. Credentials gate only the START
  // of a connection, so a few minutes of margin is enough.
  if (cached && Date.now() < cached.expiresAt - REFRESH_MARGIN_MS) {
    return cached.iceServers
  }

  const { data } = await getSupabase().auth.getSession()
  const jwt = data.session?.access_token
  if (!jwt) {
    // Signed-out is an ordinary state (BYO-backend users never sign in), not
    // an error worth surfacing — the mirror still works on LAN. A momentary
    // getSession() miss during a token refresh is the same shape, so a live
    // cached relay still wins over bare STUN.
    return degrade('no session')
  }

  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS)
  try {
    const resp = await fetch(`${CONFIG.BILLING.EDGE_FUNCTION_URL}/${FN}`, {
      method: 'POST',
      signal: abort.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({})
    })
    const body = await resp.json().catch(() => null)
    // 501 = TURN not configured on this deployment (no dashboard step done
    // yet). Expected, not a failure — log quietly and fall back.
    if (resp.status === 501) {
      return degrade('TURN not configured')
    }
    // Over the tier allowance. A 200 with an empty list, same as every other
    // degrade — but this one has a reason the user can act on, so record it
    // BEFORE the generic empty-list branch swallows it as a failure.
    const cap = toRemoteCapState(body ?? {})
    if (cap) {
      capState = cap
      devLog.log(`[mirror] relay allowance used up (${cap.reason}), STUN-only`)
      return fallback()
    }

    const iceServers = body?.iceServers
    if (!resp.ok || !Array.isArray(iceServers) || iceServers.length === 0) {
      devLog.warn('[mirror] TURN fetch failed:', body?.error ?? resp.status)
      return degrade('TURN fetch failed')
    }
    const ttlMs = (typeof body.ttl === 'number' ? body.ttl : 0) * 1000
    cached = { iceServers, expiresAt: Date.now() + ttlMs }
    // A successful mint is proof the cap lifted (window rolled over, or the user
    // upgraded) — clear it here so the phone stops showing a stale limit notice.
    capState = null
    return iceServers
  } catch (err) {
    devLog.warn('[mirror] TURN fetch error:', err)
    return degrade('TURN fetch error')
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The exact list last HANDED TO THE PHONE, for callers that can't await (the
 * mirrorStart handler runs inside a sync message switch).
 *
 * Reads `lastServed`, not `cached`, and those are NOT the same list on any
 * degrade path. Both ends must load the same relay or ICE has no shared
 * candidate pair to agree on -- reading `cached` here meant a failed re-fetch
 * gave the phone STUN-only while the Mac kept a cached relay, so the Mac
 * gathered relay candidates the phone could never match and every attempt
 * died at "connect timeout in connecting" (08-11 glasses logs).
 */
export function getCachedMirrorIceServers(): IceServer[] {
  return lastServed ?? fallback()
}

/**
 * The relay cap as of the last fetch, or null when the relay is available.
 *
 * Synchronous and cached for the same reason getCachedMirrorIceServers() is: the
 * phone asks for ICE servers and the reply is assembled inside a sync switch.
 * A null here means "not capped" — including every non-cap failure, since a
 * broken TURN deployment is not something to explain to the user.
 */
export function getMirrorCapState(): RemoteCapState | null {
  return capState
}

/** Drop cached credentials (sign-out / mirror teardown). Next call re-fetches. */
export function clearMirrorIceServers(): void {
  cached = null
  lastServed = null
  // Sign-out invalidates the verdict too — the allowance is per account, so the
  // next user must not inherit the previous one's limit notice.
  capState = null
}

/**
 * session-meter.ts — bills an off-Wi-Fi Phone Remote session by wall-clock time
 * (PRD 2026-08-04-1785824719-remote-real-minute-metering).
 *
 * WHY THE CLIENT OWNS THE CLOCK: the tunnel provision is cached on disk and reused
 * forever, so the `phone-remote-tunnel` Edge Function fires roughly once per
 * INSTALL. The server never hears about session 2, so it cannot time one. This
 * module reports open and close; the server deposits, reconciles, and reaps.
 *
 * FIRE-AND-FORGET, ALWAYS. Every call here is best-effort: a failed report must
 * never delay a teardown or fail a connection. Worst case a session goes
 * unreported, and the server-side reaper charges it the ceiling.
 *
 * ONLY OFF-LAN SESSIONS ARE METERED. Same-Wi-Fi is free and ungated by design;
 * both transports land on the same socket, so `isOffLanHost` is what separates
 * them — the same Host-header test decideObserver() uses, for the same reason
 * (cloudflared dials the origin as loopback, so only Host distinguishes them).
 */

import { CONFIG } from '../../shared/config'
import { devLog } from '../../shared/env'
import { getPhoneRemoteInstallId, getTunnelHostname } from './cloudflare-tunnel'
import { getSupabase } from '../supabase'

/** Monotonic — a laptop sleeping mid-session or an NTP step makes Date.now()
 *  deltas lie, and this one feeds billing. */
type Monotonic = number

interface OpenSession {
  sessionId: string
  startedAt: Monotonic
  source: 'tunnel' | 'turn'
}

// At most one billable session at a time: the server enforces a single active
// socket, so a second open means the first was evicted and already closed.
let current: OpenSession | null = null

/** True when THIS request arrived over the tunnel rather than the LAN.
 *  Port-stripped: the tunnel forwards Host verbatim, local clients send :17771. */
export function isOffLanHost(requestHost: string | null): boolean {
  const tunnel = getTunnelHostname()
  if (!tunnel) return false
  const host = (requestHost ?? '').toLowerCase().split(':')[0]
  return host === tunnel.toLowerCase()
}

async function report(
  kind: 'open' | 'close',
  sessionId: string,
  source: 'tunnel' | 'turn',
  minutes?: number
): Promise<void> {
  const { data } = await getSupabase().auth.getSession()
  const jwt = data.session?.access_token
  // Signed-out users can't reach the off-LAN path at all, so there is nothing to
  // meter and no token to meter it with.
  if (!jwt) return

  const attempt = async (): Promise<boolean> => {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), CONFIG.PHONE_REMOTE.USAGE.TIMEOUT_MS)
    try {
      const resp = await fetch(
        `${CONFIG.BILLING.EDGE_FUNCTION_URL}/${CONFIG.PHONE_REMOTE.USAGE.FN}`,
        {
          method: 'POST',
          signal: abort.signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
          body: JSON.stringify({
            installId: getPhoneRemoteInstallId(),
            sessionId,
            kind,
            source,
            ...(minutes === undefined ? {} : { minutes })
          })
        }
      )
      return resp.ok
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  if (await attempt()) return
  // One retry, then drop. The reaper is the real backstop for a session that
  // never reports, so retrying harder here buys accuracy we don't need.
  if (await attempt()) return
  devLog.log('[phone-remote] usage report dropped', { kind, sessionId })
}

/** Call when an off-LAN session connects. No-ops for LAN sessions. */
export function beginSession(requestHost: string | null, source: 'tunnel' | 'turn' = 'tunnel'): void {
  if (!isOffLanHost(requestHost)) return
  // An open with one already live means the previous socket was evicted without a
  // close firing. Close it out first so its deposit doesn't wait for the reaper.
  if (current) endSession()
  current = { sessionId: crypto.randomUUID(), startedAt: performance.now(), source }
  void report('open', current.sessionId, source)
}

/** Call when the session ends — socket close, tunnel stop, or quit. Idempotent:
 *  the first caller wins and the rest no-op, so wiring it to all three paths is
 *  safe. */
export function endSession(): void {
  const session = current
  if (!session) return
  current = null
  const elapsedMs = performance.now() - session.startedAt
  // Round up, min 1 — a sub-minute session is real usage.
  const minutes = Math.max(1, Math.ceil(elapsedMs / 60_000))
  void report('close', session.sessionId, session.source, minutes)
}

/** For `will-quit`. Named honestly: the report it fires is async and the process
 *  almost always exits first, so this is a lottery ticket, not a guarantee — the
 *  server-side reaper is what actually bills an abandoned session. Kept anyway
 *  because it costs nothing and occasionally wins. */
export function endSessionBestEffort(): void {
  endSession()
}

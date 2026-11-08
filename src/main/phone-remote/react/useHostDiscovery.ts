import { CONFIG } from '@shared/config'
import type { TunnelReach } from '@shared/types'
import { isInstalled, capabilities } from './host-capabilities'
import { readDeviceHints } from './device-hints'
import { credentialStore } from './credential-store'
import { nativeBridge } from './native-bridge'

/**
 * Self-healing host resolution (PRD Layer 2). Tries cheapest-first, first hit
 * wins -- see the PRD's resolution-order table for why each candidate exists
 * and why both mDNS AND the subnet probe are needed (neither alone covers
 * every network). Returns null only when every candidate failed, which means
 * App.tsx should render the full rescan state, not retry silently again.
 *
 * A "hit" is a `/whoami` fetch succeeding, NOT a WS connect -- probing must
 * never open a WebSocket per candidate (server.ts closes the previous phone
 * session on every new WS connection; a sweep of probe sockets would kick a
 * still-live real session, same bug class as the shipped agent-browser PRD).
 */

const WHOAMI_PATH = '/whoami'

function withTimeout(ms: number, signal?: AbortSignal): AbortSignal {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  signal?.addEventListener('abort', () => controller.abort())
  // Cleared implicitly when the fetch settles and the AbortController is
  // garbage-collected -- no caller holds a reference past the fetch, so
  // there's nothing to leak by not clearing this explicitly.
  void timer
  return controller.signal
}

interface WhoamiBody {
  app?: string
  tunnel?: string
  tunnelReach?: TunnelReach
}

/** Last successfully-parsed /whoami body from a hit -- probeHost only returns
 *  a boolean (its contract predates the tunnel field), so a hit's extra
 *  fields are stashed here for the caller to read immediately afterward.
 *  Single in-flight discovery sweep at a time in practice, so this is safe
 *  without threading the body through every call site. */
let lastWhoamiHit: WhoamiBody | null = null

async function probeHost(host: string, port: number, timeoutMs: number): Promise<boolean> {
  try {
    const res = await fetch(`https://${host}:${port}${WHOAMI_PATH}`, {
      signal: withTimeout(timeoutMs),
      // The probe target's cert is almost certainly untrusted on first
      // contact (same self-signed cert every candidate uses) -- Safari has
      // no `rejectUnauthorized` knob, so a probe against a NOT-yet-trusted
      // host will reject via CORS/TLS the same way a real page load would
      // before the user taps through. That's fine: a probe hit only needs to
      // prove reachability once the cert is already trusted (post Layer-4
      // "open in Safari once"), which is exactly the case this is solving.
      mode: 'cors'
    })
    if (!res.ok) return false
    const body: WhoamiBody = await res.json()
    if (body?.app !== 'mightymouse') return false
    lastWhoamiHit = body
    return true
  } catch {
    return false
  }
}

function candidatePorts(): number[] {
  const ports: number[] = []
  for (let i = 0; i < CONFIG.PHONE_REMOTE.PORT_RANGE_SIZE; i++) ports.push(CONFIG.PHONE_REMOTE.PORT + i)
  return ports
}

/** host:port pairs to try against a given hostname, across the whole port
 *  drift range (PRD §5 "port drift" risk -- 17771-17775, not just the base). */
function hostCandidates(host: string): { host: string; port: number }[] {
  return candidatePorts().map((port) => ({ host, port }))
}

async function firstReachable(
  candidates: { host: string; port: number }[],
  timeoutMs: number,
  concurrency: number
): Promise<HostDiscoveryResult | null> {
  let cursor = 0
  let found: HostDiscoveryResult | null = null

  async function worker(): Promise<void> {
    while (!found && cursor < candidates.length) {
      const candidate = candidates[cursor++]
      if (await probeHost(candidate.host, candidate.port, timeoutMs)) {
        found = {
          ...candidate,
          tunnelHost: lastWhoamiHit?.tunnel,
          tunnelReach: lastWhoamiHit?.tunnelReach
        }
        return
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker))
  return found
}

/** Derives the /24 network prefix from a dotted IPv4 -- e.g. "192.168.1.42"
 *  -> "192.168.1". Returns null for anything that isn't a plain IPv4 (a
 *  hostname like "mightymouse.local" has no subnet to sweep). */
function subnetPrefix(ip: string): string | null {
  const parts = ip.split('.')
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p))) return null
  return parts.slice(0, 3).join('.')
}

export interface HostDiscoveryResult {
  host: string
  port: number
  /** Set when the hit's /whoami body advertised a Cloudflare Tunnel hostname
   *  -- callers should persist it via rememberTunnelHost() alongside the
   *  normal rememberHost() call, so a future off-LAN discovery sweep has
   *  something to try. */
  tunnelHost?: string
  /** Why that hostname is absent, when it is. Only meaningful on a LAN hit:
   *  reaching the Mac at all is what lets it explain its own tunnel. */
  tunnelReach?: TunnelReach
}

/**
 * Resolution order: current origin -> tunnel -> mDNS -> last-known-good ->
 * subnet probe -> give up (null). The tunnel sits second because every rung
 * below it assumes a shared LAN and fails slowly when there isn't one.
 */
export async function discoverHost(): Promise<HostDiscoveryResult | null> {
  const {
    DISCOVERY_MDNS_TIMEOUT_MS,
    DISCOVERY_LAST_KNOWN_TIMEOUT_MS,
    DISCOVERY_PROBE_TIMEOUT_MS,
    DISCOVERY_PROBE_CONCURRENCY,
    DISCOVERY_LAST_HOST_KEY,
    DISCOVERY_LAST_TUNNEL_HOST_KEY
  } = CONFIG.PHONE_REMOTE

  // 1. Current origin -- the normal case, nothing moved.
  const currentHost = location.hostname
  const currentPort = Number(location.port) || CONFIG.PHONE_REMOTE.PORT
  if (await probeHost(currentHost, currentPort, DISCOVERY_MDNS_TIMEOUT_MS)) {
    return {
      host: currentHost,
      port: currentPort,
      tunnelHost: lastWhoamiHit?.tunnel,
      tunnelReach: lastWhoamiHit?.tunnelReach
    }
  }

  // 2. Cloudflare Tunnel, if a previous /whoami advertised one. Always port
  // 443 -- Cloudflare's edge terminates TLS there, so port drift doesn't apply.
  const lastTunnelHost = credentialStore.get(DISCOVERY_LAST_TUNNEL_HOST_KEY)
  if (lastTunnelHost) {
    const tunnelHit = await firstReachable(
      [{ host: lastTunnelHost, port: CONFIG.PHONE_REMOTE.TUNNEL.HTTPS_PORT }],
      DISCOVERY_LAST_KNOWN_TIMEOUT_MS,
      1
    )
    if (tunnelHit) return tunnelHit
  }

  // 3. mDNS -- a cert SAN AND published over Bonjour by main/phone-remote/
  // mdns.ts, so it survives any IP change. Fails fast when Bonjour resolution
  // is blocked on this network (guest VLAN, client isolation).
  const mdnsHit = await firstReachable(
    hostCandidates(CONFIG.PHONE_REMOTE.MDNS_HOSTNAME),
    DISCOVERY_MDNS_TIMEOUT_MS,
    1
  )
  if (mdnsHit) return mdnsHit

  // 4. localStorage last-known-good -- covers a stale-origin standalone
  // launch on the SAME network the phone connected from before.
  const lastHost = credentialStore.get(DISCOVERY_LAST_HOST_KEY)
  if (lastHost && lastHost !== currentHost) {
    const lastHit = await firstReachable(hostCandidates(lastHost), DISCOVERY_LAST_KNOWN_TIMEOUT_MS, 1)
    if (lastHit) return lastHit
  }

  // 5. Subnet probe -- only the /24 the phone was last known to be on, never
  // a blind scan, and capped well under 254 concurrent to avoid reading as a
  // port scan (PRD §5 risk).
  const seedIp = lastHost && subnetPrefix(lastHost) ? lastHost : subnetPrefix(currentHost) ? currentHost : null
  const prefix = seedIp ? subnetPrefix(seedIp) : null
  if (prefix) {
    const hostAddrs = Array.from({ length: 254 }, (_, i) => `${prefix}.${i + 1}`)
    const candidates = hostAddrs.flatMap((host) => hostCandidates(host))
    const probeHit = await firstReachable(candidates, DISCOVERY_PROBE_TIMEOUT_MS, DISCOVERY_PROBE_CONCURRENCY)
    if (probeHit) return probeHit
  }

  // 6. Every candidate failed -- caller renders the honest rescan state.
  return null
}

/**
 * URL for the stranded guard's "Open in Safari" escape hatch.
 *
 * Deliberately NOT `location.href`. A standalone PWA launches from the
 * manifest's start_url resolved at install time, so on a stranded launch
 * `location` still names the address the icon was added from -- the very
 * address that stopped resolving. Reopening it in Safari lands on the same
 * dead host and the user is no better off.
 *
 * The mDNS hostname (published by main/phone-remote/mdns.ts) is stable across
 * IP changes, so it's the one address worth handing to Safari. Safari CAN
 * show a TLS interstitial, so an untrusted cert there is recoverable -- which
 * is the entire point of routing the user out of the PWA.
 *
 * Port still comes from `location` when present: the server drifts up to
 * PORT_RANGE_SIZE ports on a bind conflict, and the launching origin's port
 * is a better guess than the base port. Discovery sweeps the whole range once
 * the page loads, so a wrong guess self-corrects; an unreachable HOST does not.
 */
export function safariEscapeUrl(): string {
  const port = Number(location.port) || CONFIG.PHONE_REMOTE.PORT
  return `https://${CONFIG.PHONE_REMOTE.MDNS_HOSTNAME}:${port}/`
}

export function rememberHost(host: string): void {
  credentialStore.set(CONFIG.PHONE_REMOTE.DISCOVERY_LAST_HOST_KEY, host)
}

/** The durable per-device credential from a /pair exchange, or null before
 *  this device has enrolled. Survives server restarts (unlike the session
 *  token), which is what lets an installed PWA reconnect on its own. */
export function currentDeviceCredential(): string | null {
  return credentialStore.get(CONFIG.PHONE_REMOTE.DEVICE_CREDENTIAL_KEY)
}

export function rememberDeviceCredential(credential: string): void {
  credentialStore.set(CONFIG.PHONE_REMOTE.DEVICE_CREDENTIAL_KEY, credential)
}

/** Forget this device's credential -- called when the server rejects it, so a
 *  revoked device falls back to the pairing-code screen instead of retrying a
 *  credential that will never be accepted again. */
export function clearDeviceCredential(): void {
  credentialStore.remove(CONFIG.PHONE_REMOTE.DEVICE_CREDENTIAL_KEY)
}

// Re-exported so `useConnection` reaches the store through this module, which
// owns every other credential read on the socket path.
export { retireTombstones } from './credential-store'

/**
 * Exchange a pairing code (read off the Mac) for a durable credential.
 *
 * This is the ONE call that works from inside a stranded PWA: a same-origin
 * POST needs no cross-partition storage trick and no URL bar -- the two
 * things a standalone Home Screen app doesn't have. Targets `host` when
 * given (discovery may have found the Mac at an address this page wasn't
 * loaded from), else the current origin.
 *
 * A scanned target carries the QR's own copy of the code, so the native scan
 * runs this exact path with nothing typed.
 */
export async function exchangePairingCode(
  code: string,
  target?: { host: string; port: number }
): Promise<{ ok: true } | { ok: false; error: string }> {
  const base = target ? `https://${target.host}:${target.port}` : location.origin
  // Awaited BEFORE the request is built, not raced with it: the hint API is a
  // Promise, so building the body first would post nulls every time.
  const hints = await readDeviceHints()
  try {
    const res = await fetch(`${base}${CONFIG.PHONE_REMOTE.PAIR_CODE_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // The UA can NOT tell an installed PWA from a Safari tab -- recent iOS
      // keeps the Safari token in standalone mode, so the Mac would name every
      // Home Screen app "Safari" in its device list. Only the page knows, so
      // the page says so. Display metadata only; nothing authorizes on it.
      // `shell` narrows that to WHICH standalone host, which the flag alone
      // can't: the native app is standalone too, with the same UA again.
      // `deviceModel`/`osVersion` are null in iOS Safari and the PWA by platform
      // ceiling, and real inside the native shell, which reads its own hardware.
      // The Mac clamps both on arrival -- this is an attacker-reachable body.
      body: JSON.stringify({
        code,
        standalone: isInstalled(),
        shell: capabilities.shell,
        deviceModel: hints.deviceModel,
        osVersion: hints.osVersion
      })
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      const error = (body as { error?: string }).error || `http-${res.status}`
      nativeBridge.log(`pair → HTTP ${res.status} from ${base}, error=${error}`, 'error')
      return { ok: false, error }
    }
    const { credential } = (await res.json()) as { credential?: string }
    if (!credential) {
      nativeBridge.log(`pair → 200 from ${base} but NO credential in body`, 'error')
      return { ok: false, error: 'no-credential' }
    }
    rememberDeviceCredential(credential)
    // A scanned target is a REACHED host -- this POST just succeeded against it.
    // Discovery's tunnel rung otherwise only fills from a /whoami hit, which a
    // native-shell pair never makes, so a tunnel-paired phone stored nothing and
    // every rung below rung 2 assumes a shared LAN: paired, then "can't reach
    // your Mac" with no WS attempt in the journal at all.
    if (target) {
      if (target.port === CONFIG.PHONE_REMOTE.TUNNEL.HTTPS_PORT) rememberTunnelHost(target.host)
      else rememberHost(target.host)
    }
    return { ok: true }
  } catch (err) {
    // A TLS/network failure here reads the same as a wrong code to the user,
    // so name it distinctly -- "can't reach" and "wrong code" need different
    // next actions. The underlying error is logged rather than surfaced: an
    // untrusted-cert failure and a dead host both arrive as a bare TypeError,
    // and telling them apart is the whole diagnosis.
    nativeBridge.log(`pair → fetch threw against ${base}: ${String(err)}`, 'error')
    return { ok: false, error: 'unreachable' }
  }
}

/** Persists the tunnel hostname a successful connection's /whoami advertised
 *  -- the tunnel step above reads this back on a later discovery sweep. A
 *  no-op when the Mac didn't advertise one (off-Wi-Fi access toggled off). */
export function rememberTunnelHost(tunnelHost: string | undefined): void {
  if (!tunnelHost) return
  credentialStore.set(CONFIG.PHONE_REMOTE.DISCOVERY_LAST_TUNNEL_HOST_KEY, tunnelHost)
}

/**
 * Cloudflare Tunnel lifecycle for Phone Remote's off-LAN path — replaces
 * tailscale.ts.
 *
 * Nothing to detect, nothing for the user to install or log into: the
 * `phone-remote-tunnel` Edge Function provisions a named tunnel + DNS on
 * MightyMouse's own Cloudflare zone (account token stays server-side; this
 * module only ever holds the per-install run token), and this module downloads
 * `cloudflared` on first use, spawns it, and keeps it alive while the feature
 * is on. DOMAIN-FREE like server.ts/tailscale.ts before it: no IPC, no
 * Settings knowledge — ipc/phone-remote.ts owns the glue and subscribes to
 * status via setTunnelStatusListener().
 *
 * Provisioning is cached on disk (`phone-remote-tunnel.json`) keyed by port,
 * so the common re-enable path costs zero network before spawn. A cached
 * token that's gone stale server-side (tunnel deleted) surfaces as cloudflared
 * exiting immediately — handled by invalidating the cache and re-provisioning
 * once before giving up.
 */
import { spawn, execFile, type ChildProcess } from 'child_process'
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  createWriteStream,
  unlinkSync
} from 'fs'
import { join } from 'path'
import { get } from 'https'
import { randomUUID } from 'crypto'
import { arch } from 'os'
import { CONFIG } from '../../shared/config'
import { devLog } from '../../shared/env'
import type { PhoneRemoteTunnelStatus, TunnelReach } from '../../shared/types'
import { isRemoteRefusal, type RemoteRefusal } from '../../shared/remote-refusal'
import { PATHS } from '../store/paths'
import { getSupabase } from '../supabase'
import { track } from '../analytics'
// Circular by module graph (session-meter reads getTunnelHostname here), but not
// at init: both sides only call across at runtime, after both modules have loaded.
import { endSession, endSessionBestEffort } from './session-meter'

interface ProvisionRecord {
  hostname: string
  tunnelToken: string
  port: number
}

let proc: ChildProcess | null = null
let status: PhoneRemoteTunnelStatus = { state: 'stopped' }
// True between startTunnel() and stopTunnel() — the crash-restart loop only
// respawns while this holds, so a deliberate stop never fights the watchdog.
let desired = false
// Last start attempt bailed for want of a sign-in. Distinguishes "no tunnel
// because nobody asked for one" from "no tunnel because we can't provision
// one" — /whoami reports it so a phone can name the reason it's LAN-only.
let signedOut = false
let restartCount = 0
let statusListener: ((s: PhoneRemoteTunnelStatus) => void) | null = null

// Serializes start/stopTunnel onto one queue: without it a fast toggle lets an
// in-flight start keep running past a later stop, racing two cloudflared procs
// for one port.
let opQueue: Promise<unknown> = Promise.resolve()

function enqueue<T>(op: () => Promise<T>): Promise<T> {
  const result = opQueue.then(op, op)
  // Swallow so a failed op doesn't permanently poison the queue for the next
  // caller — each `.then` above already sees the rejection via its own promise.
  opQueue = result.catch(() => undefined)
  return result
}

/** One listener (the IPC glue) — pushes every transition to Settings. */
export function setTunnelStatusListener(cb: ((s: PhoneRemoteTunnelStatus) => void) | null): void {
  statusListener = cb
}

export function getTunnelStatus(): PhoneRemoteTunnelStatus {
  return status
}

/** Public hostname while the tunnel is actually up, else null — /whoami embeds
 *  this so phones learn the off-LAN address from any successful LAN contact. */
export function getTunnelHostname(): string | null {
  return status.state === 'up' && status.hostname ? status.hostname : null
}

/** Why /whoami carries no `tunnel` field, for a phone that has to explain the
 *  dead end. `signed-out` is the one cause the user can act on themselves. */
export function getTunnelReach(): TunnelReach {
  if (status.state === 'up') return 'up'
  if (signedOut) return 'signed-out'
  if (status.state === 'downloading' || status.state === 'provisioning' || status.state === 'starting') {
    return 'starting'
  }
  return status.state === 'error' ? 'error' : 'off'
}

function setStatus(next: PhoneRemoteTunnelStatus): void {
  status = next
  statusListener?.(next)
}

// Stable per-install id (32 hex), kept in ~/MightyMouse. Drives the tunnel name
// AND the public hostname, so wiping the folder provisions a fresh tunnel and
// orphans the old one — an accepted non-goal.
export function getPhoneRemoteInstallId(): string {
  try {
    if (existsSync(PATHS.PHONE_REMOTE_INSTALL_ID)) {
      const id = readFileSync(PATHS.PHONE_REMOTE_INSTALL_ID, 'utf-8').trim().toLowerCase()
      if (/^[a-f0-9]{32}$/.test(id)) return id
    }
  } catch {
    // unreadable file → mint a fresh id below
  }
  const id = randomUUID().replace(/-/g, '')
  try {
    if (!existsSync(PATHS.ROOT)) mkdirSync(PATHS.ROOT, { recursive: true })
    writeFileSync(PATHS.PHONE_REMOTE_INSTALL_ID, id, { encoding: 'utf-8', mode: 0o600 })
  } catch (err) {
    devLog.error('Phone Remote tunnel: failed to persist install id', err)
  }
  return id
}

/** Release asset name per CPU arch — exported for the unit test. */
export function pickCloudflaredAsset(cpuArch: string): string {
  return cpuArch === 'arm64' ? 'cloudflared-darwin-arm64.tgz' : 'cloudflared-darwin-amd64.tgz'
}

const MANAGED_BIN = join(PATHS.BIN, 'cloudflared')
// System installs (brew) checked before downloading our own copy — a dev/user
// who already has cloudflared shouldn't pay a 17 MB download for a duplicate.
const SYSTEM_BINS = ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared']

export function parseCloudflaredVersion(out: string): string | null {
  return out.match(/version (\d+\.\d+\.\d+)/)?.[1] ?? null
}

export function isCloudflaredCurrent(version: string | null, min: string): boolean {
  if (!version) return false
  const a = version.split('.').map(Number)
  const b = min.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return true
}

function cloudflaredVersion(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: 5_000 }, (err, stdout) =>
      resolve(err ? null : parseCloudflaredVersion(stdout))
    )
  })
}

// A stale managed copy is re-downloaded over itself; a stale system copy is skipped.
async function findCloudflared(): Promise<string | null> {
  for (const p of [MANAGED_BIN, ...SYSTEM_BINS]) {
    if (!existsSync(p)) continue
    const version = await cloudflaredVersion(p)
    if (isCloudflaredCurrent(version, CONFIG.PHONE_REMOTE.TUNNEL.CLOUDFLARED_MIN_VERSION)) return p
    devLog.warn(`Phone Remote tunnel: skipping ${p} (version ${version ?? 'unknown'})`)
  }
  return null
}

// Deliberately NARROW: exact binary path AND `tunnel run` argv, never a blanket
// `pkill cloudflared` — a user's own tunnel must survive. Can't match on tunnel
// id; the token rides env, not world-readable argv.
export function matchOrphanPids(
  psOutput: string,
  bin: string,
  selfPid: number,
  livePid?: number
): number[] {
  const pids: number[] = []
  for (const line of psOutput.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/)
    if (!m) continue
    const pid = parseInt(m[1], 10)
    if (pid === selfPid) continue
    // Our OWN live child shares the exact argv an orphan has. Without this it
    // reaps itself on every re-enable: SIGTERM -> watchdog respawn -> the
    // toggle lands on a red "failed" for a tunnel nothing was wrong with.
    if (livePid !== undefined && pid === livePid) continue
    // EXACT argv match: our own child is spawned as `<bin> tunnel run` with no
    // extra flags. A user's own cloudflared (`--config`, a named tunnel, a
    // quick tunnel, a different binary) fails this and survives untouched.
    if (m[2] === `${bin} tunnel run`) pids.push(pid)
  }
  return pids
}

function reapOrphanedCloudflared(bin: string): Promise<void> {
  return new Promise((resolve) => {
    // Match in JS, NOT `pgrep -f '^…$'`: BSD pgrep's argv spacing varies, and a
    // mis-anchored pattern fails OPEN — it reaps nothing, silently.
    execFile('ps', ['-axo', 'pid=,command='], (err, stdout) => {
      if (err) return resolve() // can't enumerate → skip the reap, never block the spawn
      const pids = matchOrphanPids(stdout || '', bin, process.pid, proc?.pid)
      if (pids.length === 0) return resolve()
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGTERM')
          devLog.warn(`Phone Remote tunnel: reaped orphaned cloudflared (pid ${pid})`)
        } catch {
          // already gone / not ours to kill — nothing to do
        }
      }
      // Give the edge connections a beat to tear down so the fresh spawn isn't
      // racing a still-registered ghost.
      setTimeout(resolve, pids.length > 0 ? CONFIG.PHONE_REMOTE.TUNNEL.REAP_SETTLE_MS : 0)
    })
  })
}

/** Download + extract the official cloudflared release into our bin dir.
 *  Follows GitHub's release redirects; reports pct via the status stream so
 *  Settings can render live progress (it's a ~17 MB one-time fetch). */
function downloadCloudflared(): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      mkdirSync(PATHS.BIN, { recursive: true })
    } catch (err) {
      return reject(err)
    }
    const asset = pickCloudflaredAsset(arch())
    const tgz = join(PATHS.BIN, asset)
    const file = createWriteStream(tgz)
    let redirects = 0

    const request = (url: string): void => {
      get(url, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          const loc = res.headers.location
          res.resume()
          if (loc && redirects++ < 5) return request(loc)
          file.close()
          return reject(new Error('cloudflared download: too many redirects'))
        }
        if (res.statusCode !== 200) {
          file.close()
          return reject(new Error(`cloudflared download: HTTP ${res.statusCode}`))
        }
        const total = parseInt(res.headers['content-length'] || '0', 10)
        let received = 0
        res.on('data', (chunk: Buffer) => {
          received += chunk.length
          if (total > 0) {
            setStatus({ ...status, state: 'downloading', pct: Math.round((received / total) * 100) })
          }
        })
        res.pipe(file)
        file.on('finish', () =>
          file.close(() => {
            // macOS ships tar; the tgz contains a single `cloudflared` binary.
            execFile('tar', ['-xzf', tgz, '-C', PATHS.BIN], (err) => {
              try {
                unlinkSync(tgz)
              } catch {
                // leftover archive is harmless
              }
              if (err) return reject(err)
              try {
                chmodSync(MANAGED_BIN, 0o755)
              } catch (chmodErr) {
                return reject(chmodErr)
              }
              resolve(MANAGED_BIN)
            })
          })
        )
      }).on('error', (err) => {
        file.close()
        reject(err)
      })
    }
    request(`${CONFIG.PHONE_REMOTE.TUNNEL.CLOUDFLARED_DOWNLOAD_BASE}/${asset}`)
  })
}

function readCachedProvision(port: number): ProvisionRecord | null {
  try {
    if (!existsSync(PATHS.PHONE_REMOTE_TUNNEL_STATE)) return null
    const rec = JSON.parse(readFileSync(PATHS.PHONE_REMOTE_TUNNEL_STATE, 'utf-8'))
    if (isProvisionValid(rec) && rec.port === port) return rec
  } catch {
    // corrupt cache → re-provision
  }
  return null
}

/** Shape check for the on-disk provision cache — exported for the unit test. */
export function isProvisionValid(rec: unknown): rec is ProvisionRecord {
  const r = rec as ProvisionRecord
  return (
    !!r &&
    typeof r.hostname === 'string' &&
    r.hostname.length > 0 &&
    typeof r.tunnelToken === 'string' &&
    r.tunnelToken.length > 0 &&
    typeof r.port === 'number'
  )
}

function clearCachedProvision(): void {
  try {
    if (existsSync(PATHS.PHONE_REMOTE_TUNNEL_STATE)) unlinkSync(PATHS.PHONE_REMOTE_TUNNEL_STATE)
  } catch {
    // best-effort
  }
}

async function currentJwt(): Promise<string> {
  const { data } = await getSupabase().auth.getSession()
  return data.session?.access_token ?? ''
}

/** Sentinel reason: the pref defaults ON, so a signed-out install reaches
 *  startTunnel() routinely. Callers stay quiet on this one reason only. */
export const NOT_SIGNED_IN = 'not-signed-in'

/** A refusal the server STATED, carried intact to the UI. Subclasses Error so the
 *  existing catch chain treats it like any other failure — `message` is already
 *  the printable sentence, and `refusal` is the extra the upgrade prompt needs. */
export class RemoteRefusalError extends Error {
  constructor(readonly refusal: RemoteRefusal) {
    super(refusal.message)
    this.name = 'RemoteRefusalError'
  }
}

/** Ask the Edge Function for this install's tunnel token + hostname. */
async function provision(port: number): Promise<ProvisionRecord> {
  const jwt = await currentJwt()
  if (!jwt) throw new Error(NOT_SIGNED_IN)

  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), CONFIG.PHONE_REMOTE.TUNNEL.PROVISION_TIMEOUT_MS)
  try {
    const resp = await fetch(
      `${CONFIG.BILLING.EDGE_FUNCTION_URL}/${CONFIG.PHONE_REMOTE.TUNNEL.FN}`,
      {
        method: 'POST',
        signal: abort.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ installId: getPhoneRemoteInstallId(), port })
      }
    )
    const body = await resp.json()
    if (!resp.ok || !body?.tunnelToken || !body?.hostname) {
      // A stated refusal keeps its code + usage numbers; collapsing it to a
      // string here is what printed the bare `remote_limit_reached` in Settings.
      if (isRemoteRefusal(body)) throw new RemoteRefusalError(body)
      throw new Error(body?.error || `Tunnel setup failed (HTTP ${resp.status})`)
    }
    const rec: ProvisionRecord = { hostname: body.hostname, tunnelToken: body.tunnelToken, port }
    try {
      writeFileSync(PATHS.PHONE_REMOTE_TUNNEL_STATE, JSON.stringify(rec), { mode: 0o600 })
    } catch (err) {
      devLog.error('Phone Remote tunnel: failed to cache provision', err)
    }
    return rec
  } finally {
    clearTimeout(timer)
  }
}

/** Spawn cloudflared and resolve once it registers an edge connection (or
 *  reject on early exit / timeout). Token travels via env, not argv — argv is
 *  visible to every local process via `ps`. */
function spawnCloudflared(bin: string, rec: ProvisionRecord): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['tunnel', 'run'], {
      env: { ...process.env, TUNNEL_TOKEN: rec.tunnelToken },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    proc = child
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error('cloudflared did not connect in time'))
    }, CONFIG.PHONE_REMOTE.TUNNEL.START_TIMEOUT_MS)

    const onOutput = (chunk: Buffer): void => {
      // cloudflared logs to stderr; "Registered tunnel connection" is its
      // stable "I'm live at the edge" line (one per HA connection).
      if (!settled && chunk.toString().includes('Registered tunnel connection')) {
        settled = true
        clearTimeout(timer)
        resolve()
      }
    }
    child.stdout?.on('data', onOutput)
    child.stderr?.on('data', onOutput)

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
    child.on('exit', (code, signal) => {
      if (proc === child) proc = null
      // `code null` alone reads as a mystery — it means "killed by a signal",
      // and WHICH signal names the killer (SIGTERM = someone stopped it,
      // SIGKILL = OOM/force-quit). Always log both.
      const how = signal ? `signal ${signal}` : `code ${code}`
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(new Error(`cloudflared exited early (${how})`))
      } else if (desired) {
        // Crashed while we want it up — bounded respawns, then honest error.
        if (restartCount < CONFIG.PHONE_REMOTE.TUNNEL.RESTART_MAX) {
          const delay =
            CONFIG.PHONE_REMOTE.TUNNEL.RESTART_BACKOFF_MS[
              Math.min(restartCount, CONFIG.PHONE_REMOTE.TUNNEL.RESTART_BACKOFF_MS.length - 1)
            ]
          restartCount++
          devLog.warn(`Phone Remote tunnel: cloudflared died (${how}), restart ${restartCount}`)
          setTimeout(() => {
            if (desired) void startTunnel(rec.port)
          }, delay)
        } else {
          setStatus({ state: 'error', hostname: rec.hostname, error: 'Tunnel keeps disconnecting.' })
        }
      }
    })
  })
}

// Idempotent — 'up' or mid-start on the same port is a no-op. Never throws;
// callers surface `reason` in Settings.
export function startTunnel(
  port: number
): Promise<{ ok: true; hostname: string } | { ok: false; reason: string }> {
  return enqueue(() => startTunnelImpl(port))
}

async function startTunnelImpl(
  port: number
): Promise<{ ok: true; hostname: string } | { ok: false; reason: string }> {
  if (
    proc &&
    status.hostname &&
    (status.state === 'up' || status.state === 'starting') &&
    readCachedProvision(port)
  ) {
    return { ok: true, hostname: status.hostname }
  }

  // Bail BEFORE `desired`/status move: nothing downloads, no error surfaces,
  // and the crash-restart watchdog never arms. LAN carries pairing until the
  // next start after sign-in.
  if (!(await currentJwt())) {
    signedOut = true
    return { ok: false, reason: NOT_SIGNED_IN }
  }
  signedOut = false

  desired = true

  try {
    let bin = await findCloudflared()
    if (!bin) {
      setStatus({ state: 'downloading', pct: 0, hostname: status.hostname })
      bin = await downloadCloudflared()
    }

    let rec = readCachedProvision(port)
    if (!rec) {
      setStatus({ state: 'provisioning', hostname: status.hostname })
      rec = await provision(port)
    }

    setStatus({ state: 'starting', hostname: rec.hostname })
    // Ghosts from a previous app instance (make restart, crash, force-quit)
    // race the new child for the same tunnel and both die. Clear them first.
    await reapOrphanedCloudflared(bin)
    try {
      await spawnCloudflared(bin, rec)
    } catch (spawnErr) {
      // A stale cached token (tunnel deleted server-side) dies instantly —
      // one re-provision retry before reporting failure.
      devLog.warn('Phone Remote tunnel: first spawn failed, re-provisioning once', spawnErr)
      stopProcess()
      clearCachedProvision()
      rec = await provision(port)
      setStatus({ state: 'starting', hostname: rec.hostname })
      await spawnCloudflared(bin, rec)
    }

    restartCount = 0
    setStatus({ state: 'up', hostname: rec.hostname })
    return { ok: true, hostname: rec.hostname }
  } catch (err) {
    desired = false
    stopProcess()
    const reason = err instanceof Error ? err.message : 'Tunnel setup failed'
    const refusal = err instanceof RemoteRefusalError ? err.refusal : undefined
    if (refusal) {
      track('phone_remote_tunnel_refused', {
        code: refusal.code,
        window: refusal.usage?.window ?? null
      })
    }
    setStatus({ state: 'error', hostname: status.hostname, error: reason, refusal })
    return { ok: false, reason }
  }
}

function stopProcess(): void {
  if (proc) {
    proc.kill()
    proc = null
  }
}

// Sync kill for `will-quit`. Deliberately NOT queued: a quit hook is
// synchronous, so the process exits before a queued op runs and the child
// survives as an orphan. Kills right now, no await.
export function stopTunnelSync(): void {
  desired = false
  restartCount = 0
  // Best effort only — the report is async and the process usually exits first.
  // The server-side reaper is what actually bills an abandoned session.
  endSessionBestEffort()
  stopProcess()
}

/** Stop cloudflared. The tunnel + DNS stay provisioned server-side, so the
 *  next enable is just a cached-token spawn. Queued
 *  (see `enqueue`) alongside startTunnel() for the same reason. */
export function stopTunnel(): Promise<void> {
  return enqueue(async () => {
    desired = false
    restartCount = 0
    // Killing the tunnel ends the off-LAN session without a socket close, so
    // nothing else would report it.
    endSession()
    stopProcess()
    setStatus({ state: 'stopped', hostname: status.hostname })
  })
}

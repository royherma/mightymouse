/**
 * Bonjour/mDNS registration for the Phone Remote server.
 *
 * WHY THIS EXISTS: the cert's SAN list, useHostDiscovery.ts's step-2 probe,
 * and the stranded-guard's "Open in Safari" link all assume the phone can
 * resolve `mightymouse.local`. Nothing ever published that name -- the Mac
 * advertises its own Bonjour name (e.g. `MacBook-Pro-34.local`), so step 2
 * burned its timeout and returned null on every sweep since it was written.
 *
 * That gap is what strands an installed PWA. When the Mac's LAN IP changes,
 * loadOrCreateCert() mints a NEW keypair to cover the new IP, which voids
 * Safari's per-certificate trust exception for every SAN at once. A PWA has
 * no URL bar to tap through the new cert, so every discovery candidate fails
 * and the user lands on "Can't find your Mac".
 *
 * Registering a STABLE hostname breaks that chain: the phone reaches the Mac
 * by name instead of by a shifting IP, so a DHCP change no longer forces a
 * cert regen, so trust survives.
 *
 * Implemented by spawning macOS's built-in `dns-sd -P` rather than adding an
 * npm Bonjour library: this is a macOS-only app, `dns-sd` ships with the OS,
 * and a proxy registration is the one mode that publishes a resolvable A
 * record for a hostname we choose (a plain service registration would only
 * advertise the service, not the name the cert is issued for).
 */

import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { CONFIG } from '../../shared/config'
import { devLog } from '../../shared/env'

/** Held so stop() can kill the registration; null when not advertising. */
let proc: ChildProcess | null = null

/** What to re-register if `dns-sd` dies on its own; null once stopped. */
let advertised: { lanIp: string; port: number } | null = null
/** Pending respawn, so a stop() mid-backoff doesn't resurrect the name. */
let respawnTimer: NodeJS.Timeout | null = null
/** Consecutive unrequested exits, for the backoff below. */
let respawnAttempts = 0
/** Give up after this many: past it the failure is the network, not a blip. */
const MAX_RESPAWN_ATTEMPTS = 5
/** A registration alive this long counts as working, so the next death starts
 *  a fresh budget. Without it the 5 attempts are per-SESSION rather than per
 *  outage: five unrelated deaths hours apart retired discovery permanently,
 *  leaving `mightymouse.local` unresolvable and the phone searching forever. */
const HEALTHY_REGISTRATION_MS = 20_000

/** The advertised hostname, without the `.local` suffix `dns-sd` appends. */
const SERVICE_INSTANCE = CONFIG.PHONE_REMOTE.MDNS_SERVICE_INSTANCE
const SERVICE_TYPE = CONFIG.PHONE_REMOTE.MDNS_SERVICE_TYPE
const HOSTNAME = CONFIG.PHONE_REMOTE.MDNS_HOSTNAME

/**
 * Advertise `mightymouse.local` -> `lanIp` over mDNS. Idempotent: a second
 * call while already advertising restarts the registration, which is what a
 * LAN IP change needs (the old record points at a dead address).
 *
 * Best-effort by design. mDNS is blocked on some networks (guest VLANs,
 * client isolation, corporate Wi-Fi), and `dns-sd` can fail if the name is
 * already claimed by another host. Neither case is fatal -- discovery still
 * has the current-origin, last-known-good, tunnel, and subnet-probe
 * candidates -- so a failure logs and returns false instead of throwing.
 */
export function startMdnsAdvertisement(lanIp: string, port: number): boolean {
  if (process.platform !== 'darwin') return false
  stopMdnsAdvertisement()
  reapOrphanedRegistrations()
  // After stop(), which clears both -- a caller-driven start is a fresh run,
  // so it gets the full retry budget back.
  advertised = { lanIp, port }
  respawnAttempts = 0
  return spawnRegistration(lanIp, port)
}

/** The spawn itself, shared by the caller-driven start and the respawn. */
function spawnRegistration(lanIp: string, port: number): boolean {
  try {
    // -P is the "proxy" registration mode: it publishes BOTH the service and
    // an A record mapping HOSTNAME -> lanIp. Plain -R would advertise only
    // the service under the Mac's existing hostname, which is precisely the
    // name we can't rely on.
    const child = spawn(
      'dns-sd',
      ['-P', SERVICE_INSTANCE, SERVICE_TYPE, 'local', String(port), HOSTNAME, lanIp],
      // Piped, not ignored: dns-sd reports a conflict on stdout and still exits
      // 255, so a bare exit code can't tell "name taken" from "mDNSResponder
      // down" -- and those need opposite fixes.
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    const spawnedAt = Date.now()

    let lastOutput = ''
    const capture = (buf: Buffer): void => {
      lastOutput = buf.toString().trim().split('\n').slice(-1)[0] ?? lastOutput
    }
    child.stdout?.on('data', capture)
    child.stderr?.on('data', capture)

    child.on('error', (err) => {
      devLog.warn('[phone-remote] mDNS registration failed to spawn', err)
      if (proc !== child) return
      proc = null
      scheduleRespawn()
    })

    // dns-sd holds the registration only while it runs -- an early exit means
    // the name is no longer advertised (name conflict, mDNSResponder down).
    // Nothing else ever re-registers: start() is called once per server start,
    // so without the respawn below a single exit left `mightymouse.local`
    // unresolvable and Bonjour discovery dead for the rest of the session.
    child.on('exit', (code, signal) => {
      if (proc !== child) return
      proc = null
      if (code !== 0) {
        devLog.warn('[phone-remote] mDNS registration exited', { code, signal, reason: lastOutput })
      }
      if (Date.now() - spawnedAt >= HEALTHY_REGISTRATION_MS) respawnAttempts = 0
      scheduleRespawn()
    })

    proc = child
    devLog.log('[phone-remote] advertising', `${HOSTNAME} -> ${lanIp}:${port}`)
    return true
  } catch (err) {
    devLog.warn('[phone-remote] mDNS registration failed', err)
    proc = null
    return false
  }
}

/**
 * Re-register after an exit nobody asked for.
 *
 * Backs off so a permanently-conflicted name doesn't spin `dns-sd` forever,
 * and gives up entirely after MAX_RESPAWN_ATTEMPTS -- at that point the cause
 * is the network or a name another host owns, and neither is fixed by retrying.
 */
function scheduleRespawn(): void {
  const target = advertised
  if (!target || respawnTimer) return
  if (respawnAttempts >= MAX_RESPAWN_ATTEMPTS) {
    devLog.warn('[phone-remote] mDNS gave up re-registering', { attempts: respawnAttempts })
    return
  }
  respawnAttempts += 1
  const delayMs = Math.min(30_000, 1_000 * 2 ** (respawnAttempts - 1))
  respawnTimer = setTimeout(() => {
    respawnTimer = null
    // stop() may have landed while this was pending.
    if (!advertised) return
    devLog.log('[phone-remote] mDNS re-registering', { attempt: respawnAttempts })
    // Deliberately not startMdnsAdvertisement(): that resets the attempt
    // counter, so a name we can never claim would retry forever.
    spawnRegistration(target.lanIp, target.port)
  }, delayMs)
  respawnTimer.unref?.()
}

/**
 * Kill `dns-sd -P` processes we leaked in an earlier run.
 *
 * A registration lives only as long as its process, so we spawn one and hold
 * it -- but `make restart` SIGKILLs Electron and stop() never runs. Each
 * restart therefore leaked one, and 13 had piled up: the oldest still claimed
 * `mightymouse.local` for an IP from two networks ago. A fresh registration
 * LOSES that conflict ("Name in use, please choose another", exit 255), so the
 * name kept resolving to a dead address -- worse than not resolving, because
 * discovery step 2 gets a confident wrong answer instead of failing to the
 * next rung.
 *
 * Matching on the hostname keeps this to our own registrations; another app's
 * `dns-sd` is not ours to kill.
 */
function reapOrphanedRegistrations(): void {
  try {
    // pkill -f matches the full argv, and HOSTNAME appears only in ours. Our
    // OWN live child matches too, so it is spared explicitly: reaping it read
    // as "registered and active" then SIGTERM, and burned the respawn budget
    // until discovery retired itself for the session.
    const mine = proc?.pid
    const found = spawnSync('pgrep', ['-f', `dns-sd -P .*${HOSTNAME}`], { encoding: 'utf8' })
    const orphans = (found.stdout ?? '')
      .split('\n')
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== mine)
    for (const pid of orphans) {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        // Already gone between pgrep and here -- that is the desired end state.
      }
    }
    if (orphans.length > 0) {
      devLog.log('[phone-remote] reaped orphaned mDNS registration', { count: orphans.length })
    }
  } catch (err) {
    // Never fatal: a failed reap just means the conflict below is logged.
    devLog.warn('[phone-remote] mDNS orphan reap failed', err)
  }
}

/** Withdraw the advertisement. Safe to call when not advertising (no-op). */
export function stopMdnsAdvertisement(): void {
  // Before the early return: a stop landing while a respawn is pending must
  // cancel it, and that state outlives `proc` being null.
  advertised = null
  respawnAttempts = 0
  if (respawnTimer) {
    clearTimeout(respawnTimer)
    respawnTimer = null
  }
  if (!proc) return
  try {
    proc.kill()
  } catch (err) {
    devLog.warn('[phone-remote] failed to stop mDNS registration', err)
  }
  proc = null
}

/** True while the registration process is alive. */
export function isMdnsAdvertising(): boolean {
  return proc !== null
}

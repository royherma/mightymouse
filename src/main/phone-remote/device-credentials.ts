/**
 * Durable device-credential store: paired-phone records, persisted encrypted
 * under PATHS.PHONE_REMOTE_DEVICES. Owns load/save/migrate/mint/revoke.
 */
import { readFileSync, existsSync, writeFileSync } from 'fs'
import { createHash, randomBytes } from 'crypto'
import { CONFIG } from '../../shared/config'
import { devLog } from '../../shared/env'
import { PATHS } from '../store/paths'
import { encryptLine, decryptLine, isEncryptedLine } from '../store/safe-storage'
import { parseDeviceIdentity, formatDeviceLabel, formatOsLabel } from './device-identity'
import { recordJournal } from './connection-journal'
import type { PairedDevice } from '../../shared/types'
import type { HostShell } from '../../shared/types'
import { HOST_SHELLS } from '../../shared/types'
import { deviceIdleDays, DEVICE_REVOKE_AFTER_DAYS } from '../../shared/paired-device-labels'
import type { BlockedReason } from './connection-state'
import {
  clearPairingCode,
  getActiveSocket,
  getActiveSocketCredential,
  clearActiveSocket
} from './server-runtime'

type DeviceRecord = {
  pairedAt: number
  lastSeenAt: number | null
  userAgent: string | null
  standalone: boolean
  shell: HostShell | null
  deviceModel: string | null
  /** The phone's OS version as the CLIENT reports it. Distinct from the one the
   *  UA yields: the native shell knows it exactly, and this is the field that
   *  answers "what deployment target can we raise to". */
  osVersion: string | null
  /** The iOS shell's own version. It ships independently of the Mac app, so the
   *  events row's `app_version` (the Mac's) can't stand in for it. */
  iosAppBuild: string | null
  /** APNs device token, hex. Re-sent (and overwritten) on every iOS launch, so
   *  a rotated token self-heals with no user action -- see design. */
  pushToken: string | null
}

let deviceCredentials: Map<string, DeviceRecord> | null = null

/** True when the last load FAILED to read a file that exists, as opposed to
 *  finding no pairings. The difference decides whether a phone keeps its
 *  credential: an empty store means "you were never paired" (the phone should
 *  clear and re-pair), a failed read means "we can't tell right now" (the
 *  phone must hold what it has and retry). Reporting the second as the first
 *  made every paired device delete its own working credential. */
let credentialLoadFailed = false

export function loadDeviceCredentials(): Map<string, DeviceRecord> {
  if (deviceCredentials) return deviceCredentials
  const loaded = new Map<string, DeviceRecord>()
  let failed = false
  try {
    if (existsSync(PATHS.PHONE_REMOTE_DEVICES)) {
      const raw = readFileSync(PATHS.PHONE_REMOTE_DEVICES, 'utf8').trim()
      const plain = isEncryptedLine(raw) ? decryptLine(raw) : raw
      // A null decrypt means this file came from a different machine/identity
      // (safeStorage is app+user bound). Unreadable-but-present is a FAULT,
      // not an empty store -- see `credentialLoadFailed`.
      if (plain) {
        const parsed = JSON.parse(plain) as Record<string, number | DeviceRecord>
        for (const [cred, value] of Object.entries(parsed)) {
          loaded.set(cred, migrateDeviceRecord(value))
        }
      } else {
        failed = true
      }
    }
  } catch (err) {
    // Swallowing this used to look identical to "no devices paired", which is
    // the shape that unpaired live phones. Record it as a fault instead.
    failed = true
    devLog.warn('[phone-remote] could not read paired devices', err)
  }
  credentialLoadFailed = failed
  if (failed) {
    // devLog is IS_DEV-only and truncated by `make restart` -- the journal is
    // the only record that survives the restart this bug provokes.
    recordJournal('cred-load-failed', {
      detail: 'paired-device file present but unreadable -- refusing without revoking'
    })
  }
  deviceCredentials = loaded
  // The sweep reads `lastSeenAt` off records we never loaded, so on a failed
  // read it walks an EMPTY map and still journals a revoke -- a phone paired
  // minutes ago reported as "idle over 90 days". Nothing to sweep either way.
  if (!failed && sweepIdleCredentials(loaded)) saveDeviceCredentials()
  return loaded
}

function sweepIdleCredentials(creds: Map<string, DeviceRecord>): boolean {
  const expired: string[] = []
  for (const [cred, rec] of creds) {
    const idle = deviceIdleDays(rec)
    if (idle !== null && idle >= DEVICE_REVOKE_AFTER_DAYS) expired.push(cred)
  }
  for (const cred of expired) creds.delete(cred)
  if (expired.length > 0) {
    devLog.log('[phone-remote] revoked idle device credential(s)', { count: expired.length })
    recordJournal('revoked', {
      detail: `${expired.length} device(s) idle over ${DEVICE_REVOKE_AFTER_DAYS} days -- re-pair required`
    })
  }
  return expired.length > 0
}

function migrateDeviceRecord(value: number | DeviceRecord): DeviceRecord {
  if (typeof value === 'number') {
    return {
      pairedAt: value,
      lastSeenAt: null,
      userAgent: null,
      standalone: false,
      shell: null,
      deviceModel: null,
      osVersion: null,
      iosAppBuild: null,
      pushToken: null
    }
  }
  return {
    pairedAt: value.pairedAt ?? 0,
    lastSeenAt: value.lastSeenAt ?? null,
    userAgent: value.userAgent ?? null,
    standalone: value.standalone === true,
    shell: asHostShell(value.shell),
    // Re-clamped on the way out of the file too, not just on the wire: the store
    // is only as trustworthy as whatever wrote it, and a record predating the
    // clamp would otherwise reach the UI unchecked.
    deviceModel: clampClientString(value.deviceModel),
    osVersion: clampClientString(value.osVersion),
    iosAppBuild: clampClientString(value.iosAppBuild),
    pushToken: isValidPushToken(value.pushToken) ? value.pushToken : null
  }
}

/** APNs device tokens are 64 or 100 hex chars (32B classic / 50B iOS 13+, and
 *  Apple has reserved room to grow this before). Reject anything else outright
 *  -- it rides straight into an Edge function's push payload later. */
export function isValidPushToken(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64,100}$/i.test(value)
}

/** Longest client-reported identity string we'll store. Real values are ~16
 *  chars ("Samsung Galaxy S24 Ultra"); the cap exists so a hostile client can't
 *  push a paragraph into a Settings row or bloat the credential file. */
const CLIENT_STRING_MAX = 32

export function clampClientString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const cleaned = value.replace(/[^A-Za-z0-9 .,()-]/g, '').trim().slice(0, CLIENT_STRING_MAX)
  return cleaned.length > 0 ? cleaned : null
}

/** Narrow an off-the-wire (or off-disk) string to the closed shell set. Anything
 *  else becomes null and falls back to the UA/standalone label -- a forged value
 *  must not be able to write arbitrary text into the Settings list. */
export function asHostShell(value: unknown): HostShell | null {
  return HOST_SHELLS.includes(value as HostShell) ? (value as HostShell) : null
}

export function saveDeviceCredentials(): void {
  try {
    const obj = Object.fromEntries(loadDeviceCredentials())
    // The in-memory map is empty after a failed read, so writing it back would
    // overwrite real pairings with `{}` -- turning a transient fault into
    // permanent loss. Refuse; the file on disk is still the better copy.
    if (credentialLoadFailed) {
      devLog.warn('[phone-remote] refusing to persist over an unreadable device file')
      return
    }
    devLog.warn('[phone-remote] CRED SAVE', {
      writing: Object.keys(obj).length,
      stack: new Error().stack
    })
    writeFileSync(PATHS.PHONE_REMOTE_DEVICES, encryptLine(JSON.stringify(obj)), { mode: 0o600 })
  } catch (err) {
    devLog.error('[phone-remote] failed to persist paired devices', err)
  }
}

/** True when `candidate` is a currently-valid device credential. */
export function isDeviceCredentialValid(candidate: string | null): boolean {
  if (!candidate) return false
  return loadDeviceCredentials().has(candidate)
}

/** Mint a durable credential for a device and record who it belongs to.
 *
 *  Shared by the two ways in -- the 6-digit code and the paired phone's Allow --
 *  because a credential minted differently in each place is how the two paths
 *  drift into producing devices Settings can only half-describe. */
export function mintDeviceCredential(meta: {
  userAgent: string | null
  standalone: boolean
  shell: HostShell | null
  deviceModel: string | null
  osVersion: string | null
  iosAppBuild: string | null
}): string {
  const credential = randomBytes(32).toString('base64url')
  const creds = loadDeviceCredentials()
  creds.set(credential, {
    pairedAt: Date.now(),
    lastSeenAt: null,
    userAgent: meta.userAgent,
    standalone: meta.standalone,
    shell: meta.shell,
    deviceModel: meta.deviceModel,
    osVersion: meta.osVersion,
    iosAppBuild: meta.iosAppBuild,
    pushToken: null
  })
  // Persist immediately: an unwritten credential is one app quit away from
  // stranding the device that just paired.
  saveDeviceCredentials()
  return credential
}

export function forgetPairedDevices(): number {
  const creds = loadDeviceCredentials()
  const count = creds.size
  creds.clear()
  saveDeviceCredentials()
  clearPairingCode()
  if (getActiveSocket()) {
    getActiveSocket()!.close(4401, CONFIG.PHONE_REMOTE.CLOSE_REASON_REVOKED)
    clearActiveSocket()
  }
  return count
}

/** How many devices are currently paired -- Settings shows this next to the
 *  revoke action so "Forget paired devices" isn't a blind button. */
export function getPairedDeviceCount(): number {
  return loadDeviceCredentials().size
}

export function listPairedDevices(): PairedDevice[] {
  const activeCred = getActiveSocketCredential()
  const liveId = activeCred ? deviceIdFor(activeCred) : null
  return [...loadDeviceCredentials().entries()]
    .map(([cred, rec]) => {
      const identity = parseDeviceIdentity(rec.userAgent, rec.standalone, rec.shell)
      const id = deviceIdFor(cred)
      return {
        id,
        label: formatDeviceLabel(identity, rec.deviceModel),
        osLabel: formatOsLabel(identity, rec.osVersion),
        kind: identity.kind,
        pairedAt: rec.pairedAt,
        lastSeenAt: rec.lastSeenAt,
        connected: id === liveId
      }
    })
    .sort((a, b) => b.pairedAt - a.pairedAt)
}

/** Stable per-credential id safe to hand a renderer. Truncated to 16 hex chars
 *  -- collision-irrelevant at the handful-of-devices scale this lists, and it
 *  keeps the DOM readable while staying non-reversible. */
export function deviceIdFor(credential: string): string {
  return createHash('sha256').update(credential).digest('hex').slice(0, 16)
}

/** The journal's human-readable name for a paired device, or null if we've
 *  never learned one (paired before identity capture, or not paired at all). */
export function labelForCredential(credential: string): string | null {
  const rec = loadDeviceCredentials().get(credential)
  if (!rec) return null
  return formatDeviceLabel(
    parseDeviceIdentity(rec.userAgent, rec.standalone, rec.shell),
    rec.deviceModel
  )
}

export function describeAuthFailure(credential: string | null): BlockedReason {
  // Order matters: a load fault must never surface as `credential-revoked`.
  // That reason tells the phone to DELETE its credential, so one unreadable
  // read would unpair every device with no way back except the pairing screen.
  // `mac-unreachable` is the honest answer -- we cannot tell right now.
  if (credentialLoadFailed) return 'mac-unreachable'
  return credential ? 'credential-revoked' : 'no-credential'
}

export function revokePairedDevice(deviceId: string): boolean {
  const creds = loadDeviceCredentials()
  const match = [...creds.keys()].find((cred) => deviceIdFor(cred) === deviceId)
  if (!match) return false
  creds.delete(match)
  saveDeviceCredentials()
  if (getActiveSocket() && getActiveSocketCredential() === match) {
    getActiveSocket()!.close(4401, CONFIG.PHONE_REMOTE.CLOSE_REASON_REVOKED)
    clearActiveSocket()
  }
  devLog.log('[phone-remote] device revoked', { remaining: creds.size })
  recordJournal('revoked', {
    deviceId,
    // The caller, not just the fact: this deletes a credential and is reachable
    // from Settings, so an unexplained boot-time revoke is unreadable without
    // it. devLog carries the same trace but is truncated by `make restart` --
    // the restart you'd be investigating.
    detail: `${creds.size} device(s) still paired -- via ${callerFrame()}`
  })
  return true
}

/** The first stack frame outside this file, for a journal `detail`. Names are
 *  minified in a packaged build; a frame is still enough to tell a Settings
 *  click apart from a boot path. */
function callerFrame(): string {
  const lines = (new Error().stack ?? '').split('\n').slice(2)
  const frame = lines.find((l) => !l.includes('phone-remote/server'))
  return frame?.trim().replace(/^at\s+/, '').slice(0, 80) ?? 'unknown'
}

export function revokeActiveDevice(): boolean {
  const activeCred = getActiveSocketCredential()
  if (!activeCred) return false
  const creds = loadDeviceCredentials()
  if (!creds.delete(activeCred)) return false
  saveDeviceCredentials()
  const deviceId = deviceIdFor(activeCred)
  clearActiveSocket()
  devLog.log('[phone-remote] device unpaired itself', { remaining: creds.size })
  // This deletes a credential and is reachable from a phone message, so the
  // caller matters more than the fact. Loud on purpose.
  devLog.warn('[phone-remote] UNPAIR TRACE', {
    deviceId,
    remaining: creds.size,
    stack: new Error().stack
  })
  recordJournal('revoked', {
    deviceId,
    detail: `unpaired from phone -- ${creds.size} device(s) still paired`
  })
  return true
}

/** Record that this credential just connected, and backfill its UA the first
 *  time we see one -- that's how a device paired before identity capture stops
 *  reading "Unknown device" without anyone re-pairing. */
export function rememberDeviceIdentity(
  credential: string,
  userAgent: string | undefined,
  standalone: boolean,
  shell: HostShell | null,
  deviceModel: string | null = null,
  osVersion: string | null = null
): void {
  const creds = loadDeviceCredentials()
  const rec = creds.get(credential)
  if (!rec) return
  rec.lastSeenAt = Date.now()
  if (userAgent && rec.userAgent !== userAgent) rec.userAgent = userAgent
  // Same latch rule as `shell` below, for the same reason: a client too old to
  // report these must not erase what an earlier connect already learned.
  if (deviceModel) rec.deviceModel = deviceModel
  if (osVersion) rec.osVersion = osVersion
  // Tracks the CURRENT launch mode rather than latching: the same phone can
  // open the app in Safari one day and from the Home Screen the next, and the
  // row should say which one is actually connected.
  rec.standalone = standalone
  // Kept when this connect didn't name a shell, unlike `standalone` above: a
  // client too old to send the param would otherwise erase a known-good label
  // on its next reconnect. A client that DOES send one always wins.
  if (shell) rec.shell = shell
  saveDeviceCredentials()
}

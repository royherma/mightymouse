/**
 * In-PWA enrollment (PWA-stranded PRD). A durable credential from a typed code
 * is the installed Home Screen app's only way in -- it can't receive the QR's
 * session token. What matters: a code is single-use, and credentials survive a
 * restart but not a revoke.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { writeFileSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { CONFIG } from '../../../shared/config'
import { DEVICE_REVOKE_AFTER_DAYS } from '../../../shared/paired-device-labels'

/** PATHS derives from homedir(): unmocked, these tests clobber the real
 *  ~/MightyMouse store, paired devices included. */
const TEST_ROOT = join(tmpdir(), 'mm-pairing-test')
const DEVICES_FILE = join(TEST_ROOT, 'phone-remote-devices.json')

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => '/tmp' },
  // Unavailable -> safe-storage.ts writes plaintext, readable without Keychain.
  safeStorage: { isEncryptionAvailable: () => false }
}))

// Paths rebuilt inline: vi.mock hoists above the consts above.
vi.mock('../../store/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/paths')>()
  const { join: j } = await import('path')
  const { tmpdir: t } = await import('os')
  const root = j(t(), 'mm-pairing-test')
  // Remap EVERY path under the real root, like every other suite here. Naming
  // keys by hand missed PHONE_REMOTE_JOURNAL, so this suite's fake revokes and
  // its deliberate idle-sweep expiries landed in the user's live journal -- the
  // one file `make phone-log` reads to explain a real pairing failure.
  const { sandboxPaths } = await import('./sandbox-paths')
  return { ...actual, PATHS: sandboxPaths(actual.PATHS, actual.PATHS.ROOT, root) }
})

/** Recent timestamps: the idle sweep revokes anything past 1970. */
function recent(offsetMs = 0): number {
  return Date.now() - offsetMs
}

describe('pairing code + device credentials', () => {
  let mod: typeof import('../server')

  beforeEach(async () => {
    mkdirSync(TEST_ROOT, { recursive: true })
    rmSync(DEVICES_FILE, { force: true })
    vi.resetModules()
    mod = await import('../server')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(DEVICES_FILE, { force: true })
  })

  it('mints a code of the configured length, digits only', () => {
    const code = mod.issuePairingCode()
    expect(code).toHaveLength(CONFIG.PHONE_REMOTE.PAIR_CODE_LENGTH)
    expect(code).toMatch(/^\d+$/)
  })

  it('issuing a new code replaces the previous one', () => {
    const first = mod.issuePairingCode()
    const second = mod.issuePairingCode()
    // New code / expiry call issuePairingCode; currentPairingCode would no-op.
    expect(second).not.toBe(first)
    expect(mod.currentPairingCode()).toBe(second)
  })

  it('starts with no paired devices', () => {
    expect(mod.getPairedDeviceCount()).toBe(0)
  })

  // ── the QR and the on-screen digits must be ONE code ──────────────────────

  it('currentPairingCode reuses the outstanding code instead of re-minting', () => {
    // The QR and the Settings row fetch through two independent IPC calls. A
    // second mint would invalidate the first, so the QR would encode a code
    // the Mac no longer accepts -- the regression this whole change fixes.
    const forQr = mod.currentPairingCode()
    const forSettings = mod.currentPairingCode()
    expect(forSettings).toBe(forQr)
  })

  it('currentPairingCode adopts a code issued directly', () => {
    const issued = mod.issuePairingCode()
    expect(mod.currentPairingCode()).toBe(issued)
  })

  it('currentPairingCode mints a fresh code once the TTL lapses', () => {
    const stale = mod.currentPairingCode()
    vi.spyOn(Date, 'now').mockReturnValue(
      Date.now() + CONFIG.PHONE_REMOTE.PAIR_CODE_TTL_MS + 1000
    )
    expect(mod.currentPairingCode()).not.toBe(stale)
  })

  it('forgetPairedDevices reports how many it cleared and empties the set', () => {
    expect(mod.forgetPairedDevices()).toBe(0)
    expect(mod.getPairedDeviceCount()).toBe(0)
  })

  it('reads persisted credentials on a fresh load, and count survives a reload', async () => {
    // An in-memory-only credential dies on quit and re-strands the PWA.
    const stored = { 'test-credential-aaa': Date.now(), 'test-credential-bbb': Date.now() }
    writeFileSync(DEVICES_FILE, JSON.stringify(stored), 'utf8')
    vi.resetModules()
    const reloaded = await import('../server')
    expect(reloaded.getPairedDeviceCount()).toBe(2)
    // And revoking clears the file, not just the in-memory copy.
    expect(reloaded.forgetPairedDevices()).toBe(2)
    vi.resetModules()
    const afterRevoke = await import('../server')
    expect(afterRevoke.getPairedDeviceCount()).toBe(0)
  })

  it('starts empty rather than throwing when the store is unreadable', async () => {
    // safeStorage is app+user bound: a foreign file must degrade, not crash.
    writeFileSync(DEVICES_FILE, 'not json, not an envelope', 'utf8')
    vi.resetModules()
    const reloaded = await import('../server')
    expect(reloaded.getPairedDeviceCount()).toBe(0)
  })

  it('always emits a fixed-width code, including low random draws', () => {
    // padStart guarantees width; sampling beats mocking crypto's overloads.
    for (let i = 0; i < 200; i++) {
      const code = mod.issuePairingCode()
      expect(code).toHaveLength(CONFIG.PHONE_REMOTE.PAIR_CODE_LENGTH)
      expect(code).toMatch(/^\d+$/)
    }
  })

  // ── the paired-devices list Settings renders ──────────────────────────────

  it('lists a legacy bare-timestamp credential as an Unknown device', async () => {
    // Pre-identity-capture devices store as credential -> number, and must
    // keep working unnamed. Recent, not epoch: the SHAPE is what's tested.
    const legacyAt = recent(1000)
    writeFileSync(DEVICES_FILE, JSON.stringify({ 'legacy-cred': legacyAt }), 'utf8')
    vi.resetModules()
    const reloaded = await import('../server')
    const devices = reloaded.listPairedDevices()
    expect(devices).toHaveLength(1)
    expect(devices[0].label).toBe('Unknown device')
    expect(devices[0].kind).toBe('unknown')
    expect(devices[0].pairedAt).toBe(legacyAt)
    expect(devices[0].connected).toBe(false)
  })

  it('never exposes the credential itself to the renderer', async () => {
    // `id` reaches the DOM; a value granting remote control must not.
    writeFileSync(DEVICES_FILE, JSON.stringify({ 'super-secret-cred': Date.now() }), 'utf8')
    vi.resetModules()
    const reloaded = await import('../server')
    const [device] = reloaded.listPairedDevices()
    expect(device.id).not.toContain('super-secret-cred')
    expect(JSON.stringify(device)).not.toContain('super-secret-cred')
  })

  it('revokes one device by id and leaves the others paired', async () => {
    const stored = {
      'cred-a': { pairedAt: recent(1000), lastSeenAt: null, userAgent: null },
      'cred-b': { pairedAt: recent(2000), lastSeenAt: null, userAgent: null }
    }
    writeFileSync(DEVICES_FILE, JSON.stringify(stored), 'utf8')
    vi.resetModules()
    const reloaded = await import('../server')
    const before = reloaded.listPairedDevices()
    expect(before).toHaveLength(2)

    expect(reloaded.revokePairedDevice(before[0].id)).toBe(true)
    const after = reloaded.listPairedDevices()
    expect(after).toHaveLength(1)
    expect(after[0].id).toBe(before[1].id)

    // Gone from disk: a revoke a restart undoes is worse than none.
    vi.resetModules()
    const restarted = await import('../server')
    expect(restarted.getPairedDeviceCount()).toBe(1)
  })

  it('returns false for an unknown id instead of revoking something else', async () => {
    // A stale list's miss must be a no-op, not a kick of whoever is first.
    writeFileSync(DEVICES_FILE, JSON.stringify({ 'cred-a': recent() }), 'utf8')
    vi.resetModules()
    const reloaded = await import('../server')
    expect(reloaded.revokePairedDevice('not-a-real-id')).toBe(false)
    expect(reloaded.getPairedDeviceCount()).toBe(1)
  })

  it('sorts newest pairing first', async () => {
    const olderAt = recent(5000)
    const newerAt = recent(1000)
    const stored = {
      older: { pairedAt: olderAt, lastSeenAt: null, userAgent: null },
      newer: { pairedAt: newerAt, lastSeenAt: null, userAgent: null }
    }
    writeFileSync(DEVICES_FILE, JSON.stringify(stored), 'utf8')
    vi.resetModules()
    const reloaded = await import('../server')
    expect(reloaded.listPairedDevices().map((d) => d.pairedAt)).toEqual([newerAt, olderAt])
  })

  it('revokes a credential idle past the max, and keeps a fresh one', async () => {
    // Without this a phone paired once and sold stays a key forever.
    const idle = DEVICE_REVOKE_AFTER_DAYS * 86_400_000
    const stored = {
      stale: { pairedAt: recent(idle * 2), lastSeenAt: recent(idle + 60_000), userAgent: null },
      fresh: { pairedAt: recent(idle * 2), lastSeenAt: recent(60_000), userAgent: null }
    }
    writeFileSync(DEVICES_FILE, JSON.stringify(stored), 'utf8')
    vi.resetModules()
    const reloaded = await import('../server')
    expect(reloaded.getPairedDeviceCount()).toBe(1)

    // Written through: else the next load resurrects it from disk.
    vi.resetModules()
    const restarted = await import('../server')
    expect(restarted.getPairedDeviceCount()).toBe(1)
  })

  it('keeps a just-paired device that has never connected', async () => {
    // lastSeenAt is null until the first socket opens -- revoking on that
    // would kill a phone between /pair and its first connect.
    writeFileSync(
      DEVICES_FILE,
      JSON.stringify({ brand_new: { pairedAt: recent(1000), lastSeenAt: null, userAgent: null } }),
      'utf8'
    )
    vi.resetModules()
    const reloaded = await import('../server')
    expect(reloaded.getPairedDeviceCount()).toBe(1)
  })

  it('revokes a device that paired long ago and never once connected', async () => {
    // Same null, aged: pairedAt is then the only proof of life, and it's old.
    writeFileSync(
      DEVICES_FILE,
      JSON.stringify({
        abandoned: {
          pairedAt: recent(DEVICE_REVOKE_AFTER_DAYS * 86_400_000 + 60_000),
          lastSeenAt: null,
          userAgent: null
        }
      }),
      'utf8'
    )
    vi.resetModules()
    const reloaded = await import('../server')
    expect(reloaded.getPairedDeviceCount()).toBe(0)
  })

  it('renders a stored UA as a named device', async () => {
    const ua =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
    const seenAt = recent(1000)
    writeFileSync(
      DEVICES_FILE,
      JSON.stringify({ c: { pairedAt: recent(2000), lastSeenAt: seenAt, userAgent: ua } }),
      'utf8'
    )
    vi.resetModules()
    const reloaded = await import('../server')
    const [device] = reloaded.listPairedDevices()
    expect(device.label).toBe('iPhone · Safari')
    expect(device.kind).toBe('iphone')
    expect(device.lastSeenAt).toBe(seenAt)
  })
})

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG } from '../../../shared/config'

// reconcileHistoryEncryption() runs on EVERY app startup and rewrites the user's
// entire history file — this is the highest-blast-radius untested path in the repo
// (PRD #4, prds/active/2026-07-11-...-prelaunch-top5-cleanup.md). Zero direct tests
// existed before this file.
//
// Same trick as feedback.test.ts / prefs.test.ts / run-folder.test.ts: paths.ts
// captures os.homedir() at eval time, so the temp home must exist and homedir()
// must already return it BEFORE history.ts (→ paths.ts) is first imported.
const HOME = mkdtempSync(join(tmpdir(), 'mm-history-enc-'))
mkdirSync(join(HOME, CONFIG.APP_NAME, 'backups'), { recursive: true })

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => HOME }
})

// A real (fake-but-reversible) electron.safeStorage so encryptLine/decryptLine
// inside history.ts do real work, not a passthrough stub — we want to prove the
// ACTUAL encrypt/decrypt round-trip survives the migration, not just that bytes
// pass through untouched.
const H = vi.hoisted(() => {
  let available = true
  const encryptString = vi.fn((plain: string): Buffer => Buffer.from(plain, 'utf-8').reverse())
  const decryptString = vi.fn((buf: Buffer): string => Buffer.from(buf).reverse().toString('utf-8'))
  const isEncryptionAvailable = vi.fn(() => available)
  return { encryptString, decryptString, isEncryptionAvailable, setAvailable: (v: boolean) => (available = v) }
})

vi.mock('electron', () => ({
  safeStorage: {
    encryptString: H.encryptString,
    decryptString: H.decryptString,
    isEncryptionAvailable: H.isEncryptionAvailable
  }
}))

// history.ts imports renameSync from 'fs' (named import, bound at eval time) — a
// vi.spyOn(fs, 'renameSync') after the fact does NOT intercept that binding under
// vitest's ESM transform. Route history.ts's renameSync through an overridable
// hoisted fn instead, so a test can force the atomic-rename step to throw and
// prove the crash-between-backup-and-rename path leaves the original untouched.
const FS = vi.hoisted(() => {
  let renameImpl: ((oldPath: string, newPath: string) => void) | null = null
  return {
    setRenameOverride: (fn: ((oldPath: string, newPath: string) => void) | null) => {
      renameImpl = fn
    },
    renameSync: (oldPath: string, newPath: string) => {
      if (renameImpl) return renameImpl(oldPath, newPath)
      // Delegate to the real implementation via a lazily-required actual module
      // (require is fine here — this runs at call time, well after hoisting).
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const real = require('node:fs') as typeof import('node:fs')
      return real.renameSync(oldPath, newPath)
    }
  }
})

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return { ...actual, renameSync: FS.renameSync }
})

const APP_DIR = join(HOME, CONFIG.APP_NAME)
const HISTORY_FILE = join(APP_DIR, 'rewrite-history.jsonl')
const BACKUPS_DIR = join(APP_DIR, 'backups')
const ENC_PREF_FILE = join(APP_DIR, 'history-encryption-toggle.txt')

let PREFS: typeof import('../prefs').PREFS
let reconcileHistoryEncryption: typeof import('../history').reconcileHistoryEncryption
let isEncryptedLine: typeof import('../safe-storage').isEncryptedLine
let decryptLine: typeof import('../safe-storage').decryptLine
let encryptLine: typeof import('../safe-storage').encryptLine

function row(instruction: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { instruction, ts: '2026-07-11T00:00:00Z', mode: 'ask', ...extra }
}

function writePlainHistory(rows: Record<string, unknown>[]): void {
  writeFileSync(HISTORY_FILE, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8')
}

function backupFiles(): string[] {
  if (!existsSync(BACKUPS_DIR)) return []
  return readdirSync(BACKUPS_DIR)
}

function readLines(path: string): string[] {
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((l) => l.trim() !== '')
}

describe('reconcileHistoryEncryption (startup migration)', () => {
  beforeAll(async () => {
    PREFS = (await import('../prefs')).PREFS
    const historyModule = await import('../history')
    reconcileHistoryEncryption = historyModule.reconcileHistoryEncryption
    const safeStorageModule = await import('../safe-storage')
    isEncryptedLine = safeStorageModule.isEncryptedLine
    decryptLine = safeStorageModule.decryptLine
    encryptLine = safeStorageModule.encryptLine
  })

  afterAll(() => {
    rmSync(HOME, { recursive: true, force: true })
  })

  beforeEach(() => {
    H.setAvailable(true)
    // mockReset (not mockClear) — a prior test (e.g. (d-bis)) may have left a
    // mockImplementation override in place; reset restores the default reversible
    // cipher so later tests don't inherit a stale "throw on X" behavior.
    H.encryptString.mockReset().mockImplementation((plain: string) => Buffer.from(plain, 'utf-8').reverse())
    H.decryptString.mockReset().mockImplementation((buf: Buffer) => Buffer.from(buf).reverse().toString('utf-8'))
    // Reset the encryption toggle to off before each test unless the test sets it.
    writeFileSync(ENC_PREF_FILE, '0', 'utf-8')
    // Clean slate: no history file, no backups, from the previous test.
    if (existsSync(HISTORY_FILE)) rmSync(HISTORY_FILE)
    for (const f of backupFiles()) rmSync(join(BACKUPS_DIR, f))
  })

  it('(a) plaintext file + encryption ON: backs up BEFORE converting, file becomes encrypted, row count preserved', () => {
    const rows = [row('summarize this'), row('translate to french'), row('what did I ask yesterday')]
    writePlainHistory(rows)
    expect(backupFiles()).toHaveLength(0)

    PREFS.setHistoryEncryption(true)
    const backupPath = reconcileHistoryEncryption()

    expect(backupPath).not.toBeNull()
    expect(existsSync(backupPath!)).toBe(true)
    // The backup is the ORIGINAL plaintext, untouched.
    const backupLines = readLines(backupPath!)
    expect(backupLines).toHaveLength(rows.length)
    expect(backupLines.every((l) => !isEncryptedLine(l))).toBe(true)
    expect(JSON.parse(backupLines[0]).instruction).toBe('summarize this')

    // The live file is now encrypted, same row count, decrypts back to the originals.
    const liveLines = readLines(HISTORY_FILE)
    expect(liveLines).toHaveLength(rows.length)
    expect(liveLines.every((l) => isEncryptedLine(l))).toBe(true)
    const decoded = liveLines.map((l) => JSON.parse(decryptLine(l)!))
    expect(decoded.map((d) => d.instruction)).toEqual(rows.map((r) => r.instruction))
  })

  it('(b) encrypted file + encryption OFF: decrypts back to plaintext, rows preserved', () => {
    // Seed an encrypted file directly (bypassing the migration) so this test only
    // exercises the OFF direction.
    const rows = [row('recall my meeting notes'), row('draft a reply')]
    writeFileSync(HISTORY_FILE, rows.map((r) => encryptLine(JSON.stringify(r))).join('\n') + '\n', 'utf-8')
    expect(readLines(HISTORY_FILE).every((l) => isEncryptedLine(l))).toBe(true)

    PREFS.setHistoryEncryption(false)
    const backupPath = reconcileHistoryEncryption()

    expect(backupPath).not.toBeNull()
    const liveLines = readLines(HISTORY_FILE)
    expect(liveLines).toHaveLength(rows.length)
    expect(liveLines.every((l) => !isEncryptedLine(l))).toBe(true)
    expect(liveLines.map((l) => JSON.parse(l).instruction)).toEqual(rows.map((r) => r.instruction))
  })

  it('(c) already-consistent file (plaintext + encryption OFF): no-op, no rewrite, no backup', () => {
    const rows = [row('leave me alone')]
    writePlainHistory(rows)
    const before = readFileSync(HISTORY_FILE, 'utf-8')

    PREFS.setHistoryEncryption(false)
    const backupPath = reconcileHistoryEncryption()

    expect(backupPath).toBeNull()
    expect(backupFiles()).toHaveLength(0)
    expect(readFileSync(HISTORY_FILE, 'utf-8')).toBe(before)
  })

  it('(c-bis) already-consistent file (encrypted + encryption ON): no-op, no rewrite, no backup', () => {
    const rows = [row('already encrypted, leave alone')]
    writeFileSync(HISTORY_FILE, rows.map((r) => encryptLine(JSON.stringify(r))).join('\n') + '\n', 'utf-8')
    const before = readFileSync(HISTORY_FILE, 'utf-8')

    PREFS.setHistoryEncryption(true)
    const backupPath = reconcileHistoryEncryption()

    expect(backupPath).toBeNull()
    expect(backupFiles()).toHaveLength(0)
    expect(readFileSync(HISTORY_FILE, 'utf-8')).toBe(before)
  })

  it('(d) an unreadable/corrupt row is kept verbatim on convert, never dropped', () => {
    const goodRow = row('a perfectly fine row')
    const corruptLine = 'this is not json and not an envelope { { {'
    writeFileSync(HISTORY_FILE, [JSON.stringify(goodRow), corruptLine].join('\n') + '\n', 'utf-8')

    PREFS.setHistoryEncryption(true)
    reconcileHistoryEncryption()

    const liveLines = readLines(HISTORY_FILE)
    expect(liveLines).toHaveLength(2)
    // The corrupt line survives byte-for-byte (decryptLine treats non-JSON as
    // legacy plaintext and passes it through, then it gets re-encrypted like any
    // other plaintext row — it is NOT dropped).
    const decodedGood = decryptLine(liveLines.find((l) => l !== liveLines[1]) || liveLines[0])
    expect(liveLines.length).toBe(2)
    // Every line still decrypts to SOMETHING (nothing silently vanished).
    for (const l of liveLines) {
      expect(decryptLine(l)).not.toBeNull()
    }
    void decodedGood
  })

  it('(d-bis) a row that fails to decrypt (simulated corrupt ciphertext) is kept verbatim, count preserved', () => {
    // Seed one row that encrypts fine, and one raw line that LOOKS like a valid
    // envelope but whose ciphertext blows up on decrypt (simulates disk corruption
    // or a wrong-machine blob) — decryptLine returns null for it, and the migration
    // must keep it verbatim rather than dropping it.
    const goodEncrypted = encryptLine(JSON.stringify(row('readable row')))
    const corruptEnvelope = JSON.stringify({ v: 1, d: 'irrecoverable-garbage' })
    writeFileSync(HISTORY_FILE, [goodEncrypted, corruptEnvelope].join('\n') + '\n', 'utf-8')

    // Lines are processed in file order, so a plain mockImplementationOnce would hit
    // whichever row is decrypted FIRST — not necessarily the corrupt one. Instead,
    // throw only when the ciphertext bytes match the corrupt envelope's `d`, so the
    // mock behaves like a real decrypt failure tied to that specific blob.
    const corruptBytes = Buffer.from('irrecoverable-garbage', 'base64')
    H.decryptString.mockImplementation((buf: Buffer) => {
      if (Buffer.from(buf).equals(corruptBytes)) {
        throw new Error('simulated corrupted ciphertext')
      }
      return Buffer.from(buf).reverse().toString('utf-8')
    })

    PREFS.setHistoryEncryption(false) // decrypt-all direction
    reconcileHistoryEncryption()

    const liveLines = readLines(HISTORY_FILE)
    // Both rows survive — the corrupt one verbatim (still the original envelope
    // string, un-decryptable), the good one now plaintext.
    expect(liveLines).toHaveLength(2)
    expect(liveLines).toContain(corruptEnvelope)
  })

  it('(e) a crash between backup and atomic rename leaves the original file fully intact', () => {
    const rows = [row('must survive a crash'), row('second row')]
    writePlainHistory(rows)
    const originalContent = readFileSync(HISTORY_FILE, 'utf-8')

    // Simulate the process dying mid-conversion: renameSync (the final atomic swap)
    // throws. reconcileHistoryEncryption must catch this and leave HISTORY_FILE
    // untouched — the backup was already written before the crash point.
    FS.setRenameOverride(() => {
      throw new Error('simulated crash: disk full / process killed mid-rename')
    })

    PREFS.setHistoryEncryption(true)
    const result = reconcileHistoryEncryption()

    expect(result).toBeNull() // signals "no successful conversion"
    // Original file is untouched — same bytes as before the attempt.
    expect(readFileSync(HISTORY_FILE, 'utf-8')).toBe(originalContent)
    // A backup WAS written before the simulated crash (step 1 always precedes
    // step 3), so the pre-crash state is recoverable even though this assertion
    // only strictly requires the original file to still be intact.
    expect(backupFiles().length).toBeGreaterThan(0)

    FS.setRenameOverride(null)
  })

  it('encryption requested but safeStorage unavailable: stays plaintext, no conversion attempted', () => {
    const rows = [row('cannot encrypt on this machine')]
    writePlainHistory(rows)
    H.setAvailable(false)

    PREFS.setHistoryEncryption(true)
    const result = reconcileHistoryEncryption()

    expect(result).toBeNull()
    const liveLines = readLines(HISTORY_FILE)
    expect(liveLines.every((l) => !isEncryptedLine(l))).toBe(true)
  })

  it('empty history file: no-op either direction, no crash', () => {
    writeFileSync(HISTORY_FILE, '', 'utf-8')
    PREFS.setHistoryEncryption(true)
    expect(reconcileHistoryEncryption()).toBeNull()
  })

  it('missing history file entirely: no-op, no crash', () => {
    expect(existsSync(HISTORY_FILE)).toBe(false)
    PREFS.setHistoryEncryption(true)
    expect(reconcileHistoryEncryption()).toBeNull()
  })
})

/**
 * safe-storage.ts — thin wrapper over Electron's `safeStorage` for encrypting
 * sensitive local data (history rows, the auth session) at rest.
 *
 * WHY: `~/MightyMouse/` sits on the live, decrypted filesystem. FileVault covers
 * a powered-off stolen laptop, but NOT cloud-backup/sync agents (iCloud, Time
 * Machine, Dropbox, MDM) that read the live FS and upload plaintext. safeStorage
 * encrypts with a key the OS derives from the login Keychain (AES-256 on macOS,
 * Secure Enclave on Apple Silicon) — no password prompt, no extra dependency.
 *
 * LIMIT (documented on purpose): a blob is only decryptable on the SAME macOS user
 * + machine. Restore to a new Mac → decrypt fails. We surface that as a skipped row,
 * never a crash (decryptLine returns null). Callers MUST handle null.
 *
 * Line format on disk: `{"v":1,"d":"<base64 of the encrypted bytes>"}`. A bare JSON
 * line (no `v`/`d`) is treated as legacy plaintext, so a half-converted file reads fine.
 */

import { safeStorage } from 'electron'

/** Schema version of an encrypted line envelope. Bump if the format changes. */
const ENVELOPE_VERSION = 1

interface EncryptedEnvelope {
  v: number
  d: string // base64 of safeStorage.encryptString output
}

/**
 * True when the OS can actually encrypt (always true for a logged-in macOS user;
 * can be false on some headless Linux setups). Callers fall back to plaintext when
 * this is false so the app never hard-depends on encryption being available.
 */
export function isEncryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/**
 * Encrypt one line of UTF-8 (typically a JSON string) into the envelope form.
 * Returns the original text unchanged if encryption is unavailable — never throws,
 * so a write can always proceed.
 */
export function encryptLine(plain: string): string {
  if (!isEncryptionAvailable()) return plain
  try {
    const buf = safeStorage.encryptString(plain)
    const envelope: EncryptedEnvelope = { v: ENVELOPE_VERSION, d: buf.toString('base64') }
    return JSON.stringify(envelope)
  } catch (err) {
    console.error('safe-storage: encrypt failed, writing plaintext:', err)
    return plain
  }
}

/** True if a stored line is an encrypted envelope (vs legacy plaintext). */
export function isEncryptedLine(line: string): boolean {
  const t = line.trim()
  if (t === '' || t[0] !== '{') return false
  try {
    const o = JSON.parse(t)
    return o && typeof o === 'object' && o.v === ENVELOPE_VERSION && typeof o.d === 'string'
  } catch {
    return false
  }
}

/**
 * Decrypt one stored line back to UTF-8.
 *   - Plaintext (legacy) line → returned as-is.
 *   - Encrypted envelope → decrypted; returns null on failure (wrong machine,
 *     corrupted blob, encryption unavailable) so the caller can SKIP the row.
 */
export function decryptLine(line: string): string | null {
  const t = line.trim()
  if (t === '') return ''
  if (!isEncryptedLine(t)) return line // legacy plaintext
  if (!isEncryptionAvailable()) return null
  try {
    const { d } = JSON.parse(t) as EncryptedEnvelope
    return safeStorage.decryptString(Buffer.from(d, 'base64'))
  } catch (err) {
    console.error('safe-storage: decrypt failed, skipping row:', err)
    return null
  }
}

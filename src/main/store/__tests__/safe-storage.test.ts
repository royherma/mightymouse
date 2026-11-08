import { describe, it, expect, vi, beforeEach } from 'vitest'

// Electron's real safeStorage isn't available under vitest (no OS Keychain), so we
// stub it with a small reversible cipher (byte-reverse) that behaves like the real
// thing for our purposes: encryptString/decryptString round-trip, and
// isEncryptionAvailable is a plain toggle so tests can flip it per-case.
const H = vi.hoisted(() => {
  let available = true
  const encryptString = vi.fn((plain: string): Buffer => {
    // Reverse the bytes so ciphertext != plaintext (a real encrypt would also
    // change the bytes) but the transform is trivially invertible.
    return Buffer.from(plain, 'utf-8').reverse()
  })
  const decryptString = vi.fn((buf: Buffer): string => {
    return Buffer.from(buf).reverse().toString('utf-8')
  })
  const isEncryptionAvailable = vi.fn(() => available)
  return {
    encryptString,
    decryptString,
    isEncryptionAvailable,
    getAvailable: () => available,
    setAvailable: (v: boolean) => {
      available = v
    }
  }
})

vi.mock('electron', () => ({
  safeStorage: {
    encryptString: H.encryptString,
    decryptString: H.decryptString,
    isEncryptionAvailable: H.isEncryptionAvailable
  }
}))

import { encryptLine, decryptLine, isEncryptedLine, isEncryptionAvailable } from '../safe-storage'

describe('safe-storage', () => {
  beforeEach(() => {
    H.setAvailable(true)
    // mockReset (not mockClear) — a prior test may have left a mockImplementation
    // override (e.g. "always throw") in place; reset restores the default impl.
    H.encryptString.mockReset().mockImplementation((plain: string) => Buffer.from(plain, 'utf-8').reverse())
    H.decryptString.mockReset().mockImplementation((buf: Buffer) => Buffer.from(buf).reverse().toString('utf-8'))
    H.isEncryptionAvailable.mockReset().mockImplementation(() => H.getAvailable())
  })

  it('round-trips: encryptLine produces a {"v":1,"d":"<b64>"} envelope, decryptLine returns the original', () => {
    const plain = JSON.stringify({ instruction: 'summarize this', ts: '2026-07-11T00:00:00Z' })
    const line = encryptLine(plain)

    const parsed = JSON.parse(line)
    expect(parsed.v).toBe(1)
    expect(typeof parsed.d).toBe('string')
    // The envelope's d is valid base64 of SOME bytes (not asserting they equal
    // plaintext — that's the whole point of encrypting).
    expect(() => Buffer.from(parsed.d, 'base64')).not.toThrow()

    expect(decryptLine(line)).toBe(plain)
  })

  it('isEncryptedLine recognizes an envelope and rejects legacy plaintext / junk', () => {
    const line = encryptLine('hello world')
    expect(isEncryptedLine(line)).toBe(true)

    expect(isEncryptedLine('plain old text')).toBe(false)
    expect(isEncryptedLine('{"instruction":"not an envelope"}')).toBe(false)
    expect(isEncryptedLine('')).toBe(false)
    expect(isEncryptedLine('{not even valid json')).toBe(false)
  })

  it('legacy plaintext line passes through decryptLine unchanged', () => {
    const legacy = JSON.stringify({ instruction: 'a pre-encryption row', ts: '2026-01-01T00:00:00Z' })
    expect(decryptLine(legacy)).toBe(legacy)
  })

  it('a corrupt/garbage envelope returns null from decryptLine instead of throwing', () => {
    // Well-formed envelope shape, but the underlying decrypt call fails (simulates
    // a corrupted blob or wrong-machine key).
    H.decryptString.mockImplementation(() => {
      throw new Error('simulated: bad/corrupted ciphertext')
    })
    const garbage = JSON.stringify({ v: 1, d: 'not-real-ciphertext' })
    expect(() => decryptLine(garbage)).not.toThrow()
    expect(decryptLine(garbage)).toBeNull()
  })

  it('a garbage envelope with unparseable base64 in `d` also returns null, never throws', () => {
    // Force decryptString itself to blow up (simulating Buffer.from/decrypt failure).
    H.decryptString.mockImplementation(() => {
      throw new Error('bad base64 / wrong machine key')
    })
    const line = JSON.stringify({ v: 1, d: '###not-base64-shaped###' })
    expect(() => decryptLine(line)).not.toThrow()
    expect(decryptLine(line)).toBeNull()
  })

  it('encryptLine never throws even if the underlying encrypt fails — falls back to plaintext', () => {
    H.encryptString.mockImplementation(() => {
      throw new Error('keychain unavailable mid-call')
    })
    const plain = 'fallback me'
    expect(() => encryptLine(plain)).not.toThrow()
    expect(encryptLine(plain)).toBe(plain)
  })

  it('empty line decrypts to empty string', () => {
    expect(decryptLine('')).toBe('')
    expect(decryptLine('   ')).toBe('')
  })

  describe('when safeStorage.isEncryptionAvailable() is false (documented fallback path)', () => {
    beforeEach(() => {
      H.setAvailable(false)
    })

    it('isEncryptionAvailable() reflects the OS-level flag', () => {
      expect(isEncryptionAvailable()).toBe(false)
    })

    it('encryptLine returns the plaintext unchanged (never produces an envelope)', () => {
      const plain = 'no keychain here'
      expect(encryptLine(plain)).toBe(plain)
      expect(H.encryptString).not.toHaveBeenCalled()
    })

    it('decryptLine on an (already-encrypted) envelope returns null, per module doc, since it cannot decrypt without the OS facility', () => {
      // Build an envelope while encryption WAS available, then flip availability off
      // before decrypting — simulates restoring an encrypted file to a machine/user
      // where safeStorage isn't available.
      H.setAvailable(true)
      const line = encryptLine('secret row')
      H.setAvailable(false)
      expect(decryptLine(line)).toBeNull()
    })

    it('decryptLine still passes legacy plaintext through unchanged even when unavailable', () => {
      const legacy = 'plain row, no envelope'
      expect(decryptLine(legacy)).toBe(legacy)
    })
  })

  it('isEncryptionAvailable swallows a throw from the underlying check and returns false', () => {
    H.isEncryptionAvailable.mockImplementation(() => {
      throw new Error('unexpected native failure')
    })
    expect(() => isEncryptionAvailable()).not.toThrow()
    expect(isEncryptionAvailable()).toBe(false)
  })
})

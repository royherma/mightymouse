import { beforeEach, describe, expect, it } from 'vitest'
import { credentialStore, retireTombstones } from './credential-store'

const values = new Map<string, string>()

beforeEach(() => {
  values.clear()
  globalThis.localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
    key: () => null,
    length: 0
  } as Storage
})

describe('credentialStore', () => {
  it('round-trips values and removes them', () => {
    credentialStore.set('pairing', 'secret')
    expect(credentialStore.get('pairing')).toBe('secret')
    credentialStore.remove('pairing')
    expect(credentialStore.get('pairing')).toBeNull()
  })

  it('treats removing an absent value as a no-op', () => {
    expect(() => credentialStore.remove('missing')).not.toThrow()
    expect(credentialStore.get('missing')).toBeNull()
  })

  it('falls back to memory when browser storage throws', () => {
    globalThis.localStorage = {
      getItem: () => {
        throw new Error('private mode')
      },
      setItem: () => {
        throw new Error('private mode')
      },
      removeItem: () => {
        throw new Error('private mode')
      },
      clear: () => undefined,
      key: () => null,
      length: 0
    } as Storage

    credentialStore.set('pairing', 'session-only')
    expect(credentialStore.get('pairing')).toBe('session-only')
    credentialStore.remove('pairing')
    expect(credentialStore.get('pairing')).toBeNull()
  })
})

// The native path is where the bootstrap snapshot exists, so the browser-only
// cases above cannot see the resurrection bug at all.
describe('credentialStore inside the native shell', () => {
  const posted: Array<{ t: string; key?: string }> = []

  beforeEach(() => {
    posted.length = 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const target = globalThis as any
    target.window = target
    target.webkit = {
      messageHandlers: {
        mightymouse: { postMessage: (message: { t: string; key?: string }) => posted.push(message) }
      }
    }
    target.__MM_NATIVE_BOOTSTRAP__ = { credentials: { 'mm-remote-device-credential': 'from-keychain' } }
  })

  it('hydrates a cold launch from the Keychain bootstrap', () => {
    expect(credentialStore.get('mm-remote-device-credential')).toBe('from-keychain')
  })

  it('does NOT resurrect a revoked credential from the frozen bootstrap', () => {
    expect(credentialStore.get('mm-remote-device-credential')).toBe('from-keychain')
    // What clearDeviceCredential() does when the server rejects the device.
    credentialStore.remove('mm-remote-device-credential')
    expect(posted.at(-1)).toMatchObject({ t: 'removeCredential' })
    // The bootstrap object still holds the old value -- a cache miss must not
    // read through to it, or the phone retries a credential that can never work.
    expect(credentialStore.get('mm-remote-device-credential')).toBeNull()
  })

  it('a later re-pair clears the tombstone', () => {
    credentialStore.remove('mm-remote-device-credential')
    credentialStore.set('mm-remote-device-credential', 'freshly-paired')
    expect(credentialStore.get('mm-remote-device-credential')).toBe('freshly-paired')
  })

  // The user scanned three times on 2026-08-17 because of this: a transient refusal
  // tombstoned the key, and with no retirement event the Keychain copy stayed
  // unreadable for the rest of the launch. A QR scan was the only way back.
  it('a reached Mac retires the tombstone and the Keychain reads again', () => {
    credentialStore.remove('mm-remote-device-credential')
    expect(credentialStore.get('mm-remote-device-credential')).toBeNull()
    // What ws.onopen does: a socket that opened proves the refusal was transient.
    retireTombstones()
    expect(credentialStore.get('mm-remote-device-credential')).toBe('from-keychain')
  })

  it('retiring tombstones does not resurrect a key cleared afterwards', () => {
    retireTombstones()
    credentialStore.remove('mm-remote-device-credential')
    // The revoke came AFTER the retire, so it still stands -- retiring must not
    // be a blanket permission to read through forever.
    expect(credentialStore.get('mm-remote-device-credential')).toBeNull()
  })

  // A healthy native launch must still reach the Keychain. The write-through to
  // localStorage is additive, never a replacement -- if this stops posting, the
  // credential silently stops surviving a reinstall.
  it('still posts to the bridge when the handler is attached', () => {
    credentialStore.set('mm-remote-device-credential', 'freshly-paired')
    expect(posted.at(-1)).toMatchObject({ t: 'storeCredential', key: 'mm-remote-device-credential' })
  })
})

// The launch that caused the 2026-08-23 pairing-form bug: the shell injected its
// bootstrap but `webkit.messageHandlers.mightymouse` never attached, so every
// `postMessage` is a silent no-op. `get()` was taught to survive this; these lock
// that a WRITE survives it too, which is what returning early used to prevent.
describe('credentialStore in a native shell with NO message handler', () => {
  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const target = globalThis as any
    target.window = target
    target.webkit = undefined
    target.__MM_NATIVE_BOOTSTRAP__ = { credentials: {} }
    retireTombstones()
  })

  it('a credential paired in this window is not thrown away', () => {
    credentialStore.set('mm-remote-device-credential', 'paired-without-handler')
    // Neither the bridge (no handler) nor the bootstrap (frozen, empty) can hold
    // it, so localStorage is the only surviving copy -- and it must have one.
    expect(values.get('mm-remote-device-credential')).toBe('paired-without-handler')
    expect(credentialStore.get('mm-remote-device-credential')).toBe('paired-without-handler')
  })

  it('a revoke in this window still clears the stored copy', () => {
    credentialStore.set('mm-remote-device-credential', 'doomed')
    credentialStore.remove('mm-remote-device-credential')
    // The early return used to leave the localStorage copy behind, so a revoked
    // credential kept being retried from a vault nobody cleared.
    expect(values.has('mm-remote-device-credential')).toBe(false)
    expect(credentialStore.get('mm-remote-device-credential')).toBeNull()
  })
})

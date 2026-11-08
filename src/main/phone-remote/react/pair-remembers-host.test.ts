/**
 * A successful pair must persist the host it paired against.
 *
 * Discovery's tunnel rung fills only from a /whoami hit, which a native-shell
 * pair never makes. So a tunnel-scanned phone stored nothing, every rung below
 * it assumes a shared LAN, and the user got "Can't find your Mac" immediately
 * after "Paired" -- with no WS attempt in the journal to explain it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CONFIG } from '../../../shared/config'
import { credentialStore } from './credential-store'
import { exchangePairingCode } from './useHostDiscovery'

const { DISCOVERY_LAST_HOST_KEY, DISCOVERY_LAST_TUNNEL_HOST_KEY, TUNNEL } = CONFIG.PHONE_REMOTE
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
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ credential: 'cred-abc' }) }))
  )
})

describe('exchangePairingCode remembers where it paired', () => {
  it('stores a scanned tunnel host on the rung discovery actually reads', async () => {
    const res = await exchangePairingCode('123456', {
      host: 'abc-mightymouse-remote.getmightymouse.com',
      port: TUNNEL.HTTPS_PORT
    })
    expect(res.ok).toBe(true)
    expect(credentialStore.get(DISCOVERY_LAST_TUNNEL_HOST_KEY)).toBe(
      'abc-mightymouse-remote.getmightymouse.com'
    )
  })

  it('stores a scanned LAN host as last-known-good, not as a tunnel', async () => {
    await exchangePairingCode('123456', { host: '192.168.1.42', port: 17771 })
    expect(credentialStore.get(DISCOVERY_LAST_HOST_KEY)).toBe('192.168.1.42')
    expect(credentialStore.get(DISCOVERY_LAST_TUNNEL_HOST_KEY)).toBeNull()
  })

  it('writes no host on the typed path, where the origin is already the Mac', async () => {
    vi.stubGlobal('location', { origin: 'https://192.168.1.42:17771' } as Location)
    await exchangePairingCode('123456')
    expect(credentialStore.get(DISCOVERY_LAST_HOST_KEY)).toBeNull()
    expect(credentialStore.get(DISCOVERY_LAST_TUNNEL_HOST_KEY)).toBeNull()
  })

  it('remembers nothing when the Mac refuses the code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: 'invalid-code' }) }))
    )
    const res = await exchangePairingCode('999999', { host: 'x.example.com', port: TUNNEL.HTTPS_PORT })
    expect(res).toEqual({ ok: false, error: 'invalid-code' })
    expect(credentialStore.get(DISCOVERY_LAST_TUNNEL_HOST_KEY)).toBeNull()
  })
})

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Locks the 08-11 glasses failure: a mirror attempt whose TURN re-fetch failed
// handed the PHONE a STUN-only list while the MAC read a cached relay, so the
// two peers gathered candidates that could never pair and every attempt died at
// "connect timeout in connecting". Both halves are asserted here -- the reuse of
// still-valid credentials, and that both ends read the SAME list.

const getSessionMock = vi.fn()
vi.mock('../../supabase', () => ({ getSupabase: () => ({ auth: { getSession: getSessionMock } }) }))

import { CONFIG } from '../../../shared/config'
import {
  getMirrorIceServers,
  getCachedMirrorIceServers,
  clearMirrorIceServers
} from '../ice-servers'

const RELAY = { urls: 'turn:relay.example:3478', username: 'u', credential: 'c' }

/**
 * One successful mint, then jump INTO the refresh margin.
 *
 * The jump is load-bearing: inside the margin the happy path returns the cache
 * early and never reaches a degrade branch at all, so without it these tests
 * pass against the unfixed code while proving nothing (verified -- they did).
 */
async function primeCacheThenEnterRefreshMargin(ttlSeconds = 7200): Promise<void> {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ iceServers: [RELAY], ttl: ttlSeconds })
    })
  )
  const servers = await getMirrorIceServers()
  expect(servers.some((s) => !!s.credential)).toBe(true)
  const { REFRESH_MARGIN_MS } = CONFIG.PHONE_REMOTE.MIRROR_TURN
  // Past the refresh point, still well before real expiry: credentials remain
  // valid, so a failed re-fetch here MUST keep serving them.
  vi.setSystemTime(new Date(Date.now() + ttlSeconds * 1000 - REFRESH_MARGIN_MS + 1_000))
}

function hasRelay(servers: Array<{ credential?: string }>): boolean {
  return servers.some((s) => !!s.credential)
}

describe('mirror ICE degrade', () => {
  beforeEach(() => {
    // Clock only -- the fetch mocks resolve real promises, and faking those
    // timers would hang every await in here.
    vi.useFakeTimers({ toFake: ['Date'] })
    clearMirrorIceServers()
    getSessionMock.mockReset()
    getSessionMock.mockResolvedValue({ data: { session: { access_token: 'jwt' } } })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('reuses still-valid credentials when a re-fetch throws', async () => {
    await primeCacheThenEnterRefreshMargin()
    // Inside the refresh margin, so the next call re-fetches -- and that fetch
    // fails the way a flaky network does.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    const servers = await getMirrorIceServers()
    expect(hasRelay(servers)).toBe(true)
  })

  it('reuses still-valid credentials when the fetch returns an error status', async () => {
    await primeCacheThenEnterRefreshMargin()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => ({ error: 'bad' }) })
    )
    expect(hasRelay(await getMirrorIceServers())).toBe(true)
  })

  it('hands the Mac the exact list the phone got', async () => {
    await primeCacheThenEnterRefreshMargin()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    const phoneList = await getMirrorIceServers()
    // The Mac reads this synchronously at mirrorStart. Divergence here IS the bug.
    expect(getCachedMirrorIceServers()).toEqual(phoneList)
  })

  it('falls back to STUN once the credentials have actually expired', async () => {
    const ttlSeconds = 7200
    await primeCacheThenEnterRefreshMargin(ttlSeconds)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    // Past the real expiry, not merely inside the refresh margin: dead
    // credentials must not be served, or ICE fails slower instead of failing over.
    // Stepped from the mint, since the helper already advanced the clock.
    vi.setSystemTime(new Date(Date.now() + CONFIG.PHONE_REMOTE.MIRROR_TURN.REFRESH_MARGIN_MS))
    const servers = await getMirrorIceServers()
    expect(hasRelay(servers)).toBe(false)
    expect(getCachedMirrorIceServers()).toEqual(servers)
  })
})

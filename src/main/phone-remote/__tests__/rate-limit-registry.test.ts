/**
 * Regression for ff4ed180: server-runtime built its sweep list by importing
 * every module that owned a rate-limit map, relay-http included, while
 * relay-http imported server-runtime back. Entering relay-http through the
 * re-exports read its maps before their declarations ran and 97 tests died on
 * "Cannot access 'RELAY_AVATAR_ATTEMPTS' before initialization".
 *
 * Two things must hold, and the first is invisible from the second: every entry
 * path into relay-http initializes it fully, AND every bucket reaches the sweep
 * -- the hand-written list this replaced had silently missed two.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => '/tmp', getAppPath: () => process.cwd() },
  safeStorage: { isEncryptionAvailable: () => false }
}))

describe('rate-limit bucket registry', () => {
  it('initializes relay-http fully when entered through server-runtime first', async () => {
    const runtime = await import('../server-runtime')
    const relay = await import('../relay-http')

    expect(typeof runtime.stopPhoneRemoteServer).toBe('function')
    expect(relay.RELAY_AVATAR_ATTEMPTS).toBeInstanceOf(Map)
    expect(relay.RELAY_IMAGE_ATTEMPTS).toBeInstanceOf(Map)
    expect(relay.CHAT_MEDIA_ATTEMPTS).toBeInstanceOf(Map)
    expect(relay.relayRequestAttempts).toBeInstanceOf(Map)
    expect(relay.relayRespondAttempts).toBeInstanceOf(Map)
  })

  it('initializes relay-http fully when entered through http-handlers first', async () => {
    const handlers = await import('../http-handlers')
    const relay = await import('../relay-http')

    expect(handlers.connectLogAttempts).toBeInstanceOf(Map)
    expect(handlers.pushTokenAttempts).toBeInstanceOf(Map)
    expect(handlers.shareAttempts).toBeInstanceOf(Map)
    expect(handlers.intentAttempts).toBeInstanceOf(Map)
    expect(relay.RELAY_AVATAR_ATTEMPTS).toBeInstanceOf(Map)
  })

  it('does not re-export relay-http handlers from server-runtime', async () => {
    // The re-export IS the cycle. http-handlers must reach these directly.
    const runtime = (await import('../server-runtime')) as Record<string, unknown>
    for (const name of [
      'handleRelayRequest',
      'handleRelayRespond',
      'handleRelayImage',
      'handleChatMedia',
      'handleRelayAvatar',
      'handleSessionWrap'
    ]) {
      expect(runtime[name]).toBeUndefined()
    }
  })

  it('registers every declared bucket, not a hand-written subset', async () => {
    const { allRateLimitBuckets } = await import('../rate-limit')
    const relay = await import('../relay-http')
    const handlers = await import('../http-handlers')
    const { pairAttempts } = await import('../pairing')
    await import('../server-runtime')

    const registered = allRateLimitBuckets()
    const named = [
      relay.RELAY_AVATAR_ATTEMPTS,
      relay.RELAY_IMAGE_ATTEMPTS,
      relay.CHAT_MEDIA_ATTEMPTS,
      relay.relayRequestAttempts,
      relay.relayRespondAttempts,
      handlers.connectLogAttempts,
      handlers.pushTokenAttempts,
      handlers.shareAttempts,
      handlers.intentAttempts,
      pairAttempts
    ]
    for (const bucket of named) expect(registered).toContain(bucket)

    // sessionWrapAttempts and wsAttempts are module-private and were the two the
    // hand-written list missed, so the registry must hold MORE than the named set.
    expect(registered.length).toBeGreaterThan(named.length)
  })

  it('hands back the same bucket instance on every read', async () => {
    const { allRateLimitBuckets, rateLimitBucket } = await import('../rate-limit')
    const before = allRateLimitBuckets().length
    const fresh = rateLimitBucket()
    const after = allRateLimitBuckets()

    expect(after.length).toBe(before + 1)
    expect(after).toContain(fresh)
    expect(allRateLimitBuckets()).toBe(after)
  })
})

describe('stopPhoneRemoteServer clears every registered bucket', () => {
  beforeEach(() => vi.useRealTimers())

  it('empties buckets from relay-http and http-handlers, not just the old list', async () => {
    const relay = await import('../relay-http')
    const handlers = await import('../http-handlers')
    const { stopPhoneRemoteServer } = await import('../server-runtime')
    const { recordFailedAttempt, isRateLimited, allRateLimitBuckets } = await import('../rate-limit')

    // Twice: the first call takes the no-entry branch and returns before the
    // count >= max check, so a single failure never blocks.
    for (let i = 0; i < 2; i++) {
      recordFailedAttempt(relay.RELAY_AVATAR_ATTEMPTS, '10.0.0.1', 2)
      recordFailedAttempt(handlers.intentAttempts, '10.0.0.2', 2)
    }
    expect(isRateLimited(relay.RELAY_AVATAR_ATTEMPTS, '10.0.0.1')).toBe(true)
    expect(isRateLimited(handlers.intentAttempts, '10.0.0.2')).toBe(true)

    stopPhoneRemoteServer()

    for (const bucket of allRateLimitBuckets()) expect(bucket.size).toBe(0)
    expect(isRateLimited(relay.RELAY_AVATAR_ATTEMPTS, '10.0.0.1')).toBe(false)
    expect(isRateLimited(handlers.intentAttempts, '10.0.0.2')).toBe(false)
  })
})

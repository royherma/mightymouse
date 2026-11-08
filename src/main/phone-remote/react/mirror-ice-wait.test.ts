import { describe, it, expect } from 'vitest'

import { CONFIG } from '../../../shared/config'

// Locks the 08-11 glasses failure. The phone asked the Mac for ICE servers and
// gave up after 6s -- the SAME 6s the Mac was allowed to spend on Cloudflare,
// before its own getSession() and the WS hop. The deadline could not be met, so
// the phone negotiated STUN-only against a Mac holding a relay and every attempt
// died at "connect timeout" (6 of 7 in the logs; every "1 with credentials"
// attempt connected).

describe('mirror ICE wait budget', () => {
  const { FETCH_TIMEOUT_MS, CLIENT_WAIT_MS } = CONFIG.PHONE_REMOTE.MIRROR_TURN

  it("gives the phone longer than the Mac's own fetch budget", () => {
    expect(CLIENT_WAIT_MS).toBeGreaterThan(FETCH_TIMEOUT_MS)
  })

  it('leaves room for getSession() plus the WS hop, not just a millisecond', () => {
    // A margin under ~2s is indistinguishable from the bug: the Mac's slow path
    // is a token refresh THEN the full fetch timeout.
    expect(CLIENT_WAIT_MS - FETCH_TIMEOUT_MS).toBeGreaterThanOrEqual(2_000)
  })
})

/**
 * The observer socket (observer-socket PRD).
 *
 * A read-only client must never disturb the phone in the user's hand. That
 * holds because observers branch out before `decideTakeover`; these tests lock
 * the rule guarding that branch so a later edit can't widen it.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => '/tmp' },
  safeStorage: { isEncryptionAvailable: () => false }
}))

import { decideObserver, decideTakeover } from '../server'

const BASE = {
  observeRequested: true,
  isDev: true,
  isLoopback: true,
  requestHost: '127.0.0.1:17771',
  tunnelHostname: null as string | null
}
const TUNNEL = 'remote-abc.trycloudflare.com'

describe('decideObserver', () => {
  it('admits a dev loopback client that asked to observe', () => {
    expect(decideObserver(BASE)).toBe(true)
  })

  it('never admits a client that did not ask', () => {
    expect(decideObserver({ ...BASE, observeRequested: false })).toBe(false)
  })

  it('never admits in a packaged build', () => {
    expect(decideObserver({ ...BASE, isDev: false })).toBe(false)
  })

  it('never admits a non-loopback client', () => {
    expect(decideObserver({ ...BASE, isLoopback: false })).toBe(false)
  })

  // cloudflared dials the origin as localhost, so tunnel traffic already looks
  // loopback -- the Host header is the only thing that still separates them.
  it('never admits a request forwarded in over the tunnel', () => {
    expect(
      decideObserver({ ...BASE, requestHost: TUNNEL, tunnelHostname: TUNNEL })
    ).toBe(false)
  })

  // The point of gating per-request: Roy's phone stays on the tunnel while an
  // agent observes over LAN. Gating on "is the tunnel up" broke both at once.
  it('admits a local request while the tunnel serves the phone', () => {
    expect(
      decideObserver({ ...BASE, requestHost: '127.0.0.1:17771', tunnelHostname: TUNNEL })
    ).toBe(true)
    expect(
      decideObserver({ ...BASE, requestHost: 'mightymouse.local:17771', tunnelHostname: TUNNEL })
    ).toBe(true)
  })

  it('ignores case and port when matching the tunnel host', () => {
    expect(
      decideObserver({ ...BASE, requestHost: TUNNEL.toUpperCase() + ':443', tunnelHostname: TUNNEL })
    ).toBe(false)
  })
})

describe('observer vs the takeover gate', () => {
  // Why observers bypass this gate: both verdicts disturb the live phone.
  it('the takeover gate has no non-disruptive verdict for a newcomer', () => {
    const busy = decideTakeover({
      msSinceIncumbentInput: 0,
      takeoverRequested: false,
      incumbentDeviceId: 'phone-a',
      candidateDeviceId: 'agent-b'
    })
    const idle = decideTakeover({
      msSinceIncumbentInput: 10 * 60 * 1000,
      takeoverRequested: false,
      incumbentDeviceId: 'phone-a',
      candidateDeviceId: 'agent-b'
    })
    expect(busy).toBe('refuse')
    expect(idle).toBe('admit')
  })
})

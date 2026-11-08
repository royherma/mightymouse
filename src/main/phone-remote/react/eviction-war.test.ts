/**
 * A device that loses the single socket must NOT reconnect on its own.
 * Eviction used to close bare (1005) -> generic retry path -> 1s kick war.
 */
import { describe, it, expect } from 'vitest'
import { conflictReason, conflictKind } from './useConnection'
import { decideTakeover } from '../server'
import { CONFIG } from '../../../shared/config'

const { CLOSE_REASON_EVICTED, CLOSE_REASON_BUSY, CLOSE_REASON_SUPERSEDED, CLOSE_CODE_CONFLICT } =
  CONFIG.PHONE_REMOTE

describe('conflict close codes', () => {
  it('uses a code the 4401 branch cannot swallow', () => {
    expect(CLOSE_CODE_CONFLICT).toBe(4409)
    expect(CLOSE_CODE_CONFLICT).not.toBe(4401)
  })

  it('gives eviction and busy distinct reasons', () => {
    expect(CLOSE_REASON_EVICTED).not.toBe(CLOSE_REASON_BUSY)
  })
})

describe('conflictReason', () => {
  it('routes an evicted phone to mac-busy, never to a retry', () => {
    expect(conflictReason(CLOSE_REASON_EVICTED)).toBe('mac-busy')
  })

  it('routes a refused newcomer to mac-busy', () => {
    expect(conflictReason(CLOSE_REASON_BUSY)).toBe('mac-busy')
  })

  it('treats an unknown conflict reason as mac-busy', () => {
    // Fail toward the state that does NOT reconnect.
    expect(conflictReason('')).toBe('mac-busy')
    expect(conflictReason('something-new')).toBe('mac-busy')
  })
})

describe('conflictKind', () => {
  it('separates a full session from an eviction', () => {
    // Both are still 'mac-busy' -- BlockedReason stays the server's closed five
    // values. This only picks which copy that one screen shows.
    expect(conflictKind(CLOSE_REASON_BUSY)).toBe('no-room')
    expect(conflictKind(CLOSE_REASON_EVICTED)).toBe('evicted')
  })

  it('fails toward evicted for an unknown reason', () => {
    expect(conflictKind('')).toBe('evicted')
    expect(conflictKind('something-new')).toBe('evicted')
  })
})

describe('decideTakeover', () => {
  const GRACE = CONFIG.PHONE_REMOTE.TAKEOVER_GRACE_MS

  it('refuses a newcomer while the incumbent is actively in use', () => {
    // The silent-steal half: a second phone used to punt whoever was mid-gesture.
    expect(decideTakeover({ msSinceIncumbentInput: 0, takeoverRequested: false })).toBe('refuse')
    expect(decideTakeover({ msSinceIncumbentInput: GRACE - 1, takeoverRequested: false })).toBe(
      'refuse'
    )
  })

  it('hands over silently once the incumbent has gone idle', () => {
    expect(decideTakeover({ msSinceIncumbentInput: GRACE, takeoverRequested: false })).toBe('admit')
  })

  it('always admits an explicit take-control tap', () => {
    // The button must win even against a phone that is mid-gesture right now.
    expect(decideTakeover({ msSinceIncumbentInput: 0, takeoverRequested: true })).toBe('admit')
  })
})

describe('the war cannot restart', () => {
  it('leaves no conflict reason that resolves to an auto-retry', () => {
    // The invariant: a reason added later is caught even with no test of its own.
    // Asserted as "never a bare retry" rather than an outcome allowlist, so
    // adding a reason cannot pass by widening the list. 'superseded' is the
    // one non-blocking outcome and is handled as a silent no-op by the
    // caller, never a scheduled retry -- see useConnection.ts's onclose.
    const outcomes = [
      CLOSE_REASON_EVICTED,
      CLOSE_REASON_BUSY,
      CLOSE_REASON_SUPERSEDED,
      'future-reason'
    ].map(conflictReason)
    expect(outcomes.every((o) => o === 'mac-busy' || o === 'superseded')).toBe(true)
  })
})

describe('one phone on two transports is not two phones', () => {
  // LAN + tunnel both reach the Mac on ONE credential, so each arrival read as
  // a rival and evicted the other. Symptom on glass: a dead mic.
  const SAME = 'device-abc'

  it('treats a same-device arrival as a reconnect, even mid-gesture', () => {
    expect(
      decideTakeover({
        msSinceIncumbentInput: 0,
        takeoverRequested: false,
        incumbentDeviceId: SAME,
        candidateDeviceId: SAME
      })
    ).toBe('reconnect')
  })

  it('still refuses a genuinely different device inside the grace', () => {
    expect(
      decideTakeover({
        msSinceIncumbentInput: 0,
        takeoverRequested: false,
        incumbentDeviceId: SAME,
        candidateDeviceId: 'device-xyz'
      })
    ).toBe('refuse')
  })

  it('does not pair two unidentified sessions into a false reconnect', () => {
    // Both null (session-token sessions) must NOT compare equal -- that would
    // let any unpaired phone silently seize an active session.
    expect(
      decideTakeover({
        msSinceIncumbentInput: 0,
        takeoverRequested: false,
        incumbentDeviceId: null,
        candidateDeviceId: null
      })
    ).toBe('refuse')
  })

  it('retires the superseded socket without a takeover prompt', () => {
    expect(conflictReason(CLOSE_REASON_SUPERSEDED)).toBe('superseded')
  })
})

// The relay-allowance contract. Two things are load-bearing and neither is
// obvious from reading the types: an unrecognised reason must resolve to NOT
// capped (fail-open), and a stale/absent reset
// timestamp must yield null rather than a negative countdown.

import { describe, it, expect } from 'vitest'
import { toRemoteCapState, formatCapReset, isRemoteCapReason } from '../phone-remote-limits'

describe('toRemoteCapState', () => {
  it('reads the window that ran out, not every window', () => {
    const cap = toRemoteCapState({
      capped: true,
      reason: 'weekly',
      used: { day: 5, week: 45, month: 60 },
      limits: { day: 15, week: 45, month: 90 },
      resetsAt: '2026-07-27T00:00:00Z'
    })
    expect(cap).toEqual({ reason: 'weekly', used: 45, limit: 45, resetsAt: '2026-07-27T00:00:00Z' })
  })

  it('is null when not capped', () => {
    expect(toRemoteCapState({ iceServers: [] } as never)).toBeNull()
    expect(toRemoteCapState({ capped: false, reason: 'daily' })).toBeNull()
  })

  // The fail-open cases. `check_failed` means the limiter broke and the server
  // GRANTED anyway; rendering it as a cap would show a limit notice to a user
  // who has no limit. `abuse_cap` is a runaway-client guard, not a product rule.
  it('treats non-product reasons as not capped', () => {
    for (const reason of ['check_failed', 'abuse_cap', 'pro', 'within_limits', 'disabled', '']) {
      expect(toRemoteCapState({ capped: true, reason })).toBeNull()
    }
    expect(toRemoteCapState({ capped: true })).toBeNull()
    expect(toRemoteCapState({ capped: true, reason: 42 })).toBeNull()
  })

  it('drops non-numeric usage rather than rendering it', () => {
    const cap = toRemoteCapState({
      capped: true,
      reason: 'daily',
      used: { day: 'lots' },
      limits: null
    })
    expect(cap).toEqual({ reason: 'daily', used: undefined, limit: undefined, resetsAt: undefined })
  })

  it('guards the reason union against prototype keys', () => {
    expect(isRemoteCapReason('daily')).toBe(true)
    // `in` on a plain object would match inherited keys; the guard must not.
    expect(isRemoteCapReason('toString')).toBe(false)
    expect(isRemoteCapReason('constructor')).toBe(false)
  })
})

describe('formatCapReset', () => {
  const now = Date.parse('2026-07-25T12:00:00Z')

  it('formats minutes, hours, and days', () => {
    expect(formatCapReset('2026-07-25T12:12:00Z', now)).toBe('12m')
    expect(formatCapReset('2026-07-25T15:20:00Z', now)).toBe('3h 20m')
    expect(formatCapReset('2026-07-25T15:00:00Z', now)).toBe('3h')
    expect(formatCapReset('2026-07-26T12:00:00Z', now)).toBe('1 day')
    expect(formatCapReset('2026-07-28T12:00:00Z', now)).toBe('3 days')
  })

  // A past timestamp is the realistic bad case: the phone holds the cap across a
  // window rollover. "in -4m" is worse than saying nothing.
  it('is null for a past, missing, or unparseable timestamp', () => {
    expect(formatCapReset('2026-07-25T11:59:00Z', now)).toBeNull()
    expect(formatCapReset('2026-07-25T12:00:00Z', now)).toBeNull()
    expect(formatCapReset(undefined, now)).toBeNull()
    expect(formatCapReset('soon', now)).toBeNull()
  })
})

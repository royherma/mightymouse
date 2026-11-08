import { describe, it, expect, vi, beforeEach } from 'vitest'

// abortAllRuns / hasLiveRun are the kill-switch's reach into runBackend's private
// child registry. We can't spawn a real CLI in a unit test, so we drive the public
// surface: with nothing running, abort is a no-op (0) and hasLiveRun is false.
// A spawned run is covered by the e2e gesture path; here we lock the empty-state
// contract so a refactor can't silently make the panic button throw.

vi.mock('../../store/paths', () => ({
  PATHS: { ROOT: '/tmp/mm-test', TMP: '/tmp', LOG: '/tmp/mm-test.log', ACTS: '/tmp', ACTS_AUDITS: '/tmp', LATEST_ACT: '/tmp/latest' }
}))
vi.mock('../../supabase', () => ({
  getSupabase: () => ({ auth: { getSession: async () => ({ data: { session: null } }) } })
}))

import { abortAllRuns, abortRun, hasLiveRun, EXIT_TIMEOUT, EXIT_STOPPED } from '../runner'

describe('kill-switch registry', () => {
  beforeEach(() => {
    // Drain anything a prior test left registered so each case starts clean.
    abortAllRuns()
  })

  it('reports no live run when idle', () => {
    expect(hasLiveRun()).toBe(false)
  })

  it('abortAllRuns is a no-op that returns 0 when nothing is running', () => {
    expect(abortAllRuns()).toBe(0)
    expect(hasLiveRun()).toBe(false)
  })

  it('is safe to call repeatedly', () => {
    expect(abortAllRuns()).toBe(0)
    expect(abortAllRuns()).toBe(0)
    expect(hasLiveRun()).toBe(false)
  })

  it('abortRun returns false for an unknown runId', () => {
    expect(abortRun('no-such-run')).toBe(false)
  })
})

// A SIGKILLed child reports a generic nonzero exit indistinguishable from a real
// crash — which is why a user-initiated stop used to surface as "agent failed
// (exit -1)" in red. runner.ts now translates a stopped run to EXIT_STOPPED so
// every caller can tell the two apart. These lock the sentinels: they must stay
// distinct from each other, from success, and from any real CLI exit code (which
// are >0, so every sentinel has to be negative).
describe('exit-code sentinels', () => {
  it('EXIT_STOPPED is distinct from EXIT_TIMEOUT and from success', () => {
    expect(EXIT_STOPPED).not.toBe(EXIT_TIMEOUT)
    expect(EXIT_STOPPED).not.toBe(0)
  })

  it('sentinels are negative so they can never collide with a real CLI exit code', () => {
    expect(EXIT_STOPPED).toBeLessThan(0)
    expect(EXIT_TIMEOUT).toBeLessThan(0)
  })
})

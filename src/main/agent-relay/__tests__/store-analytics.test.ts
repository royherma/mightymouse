/**
 * The relay's only signal that leaves a user's machine. Untested instrumentation
 * is worse than none: a silent no-op here reads as "nobody uses the relay", which
 * is indistinguishable from "the relay is broken" -- the exact ambiguity these
 * events exist to remove. So assert the payloads, not just that something fired.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const TEST_ROOT = join(tmpdir(), 'mm-agent-relay-analytics-test')

vi.mock('../../store/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/paths')>()
  return {
    ...actual,
    PATHS: {
      ...actual.PATHS,
      ROOT: TEST_ROOT,
      AGENT_RELAY_LOG: join(TEST_ROOT, 'agent-relay-log.jsonl')
    }
  }
})

const track = vi.fn()
vi.mock('../../analytics', () => ({ track: (...args: unknown[]) => track(...args) }))

/** Every (event, props) pair fired for `name`, in order. */
function fired(name: string): Array<Record<string, unknown>> {
  return track.mock.calls
    .filter((c) => c[0] === name)
    .map((c) => c[1] as Record<string, unknown>)
}

describe('agent-relay analytics', () => {
  let mod: typeof import('../store')

  beforeEach(async () => {
    rmSync(TEST_ROOT, { recursive: true, force: true })
    mkdirSync(TEST_ROOT, { recursive: true })
    track.mockClear()
    vi.useFakeTimers()
    vi.resetModules()
    mod = await import('../store')
  })

  afterEach(() => {
    mod.relayRequestStore.resetForTests()
    vi.useRealTimers()
    rmSync(TEST_ROOT, { recursive: true, force: true })
  })

  it('fires relay_request_sent when a blocking verb is minted', () => {
    mod.relayRequestStore.mint('ask', { question: 'which db?' })
    expect(fired('relay_request_sent')).toEqual([{ verb: 'ask' }])
  })

  it('reports the seconds a human left the agent blocked', () => {
    const req = mod.relayRequestStore.mint('ask', { question: 'which db?' })
    vi.advanceTimersByTime(12_000)
    mod.relayRequestStore.resolve(req.id, { answer: 'postgres' }, 'device-1', 'phone')

    expect(fired('relay_request_resolved')).toEqual([
      { verb: 'ask', seconds: 12, via: 'phone' }
    ])
  })

  it('fires relay_request_timeout with the window that elapsed', () => {
    mod.relayRequestStore.mint('approve', { action: 'deploy prod' }, 30_000)
    vi.advanceTimersByTime(30_001)

    expect(fired('relay_request_timeout')).toEqual([{ verb: 'approve', seconds: 30 }])
    // A timeout is not an answer -- it must never land in the latency metric.
    expect(fired('relay_request_resolved')).toEqual([])
  })

  it('excludes notify from both sent and resolved so it cannot skew latency', () => {
    // notify settles inside mint(), so a naive emit would report a 0s "answer"
    // for every fire-and-forget call and drag the median toward zero.
    mod.relayRequestStore.mint('notify', { title: 'Build done' })

    expect(fired('relay_request_sent')).toEqual([])
    expect(fired('relay_request_resolved')).toEqual([])
  })

  it('does not double-count when a late answer arrives after timeout', () => {
    const req = mod.relayRequestStore.mint('ask', { question: 'q' }, 1_000)
    vi.advanceTimersByTime(1_001)
    mod.relayRequestStore.resolve(req.id, { answer: 'too late' }, 'device-1', 'phone')

    expect(fired('relay_request_timeout')).toHaveLength(1)
    expect(fired('relay_request_resolved')).toEqual([])
  })

  it('fires relay_request_delivered on the first NSE fetch', () => {
    const req = mod.relayRequestStore.mint('ask', { question: 'which db?' })
    mod.relayRequestStore.markFetched(req.id, 'device-1')

    expect(fired('relay_request_delivered')).toEqual([{ verb: 'ask' }])
  })

  it('dedupes: a re-fetch of the same request fires the event at most once', () => {
    // The NSE and the phone app can both hit GET /relay-request for the same
    // id -- delivery proof must not inflate just because the phone polled twice.
    const req = mod.relayRequestStore.mint('ask', { question: 'which db?' })
    mod.relayRequestStore.markFetched(req.id, 'device-1')
    mod.relayRequestStore.markFetched(req.id, 'device-1')
    mod.relayRequestStore.markFetched(req.id, 'device-1')

    expect(fired('relay_request_delivered')).toHaveLength(1)
  })

  it('does not fire delivered for an unknown request id', () => {
    mod.relayRequestStore.markFetched('not-a-real-id', 'device-1')
    expect(fired('relay_request_delivered')).toEqual([])
  })
})

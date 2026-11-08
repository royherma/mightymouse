/**
 * design cross-cutting rules, one test per rule: timeout expiry, late-response
 * drop, first-answer-wins across surfaces, never-auto-approve-on-timeout.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const TEST_ROOT = join(tmpdir(), 'mm-agent-relay-store-test')

vi.mock('../../store/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/paths')>()
  return {
    ...actual,
    PATHS: { ...actual.PATHS, ROOT: TEST_ROOT, AGENT_RELAY_LOG: join(TEST_ROOT, 'agent-relay-log.jsonl') }
  }
})

function readAuditRows(): Array<Record<string, unknown>> {
  const path = join(TEST_ROOT, 'agent-relay-log.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('agent-relay request store', () => {
  let mod: typeof import('../store')

  beforeEach(async () => {
    rmSync(TEST_ROOT, { recursive: true, force: true })
    mkdirSync(TEST_ROOT, { recursive: true })
    vi.useFakeTimers()
    vi.resetModules()
    mod = await import('../store')
  })

  afterEach(() => {
    mod.relayRequestStore.resetForTests()
    vi.useRealTimers()
    rmSync(TEST_ROOT, { recursive: true, force: true })
  })

  it('mints a pending request with the default 600s timeout for a blocking verb', () => {
    const req = mod.relayRequestStore.mint('ask', { question: 'which db?' })
    expect(req.status).toBe('pending')
    expect(req.timeoutMs).toBe(mod.RELAY_DEFAULT_TIMEOUT_MS)
    expect(mod.relayRequestStore.listPending().map((r) => r.id)).toContain(req.id)
  })

  it('expires an unanswered request on timeout, audit-logged', () => {
    const req = mod.relayRequestStore.mint('ask', { question: 'name?' }, 1_000)
    vi.advanceTimersByTime(1_001)
    const after = mod.relayRequestStore.get(req.id)
    expect(after?.status).toBe('timedout')
    expect(mod.relayRequestStore.listPending()).toHaveLength(0)
    const rows = readAuditRows()
    expect(rows.some((r) => r.event === 'timedout' && r.requestId === req.id)).toBe(true)
  })

  it('never auto-approves on timeout -- resolves approved:false with reason timeout', () => {
    const req = mod.relayRequestStore.mint('approve', { action: 'deploy prod' }, 1_000)
    vi.advanceTimersByTime(1_001)
    const after = mod.relayRequestStore.get(req.id)
    expect(after?.status).toBe('timedout')
    expect(after?.response).toEqual({ approved: false, reason: 'timeout' })
  })

  it('drops a response arriving after timeout and audit-logs it instead of accepting it', () => {
    const req = mod.relayRequestStore.mint('ask', { question: 'q' }, 1_000)
    vi.advanceTimersByTime(1_001)
    expect(mod.relayRequestStore.get(req.id)?.status).toBe('timedout')

    const result = mod.relayRequestStore.resolve(
      req.id,
      { answer: 'too late' },
      'device-a',
      'typed'
    )
    expect(result).toBe('already-resolved')
    // The late answer must never overwrite the timeout resolution the agent
    // already received.
    expect(mod.relayRequestStore.get(req.id)?.response).toEqual({
      approved: undefined,
      reason: 'timeout'
    })
    const rows = readAuditRows()
    expect(rows.some((r) => r.event === 'dropped-late' && r.requestId === req.id)).toBe(true)
  })

  it('first answer wins regardless of surface -- a second answer is a no-op, not an error', () => {
    const req = mod.relayRequestStore.mint('approve', { action: 'ship it' }, 60_000)

    const first = mod.relayRequestStore.resolve(req.id, { approved: true }, 'phone-1', 'chip')
    expect(first).toBe('resolved')

    const second = mod.relayRequestStore.resolve(
      req.id,
      { approved: false },
      'hud-local',
      'typed'
    )
    expect(second).toBe('already-resolved')

    const final = mod.relayRequestStore.get(req.id)
    expect(final?.status).toBe('resolved')
    expect(final?.response).toEqual({ approved: true })
    expect(final?.resolvedBy).toBe('phone-1')
  })

  it('a notify call resolves immediately and never blocks', () => {
    const req = mod.relayRequestStore.mint('notify', { title: 'Build finished' })
    expect(req.status).toBe('resolved')
    expect(mod.relayRequestStore.listPending()).toHaveLength(0)
  })

  // The settle-at-mint above reaches the store's change feed already resolved,
  // which is the edge ipc/agent-relay.ts must NOT send a clear push on: the
  // background clear would race the alert it is meant to retire and leave the
  // card up forever. `resolvedVia` is the discriminator that guard reads, so
  // pin it -- a dismiss/timeout names one, the settle-at-mint leaves it null.
  it('settles a notify with no resolvedVia, so a clear push can tell it from a real retirement', () => {
    const minted = mod.relayRequestStore.mint('notify', { title: 'Ready for you', idle: true })
    expect(minted.resolvedVia).toBeNull()

    const ask = mod.relayRequestStore.mint('ask', { question: 'Which db?' })
    mod.relayRequestStore.dismiss(ask.id, null)
    expect(mod.relayRequestStore.get(ask.id)?.resolvedVia).toBe('dismiss')
  })

  it('idleSinceBySender holds a sender only while the idle ping is its newest card', () => {
    const ping = mod.relayRequestStore.mint('notify', {
      title: 'Ready for you',
      from: 'a',
      idle: true
    })
    expect(mod.relayRequestStore.idleSinceBySender().get('a')).toBe(ping.createdAt)
    // A card without a sender must never claim one.
    mod.relayRequestStore.mint('notify', { title: 'anon', idle: true })
    expect(mod.relayRequestStore.idleSinceBySender().size).toBe(1)
    // ANY newer request from the sender supersedes it -- the agent moved on.
    vi.advanceTimersByTime(1)
    mod.relayRequestStore.mint('notify', { title: 'Build finished', from: 'a' })
    expect(mod.relayRequestStore.idleSinceBySender().has('a')).toBe(false)
  })

  it('idleSinceBySessionId keys the same answer on the id, ignoring the shared name', () => {
    // Two panes in one checkout send an identical `from`. The name map cannot
    // tell them apart -- that is the whole reason the id map exists.
    const ping = mod.relayRequestStore.mint('notify', {
      title: 'Ready for you',
      from: 'ShowAndTell/dev',
      sessionId: 'sess-twin-a',
      idle: true
    })
    const byId = mod.relayRequestStore.idleSinceBySessionId()
    expect(byId.get('sess-twin-a')).toBe(ping.createdAt)
    expect(byId.has('sess-twin-b'), 'the twin never sent an idle ping').toBe(false)
    // A ping with no id must not invent one, exactly as the name map ignores a
    // card with no sender.
    mod.relayRequestStore.mint('notify', { title: 'anon', idle: true })
    expect(mod.relayRequestStore.idleSinceBySessionId().size).toBe(1)
  })

  it('audit-logs notify as sent -- with no phone paired the log is its only surface', () => {
    mod.relayRequestStore.mint('notify', { title: 'Build finished' })
    const rows = readAuditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].verb).toBe('notify')
    expect(rows[0].event).toBe('sent')
  })

  it('onRelayStoreChanged fires on mint, resolve, and timeout', () => {
    const seen: string[] = []
    const unsubscribe = mod.onRelayStoreChanged((r) => seen.push(r.status))

    const req = mod.relayRequestStore.mint('ask', { question: 'q' }, 1_000)
    mod.relayRequestStore.resolve(req.id, { answer: 'a' }, 'd1', 'typed')

    const req2 = mod.relayRequestStore.mint('ask', { question: 'q2' }, 1_000)
    vi.advanceTimersByTime(1_001)

    expect(seen).toEqual(['pending', 'resolved', 'pending', 'timedout'])
    unsubscribe()
  })

  it('unknown request id is reported distinctly from an already-resolved one', () => {
    expect(mod.relayRequestStore.resolve('does-not-exist', {}, null, 'typed')).toBe('unknown')
  })

  it('a dismiss leaves every surface at once but reaches the agent only after the undo window', () => {
    const delivered: string[] = []
    const off = mod.onRelayDelivered((r) => delivered.push(r.id))
    const req = mod.relayRequestStore.mint('ask', { question: 'q' })

    mod.relayRequestStore.dismiss(req.id, 'device-a')
    // Gone from the inbox immediately -- the split is the whole point: the card
    // goes, the agent waits.
    expect(mod.relayRequestStore.listPending()).toHaveLength(0)
    expect(mod.relayRequestStore.undoPending(req.id)).toBe(true)
    expect(delivered).toEqual([])

    vi.advanceTimersByTime(mod.RELAY_UNDO_WINDOW_MS)
    expect(delivered).toEqual([req.id])
    expect(mod.relayRequestStore.undoPending(req.id)).toBe(false)
    off()
  })

  it('undo inside the window puts the card back and the agent is never told', () => {
    const delivered: string[] = []
    const off = mod.onRelayDelivered((r) => delivered.push(r.id))
    const req = mod.relayRequestStore.mint('ask', { question: 'q' })

    mod.relayRequestStore.dismiss(req.id, 'device-a')
    expect(mod.relayRequestStore.undismiss(req.id)).toBe(true)

    const back = mod.relayRequestStore.get(req.id)
    expect(back?.status).toBe('pending')
    expect(back?.response).toBe(null)
    expect(mod.relayRequestStore.listPending().map((r) => r.id)).toContain(req.id)

    // Past the window with nothing delivered: the timer was cancelled, not just
    // outrun. Without this the agent would get a dismiss for a live card.
    vi.advanceTimersByTime(mod.RELAY_UNDO_WINDOW_MS * 2)
    expect(delivered).toEqual([])
    off()
  })

  it('undo restarts the FULL timeout -- a card taken back must not expire under you', () => {
    const req = mod.relayRequestStore.mint('ask', { question: 'q' }, 10_000)
    vi.advanceTimersByTime(9_000)
    mod.relayRequestStore.dismiss(req.id, 'device-a')
    mod.relayRequestStore.undismiss(req.id)

    // The original deadline has passed; the restarted one has not.
    vi.advanceTimersByTime(9_500)
    expect(mod.relayRequestStore.get(req.id)?.status).toBe('pending')
    vi.advanceTimersByTime(1_000)
    expect(mod.relayRequestStore.get(req.id)?.status).toBe('timedout')
  })

  it('undo is refused once the window has closed -- the agent already moved on', () => {
    const req = mod.relayRequestStore.mint('ask', { question: 'q' })
    mod.relayRequestStore.dismiss(req.id, 'device-a')
    vi.advanceTimersByTime(mod.RELAY_UNDO_WINDOW_MS)

    expect(mod.relayRequestStore.undismiss(req.id)).toBe(false)
    expect(mod.relayRequestStore.get(req.id)?.status).toBe('dismissed')
  })

  it('the sweep drops settled rows past retention and never touches a pending one', () => {
    const settled = mod.relayRequestStore.mint('ask', { question: 'old' })
    mod.relayRequestStore.resolve(settled.id, { answer: 'a' }, 'd1', 'typed')
    const live = mod.relayRequestStore.mint('ask', { question: 'still waiting' }, mod.RELAY_RETENTION_MS * 4)

    vi.advanceTimersByTime(mod.RELAY_RETENTION_MS + 60 * 60 * 1000)

    expect(mod.relayRequestStore.get(settled.id)).toBe(null)
    // An agent is still blocked on this one -- sweeping it would hang it forever.
    expect(mod.relayRequestStore.get(live.id)?.status).toBe('pending')
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CoordinationStore } from '../store'
import { COORDINATION, type CoordinationMessage } from '../../../../shared/coordination'

const mocks = vi.hoisted(() => ({
  live: vi.fn(() => [] as unknown[]),
  listed: vi.fn(() => [] as unknown[]),
  pending: vi.fn(() => [] as unknown[]),
  sendPaneText: vi.fn(async () => 'tmux' as 'tmux' | 'tty' | 'skipped')
}))
vi.mock('../../mcp/http-listener', () => ({
  liveAgentSessions: mocks.live,
  listedAgentSessions: mocks.listed,
  getCoordinationService: vi.fn(),
  addSessionTurnEndedListener: vi.fn()
}))
vi.mock('../../picker-keys', () => ({ sendPaneText: mocks.sendPaneText }))
vi.mock('../../store', () => ({ relayRequestStore: { listPending: mocks.pending } }))

import { deliverHandoff } from '../delivery'

const disposals: Array<() => void> = []
beforeEach(() => {
  mocks.live.mockReset().mockReturnValue([])
  mocks.listed.mockReset().mockReturnValue([])
  mocks.pending.mockReset().mockReturnValue([])
  mocks.sendPaneText.mockReset().mockResolvedValue('tmux')
})
afterEach(() => {
  for (const close of disposals.splice(0).reverse()) close()
})

let keySeq = 0
function fixture(recipientHarness: 'claude' | 'codex' = 'claude', recipientProject = 'p'): {
  db: CoordinationStore
  send: () => CoordinationMessage
  goStale: () => void
} {
  const root = mkdtempSync(join(tmpdir(), 'mm-delivery-'))
  disposals.push(() => rmSync(root, { recursive: true, force: true }))
  const clock = { now: 1_000_000 }
  const db = new CoordinationStore(join(root, 'test.sqlite'), () => clock.now)
  disposals.push(() => db.close())
  const base = { project: 'p', projectName: 'P', cwd: root, version: 'test' }
  db.register({ ...base, session: 'sender-sess', harness: 'claude', label: 'Sender' }, 'a')
  const r = db.register(
    {
      ...base,
      project: recipientProject,
      session: 'recip-sess',
      harness: recipientHarness,
      label: 'Recipient'
    },
    'r'
  )
  const send = (): CoordinationMessage =>
    db.call(
      'send',
      { to: r.id, key: `k-${++keySeq}`, subject: 'Review', body: 'Please check.' },
      'a'
    ) as CoordinationMessage
  const goStale = (): void => {
    clock.now += COORDINATION.staleMs + 1
  }
  return { db, send, goStale }
}

describe('handoffs between repos', () => {
  it('delivers a note to a live agent in another project, which reads it and completes it', async () => {
    const { db, send } = fixture('claude', 'other-repo')
    mocks.live.mockReturnValue([liveRecipient()])
    const sent = send()
    const out = deliverHandoff(db, sent)
    expect(out.delivery).toBe('woken')
    expect(out.message.state).toBe('pending')
    await flush()
    expect(mocks.sendPaneText).toHaveBeenCalledTimes(1)
    const inbox = db.call('inbox', {}, 'r') as CoordinationMessage[]
    expect(inbox.map((m) => m.id)).toEqual([sent.id])
    const done = db.call(
      'ack',
      { message: sent.id, state: 'completed', note: 'Fixed in the other repo' },
      'r'
    ) as CoordinationMessage
    expect(done.state).toBe('completed')
    const receipt = (db.call('status', {}, 'a') as { messages: CoordinationMessage[] }).messages
    expect(receipt.find((m) => m.id === sent.id)?.state).toBe('completed')
  })

  it('sends back a note to a closed agent in another project as declined', () => {
    const { db, send, goStale } = fixture('claude', 'other-repo')
    goStale()
    const out = deliverHandoff(db, send())
    expect(out.delivery).toBe('closed')
    expect(out.message.state).toBe('declined')
    expect(db.call('inbox', {}, 'r')).toEqual([])
  })
})
const liveRecipient = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  sessionId: 'recip-sess',
  label: 'Recipient',
  since: 0,
  ...extra
})
const flush = (): Promise<unknown> => new Promise((r) => setTimeout(r, 0))

describe('deliverHandoff routing', () => {
  it('bounces a handoff to a closed Claude agent: declined with a note, gone from its inbox', () => {
    const { db, send, goStale } = fixture('claude')
    goStale()
    const sent = send()
    const out = deliverHandoff(db, sent)
    expect(out.delivery).toBe('closed')
    expect(out.message.id).toBe(sent.id)
    expect(out.message.state).toBe('declined')
    expect(out.message.note).toMatch(/recipient agent is closed/)
    expect(db.call('inbox', {}, 'r')).toEqual([])
    expect(mocks.sendPaneText).not.toHaveBeenCalled()
  })

  it('keeps a handoff pending for a stale recipient whose harness has no presence signal', () => {
    const { db, send, goStale } = fixture('codex')
    goStale()
    const out = deliverHandoff(db, send())
    expect(out.delivery).toBe('next-turn')
    expect(out.message.state).toBe('pending')
    expect((db.call('inbox', {}, 'r') as CoordinationMessage[])).toHaveLength(1)
  })

  it('keeps a handoff pending for a stale Claude agent that is still listed (reconnecting)', () => {
    const { db, send, goStale } = fixture('claude')
    goStale()
    mocks.listed.mockReturnValue([liveRecipient({ staleSince: 1 })])
    const out = deliverHandoff(db, send())
    expect(out.delivery).toBe('next-turn')
    expect(out.message.state).toBe('pending')
  })

  it('does not bounce a Claude recipient that was seen recently but has no live socket', () => {
    const { db, send } = fixture('claude')
    const out = deliverHandoff(db, send())
    expect(out.delivery).toBe('next-turn')
    expect(out.message.state).toBe('pending')
  })

  it('wakes a live idle recipient by typing into its pane exactly once per message', async () => {
    const { db, send } = fixture()
    mocks.live.mockReturnValue([liveRecipient()])
    const sent = send()
    expect(deliverHandoff(db, sent).delivery).toBe('woken')
    await flush()
    expect(mocks.sendPaneText).toHaveBeenCalledTimes(1)
    expect(mocks.sendPaneText.mock.calls[0][1]).toMatch(/sent you a new handoff/)
    deliverHandoff(db, sent)
    await flush()
    expect(mocks.sendPaneText).toHaveBeenCalledTimes(1)
  })

  it('retypes a wake on the next delivery when the first one could not reach the pane', async () => {
    const { db, send } = fixture()
    mocks.live.mockReturnValue([liveRecipient()])
    mocks.sendPaneText.mockResolvedValueOnce('skipped')
    const sent = send()
    deliverHandoff(db, sent)
    await flush()
    deliverHandoff(db, sent)
    await flush()
    expect(mocks.sendPaneText).toHaveBeenCalledTimes(2)
  })

  it('waits for the turn to end when the recipient is busy', async () => {
    const { db, send } = fixture()
    mocks.live.mockReturnValue([liveRecipient({ busySince: Date.now() })])
    expect(deliverHandoff(db, send()).delivery).toBe('after-turn')
    await flush()
    expect(mocks.sendPaneText).not.toHaveBeenCalled()
  })

  it('never types into a pane that has an open ask or approve picker', async () => {
    const { db, send } = fixture()
    mocks.live.mockReturnValue([liveRecipient()])
    mocks.pending.mockReturnValue([{ verb: 'ask', params: { sessionId: 'recip-sess' } }])
    expect(deliverHandoff(db, send()).delivery).toBe('after-turn')
    mocks.pending.mockReturnValue([{ verb: 'approve', params: { sessionId: 'recip-sess' } }])
    expect(deliverHandoff(db, send()).delivery).toBe('after-turn')
    await flush()
    expect(mocks.sendPaneText).not.toHaveBeenCalled()
  })

  it('ignores a picker that belongs to a different session', () => {
    const { db, send } = fixture()
    mocks.live.mockReturnValue([liveRecipient()])
    mocks.pending.mockReturnValue([{ verb: 'ask', params: { sessionId: 'someone-else' } }])
    expect(deliverHandoff(db, send()).delivery).toBe('woken')
  })

  it('a pending show card takes no typed answer, so it does not hold the wake back', () => {
    const { db, send } = fixture()
    mocks.live.mockReturnValue([liveRecipient()])
    mocks.pending.mockReturnValue([{ verb: 'show', params: { sessionId: 'recip-sess' } }])
    expect(deliverHandoff(db, send()).delivery).toBe('woken')
  })

  it('leaves a handoff the recipient already read alone, even if it is now closed', () => {
    const { db, send, goStale } = fixture('claude')
    const sent = send()
    db.call('inbox', {}, 'r')
    goStale()
    const out = deliverHandoff(db, sent)
    expect(out.delivery).toBe('next-turn')
    expect(out.message.state).toBe('pending')
  })
})

describe('store handoff queries', () => {
  it('unreadFor lists only pending, never-offered messages for that harness session, oldest first', () => {
    const { db, send, goStale } = fixture()
    const first = send()
    goStale()
    const second = send()
    expect(db.unreadFor('recip-sess').map((m) => m.id)).toEqual([first.id, second.id])
    expect(db.unreadFor('sender-sess')).toEqual([])
    db.call('inbox', {}, 'r')
    expect(db.unreadFor('recip-sess')).toEqual([])
  })

  it('bounce refuses a message that is no longer pending', () => {
    const { db, send } = fixture()
    const sent = send()
    db.call('ack', { message: sent.id, state: 'accepted' }, 'r')
    expect(db.bounce(sent.id, 'closed')).toBeUndefined()
    expect((db.call('inbox', {}, 'r') as CoordinationMessage[])[0].state).toBe('accepted')
  })
})

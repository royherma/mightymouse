import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRelaySessionInfo, AgentTranscriptTurn } from '../../../../shared/types'
import type { CoordinationSnapshot } from '../../../../shared/coordination'
import {
  PRIORITY_COPY,
  PRIORITY_LIMITS,
  localPriority,
  suggestedReply
} from '../../../../shared/session-priority'

const mocks = vi.hoisted(() => ({ call: vi.fn(), transcript: vi.fn() }))
vi.mock('../../../actions/decide-transport', () => ({ callJev: mocks.call }))
vi.mock('../../session-transcript', () => ({ readSessionTranscript: mocks.transcript }))
const snapshot = {
  sessions: [],
  work: [],
  messages: [],
  projects: [],
  events: []
} as unknown as CoordinationSnapshot
const session = (index = 0): AgentRelaySessionInfo => ({
  label: 'same label',
  sessionId: `agent-${index}`,
  since: index,
  tldr: 'Working on the implementation'
})
const go: AgentTranscriptTurn = {
  role: 'agent',
  at: 100,
  text: 'Next: say go and I will implement W1 first, then the contract field and the iOS picker.'
}

beforeEach(() => {
  vi.resetModules()
  mocks.call.mockReset()
  mocks.transcript.mockReset()
})

describe('Sessions priority', () => {
  it.each([0, 1, 63, 100, 150])(
    'preserves all %i sessions without coordination registration',
    async (count) => {
      mocks.call.mockImplementation(async (body) => ({
        answers: Object.fromEntries(Object.keys(body.questions).map((key) => [key, { score: 2 }]))
      }))
      const { computeSessionPriority } = await import('../session-priority')
      const result = await computeSessionPriority(
        Array.from({ length: count }, (_, index) => session(index)),
        'run',
        snapshot
      )
      expect(result.rows).toHaveLength(count)
      expect(new Set(result.rows.map((row) => row.key)).size).toBe(count)
      expect(result.rows.filter((row) => row.level === 2)).toHaveLength(Math.min(count, 100))
      expect(mocks.call.mock.calls.length).toBe(Math.ceil(Math.min(count, 100) / 50))
    }
  )
  it('keeps unknown, missing identity and ended sessions out of inference', async () => {
    const { computeSessionPriority } = await import('../session-priority')
    const result = await computeSessionPriority(
      [
        { ...session(), tldr: '' },
        { ...session(1), sessionId: undefined },
        { ...session(2), stale: true }
      ],
      'run',
      snapshot
    )
    expect(result.rows.every((row) => row.level === null)).toBe(true)
    expect(mocks.call).not.toHaveBeenCalled()
    expect(localPriority({ ...session(), waiting: 1 }).level).toBe(4)
  })
  it('keeps successful chunks when another fails and bounds Unicode bytes', async () => {
    mocks.call
      .mockImplementationOnce(async (body) => ({
        answers: Object.fromEntries(Object.keys(body.questions).map((key) => [key, { score: 3 }]))
      }))
      .mockResolvedValue(null)
    const { computeSessionPriority } = await import('../session-priority')
    const result = await computeSessionPriority(
      Array.from({ length: 100 }, (_, index) => ({ ...session(index), tldr: '界'.repeat(1200) })),
      'run',
      snapshot
    )
    expect(result.status).toBe('partial')
    expect(result.rows.some((row) => row.level === 3)).toBe(true)
    expect(result.rows.some((row) => row.reason === PRIORITY_COPY.failed)).toBe(true)
    for (const [body] of mocks.call.mock.calls)
      expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(PRIORITY_LIMITS.bytes)
  })
  it('reuses unchanged scores and rejects invalid numbers', async () => {
    mocks.call.mockResolvedValue({ answers: { '0': { score: 2 }, '1': { score: NaN } } })
    const { computeSessionPriority } = await import('../session-priority')
    const first = await computeSessionPriority([session(), session(1)], 'a', snapshot)
    expect(first.rows[1].level).toBeNull()
    const next = await computeSessionPriority([session()], 'b', snapshot)
    expect(next.rows[0].source).toBe('cache')
    expect(mocks.call).toHaveBeenCalledTimes(1)
  })
  it('surfaces the complete Go scope and abstains for changed or consequential requests', () => {
    expect(suggestedReply([go])?.scope).toContain('then the contract field and the iOS picker')
    expect(suggestedReply([go, { role: 'you', at: 101, text: 'Go' }])).toBeNull()
    expect(suggestedReply([{ ...go, text: 'Say go and I will deploy to production.' }])).toBeNull()
    expect(suggestedReply([{ ...go, text: 'Working on uploads' }])).toBeNull()
  })
  it('checks the latest question and refuses duplicate or already answered suggestions', async () => {
    mocks.transcript.mockReturnValue([go])
    const { claimSuggestedReply } = await import('../session-priority')
    expect(claimSuggestedReply(session(), { ...go, text: 'older request' }, [])).toBe(false)
    expect(claimSuggestedReply(session(), go, [{ at: 101 }])).toBe(false)
    expect(claimSuggestedReply(session(), go, [])).toBe(true)
    expect(claimSuggestedReply(session(), go, [])).toBe(false)
  })
})

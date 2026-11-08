import { describe, expect, it } from 'vitest'
import { sessionActiveAt, sessionRow, shortAge } from '../relay-status'
import type { AgentRelaySessionInfo } from '../types'

const NOW = new Date(2026, 8, 27, 15, 0).getTime()
const MIN = 60_000
const row = (over: Partial<AgentRelaySessionInfo>) =>
  sessionRow({ label: 'mighty-mouse/dev', since: NOW - 180 * MIN, ...over } as AgentRelaySessionInfo, NOW)

describe('session row Last reply', () => {
  it('survives the turn ending: the turn-end stamp alone still dates the reply', () => {
    expect(row({ lastTurnEndedAt: NOW - 5 * MIN }).lastReply).toMatch(/\(5m ago\)$/)
  })

  it('uses the newest of turn end, handback and activity', () => {
    expect(row({ handedBackAt: NOW - 120 * MIN, lastTurnEndedAt: NOW - 5 * MIN, lastActivityAt: NOW - 60 * MIN }).lastReply).toMatch(/\(5m ago\)$/)
  })

  it('says Working now only while the agent is really mid-turn', () => {
    expect(row({ busySince: NOW - MIN, lastActivityAt: NOW - 10_000 }).lastReply).toBe('Working now')
  })

  it('a turn that never ended (crashed agent) stops claiming Working now', () => {
    expect(row({ busySince: NOW - 30 * MIN, lastActivityAt: NOW - 30 * MIN }).lastReply).toMatch(/\(30m ago\)$/)
  })
})

describe('sessionActiveAt / shortAge', () => {
  it('sorts on the newest of start, busy, turn end and handback', () => {
    expect(sessionActiveAt({ label: 'x', since: 1, busySince: 4, lastTurnEndedAt: 3, handedBackAt: 2 } as AgentRelaySessionInfo)).toBe(4)
    expect(sessionActiveAt({ label: 'x' } as AgentRelaySessionInfo)).toBe(0)
  })

  it('short ages drop the "ago"', () => {
    expect(shortAge(10_000)).toBe('now')
    expect(shortAge(5 * MIN)).toBe('5m')
    expect(shortAge(26 * 60 * MIN)).toBe('1d')
  })
})

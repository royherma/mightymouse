import { describe, it, expect } from 'vitest'
import {
  buildAttentionRows,
  candidatesForJev,
  groupAttentionRows,
  groupForLevel,
  hasReadableWords,
  clampLevel,
  type AttentionCandidate
} from './coordination-attention'
import type { RosterAgent } from './coordination-roster'
import type { CoordinationSession, CoordinationWork, CoordinationMessage } from './coordination'
import type { AgentRelaySessionInfo } from './types'

function session(overrides: Partial<CoordinationSession> = {}): CoordinationSession {
  return {
    id: 's1',
    project: 'p1',
    projectName: 'Project One',
    session: 's1',
    harness: 'claude',
    label: 'claude abc123',
    cwd: '/repo',
    version: '1',
    lastSeen: Date.now(),
    state: 'active',
    stale: false,
    ...overrides
  }
}

function agent(overrides: Partial<RosterAgent> = {}): RosterAgent {
  return {
    session: session(),
    state: 'working',
    work: [],
    messages: [],
    quietFor: 1000,
    ...overrides
  }
}

function work(overrides: Partial<CoordinationWork> = {}): CoordinationWork {
  return {
    project: 'p1',
    id: 'w1',
    title: 'Do the thing',
    acceptance: 'It works',
    owner: 's1',
    generation: 1,
    expiresAt: Date.now() + 100_000,
    state: 'working',
    stage: 'implemented',
    note: '',
    refs: [],
    updatedAt: Date.now(),
    expired: false,
    ...overrides
  }
}

function message(overrides: Partial<CoordinationMessage> = {}): CoordinationMessage {
  return {
    id: 'm1',
    project: 'p1',
    sender: 'other',
    recipient: 's1',
    subject: 'Which Stripe account?',
    body: 'Sandbox or live?',
    refs: [],
    work: null,
    state: 'pending',
    note: '',
    createdAt: Date.now(),
    offeredAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides
  }
}

function candidate(overrides: Partial<AttentionCandidate> = {}): AttentionCandidate {
  return { agent: agent(), ...overrides }
}

describe('candidatesForJev', () => {
  it('never sends a blocked agent to Jev -- the rule already placed it', () => {
    const c = candidate({
      agent: agent({ work: [work({ state: 'blocked' })] }),
      relay: { label: 'x', tldr: 'stuck on auth' } as AgentRelaySessionInfo
    })
    expect(candidatesForJev([c])).toEqual([])
  })

  it('never sends a cold agent -- rules place gone agents at level 0', () => {
    const c = candidate({
      agent: agent({ state: 'gone' }),
      relay: { label: 'x', tldr: 'was doing something' } as AgentRelaySessionInfo
    })
    expect(candidatesForJev([c])).toEqual([])
  })

  it('never sends an agent with no readable words', () => {
    const c = candidate({ agent: agent({ state: 'idle' }) })
    expect(candidatesForJev([c])).toEqual([])
  })

  it('sends a live agent with a tldr and no rule verdict', () => {
    const c = candidate({
      agent: agent({ state: 'working' }),
      relay: { label: 'x', tldr: 'refactoring the router' } as AgentRelaySessionInfo
    })
    expect(candidatesForJev([c])).toEqual([c])
  })
})

describe('groupForLevel', () => {
  it('level 4 always talks to you now', () => {
    expect(groupForLevel(4, false)).toBe('talk')
  })
  it('level 0 with wrap-up available goes to wrap', () => {
    expect(groupForLevel(0, true)).toBe('wrap')
  })
  it('level 0 without wrap-up available can still just wait', () => {
    expect(groupForLevel(0, false)).toBe('wait')
  })
  it('level 2 (working fine) waits', () => {
    expect(groupForLevel(2, true)).toBe('wait')
  })
})

describe('buildAttentionRows', () => {
  it('a blocked claim outranks any Jev score and needs no call', () => {
    const c = candidate({ agent: agent({ work: [work({ state: 'blocked' })] }) })
    const [row] = buildAttentionRows([c], new Map())
    expect(row.group).toBe('talk')
    expect(row.level).toBe(4)
    expect(row.scored).toBe(false)
    expect(row.reason).toBe('Stuck on its work')
  })

  it('a pending incoming handoff needs no call and quotes the subject', () => {
    const c = candidate({ agent: agent({ messages: [{ message: message(), outgoing: false, otherLabel: 'Someone' }] }) })
    const [row] = buildAttentionRows([c], new Map())
    expect(row.group).toBe('talk')
    expect(row.reason).toBe('Asking: Which Stripe account?')
  })

  it('an outgoing (already-answered) message never forces talk', () => {
    const c = candidate({
      agent: agent({
        messages: [{ message: message({ state: 'accepted' }), outgoing: true, otherLabel: 'Someone' }]
      })
    })
    const [row] = buildAttentionRows([c], new Map())
    expect(row.group).not.toBe('talk')
  })

  it('a scored row uses the clamped position from Jev', () => {
    const c = candidate({
      agent: agent(),
      relay: { label: 'x', tldr: 'building the thing', canWrapUp: false } as AgentRelaySessionInfo
    })
    const scores = new Map([[c.agent.session.id, 3.6]])
    const [row] = buildAttentionRows([c], scores)
    expect(row.scored).toBe(true)
    expect(row.level).toBe(4)
    expect(row.group).toBe('talk')
  })

  it('an unscored, unruled row defaults to can-wait rather than vanishing', () => {
    const c = candidate({
      agent: agent(),
      relay: { label: 'x', tldr: 'working', canWrapUp: true } as AgentRelaySessionInfo
    })
    const [row] = buildAttentionRows([c], new Map())
    expect(row.scored).toBe(false)
    expect(row.group).toBe('wait')
  })
})

describe('clampLevel', () => {
  it('clamps below the floor and above the ceiling', () => {
    expect(clampLevel(-1)).toBe(0)
    expect(clampLevel(9)).toBe(4)
    expect(clampLevel(2.5)).toBe(3)
  })
})

describe('hasReadableWords', () => {
  it('is false with no relay session at all', () => {
    expect(hasReadableWords(undefined)).toBe(false)
  })
  it('is true with only a preview, no tldr', () => {
    expect(hasReadableWords({ label: 'x', preview: 'last line of output' } as AgentRelaySessionInfo)).toBe(true)
  })
})

describe('groupAttentionRows', () => {
  it('keeps a stable order: highest level first within talk, longest-quiet first in wrap', () => {
    const low = candidate({
      agent: agent({ session: session({ id: 's-low' }), quietFor: 5000 }),
      relay: { label: 'x', tldr: 'a', canWrapUp: false } as AgentRelaySessionInfo
    })
    const high = candidate({
      agent: agent({ session: session({ id: 's-high' }), quietFor: 1000 }),
      relay: { label: 'x', tldr: 'b', canWrapUp: false } as AgentRelaySessionInfo
    })
    const rows = buildAttentionRows(
      [low, high],
      new Map([
        ['s-low', 3],
        ['s-high', 4]
      ])
    )
    const groups = groupAttentionRows(rows)
    expect(groups.talk.map((r) => r.agent.session.id)).toEqual(['s-high', 's-low'])
  })
})

import { describe, it, expect } from 'vitest'
import { buildRoster } from './coordination-roster'
import type {
  CoordinationMessage,
  CoordinationSession,
  CoordinationSnapshot,
  CoordinationWork
} from './coordination'

function session(overrides: Partial<CoordinationSession> = {}): CoordinationSession {
  return {
    id: 'gone1',
    project: 'p1',
    projectName: 'Project One',
    session: 'gone1',
    harness: 'claude',
    label: 'Quiet agent',
    cwd: '/repo',
    version: '1',
    lastSeen: Date.now() - 3 * 3_600_000,
    state: 'active',
    stale: true,
    ...overrides
  }
}

function work(overrides: Partial<CoordinationWork> = {}): CoordinationWork {
  return {
    project: 'p1',
    id: 'w1',
    title: 'Do the thing',
    acceptance: 'It works',
    owner: 'gone1',
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
    sender: 'gone1',
    recipient: 'live1',
    subject: 'Check this',
    body: 'Please',
    refs: [],
    work: null,
    state: 'completed',
    note: '',
    createdAt: Date.now(),
    offeredAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides
  }
}

const live = session({ id: 'live1', session: 'live1', label: 'Live agent', stale: false, lastSeen: Date.now() })

function snapshot(
  parts: Partial<Pick<CoordinationSnapshot, 'work' | 'messages'>>
): Pick<CoordinationSnapshot, 'projects' | 'sessions' | 'work' | 'messages' | 'events'> {
  return { projects: [], sessions: [session(), live], work: [], messages: [], events: [], ...parts }
}

const shown = (r: ReturnType<typeof buildRoster>): string[] =>
  r.projects.flatMap((p) => p.agents.map((a) => a.session.id)).sort()

describe('buildRoster hides a cold agent unless live work or an open handoff pins it', () => {
  it('a cold agent whose work is all finished is hidden', () => {
    const r = buildRoster(snapshot({ work: [work({ state: 'done' }), work({ id: 'w2', state: 'released' })] }))
    expect(shown(r)).toEqual(['live1'])
    expect(r.hidden).toBe(1)
  })

  it('a cold agent whose sent handoffs are all settled is hidden', () => {
    const r = buildRoster(
      snapshot({ messages: [message({ state: 'completed' }), message({ id: 'm2', state: 'declined' })] })
    )
    expect(shown(r)).toEqual(['live1'])
    expect(r.hidden).toBe(1)
  })

  it('a cold agent still holding a live claim stays on the list as gone', () => {
    const r = buildRoster(snapshot({ work: [work({ state: 'working' })] }))
    expect(shown(r)).toEqual(['gone1', 'live1'])
    expect(r.hidden).toBe(0)
    const agent = r.projects[0].agents.find((a) => a.session.id === 'gone1')
    expect(agent?.state).toBe('gone')
  })

  it('a cold agent with an accepted, not yet completed handoff stays on the list', () => {
    const r = buildRoster(snapshot({ messages: [message({ state: 'accepted' })] }))
    expect(shown(r)).toEqual(['gone1', 'live1'])
    expect(r.hidden).toBe(0)
  })

  it('showCold reveals the finished cold agent too', () => {
    const r = buildRoster(snapshot({ work: [work({ state: 'done' })] }), true)
    expect(shown(r)).toEqual(['gone1', 'live1'])
    expect(r.hidden).toBe(0)
  })
})

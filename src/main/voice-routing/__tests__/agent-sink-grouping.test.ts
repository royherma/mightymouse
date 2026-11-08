/**
 * The project fan-out that decides where a dictated note lands. `slug` becomes
 * a Jev question key matched back by exact string, so two projects collapsing
 * to one slug routes a note into the wrong project's agent -- the failure this
 * pins. The description is the only text Jev ranks a project on, so its parts
 * (count, how many are working, what they're on) have to survive.
 */

import { describe, it, expect, vi } from 'vitest'
import { groupAgentSinksByProject, isAgentSinkId, type AgentSink } from '../agent-sinks'
import type { AgentSession } from '../../agent-relay/mcp/http-listener'

vi.mock('../../ipc/agent-relay', () => ({ rowName: (s: AgentSession) => s.stated }))

function sink(project: string, over: Partial<AgentSession> = {}): AgentSink {
  const session = { label: 'agent', since: 0, ...over } as AgentSession
  return {
    kind: 'agent',
    id: `agent:${project}-${over.sessionId ?? over.label ?? 'x'}`,
    label: 'Agent',
    description: '',
    session,
    project,
    branch: 'dev',
    activity: 'idle'
  }
}

describe('groupAgentSinksByProject', () => {
  it('returns nothing for no sinks', () => {
    expect(groupAgentSinksByProject([])).toEqual([])
  })

  it('puts every agent of a project in one group', () => {
    const groups = groupAgentSinksByProject([
      sink('ShowAndTell', { sessionId: 'a' }),
      sink('portal', { sessionId: 'b' }),
      sink('ShowAndTell', { sessionId: 'c' })
    ])
    expect(groups).toHaveLength(2)
    const showAndTell = groups.find((g) => g.project === 'ShowAndTell')
    expect(showAndTell?.sinks.map((s) => s.session.sessionId)).toEqual(['a', 'c'])
  })

  it('keeps first-seen project order', () => {
    const groups = groupAgentSinksByProject([
      sink('portal', { sessionId: 'a' }),
      sink('ShowAndTell', { sessionId: 'b' }),
      sink('portal', { sessionId: 'c' })
    ])
    expect(groups.map((g) => g.project)).toEqual(['portal', 'ShowAndTell'])
  })

  it('gives distinct projects distinct slugs', () => {
    // A collision here is a note delivered to the wrong project's agent.
    const groups = groupAgentSinksByProject([
      sink('ShowAndTell'),
      sink('portal'),
      sink('workspace-memory')
    ])
    const slugs = groups.map((g) => g.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
  })

  it('lowercases and collapses punctuation into a code-safe slug', () => {
    const [group] = groupAgentSinksByProject([sink('My Repo.v2 (fork)')])
    expect(group.slug).toBe('my_repo_v2_fork')
    expect(group.slug).toMatch(/^[a-z0-9_]+$/)
  })

  it("falls back to 'unknown' when the name has no usable characters", () => {
    const [group] = groupAgentSinksByProject([sink('---')])
    expect(group.slug).toBe('unknown')
  })

  it('singularizes the count for one agent and pluralizes past that', () => {
    const [one] = groupAgentSinksByProject([sink('solo')])
    expect(one.description).toContain('1 agent')
    expect(one.description).not.toContain('1 agents')

    const [two] = groupAgentSinksByProject([
      sink('pair', { sessionId: 'a' }),
      sink('pair', { sessionId: 'b' })
    ])
    expect(two.description).toContain('2 agents')
  })

  it('counts only busy sessions as working, and omits the clause at zero', () => {
    const [idle] = groupAgentSinksByProject([sink('repo', { sessionId: 'a' })])
    expect(idle.description).not.toContain('working right now')

    const [mixed] = groupAgentSinksByProject([
      sink('repo', { sessionId: 'a', busySince: 1 }),
      sink('repo', { sessionId: 'b' }),
      sink('repo', { sessionId: 'c', busySince: 2 })
    ])
    expect(mixed.description).toContain('3 agents')
    expect(mixed.description).toContain('2 working right now')
  })

  it('lists what agents are on, capped at three and skipping empty subjects', () => {
    const [group] = groupAgentSinksByProject([
      sink('repo', { sessionId: 'a', tldr: 'fixing the cycle' }),
      sink('repo', { sessionId: 'b', tldr: '' }),
      sink('repo', { sessionId: 'c', tldr: 'writing tests' }),
      sink('repo', { sessionId: 'd', tldr: 'third thing' }),
      sink('repo', { sessionId: 'e', tldr: 'fourth thing' })
    ] as AgentSink[])
    expect(group.description).toContain('fixing the cycle; writing tests; third thing')
    expect(group.description).not.toContain('fourth thing')
  })

  it('omits the subject clause entirely when no agent reported one', () => {
    const [group] = groupAgentSinksByProject([sink('repo', { sessionId: 'a' })])
    expect(group.description).toBe('repo — 1 agent')
  })

  it('names the project first, which is what Jev ranks on', () => {
    const [group] = groupAgentSinksByProject([sink('ShowAndTell', { sessionId: 'a' })])
    expect(group.description.startsWith('ShowAndTell — ')).toBe(true)
  })
})

describe('isAgentSinkId', () => {
  it('separates agent ids from a bundle id in the shared id space', () => {
    expect(isAgentSinkId('agent:abc')).toBe(true)
    expect(isAgentSinkId('com.apple.Safari')).toBe(false)
    expect(isAgentSinkId('skill:deploy')).toBe(false)
    expect(isAgentSinkId('')).toBe(false)
  })
})

import { describe, expect, it, vi } from 'vitest'
import type { HideoutAsk } from '../../shared/hideout'
import type { AgentRelaySessionInfo } from '../../shared/types'

const checklists = vi.hoisted(() => new Map<string, { items: { label: string; status: string }[] }>())
vi.mock('../agent-relay/session-checklist', () => ({ readSessionChecklist: (id: string) => checklists.get(id) }))

import { newsBetween, recapToday, sinceLastLook, takeLook, type HideoutLook } from '../hideout-news'

const session = (name: string, over: Partial<AgentRelaySessionInfo> = {}): AgentRelaySessionInfo =>
  ({ label: name, project: { name }, sessionId: `s-${name}`, ...over }) as AgentRelaySessionInfo
const ask = (id: string, project: string | null, question = 'which db.'): HideoutAsk => ({
  id,
  project,
  question,
  options: ['a', 'b'],
  recommended: 0,
  approve: false,
  pcts: [],
  createdAt: 0
})
const look = (projects: HideoutLook['projects'], asks: HideoutLook['asks'] = {}): HideoutLook => ({ projects, asks })

describe('takeLook', () => {
  it('folds sessions of one project into its latest handback and known verdict', () => {
    const l = takeLook(
      [session('pf', { sessionId: 'a', handedBackAt: 5 }), session('pf', { sessionId: 'b', handedBackAt: 9, tldr: 'shipping' })],
      { a: 'looping' },
      [ask('r1', null)]
    )
    expect(l).toEqual({ projects: { pf: { verdict: 'looping', handedBackAt: 9, tldr: 'shipping' } }, asks: { r1: 'An agent' } })
  })
})

describe('newsBetween', () => {
  it('announces an agent that handed back since the last look, with its summary', () => {
    const news = newsBetween(look({ pf: { verdict: '', handedBackAt: 1 } }), look({ pf: { verdict: '', handedBackAt: 2, tldr: 'Tests pass.' } }), [])
    expect(news).toHaveLength(1)
    expect(news[0]).toMatchObject({ key: 'done:pf:2:', project: 'pf', detail: 'Tests pass.' })
    expect(news[0]!.line).toContain('pf')
  })

  it('a verdict turning done counts as finished; a brand-new project does not', () => {
    const before = look({ pf: { verdict: 'on_track', handedBackAt: 1 } })
    const now = look({ pf: { verdict: 'done', handedBackAt: 1 }, mm: { verdict: 'done', handedBackAt: 9 } })
    expect(newsBetween(before, now, []).map((n) => n.key)).toEqual(['done:pf:1:done'])
  })

  it('announces each new question once, as a question', () => {
    const asks = [ask('r1', 'pf'), ask('r2', null, 'ship it?!')]
    const news = newsBetween(look({}, { r1: 'pf' }), look({}), asks)
    expect(news).toHaveLength(1)
    expect(news[0]).toMatchObject({ key: 'ask:r2', project: 'An agent' })
    expect(news[0]!.line).toMatch(/ship it\?$/)
  })

  it('nothing changed, nothing to say', () => {
    const l = look({ pf: { verdict: 'done', handedBackAt: 3 } }, { r1: 'pf' })
    expect(newsBetween(l, l, [ask('r1', 'pf')])).toEqual([])
  })
})

describe('sinceLastLook', () => {
  it('is silent when nothing changed', () => {
    const l = look({ pf: { verdict: '', handedBackAt: 1 } })
    expect(sinceLastLook(l, l)).toBeNull()
  })

  it('lists finished, new questions (once per project), stuck, started and stopped', () => {
    const before = look({ a: { verdict: '', handedBackAt: 1 }, b: { verdict: 'on_track', handedBackAt: 1 }, gone: { verdict: '', handedBackAt: 1 } })
    const now = look(
      { a: { verdict: '', handedBackAt: 2 }, b: { verdict: 'looping', handedBackAt: 1 } },
      { q1: 'b', q2: 'b' }
    )
    expect(sinceLastLook(before, now)).toBe('Since you last looked, a finished, b has a new question, b got stuck and gone stopped.')
  })

  it('caps at four and counts the rest', () => {
    const now = look({ p1: { verdict: '', handedBackAt: 0 }, p2: { verdict: '', handedBackAt: 0 }, p3: { verdict: '', handedBackAt: 0 }, p4: { verdict: '', handedBackAt: 0 }, p5: { verdict: '', handedBackAt: 0 }, p6: { verdict: '', handedBackAt: 0 } })
    expect(sinceLastLook(look({}), now)).toBe('Since you last looked, p1 started, p2 started, p3 started, p4 started and 2 more.')
  })
})

describe('recapToday', () => {
  it('counts ticked-off items per agent, busiest first, naming the last one', () => {
    checklists.set('s-pf', { items: [{ label: 'Add login', status: 'completed' }, { label: 'Fix tests.', status: 'completed' }, { label: 'Deploy', status: 'pending' }] })
    checklists.set('s-mm', { items: [] })
    expect(recapToday([session('mm', { tldr: 'Refactoring the HUD.' }), session('pf')])).toBe(
      '2 things done across 2 agents. pf got 2 things done, last one: Fix tests. mm is on: Refactoring the HUD.'
    )
  })

  it('no sessions says so', () => {
    expect(recapToday([])).toBe('No agents ran today that I can see.')
  })
})

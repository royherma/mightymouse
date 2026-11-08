import { describe, expect, it, vi } from 'vitest'
import type { ActionContextSnapshot, ActionDefinition } from '../../../shared/action-engine'

vi.mock('../../analytics', () => ({ track: vi.fn() }))
vi.mock('../../store/action-prefs', () => ({ ACTION_PREFS: {} }))
vi.mock('../registry', () => ({ listAllActions: vi.fn() }))
vi.mock('../context-window', () => ({ snapshotContext: vi.fn(), noteActionRun: vi.fn() }))
vi.mock('../action-log', () => ({ appendActionDecision: vi.fn(), appendActionOutcome: vi.fn() }))
vi.mock('../personal-model', () => ({
  getHabits: () => [],
  isMuted: () => false,
  habitBoost: () => 1,
  slotValueBoost: () => 1
}))
vi.mock('../decide-transport', () => ({ callJev: vi.fn() }))
vi.mock('../executor', () => ({ executeAction: vi.fn() }))

const { parseActionAnswers } = await import('../decide')
const { resolveActions } = await import('../engine')

const REWRITE = 'input.rewrite'

function action(id: string): ActionDefinition {
  return {
    id,
    capabilityId: id.split('.')[0],
    title: id,
    when: id,
    icon: 'zap',
    runKind: 'builtin',
    safety: 'safe',
    triggers: ['voice'],
    slots: [],
    run: async () => ({ ok: true, line: '' })
  } as ActionDefinition
}

const ACTIONS = ['app.a', 'app.b', 'app.c', REWRITE].map(action)

function answers(choice: string, probabilities: Record<string, number>, noul = 0.9): Record<string, unknown> {
  return { action: { choice, probabilities }, is_command: { noul } }
}

function resolve(a: Record<string, unknown>, trigger: 'voice' | 'idle' = 'voice') {
  return resolveActions(
    {
      runId: `r-${Math.random()}`,
      trigger,
      transcript: 'x',
      context: { frontApp: 'Notes', selectionText: '' } as ActionContextSnapshot,
      actions: ACTIONS,
      state: {},
      questions: {}
    },
    a,
    { latencyMs: 1, via: 'proxy', inputTokens: 1 }
  )
}

describe('parseActionAnswers with a reserved action', () => {
  it('returns only the chosen action when the reserved one is below its floor', () => {
    const got = parseActionAnswers(ACTIONS, answers('app.a', { 'app.a': 0.9, [REWRITE]: 0.004 }))
    expect(got.map((p) => [p.actionId, p.chosen])).toEqual([['app.a', true]])
  })

  it('lets the reserved action ride along at or above its floor, marked not chosen', () => {
    const got = parseActionAnswers(ACTIONS, answers('app.a', { 'app.a': 0.9, [REWRITE]: 0.005 }))
    expect(got.map((p) => [p.actionId, p.chosen, p.probability])).toEqual([
      ['app.a', true, 0.9],
      [REWRITE, false, 0.005]
    ])
  })

  it('offers the reserved action even when Jev picked none', () => {
    const got = parseActionAnswers(ACTIONS, answers('none', { none: 0.7, [REWRITE]: 0.3 }))
    expect(got.map((p) => p.actionId)).toEqual([REWRITE])
  })

  it('never offers a non-reserved action Jev did not choose, however likely', () => {
    const got = parseActionAnswers(ACTIONS, answers('app.a', { 'app.a': 0.3, 'app.b': 0.6 }))
    expect(got.map((p) => p.actionId)).toEqual(['app.a'])
  })

  it('ignores a chosen id that was never offered', () => {
    expect(parseActionAnswers(ACTIONS, answers('app.zzz', { 'app.zzz': 1 }))).toEqual([])
  })

  it('returns nothing without an action answer', () => {
    expect(parseActionAnswers(ACTIONS, {})).toEqual([])
  })
})

describe('resolveActions card with a reserved action', () => {
  it('puts the reserved row on the card ranked by its own odds', () => {
    const card = resolve(answers('app.a', { 'app.a': 0.4, [REWRITE]: 0.55 }))
    expect(card?.proposals.map((p) => p.actionId)).toEqual([REWRITE, 'app.a'])
  })

  it('never preselects the reserved row when Jev did not choose it', () => {
    const card = resolve(answers('none', { [REWRITE]: 0.95 }))
    expect(card?.proposals.map((p) => [p.actionId, p.preselected])).toEqual([[REWRITE, false]])
  })

  it('still preselects a chosen top row above the voice floor on a command', () => {
    const card = resolve(answers('app.a', { 'app.a': 0.8, [REWRITE]: 0.1 }))
    expect(card?.proposals.map((p) => [p.actionId, p.preselected])).toEqual([
      ['app.a', true],
      [REWRITE, false]
    ])
  })

  it('drops an idle card whose best row is under the idle floor', () => {
    expect(resolve(answers('none', { [REWRITE]: 0.5 }), 'idle')).toBeNull()
  })
})

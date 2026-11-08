import { describe, expect, it } from 'vitest'
import {
  HIDEOUT_FULL,
  HIDEOUT_SIDE,
  hideoutAsks,
  hideoutStuck,
  placeHideout,
  planHideout,
  type HideoutAsk,
  type HideoutWorld
} from '../hideout'
import type { RelayRequestWire } from '../phone-remote-protocol'
import type { AgentRelaySessionInfo } from '../types'

const approveAsk: HideoutAsk = {
  id: 'r1',
  project: 'petfomo',
  question: 'deploy prod',
  options: ['Approve', 'Deny'],
  recommended: 0,
  approve: true,
  pcts: [],
  createdAt: 1
}
const dbAsk: HideoutAsk = {
  id: 'r2',
  project: 'mighty-mouse',
  question: 'which db?',
  options: ['sqlite', 'postgres', 'json file'],
  recommended: 0,
  approve: false,
  pcts: [79, 17, 4],
  createdAt: 2
}

const world = (over: Partial<HideoutWorld> = {}): HideoutWorld => ({
  open: true,
  paused: false,
  projects: ['mighty-mouse', 'petfomo'],
  stuck: null,
  asks: [],
  focus: null,
  place: { ...HIDEOUT_FULL },
  ...over
})
const kinds = (text: string, w: HideoutWorld) => planHideout(text, w).commands.map((c) => c.kind)

describe('planHideout answering agent decisions', () => {
  it('a stray "yes" does not approve an ask you are not looking at', () => {
    expect(planHideout('yes', world({ asks: [approveAsk] })).commands).toEqual([])
  })

  it('a stray "yes" does not approve an ask whose project is unknown either', () => {
    const orphan = { ...approveAsk, id: 'r9', project: null }
    expect(planHideout('yes', world({ asks: [orphan] })).commands).toEqual([])
  })

  it('"yes" / "no" answer the ask you are looking at', () => {
    const w = world({ asks: [approveAsk], focus: { kind: 'ask', id: 'r1' } })
    expect(planHideout('yes', w).commands).toEqual([{ kind: 'answer', askId: 'r1', option: 0 }])
    expect(planHideout('no', w).commands).toEqual([{ kind: 'answer', askId: 'r1', option: 1 }])
  })

  it('"don\'t approve that" denies, never approves', () => {
    const w = world({ asks: [approveAsk], focus: { kind: 'ask', id: 'r1' } })
    expect(planHideout("don't approve that", w).commands).toEqual([{ kind: 'answer', askId: 'r1', option: 1 }])
  })

  it('naming the project approves its ask without focusing it first', () => {
    expect(planHideout('approve petfomo', world({ asks: [approveAsk] })).commands).toEqual([
      { kind: 'answer', askId: 'r1', option: 0 }
    ])
  })

  it('picks by position or by the option\'s own words', () => {
    const w = world({ asks: [dbAsk], focus: { kind: 'ask', id: 'r2' } })
    expect(planHideout('the second one', w).commands).toEqual([{ kind: 'answer', askId: 'r2', option: 1 }])
    expect(planHideout('go with the json file', w).commands).toEqual([{ kind: 'answer', askId: 'r2', option: 2 }])
  })
})

describe('planHideout commands', () => {
  it('does nothing while closed except open', () => {
    const w = world({ open: false })
    expect(planHideout('status', w)).toEqual({ commands: [], complete: false })
    expect(kinds('open the hideout', w)).toEqual(['open'])
  })

  it('while paused only resume and close get through', () => {
    const w = world({ paused: true })
    expect(kinds('status', w)).toEqual([])
    expect(kinds('resume', w)).toEqual(['resume'])
  })

  it('"how many agents" and "what\'s running" answer from the Hideout', () => {
    expect(kinds('how many agents', world())).toEqual(['status'])
    expect(kinds("what's running", world())).toEqual(['status'])
  })

  it('"what did my agents do today" is the recap', () => {
    expect(kinds('what did my agents do today', world())).toEqual(['recap'])
  })

  it('"tell <project> to X" sends X to that project', () => {
    expect(planHideout('tell petfomo to run the tests.', world()).commands).toEqual([
      { kind: 'tell', project: 'petfomo', name: 'petfomo', message: 'Run the tests' }
    ])
  })

  it('"tell it to X" goes to the agent you are watching', () => {
    const w = world({ focus: { kind: 'agent', project: 'mighty-mouse' } })
    expect(planHideout('tell it to stop', w).commands).toEqual([
      { kind: 'tell', project: 'mighty-mouse', name: 'it', message: 'Stop' }
    ])
  })

  it('"watch <project>" pins it', () => {
    expect(planHideout('watch mighty mouse', world()).commands).toEqual([{ kind: 'watch', project: 'mighty-mouse' }])
  })

  it('one sentence runs several commands', () => {
    expect(planHideout("open the hideout and then what's running", world({ open: false }))).toEqual({
      commands: [{ kind: 'open' }, { kind: 'status' }],
      complete: true
    })
  })

  it('speech it cannot match is left incomplete for the agent', () => {
    expect(planHideout('refactor the billing module', world()).complete).toBe(false)
  })
})

describe('placeHideout', () => {
  it('"move left" docks a rail on the left edge', () => {
    expect(placeHideout('move left', HIDEOUT_FULL)).toEqual({ place: { x: 0, y: 0, w: 0.26, h: 1 }, name: 'Moved.' })
  })

  it('"top right corner" is a quarter-height rail in that corner', () => {
    const r = placeHideout('top right corner', HIDEOUT_FULL)!
    expect(r.place.x).toBeCloseTo(0.74)
    expect(r.place).toMatchObject({ y: 0, w: 0.26, h: 0.5 })
  })

  it('"bigger" grows around its centre and stays on screen', () => {
    const r = placeHideout('bigger', HIDEOUT_SIDE)!
    expect(r.name).toBe('Bigger.')
    expect(r.place.w).toBeCloseTo(0.325)
    expect(r.place.h).toBe(1)
    expect(r.place.x + r.place.w).toBeLessThanOrEqual(1)
  })

  it('"expand" and "side view" jump to the two presets', () => {
    expect(placeHideout('expand', HIDEOUT_SIDE)).toEqual({ place: HIDEOUT_FULL, name: 'Full screen.' })
    expect(placeHideout('side view', HIDEOUT_FULL)).toEqual({ place: HIDEOUT_SIDE, name: 'Side view.' })
  })

  it('ordinary speech is not a move', () => {
    expect(placeHideout('move the build', HIDEOUT_FULL)).toBeNull()
    expect(placeHideout('a lot', HIDEOUT_FULL)).toBeNull()
  })
})

describe('hideoutAsks', () => {
  const wire = (over: Partial<RelayRequestWire> & Pick<RelayRequestWire, 'id' | 'verb' | 'params'>): RelayRequestWire =>
    ({ createdAt: 0, timeoutMs: 1, status: 'pending', response: null, ...over }) as RelayRequestWire
  const sessions = [{ label: 'x', cwd: '/w/pf', project: { name: 'petfomo' } }] as AgentRelaySessionInfo[]

  it('turns pending approve/ask cards into voice-answerable asks, oldest first', () => {
    const asks = hideoutAsks(
      [
        wire({ id: 'b', verb: 'ask', createdAt: 5, params: { question: 'db?', options: ['a', 'b'], decision: { best: 9, pcts: [60, 40] } } as never }),
        wire({ id: 'a', verb: 'approve', createdAt: 1, params: { action: 'deploy', detail: 'prod', cwd: '/w/pf' } as never }),
        wire({ id: 'c', verb: 'ask', createdAt: 2, params: { question: 'name?' } as never })
      ],
      sessions
    )
    expect(asks.map((a) => a.id)).toEqual(['a', 'b'])
    expect(asks[0]).toMatchObject({ project: 'petfomo', question: 'deploy - prod', options: ['Approve', 'Deny'], approve: true })
    expect(asks[1]).toMatchObject({ recommended: 0, pcts: [60, 40] })
  })

  it('a stuck verdict on a live session names its project; a stale one does not', () => {
    const list = [
      { label: 'a', sessionId: 's1', stale: true, project: { name: 'old' } },
      { label: 'b', sessionId: 's2', project: { name: 'petfomo' } }
    ] as AgentRelaySessionInfo[]
    expect(hideoutStuck(list, { s1: 'looping', s2: 'off_goal' })).toBe('petfomo')
    expect(hideoutStuck(list, { s1: 'looping', s2: 'on_track' })).toBeNull()
  })
})

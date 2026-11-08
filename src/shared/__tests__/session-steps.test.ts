import { describe, expect, it } from 'vitest'
import { CONFIG } from '../config'
import { foldSteps, waitingWords } from '../session-steps'
import type { AgentRelaySessionInfo } from '../types'

const said = (role: string, text: string, at: number) => ({ kind: 'said', role, text, at })
const L = CONFIG.UI_LABELS

describe('foldSteps: tool lines collapse into one steps row per run', () => {
  const turns = [
    said('you', 'fix the test', 1),
    said('tool', 'Read a.ts', 2),
    said('tool', 'Edit a.ts', 3),
    said('agent', 'Done.', 4),
    said('tool', 'Bash npm test', 5),
    { kind: 'question', at: 6 }
  ]

  it('groups consecutive tool lines and starts a new group after any other row', () => {
    expect(foldSteps(turns, true)).toEqual([
      turns[0],
      { kind: 'steps', at: 2, texts: ['Read a.ts', 'Edit a.ts'] },
      turns[3],
      { kind: 'steps', at: 5, texts: ['Bash npm test'] },
      turns[5]
    ])
  })

  it('hides tool lines entirely when steps are off', () => {
    expect(foldSteps(turns, false)).toEqual([turns[0], turns[3], turns[5]])
  })

  it('a tool line with no text still counts as a step', () => {
    expect(foldSteps([{ kind: 'said', role: 'tool', at: 1 }], true)).toEqual([{ kind: 'steps', at: 1, texts: [''] }])
  })

  it('does not mutate the turns it was given', () => {
    const input = [said('tool', 'a', 1), said('tool', 'b', 2)]
    foldSteps(input, true)
    expect(input).toEqual([said('tool', 'a', 1), said('tool', 'b', 2)])
  })
})

describe('waitingWords: what the thread says while the agent is quiet', () => {
  const live = { sessionId: 's1' } as AgentRelaySessionInfo

  it('ended beats everything, then starting, then compacting', () => {
    const compactingNoId = { compactingSince: Date.now() } as AgentRelaySessionInfo
    expect(waitingWords(compactingNoId, [], true)).toBe(L.CODE_SESSION_ENDED)
    expect(waitingWords(compactingNoId, [], false)).toBe(L.CODE_SESSION_STARTING)
    expect(waitingWords({ ...live, compactingSince: Date.now() }, [], false)).toBe(L.CODE_SESSION_COMPACTING)
  })

  it('reading until the agent has said anything, thinking after', () => {
    expect(waitingWords(live, [{ role: 'you' }], false)).toBe(L.CODE_SESSION_READING)
    expect(waitingWords(live, [{ role: 'you' }, { role: 'agent' }], false)).toBe(L.CODE_SESSION_THINKING)
  })
})

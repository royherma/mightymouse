import { describe, it, expect } from 'vitest'
import { isAudioDestination, PHONE_AUDIO_TO } from '../types'
import {
  decideTalk,
  talkRankingOf,
  talkId,
  talkText,
  TALK,
  type TalkCandidate,
  type TalkRanking
} from '../talk'

const FLOOR = 0.5

const agent: TalkCandidate = {
  id: 'a1',
  kind: 'agent',
  label: 'api-server',
  detail: 'main',
  project: { name: 'Api' }
}
const other: TalkCandidate = { id: 'a2', kind: 'agent', label: 'web-app', detail: '' }
const fresh: TalkCandidate = {
  id: 'n1',
  kind: 'new-agent',
  label: 'Docs',
  detail: 'Starts fresh with just this'
}

function ranking(over: Partial<TalkRanking> = {}): TalkRanking {
  return {
    mode: { computer: 0.2, agent: 0.8 },
    modeConfidence: 0.9,
    helper: { a1: 0.7, a2: 0.2, n1: 0.1 },
    helperPick: 'a1',
    helperConfidence: 0.8,
    ...over
  }
}

describe('decideTalk', () => {
  it('does it on the computer when nothing can rank', () => {
    const d = decideTalk([agent], null, FLOOR)
    expect(d.auto).toBe(true)
    expect(d.pick).toBe(TALK.COMPUTER_ID)
    expect(d.options.map((o) => o.id)).toEqual([TALK.COMPUTER_ID])
  })

  it('does it on the computer when there are no agents at all', () => {
    expect(decideTalk([], ranking(), FLOOR).pick).toBe(TALK.COMPUTER_ID)
  })

  it('stays on the computer when sure it is computer work', () => {
    const d = decideTalk([agent], ranking({ mode: { computer: 0.9, agent: 0.1 } }), FLOOR)
    expect(d).toMatchObject({ auto: true, pick: TALK.COMPUTER_ID })
  })

  it('hands off on its own only when sure of the mode and of the agent', () => {
    const d = decideTalk([agent, other, fresh], ranking(), FLOOR)
    expect(d.auto).toBe(true)
    expect(d.pick).toBe('a1')
    expect(d.options.map((o) => o.id)).toEqual(['a1', 'a2', TALK.COMPUTER_ID])
    expect(d.options[0]).toMatchObject({ percent: 56, project: { name: 'Api' } })
  })

  it('asks when it is agent work but the agent is unclear', () => {
    const d = decideTalk([agent, other], ranking({ helperConfidence: 0.3 }), FLOOR)
    expect(d.auto).toBe(false)
    expect(d.options[0].id).toBe('a1')
    expect(d.options.at(-1)?.id).toBe(TALK.COMPUTER_ID)
  })

  it('asks when the named agent is not one of the candidates', () => {
    const d = decideTalk([other, fresh], ranking({ helperPick: 'gone' }), FLOOR)
    expect(d.auto).toBe(false)
    expect(d.pick).toBe('a2')
  })

  it('asks with the computer first when it leans computer but is unsure', () => {
    const d = decideTalk(
      [agent],
      ranking({ mode: { computer: 0.55, agent: 0.45 }, modeConfidence: 0.3 }),
      FLOOR
    )
    expect(d.auto).toBe(false)
    expect(d.pick).toBe(TALK.COMPUTER_ID)
    expect(d.options.map((o) => o.id)).toEqual([TALK.COMPUTER_ID, 'a1'])
  })

  it('never offers more than the option cap', () => {
    const many = Array.from(
      { length: 6 },
      (_, i): TalkCandidate => ({ id: `x${i}`, kind: 'agent', label: `x${i}`, detail: '' })
    )
    const d = decideTalk(
      many,
      ranking({ helperPick: 'x0', helperConfidence: 0.2, helper: {} }),
      FLOOR
    )
    expect(d.options).toHaveLength(TALK.MAX_OPTIONS)
  })
})

describe('talkRankingOf', () => {
  const answers = { probabilities: { computer: 0.3, agent: 0.7 }, confidence: 0.6 }

  it('reads the mode answer next to the helper ranking', () => {
    const r = talkRankingOf({
      answers: { [TALK.MODE_QUESTION]: answers },
      helperProbabilities: { a1: 1 },
      helperSinkId: 'a1',
      confidence: 0.9
    })
    expect(r).toEqual({
      mode: { computer: 0.3, agent: 0.7 },
      modeConfidence: 0.6,
      helper: { a1: 1 },
      helperPick: 'a1',
      helperConfidence: 0.9
    })
  })

  it('gives up when the mode question went unanswered', () => {
    expect(talkRankingOf(null)).toBeNull()
    expect(
      talkRankingOf({ answers: {}, helperProbabilities: {}, helperSinkId: '', confidence: 0 })
    ).toBeNull()
  })

  it('drops junk probabilities and a missing confidence', () => {
    const r = talkRankingOf({
      answers: { [TALK.MODE_QUESTION]: { probabilities: { agent: 0.8, computer: 'lots' } } },
      helperProbabilities: {},
      helperSinkId: '',
      confidence: 0
    })
    expect(r?.mode).toEqual({ agent: 0.8 })
    expect(r?.modeConfidence).toBe(0)
  })
})

describe('talk wire input', () => {
  it('clamps ids and text and rejects non-strings', () => {
    expect(talkId('x'.repeat(200))).toHaveLength(TALK.ID_MAX_CHARS)
    expect(talkId(42)).toBe('')
    expect(talkText('  hi  ')).toBe('hi')
    expect(talkText(null)).toBe('')
    expect(talkText('y'.repeat(TALK.TEXT_MAX_CHARS + 10))).toHaveLength(TALK.TEXT_MAX_CHARS)
  })
})

describe('isAudioDestination', () => {
  it('accepts every known destination and nothing else', () => {
    for (const to of Object.values(PHONE_AUDIO_TO)) expect(isAudioDestination(to)).toBe(true)
    expect(isAudioDestination('note')).toBe(true)
    expect(isAudioDestination('shell')).toBe(false)
    expect(isAudioDestination(undefined)).toBe(false)
  })
})

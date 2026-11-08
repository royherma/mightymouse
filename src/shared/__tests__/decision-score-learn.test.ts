import { describe, expect, it } from 'vitest'
import { decisionInputError, learnYourWeights, scoreDecision, winsLine, youLine, type DecisionWire } from '../decision-score'

const EVEN = { fast: 20, cheap: 20, undo: 20, lasts: 20, handsoff: 20 }
const RAMP_SCORES = [
  [80, 75, 55, 80, 80],
  [75, 50, 95, 60, 75],
  [100, 40, 90, 20, 100]
]

describe('scoreDecision edges', () => {
  it('percentages always add up to exactly 100', () => {
    const r = scoreDecision(EVEN, [
      [33, 33, 33, 33, 33],
      [33, 33, 33, 33, 33],
      [33, 33, 33, 33, 33]
    ])
    expect(r.pcts.reduce((a, b) => a + b, 0)).toBe(100)
    expect(r.best).toBe(0)
    expect(r.lead).toBe(0)
  })

  it('a clear winner gets a lead in points', () => {
    const r = scoreDecision(EVEN, [
      [50, 50, 50, 50, 50],
      [90, 90, 90, 90, 90]
    ])
    expect(r.best).toBe(1)
    expect(r.lead).toBe(40)
    expect(r.pcts).toEqual([0, 100])
  })
})

describe('decisionInputError', () => {
  it('names the missing weights', () => {
    expect(decisionInputError(2, { fast: 50, cheap: 50 }, [])).toBe(
      'weights is missing undo, lasts, handsoff. Send all five: fast, cheap, undo, lasts, handsoff.'
    )
  })

  it('names the short score row, counting from 1', () => {
    expect(decisionInputError(2, EVEN, [[1, 2, 3, 4, 5], [1, 2, 3]])).toBe(
      'scores row 2 has 3 numbers. Each row needs 5: fast, cheap, undo, lasts, handsoff.'
    )
  })

  it('needs two options and tolerates weights off by one from rounding', () => {
    expect(decisionInputError(1, EVEN, [[1, 2, 3, 4, 5]])).toBe('scores needs at least 2 options to compare.')
    expect(decisionInputError(2, { ...EVEN, fast: 21 }, [[1, 2, 3, 4, 5], [1, 2, 3, 4, 5]])).toBeNull()
  })
})

describe('learnYourWeights', () => {
  it('with no history every angle weighs the same', () => {
    expect(learnYourWeights([])).toEqual(EVEN)
  })

  it('an angle your picks always beat the average on gets the weight', () => {
    const row = { scores: [[50, 90, 50, 50, 50], [50, 10, 50, 50, 50]], picked: 0 }
    expect(learnYourWeights([row, row])).toEqual({ fast: 4, cheap: 84, undo: 4, lasts: 4, handsoff: 4 })
  })

  it('picking the worse option on an angle does not count against it', () => {
    const row = { scores: [[50, 90, 50, 50, 50], [50, 10, 50, 50, 50]], picked: 1 }
    expect(learnYourWeights([row])).toEqual(EVEN)
  })
})

describe('card lines', () => {
  const d: DecisionWire = { weights: EVEN, scores: RAMP_SCORES, totals: [], pcts: [], best: 0, lead: 0 }
  const keys = ['sqlite', 'postgres', 'json file']

  it('says what the pick wins and loses on against another option', () => {
    expect(winsLine(d, 1, keys)).toBe('sqlite wins on Fast, Cheap, Lasts and Hands-off. postgres wins on Undoable.')
  })

  it('names your heaviest angle and whether the pick agrees with you', () => {
    const youWeights = { fast: 10, cheap: 50, undo: 20, lasts: 10, handsoff: 10 }
    expect(youLine({ ...d, youIdx: 0, youWeights }, keys)).toBe('You usually weigh cheap most, and so does sqlite.')
    expect(youLine({ ...d, youIdx: 2, youWeights }, keys)).toBe('You usually weigh cheap most - so json file gets the You usually tag.')
    expect(youLine(d, keys)).toBe('')
  })
})

import { describe, expect, it } from 'vitest'
import { scoreDecision } from '../decision-score'

describe('scoreDecision', () => {
  it('ramp gives 79 / 17 / 4', () => {
    const r = scoreDecision(
      { fast: 20, cheap: 25, undo: 15, lasts: 30, handsoff: 10 },
      [
        [80, 75, 55, 80, 80],
        [75, 50, 95, 60, 75],
        [100, 40, 90, 20, 100]
      ]
    )
    expect(r.totals).toEqual([75, 67.25, 59.5])
    expect(r.pcts).toEqual([79, 17, 4])
    expect(r.best).toBe(0)
  })

  it('ship gives 65 / 32 / 3', () => {
    const r = scoreDecision(
      { fast: 25, cheap: 10, undo: 30, lasts: 15, handsoff: 20 },
      [
        [90, 90, 70, 75, 90],
        [70, 90, 95, 75, 60],
        [40, 70, 95, 90, 40]
      ]
    )
    expect(r.pcts).toEqual([65, 32, 3])
  })
})

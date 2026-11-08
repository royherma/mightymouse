import { describe, expect, it } from 'vitest'
import { CONFIG } from '@shared/config'
import { rubBegin, rubMove, rubQualifies, type RubTrace } from '../rub-toggle'

const { RUB_BAND_PX, RUB_DRIFT_PX, RUB_LEG_PX, RUB_WINDOW_MS } = CONFIG.PHONE_REMOTE

/** Drive a whole gesture: start at `x0`, then walk to each x in turn. */
function run(x0: number, xs: number[], y = 20, step = 40): RubTrace | null {
  let trace = rubBegin({ x: x0, y, t: 0 })
  if (!trace) return null
  xs.forEach((x, i) => {
    trace = rubMove(trace!, { x, y, t: (i + 1) * step })
  })
  return trace
}

describe('rubBegin', () => {
  it('rejects a touch below the band', () => {
    expect(rubBegin({ x: 100, y: RUB_BAND_PX + 1, t: 0 })).toBeNull()
  })

  it('accepts a touch inside the band', () => {
    expect(rubBegin({ x: 100, y: RUB_BAND_PX - 1, t: 0 })).not.toBeNull()
  })
})

describe('rubQualifies', () => {
  it('fires on left-right-left', () => {
    const L = RUB_LEG_PX + 10
    expect(rubQualifies(run(200, [200 - L, 200, 200 - L])!)).toBe(true)
  })

  it('fires on the mirrored right-left-right', () => {
    const L = RUB_LEG_PX + 10
    expect(rubQualifies(run(200, [200 + L, 200, 200 + L])!)).toBe(true)
  })

  it('does not fire on one long stroke', () => {
    expect(rubQualifies(run(50, [150, 250, 350, 450])!)).toBe(false)
  })

  it('does not fire on a single back-and-forth', () => {
    const L = RUB_LEG_PX + 10
    expect(rubQualifies(run(200, [200 - L, 200])!)).toBe(false)
  })

  it('ignores sub-threshold wobble', () => {
    const w = RUB_LEG_PX - 5
    expect(rubQualifies(run(200, [200 - w, 200, 200 - w, 200, 200 - w, 200])!)).toBe(false)
  })

  it('dies when the finger drifts down out of the band', () => {
    const L = RUB_LEG_PX + 10
    let trace = rubBegin({ x: 200, y: 20, t: 0 })!
    trace = rubMove(trace, { x: 200 - L, y: 20, t: 40 })
    trace = rubMove(trace, { x: 200, y: RUB_BAND_PX + 1, t: 80 })
    trace = rubMove(trace, { x: 200 - L, y: 20, t: 120 })
    expect(trace.dead).toBe(true)
    expect(rubQualifies(trace)).toBe(false)
  })

  it('dies on vertical drift within the band', () => {
    const L = RUB_LEG_PX + 10
    let trace = rubBegin({ x: 200, y: 2, t: 0 })!
    trace = rubMove(trace, { x: 200 - L, y: 2 + RUB_DRIFT_PX + 1, t: 40 })
    expect(trace.dead).toBe(true)
  })

  it('dies when the rub takes longer than the window', () => {
    const L = RUB_LEG_PX + 10
    let trace = rubBegin({ x: 200, y: 20, t: 0 })!
    trace = rubMove(trace, { x: 200 - L, y: 20, t: 100 })
    trace = rubMove(trace, { x: 200, y: 20, t: RUB_WINDOW_MS + 1 })
    expect(trace.dead).toBe(true)
  })

  it('stays dead once dead', () => {
    const L = RUB_LEG_PX + 10
    let trace = rubBegin({ x: 200, y: 2, t: 0 })!
    trace = rubMove(trace, { x: 200, y: 2 + RUB_DRIFT_PX + 1, t: 40 })
    trace = rubMove(trace, { x: 200 - L, y: 2, t: 80 })
    trace = rubMove(trace, { x: 200, y: 2, t: 120 })
    trace = rubMove(trace, { x: 200 - L, y: 2, t: 160 })
    expect(rubQualifies(trace)).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { parseUsageMeter, usagePercentLeft, usageResetText, type UsageMeter } from '../billing-math'

const ROW = {
  allowed: true,
  limits_on: true,
  plan: 'plan_starter',
  plan_left_cents: 130,
  plan_limit_cents: 650,
  extra_cents: 200,
  resets_at: '2026-10-09T00:00:00Z',
}

const meter = (planLeftCents: number, planLimitCents = 650): UsageMeter => ({
  plan: 'free',
  planLeftCents,
  planLimitCents,
  extraCents: 0,
  resetsAt: null,
})

describe('parseUsageMeter', () => {
  it('reads a usage_status row into the meter', () => {
    expect(parseUsageMeter(ROW)).toEqual({
      plan: 'plan_starter',
      planLeftCents: 130,
      planLimitCents: 650,
      extraCents: 200,
      resetsAt: '2026-10-09T00:00:00Z',
    })
  })

  it('returns null while limits are off, so the dollar balance keeps showing', () => {
    for (const limits_on of [false, undefined, 'true', 1]) {
      expect(parseUsageMeter({ ...ROW, limits_on }), `limits_on=${String(limits_on)}`).toBeNull()
    }
  })

  it('returns null when there is no usable limit to divide by', () => {
    for (const plan_limit_cents of [0, -5, null, undefined, '650']) {
      expect(parseUsageMeter({ ...ROW, plan_limit_cents }), `limit=${String(plan_limit_cents)}`).toBeNull()
    }
  })

  it('returns null for a failed or empty read', () => {
    for (const row of [null, undefined, 'granted', 42]) expect(parseUsageMeter(row)).toBeNull()
  })

  it('fills in the plan name, cents and refill time a sparse row leaves out', () => {
    expect(parseUsageMeter({ limits_on: true, plan_limit_cents: 100 })).toEqual({
      plan: 'free',
      planLeftCents: 0,
      planLimitCents: 100,
      extraCents: 0,
      resetsAt: null,
    })
  })
})

describe('usagePercentLeft', () => {
  it('is the share of the plan allowance still unspent', () => {
    expect(usagePercentLeft(meter(130))).toBe(20)
    expect(usagePercentLeft(meter(650))).toBe(100)
    expect(usagePercentLeft(meter(0))).toBe(0)
  })

  it('never leaves 0 to 100, even with an overdrawn or over-full bucket', () => {
    expect(usagePercentLeft(meter(-40))).toBe(0)
    expect(usagePercentLeft(meter(900))).toBe(100)
  })
})

describe('usageResetText', () => {
  const now = new Date(2026, 9, 2, 10, 0, 0)
  const at = (days: number, hours = 0): string =>
    new Date(2026, 9, 2 + days, 10 + hours, 0, 0).toISOString()

  it('says nothing without a refill time, or with one it cannot read', () => {
    expect(usageResetText(null, now)).toBe('')
    expect(usageResetText('not a date', now)).toBe('')
  })

  it('a refill time already behind us lands on the next message', () => {
    expect(usageResetText(at(0, -1), now)).toBe('Refills on your next message')
    expect(usageResetText(at(0), now)).toBe('Refills on your next message')
  })

  it('later the same day reads as today', () => {
    expect(usageResetText(at(0, 5), now)).toBe('Refills today')
  })

  it('inside a week it names the weekday', () => {
    const friday = new Date(2026, 9, 2 + 3, 10).toLocaleDateString(undefined, { weekday: 'long' })
    expect(usageResetText(at(3), now)).toBe(`Refills ${friday}`)
  })

  it('a week or more out it names the date instead of a weekday that would read as this week', () => {
    const date = new Date(2026, 9, 9, 10).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    expect(usageResetText(at(7), now)).toBe(`Refills ${date}`)
    expect(usageResetText(at(7), now)).not.toMatch(/day$/)
  })
})

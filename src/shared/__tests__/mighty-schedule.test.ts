import { describe, it, expect } from 'vitest'
import { isJobDue, lastScheduledFire } from '../mighty-schedule'

// All times are constructed in the machine's local zone (the scheduler uses local
// hours), so these tests build Date objects with local Y/M/D/H and reason locally.

// 2026-06-10 is a Wednesday. Build local times off it.
const wed = (h: number, m = 0): Date => new Date(2026, 5, 10, h, m, 0, 0)
const sat = (h: number): Date => new Date(2026, 5, 13, h, 0, 0, 0) // 2026-06-13 = Saturday

describe('lastScheduledFire', () => {
  it('manual has no scheduled fire', () => {
    expect(lastScheduledFire('manual', 8, wed(12))).toBeNull()
  })

  it('hourly → top of the current hour', () => {
    const fire = lastScheduledFire('hourly', 0, wed(14, 37))
    expect(fire?.getHours()).toBe(14)
    expect(fire?.getMinutes()).toBe(0)
  })

  it('daily after the hour → today at that hour', () => {
    const fire = lastScheduledFire('daily', 8, wed(10))
    expect(fire?.getDate()).toBe(10)
    expect(fire?.getHours()).toBe(8)
  })

  it('daily before the hour → yesterday at that hour', () => {
    const fire = lastScheduledFire('daily', 8, wed(6))
    expect(fire?.getDate()).toBe(9) // Tuesday
    expect(fire?.getHours()).toBe(8)
  })

  it('weekdays on Saturday before/after hour → falls back to Friday', () => {
    const fire = lastScheduledFire('weekdays', 8, sat(12))
    expect(fire?.getDate()).toBe(12) // Friday 2026-06-12
    expect(fire?.getHours()).toBe(8)
  })
})

describe('isJobDue', () => {
  it('never-run daily job past its hour is due', () => {
    expect(isJobDue('daily', 8, null, wed(10))).toBe(true)
  })

  it('job already run after the latest fire is NOT due', () => {
    const ranAt = wed(8, 5) // ran just after today's 8am fire
    expect(isJobDue('daily', 8, ranAt, wed(10))).toBe(false)
  })

  it('job last run before today’s fire IS due again', () => {
    const ranYesterday = new Date(2026, 5, 9, 8, 1, 0, 0)
    expect(isJobDue('daily', 8, ranYesterday, wed(10))).toBe(true)
  })

  it('manual job is never due', () => {
    expect(isJobDue('manual', 8, null, wed(23))).toBe(false)
  })

  it('weekdays job does not fire on the weekend window when already run Friday', () => {
    const ranFriday = new Date(2026, 5, 12, 8, 1, 0, 0)
    // Saturday: latest fire is Friday 8am, which the job already ran → not due.
    expect(isJobDue('weekdays', 8, ranFriday, sat(12))).toBe(false)
  })

  it('daily before its hour with a run from before yesterday’s fire is due (catch-up)', () => {
    const ranTwoDaysAgo = new Date(2026, 5, 8, 8, 0, 0, 0)
    // Wed 6am → latest fire is Tue 8am; last run (Mon) predates it → due.
    expect(isJobDue('daily', 8, ranTwoDaysAgo, wed(6))).toBe(true)
  })
})

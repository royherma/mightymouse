import { MightySchedule } from './types'

// Pure schedule math for the Mighty scheduler — no electron / fs deps so it unit-tests
// cleanly. "Due" means: the job's most recent scheduled fire-time is in the past AND
// it hasn't run since that fire-time. This makes the tick idempotent (a job fires once
// per window) and gives free catch-up: a window that elapsed while the app was quit is
// still "due" on next launch because lastRun predates it.

/** Is `day` (local) a weekday (Mon-Fri)? */
function isWeekday(day: Date): boolean {
  const d = day.getDay() // 0 = Sun … 6 = Sat
  return d >= 1 && d <= 5
}

/**
 * The most recent scheduled fire-time at or before `now`, or null if there is no
 * applicable past fire (e.g. weekdays schedule evaluated on a weekend with no prior
 * weekday window today). Times are in the machine's LOCAL zone (hour is local).
 */
export function lastScheduledFire(schedule: MightySchedule, hour: number, now: Date): Date | null {
  if (schedule === 'manual') return null

  if (schedule === 'hourly') {
    // Top of the current hour.
    const d = new Date(now)
    d.setMinutes(0, 0, 0)
    return d
  }

  // daily | weekdays: today's fire-time at `hour:00` if already passed, else yesterday's.
  const todayFire = new Date(now)
  todayFire.setHours(hour, 0, 0, 0)

  // Walk back up to 7 days to find the most recent VALID (passed) fire-time. Covers
  // weekdays skipping Sat/Sun, and the "before hour today" → yesterday case.
  for (let back = 0; back < 8; back++) {
    const candidate = new Date(todayFire)
    candidate.setDate(todayFire.getDate() - back)
    if (candidate.getTime() > now.getTime()) continue // hasn't fired yet
    if (schedule === 'weekdays' && !isWeekday(candidate)) continue
    return candidate
  }
  return null
}

/**
 * Is the job due to run at `now`? True when there's a past scheduled fire-time that
 * the job hasn't run since. `lastRun` null = never run = due on the first applicable
 * window.
 */
export function isJobDue(
  schedule: MightySchedule,
  hour: number,
  lastRun: Date | null,
  now: Date
): boolean {
  if (schedule === 'manual') return false
  const fire = lastScheduledFire(schedule, hour, now)
  if (!fire) return false
  if (!lastRun) return true
  return lastRun.getTime() < fire.getTime()
}

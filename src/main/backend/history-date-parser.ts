/**
 * history-date-parser.ts — turn a natural phrase into a date window + search terms,
 * with ZERO model call. Powers the keyword-routed recall path (free backends) and
 * sanity-checks the Haiku classifier's window (paid backend).
 *
 * Windows are [from, to) and computed in the user's LOCAL day boundaries (the main
 * process runs on their machine), matching how analytics buckets days. Returns null
 * when no date phrase is present, so the caller can fall back to plain text search.
 */

export interface DateRange {
  from: Date
  to: Date
}

/** Start of the local day `offsetDays` ago (0 = today). */
function startOfDay(offsetDays = 0): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - offsetDays)
  return d
}

/** Start of the local week (Monday) `offsetWeeks` ago. */
function startOfWeek(offsetWeeks = 0): Date {
  const d = startOfDay()
  const dow = (d.getDay() + 6) % 7 // 0 = Monday
  d.setDate(d.getDate() - dow - offsetWeeks * 7)
  return d
}

function startOfMonth(offsetMonths = 0): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(1)
  d.setMonth(d.getMonth() - offsetMonths)
  return d
}

const NOW = (): Date => new Date()

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

// Spelled-out small numbers, since "last seven days" is at least as common as "last 7 days".
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14
}

/** "last N days"/"past N days" (digit or spelled-out) → [N days ago, now). Null if no match. */
function lastNDays(t: string): DateRange | null {
  const m = t.match(/\b(?:last|past)\s+(\d+|[a-z]+)\s+days?\b/)
  if (!m) return null
  const n = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : NUMBER_WORDS[m[1]]
  if (!n || n <= 0) return null
  return { from: startOfDay(n - 1), to: NOW() }
}

/** The most recent past occurrence of a weekday (today excluded), as a [day, nextDay) window. */
function lastWeekday(target: number): DateRange {
  const today = startOfDay()
  let back = (today.getDay() - target + 7) % 7
  if (back === 0) back = 7 // "monday" said on a Monday means the previous Monday
  const from = startOfDay(back)
  const to = new Date(from)
  to.setDate(to.getDate() + 1)
  return { from, to }
}

/**
 * Parse a date window from free text. Checks specific phrases before generic ones
 * so "last week" wins over a bare "week". Returns null when nothing matches.
 */
export function parseDateRange(text: string): DateRange | null {
  const t = text.toLowerCase()

  if (/\byesterday\b/.test(t)) return { from: startOfDay(1), to: startOfDay(0) }
  if (/\bthis morning\b/.test(t)) {
    const from = startOfDay(0)
    const noon = new Date(from)
    noon.setHours(12, 0, 0, 0)
    return { from, to: noon }
  }
  if (/\b(today|so far today|earlier today)\b/.test(t)) return { from: startOfDay(0), to: NOW() }

  const nDays = lastNDays(t)
  if (nDays) return nDays

  if (/\blast week\b/.test(t)) return { from: startOfWeek(1), to: startOfWeek(0) }
  if (/\b(this week|past week)\b/.test(t)) return { from: startOfWeek(0), to: NOW() }
  if (/\blast month\b/.test(t)) return { from: startOfMonth(1), to: startOfMonth(0) }
  if (/\b(this month|past month)\b/.test(t)) return { from: startOfMonth(0), to: NOW() }

  // Weekday names ("on tuesday", "last friday").
  for (let i = 0; i < WEEKDAYS.length; i++) {
    if (new RegExp(`\\b${WEEKDAYS[i]}\\b`).test(t)) return lastWeekday(i)
  }

  return null
}

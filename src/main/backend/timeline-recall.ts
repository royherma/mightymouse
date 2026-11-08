/**
 * timeline-recall.ts — Assemble a CHRONOLOGICAL RECAP of a period from two merged
 * sources, for a "what did I do this week" style query (RecallIntent 'timeline').
 *
 * Distinct from:
 *   - assembleHistoryRecall (context-memory.ts): answers a POINTED question from
 *     history rows, ranked by relevance, ungrouped.
 *   - assembleActivityRecall (activity-recall.ts): ranks ambient activity segments
 *     against a query, ungrouped.
 *
 * A timeline is neither a ranked answer nor a single source — it's a day-by-day story.
 * So this module:
 *   1. Takes history entries (what the user asked MightyMouse) + activity segments
 *      (what apps/sites they used), each already windowed to the period.
 *   2. Buckets both by LOCAL day, oldest-first.
 *   3. Emits one block per day: a "## Mon Jul 7" header, then the asks, then the
 *      apps/sites — so the model narrates chronologically instead of answering one Q.
 *   4. Greedily packs to the char budget. When the budget bites, OLDER days are
 *      dropped first (we keep the most recent days) — a recap of "this week" is more
 *      useful ending on today than trailing off mid-Tuesday.
 *
 * Both sources are optional: activity is gated behind PREFS.getContextLog() by the
 * caller, so a timeline with logging off is just the history side. An empty period
 * returns an honest "no activity" block (never ''), so the model says so plainly.
 */

import type { HistoryEntry } from '../../shared/types'
import type { ActivitySegment } from './activity-recall'
import { packBlocks } from './recall-core'
import { parseTs } from '../store/history'

/** Max asks listed under one day (a heavy day shouldn't eat the whole budget). */
const MAX_ASKS_PER_DAY = 8

/** Max activity segments listed under one day. */
const MAX_ACTIVITY_PER_DAY = 8

/** Local `YYYY-MM-DD` key for bucketing — stable across the day regardless of time. */
function dayKey(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Human day label for a block header, e.g. "Mon Jul 7". */
function dayLabel(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric'
  })
}

/** Local `h:mm` clock for one entry line. */
function clock(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/** One history ask → a compact `- 2:14pm asked: "…" (in Chrome)` line. */
function formatAsk(e: HistoryEntry): string {
  const ms = parseTs(e.ts).getTime()
  const verb = e.mode === 'act' ? 'ran' : e.mode === 'rewrite' ? 'rewrote' : 'asked'
  const instr = e.instruction.length > 100 ? e.instruction.slice(0, 100) + '…' : e.instruction
  const where = e.front_app ? ` (in ${e.front_app})` : ''
  return `- ${clock(ms)} ${verb}: "${instr}"${where}`
}

/** One activity segment → a compact `- 9:03am App · host — title` line. */
function formatActivity(seg: ActivitySegment): string {
  const head = `${seg.app}${seg.host ? ` · ${seg.host}` : ''}`
  const title = seg.titles.length > 0 ? ` — ${seg.titles[0]}` : ''
  return `- ${clock(seg.startMs)} ${head}${title}`
}

/** A day's worth of both sources, ready to format. */
interface DayBucket {
  ms: number // representative timestamp (earliest event) for label + sort
  asks: HistoryEntry[]
  activity: ActivitySegment[]
}

/** Build one text block for a day: header, then asks, then apps/sites. */
function formatDay(bucket: DayBucket): string {
  const lines: string[] = [`## ${dayLabel(bucket.ms)}`]

  const asks = bucket.asks.slice(0, MAX_ASKS_PER_DAY)
  if (asks.length > 0) {
    lines.push('Asked MightyMouse:')
    for (const a of asks) lines.push(formatAsk(a))
    if (bucket.asks.length > asks.length) lines.push(`- …and ${bucket.asks.length - asks.length} more`)
  }

  const activity = bucket.activity.slice(0, MAX_ACTIVITY_PER_DAY)
  if (activity.length > 0) {
    lines.push('Apps & sites used:')
    for (const s of activity) lines.push(formatActivity(s))
    if (bucket.activity.length > activity.length) {
      lines.push(`- …and ${bucket.activity.length - activity.length} more`)
    }
  }

  if (asks.length === 0 && activity.length === 0) lines.push('(no recorded activity)')
  return lines.join('\n')
}

/**
 * Assemble a chronological, day-bucketed recap blob from history asks + activity
 * segments (both already windowed to the period). Days are emitted oldest→newest so
 * the model reads them in order; when the budget bites, the OLDEST days are dropped
 * (most-recent days survive). Returns an honest empty block, never '', so a period
 * with nothing recorded produces a plain "no activity" answer rather than a
 * hallucinated one.
 *
 * @param entries   History rows in the window (any order — bucketed by their ts).
 * @param segments  Activity segments in the window (any order — bucketed by startMs).
 * @param budget    Char budget for the whole blob.
 */
export function assembleTimelineRecall(
  entries: HistoryEntry[],
  segments: ActivitySegment[],
  budget: number
): string {
  const buckets = new Map<string, DayBucket>()

  const bucketFor = (ms: number): DayBucket => {
    const key = dayKey(ms)
    let b = buckets.get(key)
    if (!b) {
      b = { ms, asks: [], activity: [] }
      buckets.set(key, b)
    }
    if (ms < b.ms) b.ms = ms // earliest event anchors the day's label/sort
    return b
  }

  for (const e of entries) {
    const ms = parseTs(e.ts).getTime()
    if (isNaN(ms)) continue
    bucketFor(ms).asks.push(e)
  }
  for (const seg of segments) {
    if (isNaN(seg.startMs)) continue
    bucketFor(seg.startMs).activity.push(seg)
  }

  const header = '## Your timeline (recap the period below using ONLY these records, day by day)\n\n'
  if (buckets.size === 0) {
    return `${header}No recorded activity was found for this period.`
  }

  // Newest day first so packBlocks keeps recent days when the budget bites; the
  // day headers still carry the date, so the model can order them chronologically.
  const days = [...buckets.values()].sort((a, b) => b.ms - a.ms)
  // Sort each day's contents oldest→newest within the day for a natural read.
  for (const d of days) {
    d.asks.sort((a, b) => parseTs(a.ts).getTime() - parseTs(b.ts).getTime())
    d.activity.sort((a, b) => a.startMs - b.startMs)
  }

  return packBlocks(header, '', days.map(formatDay), budget)
}

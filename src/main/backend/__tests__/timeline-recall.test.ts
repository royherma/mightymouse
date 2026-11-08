/**
 * Tests for timeline-recall.ts — day-bucketed chronological recap of a period,
 * merging MightyMouse history (asks) + ambient activity (apps/sites).
 *
 * Covers:
 *   1. Merges both sources under per-day headers, one block per local day
 *   2. Empty period → honest "no activity" block (never '')
 *   3. Budget bite drops the OLDEST days, keeps the most recent
 *   4. Per-day caps on asks/activity with "…and N more" overflow
 */

import { describe, it, expect } from 'vitest'
import { assembleTimelineRecall } from '../timeline-recall'
import type { ActivitySegment } from '../activity-recall'
import type { HistoryEntry } from '../../../shared/types'

// Build a LOCAL timestamp for (day, hour) so bucketing (which uses local time) is
// stable regardless of the machine's timezone — a UTC ISO string near midnight would
// land on a different local day and make the day-bucket assertions flaky.
function localTs(year: number, month: number, day: number, hour = 12): string {
  return new Date(year, month - 1, day, hour, 0, 0).toISOString()
}

function ask(ts: string, instruction: string, frontApp = 'Google Chrome'): HistoryEntry {
  return {
    schema_version: 1,
    run_id: `r:${ts}`,
    ts,
    duration_s: 1,
    instruction,
    mode: 'ask',
    selection: '',
    selection_chars: 0,
    ok: true,
    backend: 'claude',
    model: '',
    ctx_attached: false,
    front_app: frontApp
  }
}

function seg(startMs: number, app: string, host: string | null, title?: string): ActivitySegment {
  return {
    app,
    host,
    urls: host ? [`https://${host}/`] : [],
    titles: title ? [title] : [],
    snippets: [],
    startMs,
    endMs: startMs + 60_000
  }
}

const BIG_BUDGET = 100_000

// Day blocks are the "## " lines minus the one top-level section header. Locale-safe
// (doesn't assume the day-label format, which varies by machine locale).
function dayHeaderCount(blob: string): number {
  const all = (blob.match(/^## /gm) || []).length
  return Math.max(0, all - 1)
}

describe('assembleTimelineRecall', () => {
  it('merges history + activity into one block per local day', () => {
    const blob = assembleTimelineRecall(
      [ask(localTs(2026, 7, 7, 10), 'fix the billing bug')],
      [seg(new Date(2026, 6, 7, 11).getTime(), 'Google Chrome', 'github.com', 'PR #12')],
      BIG_BUDGET
    )
    expect(blob).toContain('Asked MightyMouse:')
    expect(blob).toContain('fix the billing bug')
    expect(blob).toContain('Apps & sites used:')
    expect(blob).toContain('github.com')
    // One day block. All "## " lines minus the top section header = day count.
    expect(dayHeaderCount(blob)).toBe(1)
  })

  it('emits a separate block per day and keeps the section header', () => {
    const blob = assembleTimelineRecall(
      [
        ask(localTs(2026, 7, 6, 10), 'day one task'),
        ask(localTs(2026, 7, 7, 10), 'day two task')
      ],
      [],
      BIG_BUDGET
    )
    expect(dayHeaderCount(blob)).toBe(2)
    expect(blob).toContain('day one task')
    expect(blob).toContain('day two task')
  })

  it('returns an honest empty block (never blank) for a period with no records', () => {
    const blob = assembleTimelineRecall([], [], BIG_BUDGET)
    expect(blob).not.toBe('')
    expect(blob.toLowerCase()).toContain('no recorded activity')
  })

  it('drops the OLDEST days first when the budget bites', () => {
    // Three distinct days; a budget that only fits ~one day block.
    const entries = [
      ask(localTs(2026, 7, 5, 10), 'oldest day work'),
      ask(localTs(2026, 7, 6, 10), 'middle day work'),
      ask(localTs(2026, 7, 7, 10), 'newest day work')
    ]
    const blob = assembleTimelineRecall(entries, [], 220)
    // Most-recent day survives, oldest is cut.
    expect(blob).toContain('newest day work')
    expect(blob).not.toContain('oldest day work')
  })

  it('caps asks per day and shows an overflow line', () => {
    const many: HistoryEntry[] = []
    for (let i = 0; i < 12; i++) {
      // All on the SAME local day (hours 8–19) so the 8-per-day cap trips.
      many.push(ask(localTs(2026, 7, 7, 8 + i), `task number ${i}`))
    }
    const blob = assembleTimelineRecall(many, [], BIG_BUDGET)
    expect(blob).toMatch(/…and \d+ more/)
  })
})

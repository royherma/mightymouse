/**
 * Analytics IPC — the usage-stats window's data (KPIs, series, heatmap, feedback,
 * suggestions) and the manual AI-insight generator. Extracted verbatim from the old
 * monolithic `ipc.ts`.
 */
import { ipcMain } from 'electron'
import { CHANNELS } from '../../shared/ipc'
import { PATHS } from '../store/paths'
import { PREFS } from '../store/prefs'
import { HISTORY, parseTs } from '../store/history'
import { FEEDBACK } from '../store/feedback'
import { SPEECH } from '../store/speech'
import { AGENT_SESSIONS } from '../store/agent-sessions'
import { readAgentSpend, type AgentSpendRow } from '../agent-relay/session-spend'
import { modelDisplayName } from '../../shared/model-label'
import { runBackend } from '../backend/runner'
import { OutcomeStore, SUGGESTION_DECISIONS } from '../insights/outcome-store'
import type {
  AnalyticsData,
  AnalyticsInsightSeed,
  AnalyticsRange,
  HistoryEntry,
  SpeechData,
  AgentSessionsData,
  AgentSpendData,
  AgentSpendTotals,
  SuggestionsData,
  DecisionBucket,
  SeriesBucket,
  SeriesGranularity,
  HeatCell,
  FeedbackData,
  FeedbackSeriesBucket,
  AppMode,
  ModeBucket,
  AppBucket,
  DurBucket,
  HourBucket,
  FeedbackRating
} from '../../shared/types'

// `YYYY-MM-DD` in the USER'S LOCAL timezone (the main process runs on their
// machine). All day/week bucketing must use this, NOT `toISOString().slice(0,10)`
// — toISOString is UTC, so a run at 11pm local lands on the next UTC day and gets
// mis-bucketed by the UTC offset. getHours()/getDay() are already local, so this
// keeps hour-of-day, day, week, heatmap and streaks all on the same local clock.
function localDateKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** How many recent corrections the Feedback & learning section lists (newest 20). */
const ANALYTICS_FEEDBACK_RECENT = 20

function buildAnalyticsData(range: AnalyticsRange = 'alltime', spendRows: AgentSpendRow[] = []): {
  data: AnalyticsData
  insightSeed: AnalyticsInsightSeed
} {
  // ── 1. Read history (decoded + decrypted via the store, so analytics works
  // whether or not encryption is on) ────────────────────────────────────────
  const allEntries: HistoryEntry[] = HISTORY.readAllEntries()

  // ── 2. Apply range filter for KPIs / charts (heatmap always uses all) ────
  const now = new Date()
  const cutoff = new Date(now)
  if (range === 'daily') cutoff.setHours(0, 0, 0, 0)
  else if (range === 'weekly') cutoff.setDate(now.getDate() - 7)
  else if (range === 'monthly') cutoff.setDate(now.getDate() - 30)
  else cutoff.setFullYear(1970)

  const entries = allEntries.filter((e) => {
    if (!e.ts) return false
    return parseTs(e.ts) >= cutoff
  })

  // ── 3. KPIs ───────────────────────────────────────────────────────────────
  // Captures (screenshot / recording) live in the same history but are NOT LLM
  // runs — split them out so they don't inflate the run KPIs. Listen is already
  // tracked via SPEECH below, so "captures" here = screenshots + recordings only.
  const captureEntries = entries.filter(
    (e) => e.capture_kind === 'screenshot' || e.capture_kind === 'recording'
  )
  const runEntries = entries.filter((e) => !e.capture_kind)
  const totalCaptures = captureEntries.length

  const totalRuns = runEntries.length
  const okCount = runEntries.filter((e) => e.ok !== false).length
  const successRate = totalRuns > 0 ? okCount / totalRuns : 0

  const durSum = runEntries.reduce((s, e) => s + (e.duration_s ?? 0), 0)
  const avgDurationS = totalRuns > 0 ? durSum / totalRuns : 0

  const totalCharsGenerated = runEntries.reduce((s, e) => s + (e.result_chars ?? 0), 0)
  const totalCharsInput = runEntries.reduce((s, e) => s + (e.selection_chars ?? 0), 0)

  const askEntries = runEntries.filter((e) => e.mode === 'ask' && (e.turn_count ?? 0) > 0)
  const avgTurnCount =
    askEntries.length > 0
      ? askEntries.reduce((s, e) => s + (e.turn_count ?? 1), 0) / askEntries.length
      : 0

  const ctxCount = runEntries.filter((e) => e.ctx_attached).length
  const ctxAttachedPct = totalRuns > 0 ? ctxCount / totalRuns : 0

  // Listens (dictation) read up-front so they can feed both the time-saved KPI
  // and the per-bucket Activity stack below. Range-filtered like the runs.
  const allSpeech = SPEECH.readAll()
  const speechInRange = allSpeech.filter((r) => r.ts && new Date(r.ts) >= cutoff)
  const totalListens = speechInRange.length
  const listenSeconds = speechInRange.reduce((s, r) => s + (r.duration_s ?? 0), 0)

  // Time saved = ~3min per LLM run (generous but fun) + the real minutes spent
  // dictating (speaking beats typing, so the listen time itself is the saving).
  const estimatedMinsSaved = Math.round(totalRuns * 3 + listenSeconds / 60)

  const modelCounts: Record<string, number> = {}
  for (const e of runEntries) {
    const m = modelDisplayName(e.model, e.backend)
    modelCounts[m] = (modelCounts[m] ?? 0) + 1
  }
  const byModel = Object.entries(modelCounts)
    .map(([model, count]) => ({ model, count }))
    .sort((a, b) => b.count - a.count)
  const topModel = byModel[0]?.model ?? ''

  // ── 4. Streaks (always computed from all history, not range-filtered) ─────
  // Local-date keyed so a late-night run counts toward the right calendar day.
  const allDates = new Set(
    allEntries.map((e) => (e.ts ? localDateKey(parseTs(e.ts)) : null)).filter(Boolean) as string[]
  )
  const sortedDates = Array.from(allDates).sort()

  let currentStreak = 0
  const check = new Date(now)
  while (true) {
    const d = localDateKey(check)
    if (!allDates.has(d)) break
    currentStreak++
    check.setDate(check.getDate() - 1)
  }

  let longestStreak = 0
  let run = 0
  for (let i = 0; i < sortedDates.length; i++) {
    if (i === 0) {
      run = 1
      continue
    }
    const prev = new Date(sortedDates[i - 1])
    const curr = new Date(sortedDates[i])
    const diff = (curr.getTime() - prev.getTime()) / 86400000
    run = diff === 1 ? run + 1 : 1
    if (run > longestStreak) longestStreak = run
  }
  if (run > longestStreak) longestStreak = run

  // ── 5. Range-aware time series ────────────────────────────────────────────
  // ONE series drives both the Activity grid and the trend charts. Granularity
  // matches the picked range so switching ranges visibly changes every chart:
  //   daily   → 24 hourly buckets (today, midnight→now)
  //   weekly  → 7 daily buckets
  //   monthly → 30 daily buckets
  //   alltime → 52 weekly buckets (Mon-anchored), the calendar overview
  // Buckets are built from the range-filtered `entries` so empty leading buckets
  // are intentional (they show "no activity in that slot"), not a clamp artifact.
  const granularity: SeriesGranularity =
    range === 'daily' ? 'hour' : range === 'alltime' ? 'week' : 'day'

  // Empty bucket scaffold keyed by the granularity unit, in chronological order.
  // Each entry is assigned to a bucket via the same keying fn, so placement and
  // the date label can never drift apart (the old heatmap bug).
  const buckets: SeriesBucket[] = []
  const bucketIndex = new Map<string, number>() // key → buckets[] index

  const pushBucket = (key: string, label: string): void => {
    bucketIndex.set(key, buckets.length)
    buckets.push({ key, label, count: 0, ok: 0, avgDur: 0, chars: 0, modes: { rewrite: 0, ask: 0, act: 0, write: 0 }, listens: 0, captures: 0 })
  }

  if (granularity === 'hour') {
    for (let h = 0; h < 24; h++) {
      const label = `${(h % 12) || 12}${h < 12 ? 'am' : 'pm'}`
      pushBucket(String(h), label)
    }
  } else if (granularity === 'day') {
    const dayCount = range === 'weekly' ? 7 : 30
    for (let i = dayCount - 1; i >= 0; i--) {
      const d = new Date(now)
      d.setDate(d.getDate() - i)
      const key = localDateKey(d)
      const label = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      pushBucket(key, label)
    }
  } else {
    // 52 weekly buckets, anchored to the Monday of each week (local time).
    const monday = (d: Date): Date => {
      const m = new Date(d)
      const dow = (m.getDay() + 6) % 7 // 0 = Monday
      m.setDate(m.getDate() - dow)
      m.setHours(0, 0, 0, 0)
      return m
    }
    const start = monday(now)
    start.setDate(start.getDate() - 7 * 51) // 52 weeks back
    for (let i = 0; i < 52; i++) {
      const d = new Date(start)
      d.setDate(d.getDate() + 7 * i)
      const key = localDateKey(d)
      const label = `Wk of ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
      pushBucket(key, label)
    }
  }

  // Key an entry's timestamp to its bucket. Returns null if it falls outside the
  // scaffold (shouldn't happen — `entries` is already range-filtered — but guards
  // a future-dated row from landing in a bucket it doesn't belong to). All local.
  const keyFor = (d: Date): string | null => {
    if (granularity === 'hour') return String(d.getHours())
    if (granularity === 'day') return localDateKey(d)
    const m = new Date(d)
    const dow = (m.getDay() + 6) % 7
    m.setDate(m.getDate() - dow)
    m.setHours(0, 0, 0, 0)
    return localDateKey(m)
  }

  // For all-time the series uses ALL history (52 weeks), not the range-filtered
  // `entries` (which for alltime == all anyway). Hour/day use range-filtered.
  const seriesSource = granularity === 'week' ? allEntries : entries
  const durSumByBucket: number[] = new Array(buckets.length).fill(0)
  for (const e of seriesSource) {
    if (!e.ts) continue
    const idx = bucketIndex.get(keyFor(parseTs(e.ts)) ?? '')
    if (idx === undefined) continue
    const b = buckets[idx]
    // Captures (screenshot / recording) ride their own per-bucket lane like
    // listens — they don't inflate the run count, modes, chars, or durations.
    if (e.capture_kind === 'screenshot' || e.capture_kind === 'recording') {
      b.captures++
      continue
    }
    b.count++
    if (e.ok !== false) b.ok++
    b.chars += e.result_chars ?? 0
    durSumByBucket[idx] += e.duration_s ?? 0
    const m = e.mode === 'ask' || e.mode === 'act' ? e.mode : 'rewrite'
    b.modes[m]++
  }
  for (let i = 0; i < buckets.length; i++) {
    buckets[i].avgDur = buckets[i].count > 0 ? durSumByBucket[i] / buckets[i].count : 0
  }
  // Listens share the run buckets so the Activity chart can stack them. All-time
  // uses ALL speech (matches `seriesSource`); narrower ranges use the filtered set.
  const listenSource = granularity === 'week' ? allSpeech : speechInRange
  for (const r of listenSource) {
    if (!r.ts) continue
    const idx = bucketIndex.get(keyFor(parseTs(r.ts)) ?? '')
    if (idx !== undefined) buckets[idx].listens++
  }
  const series = buckets

  // ── 6. Daily calendar (all-time only) ─────────────────────────────────────
  // GitHub-style 7×52 grid of the last 364 days. Built ONLY for all-time (where
  // a day-textured year view is meaningful); other ranges leave it empty and use
  // the `series` strip. Cell i sits at column floor(i/7), row i%7, and is DATED
  // by the same sequential offset — placement and label can't drift (the prior
  // future-date bug placed by weekday but dated by index).
  const heatmap: HeatCell[] = []
  if (range === 'alltime') {
    const heatCountMap: Record<string, number> = {}
    const heatCaptureMap: Record<string, number> = {}
    for (const e of allEntries) {
      if (!e.ts) continue
      const d = localDateKey(parseTs(e.ts))
      if (e.capture_kind === 'screenshot' || e.capture_kind === 'recording') {
        heatCaptureMap[d] = (heatCaptureMap[d] ?? 0) + 1
        continue
      }
      heatCountMap[d] = (heatCountMap[d] ?? 0) + 1
    }
    // Listens get their own per-day tally so the cell can color by runs + listens
    // and the tooltip can split them. Uses ALL speech (matches the runs source).
    const heatListenMap: Record<string, number> = {}
    for (const r of allSpeech) {
      if (!r.ts) continue
      const d = localDateKey(parseTs(r.ts))
      heatListenMap[d] = (heatListenMap[d] ?? 0) + 1
    }
    const heatStart = new Date(now)
    heatStart.setDate(heatStart.getDate() - 363)
    for (let i = 0; i < 364; i++) {
      const d = new Date(heatStart)
      d.setDate(d.getDate() + i)
      const dateStr = localDateKey(d)
      heatmap.push({
        week: Math.floor(i / 7),
        day: i % 7,
        count: heatCountMap[dateStr] ?? 0,
        listens: heatListenMap[dateStr] ?? 0,
        captures: heatCaptureMap[dateStr] ?? 0,
        label: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      })
    }
  }

  // ── 7. Mode breakdown ─────────────────────────────────────────────────────
  const modeCounts: Record<string, number> = {}
  for (const e of runEntries) {
    const m = e.mode || 'rewrite'
    modeCounts[m] = (modeCounts[m] ?? 0) + 1
  }
  const byMode: ModeBucket[] = Object.entries(modeCounts)
    .map(([mode, count]) => ({ mode: mode as AnalyticsData['byMode'][0]['mode'], count }))
    .sort((a, b) => b.count - a.count)

  // ── 8. Top apps ───────────────────────────────────────────────────────────
  const appCounts: Record<string, number> = {}
  for (const e of runEntries) {
    const app = e.front_app || '(unknown)'
    appCounts[app] = (appCounts[app] ?? 0) + 1
  }
  const topApps: AppBucket[] = Object.entries(appCounts)
    .map(([app, count]) => ({ app, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)

  // ── 9. Duration histogram ─────────────────────────────────────────────────
  const bucketDefs = [
    { label: '0–2s', max: 2 },
    { label: '2–5s', max: 5 },
    { label: '5–10s', max: 10 },
    { label: '10–20s', max: 20 },
    { label: '20–30s', max: 30 },
    { label: '30s+', max: Infinity }
  ]
  const durationBuckets: DurBucket[] = bucketDefs.map(({ label, max }, i) => {
    const min = i === 0 ? 0 : bucketDefs[i - 1].max
    return {
      label,
      count: runEntries.filter((e) => (e.duration_s ?? 0) >= min && (e.duration_s ?? 0) < max).length
    }
  })

  // ── 10. By hour of day ────────────────────────────────────────────────────
  const hourCounts: number[] = Array(24).fill(0)
  for (const e of runEntries) {
    if (!e.ts) continue
    const h = parseTs(e.ts).getHours()
    if (h >= 0 && h < 24) hourCounts[h]++
  }
  const byHour: HourBucket[] = hourCounts.map((count, hour) => ({ hour, count }))

  // ── 11. Timestamps ────────────────────────────────────────────────────────
  const tsSorted = runEntries
    .map((e) => e.ts)
    .filter(Boolean)
    .map((ts) => new Date(ts!))
    .filter((d) => !isNaN(d.getTime()))
    .sort((a, b) => a.getTime() - b.getTime())

  const firstRunTs = tsSorted.length > 0 ? tsSorted[0].toISOString() : null
  const lastRunTs = tsSorted.length > 0 ? tsSorted[tsSorted.length - 1].toISOString() : null
  const dataSpanDays =
    firstRunTs && lastRunTs
      ? Math.ceil((new Date(lastRunTs).getTime() - new Date(firstRunTs).getTime()) / 86400000) + 1
      : 0

  // ── 12. Speech / dictation (separate log, separate KPIs) ──────────────────
  // Listen runs live in their own speech.jsonl, so they never inflate the run
  // KPIs above. Already read + range-filtered up-front (allSpeech/speechInRange);
  // here we derive words + WPM. Null when the user has never dictated, so the
  // renderer can hide the whole section.
  let speech: SpeechData | null = null
  if (speechInRange.length > 0) {
    const totalWords = speechInRange.reduce((s, r) => s + (r.words ?? 0), 0)
    const totalSeconds = listenSeconds
    const totalMinutes = totalSeconds / 60
    // Mirror the same range-aware buckets as `series` so the dictation sparkline
    // lines up with the run charts. Key each speech row the same way.
    const wordsByBucket: number[] = new Array(series.length).fill(0)
    for (const r of speechInRange) {
      if (!r.ts) continue
      const idx = bucketIndex.get(keyFor(parseTs(r.ts)) ?? '')
      if (idx !== undefined) wordsByBucket[idx] += r.words ?? 0
    }
    const wordsByDay = series.map((b, i) => ({ date: b.label, words: wordsByBucket[i] }))
    speech = {
      sessions: speechInRange.length,
      totalWords,
      totalSeconds,
      avgWpm: totalMinutes > 0 ? totalWords / totalMinutes : 0,
      wordsByDay
    }
  }

  const sessionRows = AGENT_SESSIONS.readAll().filter((r) => parseTs(r.ts) >= cutoff)
  let agentSessions: AgentSessionsData | null = null
  if (sessionRows.length > 0) {
    const byBucket = series.map((b) => ({ label: b.label, started: 0, archived: 0 }))
    for (const r of sessionRows) {
      const idx = bucketIndex.get(keyFor(parseTs(r.ts)) ?? '')
      if (idx !== undefined) byBucket[idx][r.kind]++
    }
    agentSessions = {
      started: sessionRows.filter((r) => r.kind === 'started').length,
      archived: sessionRows.filter((r) => r.kind === 'archived').length,
      byBucket
    }
  }

  const spendInRange = spendRows.filter((r) => r.at >= cutoff.getTime())
  let agentSpend: AgentSpendData | null = null
  if (spendInRange.length > 0) {
    const zero = (): AgentSpendTotals => ({ usd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    const add = (t: AgentSpendTotals, r: AgentSpendRow): void => {
      t.usd += r.usd
      t.input += r.input
      t.output += r.output
      t.cacheRead += r.cacheRead
      t.cacheWrite += r.cacheWrite
    }
    const totals = zero()
    const byBucket = series.map((b) => ({ label: b.label, ...zero() }))
    for (const r of spendInRange) {
      add(totals, r)
      const idx = bucketIndex.get(keyFor(new Date(r.at)) ?? '')
      if (idx !== undefined) add(byBucket[idx], r)
    }
    agentSpend = { ...totals, sessions: spendInRange.length, byBucket }
  }

  // ── 13. Suggestions (proactive cursor companion — its OWN block) ──────────
  // Read from OutcomeStore: one row per SHOWN suggestion, `accepted` is the
  // outcome, `gen_ms` the LLM latency. A different interaction from runs (it
  // appears and writes), so it never touches the run KPIs above. Null when the
  // user has been shown nothing in range, so the renderer hides the section.
  const suggestionRows = OutcomeStore.readAll().filter((o) => o.ts && parseTs(o.ts) >= cutoff)
  let suggestions: SuggestionsData | null = null
  if (suggestionRows.length > 0) {
    const shown = suggestionRows.length
    const acceptedRows = suggestionRows.filter((o) => o.accepted)
    const accepted = acceptedRows.length

    // Decision breakdown — what ended each shown suggestion. Legacy rows with no
    // `decision` are inferred from `accepted` (true → accepted, false → rejected),
    // so old history still slots in. Counts sum to `shown`; empty buckets dropped.
    const decisionCounts: Record<string, number> = {}
    for (const o of suggestionRows) {
      const d = o.decision ?? (o.accepted ? 'accepted' : 'rejected')
      decisionCounts[d] = (decisionCounts[d] ?? 0) + 1
    }
    const byDecision: DecisionBucket[] = SUGGESTION_DECISIONS.map((decision) => ({
      decision,
      count: decisionCounts[decision] ?? 0
    })).filter((b) => b.count > 0)

    // What the user picks: accepted suggestions split by mode.
    const sugModeCounts: Record<string, number> = {}
    for (const o of acceptedRows) sugModeCounts[o.mode] = (sugModeCounts[o.mode] ?? 0) + 1
    const sugByMode: ModeBucket[] = Object.entries(sugModeCounts)
      .map(([mode, count]) => ({ mode: mode as ModeBucket['mode'], count }))
      .sort((a, b) => b.count - a.count)

    // Where suggestions land most (by how often shown there).
    const sugAppCounts: Record<string, number> = {}
    for (const o of suggestionRows) {
      const app = o.front_app || '(unknown)'
      sugAppCounts[app] = (sugAppCounts[app] ?? 0) + 1
    }
    const sugTopApps: AppBucket[] = Object.entries(sugAppCounts)
      .map(([app, count]) => ({ app, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8)

    // Generation latency — only rows that carry gen_ms (legacy rows excluded).
    const timed = suggestionRows
      .map((o) => o.gen_ms)
      .filter((ms): ms is number => typeof ms === 'number' && ms >= 0)
      .sort((a, b) => a - b)
    let gen: SuggestionsData['gen'] = null
    if (timed.length > 0) {
      const pct = (p: number): number => timed[Math.min(timed.length - 1, Math.floor(p * timed.length))]
      // Per-bucket avg latency, aligned to the run `series` buckets so the UI can
      // chart "is generation getting slower" at whatever range is picked.
      const genSumByBucket: number[] = new Array(series.length).fill(0)
      const genCountByBucket: number[] = new Array(series.length).fill(0)
      for (const o of suggestionRows) {
        if (typeof o.gen_ms !== 'number' || !o.ts) continue
        const idx = bucketIndex.get(keyFor(parseTs(o.ts)) ?? '')
        if (idx === undefined) continue
        genSumByBucket[idx] += o.gen_ms
        genCountByBucket[idx]++
      }
      // Distribution by latency (the spread), not by date. Buckets sit where
      // suggestion gen time actually lands (~8–16s, p50 ≈ 12s) so the spread is
      // visible — low buckets (0–8s) were all empty and wasted the chart. Mirrors
      // the run duration histogram's look so the two perf charts read consistently.
      const genBucketDefs = [
        { label: '<8s', max: 8000 },
        { label: '8–10s', max: 10000 },
        { label: '10–12s', max: 12000 },
        { label: '12–14s', max: 14000 },
        { label: '14–16s', max: 16000 },
        { label: '16s+', max: Infinity }
      ]
      const distribution = genBucketDefs.map(({ label, max }, i) => {
        const min = i === 0 ? 0 : genBucketDefs[i - 1].max
        return { label, count: timed.filter((ms) => ms >= min && ms < max).length }
      })
      gen = {
        samples: timed.length,
        avgMs: timed.reduce((s, m) => s + m, 0) / timed.length,
        p50Ms: pct(0.5),
        p95Ms: pct(0.95),
        series: series.map((b, i) => ({
          key: b.key,
          label: b.label,
          avgMs: genCountByBucket[i] > 0 ? genSumByBucket[i] / genCountByBucket[i] : 0,
          count: genCountByBucket[i]
        })),
        distribution
      }
    }

    suggestions = {
      shown,
      accepted,
      dismissed: shown - accepted,
      acceptRate: shown > 0 ? accepted / shown : 0,
      byDecision,
      byMode: sugByMode,
      topApps: sugTopApps,
      gen
    }
  }

  // ── 12. Feedback (👍/👎 + corrections) over time ───────────────────────────
  // The eval surface for the feedback loop. Joins the feedback store (keyed by
  // run_id) against the SAME run buckets `series` already uses, so the charts
  // share the run x-axis for free. Null when nothing's rated in range → section
  // hides. `seriesSource` matches the runs the buckets were built from (all-time
  // uses ALL history, narrower ranges use the range-filtered `entries`).
  let feedback: FeedbackData | null = null
  {
    const fbAll = FEEDBACK.all() // run_id → latest FeedbackEntry
    // Per-bucket tallies, aligned 1:1 to `series` by index.
    const fbBuckets: FeedbackSeriesBucket[] = series.map((b) => ({
      key: b.key,
      label: b.label,
      runs: b.count,
      up: 0,
      down: 0,
      corrections: 0,
      praises: 0
    }))
    let up = 0
    let down = 0
    let corrections = 0
    let praises = 0
    for (const e of seriesSource) {
      if (!e.ts) continue
      const fb = fbAll[e.run_id]
      if (!fb) continue
      const idx = bucketIndex.get(keyFor(parseTs(e.ts)) ?? '')
      if (idx === undefined) continue
      const slot = fbBuckets[idx]
      if (fb.rating === 'up') {
        slot.up++
        up++
        if (fb.note) {
          slot.praises++
          praises++
        }
      } else {
        slot.down++
        down++
        if (fb.note) {
          slot.corrections++
          corrections++
        }
      }
    }
    const rated = up + down
    if (rated > 0) {
      // Trend = approval at the last rated bucket minus the first. Buckets with no
      // ratings are skipped so a quiet day doesn't read as a 0% dip.
      const ratedBuckets = fbBuckets.filter((b) => b.up + b.down > 0)
      const approvalOf = (b: FeedbackSeriesBucket): number =>
        b.up + b.down > 0 ? b.up / (b.up + b.down) : 0
      const trendDelta =
        ratedBuckets.length >= 2
          ? approvalOf(ratedBuckets[ratedBuckets.length - 1]) - approvalOf(ratedBuckets[0])
          : 0
      // Recent notes — both 👍 praises and 👎 corrections — name the instruction each
      // was about (when history has it). Merged, tagged with the rating so the renderer
      // can split + color them, sorted newest-first, then capped.
      const byRun = new Map<string, HistoryEntry>()
      for (const e of allEntries) byRun.set(e.run_id, e)
      const recent = [
        ...FEEDBACK.recentCorrections(ANALYTICS_FEEDBACK_RECENT),
        ...FEEDBACK.recentPraises(ANALYTICS_FEEDBACK_RECENT)
      ]
        .sort((a, b) => (a.ts < b.ts ? 1 : -1))
        .slice(0, ANALYTICS_FEEDBACK_RECENT)
        .map((fb) => ({
          instruction: byRun.get(fb.run_id)?.instruction ?? null,
          note: (fb.note ?? '').replace(/\n/g, ' ').slice(0, 120).trim(),
          mode: (fb.mode === 'ask' || fb.mode === 'act' ? fb.mode : 'rewrite') as AppMode,
          // Sourced only from recentCorrections/recentPraises, which filter to
          // rating 'down'/'up' — never a note-only null. Narrow for the type.
          rating: (fb.rating ?? 'up') as FeedbackRating
        }))
        .filter((r) => r.note)
      feedback = {
        up,
        down,
        corrections,
        praises,
        rated,
        totalRuns,
        approvalRate: rated > 0 ? up / rated : 0,
        ratedCoverage: totalRuns > 0 ? rated / totalRuns : 0,
        trendDelta,
        series: fbBuckets,
        recent
      }
    }
  }

  // Seed for the AI insight — fetched separately (async) so the slow Claude
  // round-trip never blocks this stats response. See buildAnalyticsInsight.
  const insightSeed: AnalyticsInsightSeed = {
    totalRuns,
    successRate,
    avgDurationS,
    totalCharsGenerated,
    topApp: topApps[0]?.app ?? 'various apps',
    topMode: byMode[0]?.mode ?? 'rewrite',
    currentStreak
  }

  return {
    data: {
      totalRuns,
      totalListens,
      totalCaptures,
      successRate,
      avgDurationS,
      totalCharsGenerated,
      totalCharsInput,
      avgTurnCount,
      currentStreak,
      longestStreak,
      ctxAttachedPct,
      estimatedMinsSaved,
      topModel,
      byModel,
      series,
      granularity,
      heatmap,
      byMode,
      topApps,
      durationBuckets,
      byHour,
      firstRunTs,
      lastRunTs,
      dataSpanDays,
      speech,
      agentSessions,
      agentSpend,
      suggestions,
      feedback
    },
    insightSeed
  }
}

/**
 * Generate the 1-2 sentence AI insight. Routes through `runBackend` so it honors
 * the user's selected backend (PREFS.getBackend) — same path as every other LLM
 * call. The old version hardcoded the `claude` CLI, so it silently no-op'd for
 * anyone on `codex`/`mightymouse` (no claude binary → empty card). User-triggered
 * only now (manual button), never auto-fired.
 *
 * Returns '' on any failure (no run data, non-zero exit, timeout) so the UI can
 * surface an error state. Resolves with the cleaned final answer.
 */
function buildAnalyticsInsight(seed: AnalyticsInsightSeed): Promise<string> {
  if (seed.totalRuns <= 0) return Promise.resolve('')

  const streakLine = seed.currentStreak > 1 ? `${seed.currentStreak}-day active streak.` : ''
  const userPrompt = [
    `MightyMouse AI assistant usage stats: ${seed.totalRuns} runs, ${Math.round(seed.successRate * 100)}% success,`,
    `avg ${seed.avgDurationS.toFixed(1)}s response, ${seed.totalCharsGenerated.toLocaleString()} chars generated.`,
    `Top app: ${seed.topApp}. Favorite mode: ${seed.topMode}. ${streakLine}`,
    `Write exactly 1-2 sentences (no preamble, no bullet points) with the single most interesting insight or pattern from this usage.`
  ].join(' ')

  return new Promise((resolve) => {
    const runId = `insight:${(Date.now() % 0xffff).toString(16).padStart(4, '0')}`
    runBackend({
      backend: PREFS.getBackend(),
      runId,
      systemPrompt: '',
      userPrompt,
      runDir: PATHS.TMP,
      timeoutMs: 18000,
      lean: true,
      onPhase: () => {},
      onDone: (result, exitCode) => {
        resolve(exitCode === 0 && result ? result.trim() : '')
      }
    })
  })
}

export function registerAnalyticsHandlers(): void {
  // The last range the user picked, so reopening the window restores it instead
  // of snapping back to All Time. Read once on mount by the renderer.
  ipcMain.handle(CHANNELS.analyticsInitialRange, () => PREFS.getAnalyticsRange())

  // Stats only — fast, no LLM. The renderer paints these immediately, then
  // requests the (slow) AI insight separately via analyticsInsight. Persist the
  // range on every request so the next window open restores the same view.
  ipcMain.handle(CHANNELS.analyticsRequest, async (_, range: AnalyticsRange = 'alltime') => {
    PREFS.setAnalyticsRange(range)
    const spendRows = await readAgentSpend().catch((err) => {
      console.error('Agent spend scan failed:', err)
      return []
    })
    return buildAnalyticsData(range, spendRows).data
  })

  // AI insight — user-triggered only (manual button in the renderer). Routes
  // through runBackend (honors the selected backend). Recomputes the seed (cheap,
  // no file-spawn) rather than threading it back through the wire.
  ipcMain.handle(CHANNELS.analyticsInsight, (_, range: AnalyticsRange = 'alltime') => {
    return buildAnalyticsInsight(buildAnalyticsData(range).insightSeed)
  })
}

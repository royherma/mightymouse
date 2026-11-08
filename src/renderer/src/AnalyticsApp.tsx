import { JSX, useEffect, useState, useCallback, MouseEvent } from 'react'
import {
  Play,
  Check,
  Gauge,
  Sparkles,
  Clock,
  Type as TypeIcon,
  Mic,
  Camera,
  Activity,
  Lightbulb,
  Check as CheckIcon,
  Timer,
  ThumbsUp,
  ThumbsDown,
  TrendingUp,
  Percent,
  Layers,
  Coins,
  type LucideIcon
} from 'lucide-react'
import { WindowFrame } from './WindowFrame'
import { Badge } from './components/Badge'
import { AppIcon } from './components/AppIcon'
import { ProgressBar } from './components/ProgressBar'
import { SegmentedControl } from './components/SegmentedControl'
import { CONFIG } from '../../shared/config'
import type { AnalyticsData, AnalyticsRange, SpeechData, SuggestionsData, SuggestionDecisionId, AppMode, FeedbackData, FeedbackSeriesBucket } from '../../shared/types'
import { Tooltip, type TipState } from './components/Tooltip'
import { KpiChip, AgentSessionsCard, AgentSpendCard } from './components/analytics-cards'
import {
  MODE_COLORS,
  MODE_LABELS,
  ANALYTICS_KINDS,
  type InteractionKind,
  type AnalyticsKind
} from './mode-colors'
import { APP_MODES } from '../../shared/mode'
import { Button } from './components/Button'

// A "run" is any non-voice interaction. Spell out the modes so the run count and
// the by-hour/by-day charts aren't an opaque number. Derived from APP_MODES (the
// SSOT) + MODE_LABELS so adding a mode updates this caption for free.
const RUN_MEANS = `A run is any ${APP_MODES.map(m => MODE_LABELS[m]).join(', ')}. Listens (voice) are counted on their own.`

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function fmtPct(rate: number): string {
  return `${Math.round(rate * 100)}%`
}

function fmtDur(s: number): string {
  if (s < 60) return `${s.toFixed(1)}s`
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`
}

function fmtHour(h: number): string {
  if (h === 0) return '12a'
  if (h < 12) return `${h}a`
  if (h === 12) return '12p'
  return `${h - 12}p`
}

// "5 rewrite · 4 ask · 4 act" for the Runs KPI sub-line, so the run count isn't a
// bare number — the user sees the run-mode split at a glance. Empty → ''.
function fmtRunModeSplit(byMode: AnalyticsData['byMode']): string {
  return byMode
    .filter(m => m.count > 0)
    .map(m => `${m.count} ${m.mode}`)
    .join(' · ')
}

// ── Shared classes (mirrors SettingsApp) ──────────────────────────────────────

const cardCls = 'bg-surface1 border border-surface3 rounded-md p-3.5 mb-2.5 shadow-card'
const sectionCls = 'text-sm uppercase text-muted font-bold tracking-wider mt-4 mb-1.5'
// In-card title (smaller than the section header) — one home so every chart card
// reads at the same scale instead of each redefining the same long class string.
const cardTitleCls = 'text-xlg text-muted font-semibold uppercase tracking-wide mb-3'

// ── KPI Chip ──────────────────────────────────────────────────────────────────

// ── GitHub-style Heatmap ──────────────────────────────────────────────────────

// Range-aware activity grid. All-time keeps the GitHub-style 52-week calendar
// (7 rows × 52 cols). Today/week/month render a single strip of cells (24 hours
// / 7 / 30 days). Labels come from the server (`bucket.label`), so the tooltip
// date always matches the cell — no index-vs-weekday drift.
function ActivityGrid({
  series,
  granularity,
  heatmap,
  setTip
}: {
  series: AnalyticsData['series']
  granularity: AnalyticsData['granularity']
  heatmap: AnalyticsData['heatmap']
  setTip: (t: TipState) => void
}): JSX.Element {
  function colorFor(count: number, max: number): string {
    if (count === 0) return 'var(--surface3)'
    const ratio = count / max
    if (ratio < 0.25) return 'var(--green-bg-subtle)'
    if (ratio < 0.55) return 'var(--green-light)'
    return 'var(--green)'
  }
  // Tooltip text for a day: "3 runs, 2 listens, 4 captured" — only the non-zero
  // parts, so a single-kind day reads cleanly. The grid colors by runs + listens.
  const activityStr = (runs: number, listens: number, captures = 0): string => {
    const parts: string[] = []
    if (runs > 0) parts.push(`${runs} run${runs !== 1 ? 's' : ''}`)
    if (listens > 0) parts.push(`${listens} listen${listens !== 1 ? 's' : ''}`)
    if (captures > 0) parts.push(`${captures} captured`)
    return parts.length ? parts.join(', ') : 'No activity'
  }

  // Calendar layout (all-time): GitHub-style 7×52 grid of daily cells. Cells carry
  // their own server-built date label, so the tooltip can never show a wrong date.
  if (granularity === 'week') {
    const maxCount = Math.max(...heatmap.map(c => c.count + c.listens), 1)
    const cellSize = 10
    const gap = 2
    const w = 52 * (cellSize + gap) - gap
    const h = 7 * (cellSize + gap) - gap
    return (
      <div className="pb-0.5">
        <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="xMidYMid meet" style={{ display: 'block' }} onMouseLeave={() => setTip(null)}>
          {heatmap.map((cell, i) => (
            <rect key={i} x={cell.week * (cellSize + gap)} y={cell.day * (cellSize + gap)} width={cellSize} height={cellSize} rx={2}
              fill={colorFor(cell.count + cell.listens, maxCount)} style={{ cursor: 'pointer' }}
              onMouseMove={e => setTip({ x: e.clientX, y: e.clientY, text: `${cell.label} · ${activityStr(cell.count, cell.listens, cell.captures)}` })} />
          ))}
        </svg>
        <div className="flex justify-between mt-1.5">
          <span className="text-xlg text-muted">52 weeks ago</span>
          <span className="text-xlg text-muted">Today</span>
        </div>
      </div>
    )
  }

  const maxCount = Math.max(...series.map(b => b.count + b.listens), 1)
  const tip = (b: AnalyticsData['series'][0]): string => `${b.label} · ${activityStr(b.count, b.listens, b.captures)}`

  // Strip layout (today/week/month): one row of evenly-sized cells.
  const n = series.length
  const cellH = 22
  const gapPx = 3
  const w = 320
  const cellW = (w - gapPx * (n - 1)) / n
  return (
    <div className="pb-0.5">
      <svg viewBox={`0 0 ${w} ${cellH}`} width="100%" height={cellH} preserveAspectRatio="none" style={{ display: 'block' }} onMouseLeave={() => setTip(null)}>
        {series.map((b, i) => (
          <rect key={b.key} x={i * (cellW + gapPx)} y={0} width={cellW} height={cellH} rx={2} fill={colorFor(b.count + b.listens, maxCount)} style={{ cursor: 'pointer' }}
            onMouseMove={e => setTip({ x: e.clientX, y: e.clientY, text: tip(b) })} />
        ))}
      </svg>
      <div className="flex justify-between mt-1.5">
        <span className="text-xlg text-muted">{series[0]?.label}</span>
        <span className="text-xlg text-muted">{series[n - 1]?.label}</span>
      </div>
    </div>
  )
}

// ── Activity Bars (runs + listens, stacked) ───────────────────────────────────
// Our two main interactions, stacked per bucket: runs (green, bottom) + listens
// (cyan, top). Scales to the combined total so a busy listen day reads as tall
// as a busy run day. Empty buckets show a faint baseline tick.

const RUN_COLOR = 'var(--green)'
const LISTEN_COLOR = 'var(--cyan)'

function ActivityBars({
  days,
  setTip
}: {
  days: AnalyticsData['series']
  setTip: (t: TipState) => void
}): JSX.Element {
  const maxTotal = Math.max(...days.map(d => d.count + d.listens), 1)
  const gap = 3
  const chartH = 64
  const w = 320
  const barW = (w - gap * (days.length - 1)) / days.length

  function tipText(d: AnalyticsData['series'][0]): string {
    const parts: string[] = []
    if (d.count > 0) parts.push(`${d.count} run${d.count !== 1 ? 's' : ''}`)
    if (d.listens > 0) parts.push(`${d.listens} listen${d.listens !== 1 ? 's' : ''}`)
    if (d.captures > 0) parts.push(`${d.captures} captured`)
    return `${d.label} · ${parts.length ? parts.join(', ') : 'no activity'}`
  }

  return (
    <div>
      <svg
        viewBox={`0 0 ${w} ${chartH}`}
        width="100%"
        height={chartH}
        preserveAspectRatio="none"
        style={{ display: 'block' }}
        onMouseLeave={() => setTip(null)}
      >
        {days.map((d, i) => {
          const x = i * (barW + gap)
          const total = d.count + d.listens
          const runH = (d.count / maxTotal) * (chartH - 4)
          const listenH = (d.listens / maxTotal) * (chartH - 4)
          const onMove = (e: MouseEvent): void => setTip({ x: e.clientX, y: e.clientY, text: tipText(d) })
          return (
            <g key={i} style={{ cursor: 'pointer' }} onMouseMove={onMove}>
              {/* Invisible full-height hit area so thin/empty bars are still hoverable */}
              <rect x={x} y={0} width={barW} height={chartH} fill="transparent" />
              {d.count > 0 && (
                <rect x={x} y={chartH - runH} width={barW} height={Math.max(runH, 3)} rx={2} fill={RUN_COLOR} opacity={0.85} />
              )}
              {d.listens > 0 && (
                <rect x={x} y={chartH - runH - listenH} width={barW} height={Math.max(listenH, 3)} rx={2} fill={LISTEN_COLOR} opacity={0.85} />
              )}
              {total === 0 && (
                <rect x={x} y={chartH - 2} width={barW} height={2} rx={1} fill="var(--surface3)" />
              )}
            </g>
          )
        })}
      </svg>
    </div>
  )
}

// ── Interaction modes ─────────────────────────────────────────────────────────
// The four ways a user interacts: the three run modes (rewrite/ask/act) PLUS
// listen (dictation). `listen` is NOT an AppMode at the core (runs and listens
// are logged separately) — it's an analytics-only "4th mode" so the breakdown
// reads the way a user thinks: "I rewrite, ask, act, and dictate."
//
// The palette + labels + order now live in ../mode-colors (one home, shared with
// CursorApp's suggestion chips) so a mode never reads as two colors across windows.

// ── Mode-over-time (stacked) ──────────────────────────────────────────────────
// Rewrite / Ask / Act / Listen per bucket, stacked, so you see how the four-way
// interaction mix shifts over the range. Listen (dictation) is folded in as the
// 4th segment. Shares BarSparkline's width math (fixed 320 viewBox, fluid w).
function ModeStackChart({
  days,
  setTip
}: {
  days: AnalyticsData['series']
  setTip: (t: TipState) => void
}): JSX.Element {
  // Per-bucket count for a kind: run modes read from `modes`, listen from `listens`.
  // `m` is an analytics kind (the 4 LLM modes + listen), so the non-listen branch
  // is always a real AppMode key of `modes`.
  const countOf = (d: AnalyticsData['series'][0], m: AnalyticsKind): number =>
    m === 'listen' ? d.listens : d.modes[m]
  const maxTotal = Math.max(...days.map(d => d.count + d.listens), 1)
  const gap = 3
  const chartH = 64
  const w = 320
  const barW = (w - gap * (days.length - 1)) / days.length

  return (
    <div>
      <svg viewBox={`0 0 ${w} ${chartH}`} width="100%" height={chartH} preserveAspectRatio="none" style={{ display: 'block' }} onMouseLeave={() => setTip(null)}>
        {days.map((d, i) => {
          const x = i * (barW + gap)
          const tip = `${d.label} · ${ANALYTICS_KINDS.filter(m => countOf(d, m) > 0).map(m => `${countOf(d, m)} ${MODE_LABELS[m].toLowerCase()}`).join(', ') || 'no activity'}`
          let yCursor = chartH
          return (
            <g key={i} style={{ cursor: 'pointer' }} onMouseMove={e => setTip({ x: e.clientX, y: e.clientY, text: tip })}>
              <rect x={x} y={0} width={barW} height={chartH} fill="transparent" />
              {ANALYTICS_KINDS.map(m => {
                const c = countOf(d, m)
                if (c === 0) return null
                const segH = (c / maxTotal) * (chartH - 4)
                yCursor -= segH
                return <rect key={m} x={x} y={yCursor} width={barW} height={segH} fill={MODE_COLORS[m]} opacity={0.85} />
              })}
              {d.count + d.listens === 0 && <rect x={x} y={chartH - 2} width={barW} height={2} rx={1} fill="var(--surface3)" />}
            </g>
          )
        })}
      </svg>
      <div className="flex gap-3 mt-2">
        {ANALYTICS_KINDS.map(m => (
          <span key={m} className="flex items-center gap-1 text-xlg text-muted">
            <span className="w-2 h-2 rounded-full inline-block" style={{ background: MODE_COLORS[m] }} />
            {MODE_LABELS[m]}
          </span>
        ))}
      </div>
    </div>
  )
}

function ModeDonut({
  byMode,
  listens,
  setTip
}: {
  byMode: AnalyticsData['byMode']
  /** Listen (dictation) count — the 4th slice. */
  listens: number
  setTip: (t: TipState) => void
}): JSX.Element {
  const r = 38
  const strokeW = 14
  const cx = 60
  const cy = 60
  const circumference = 2 * Math.PI * r

  // Fold listen in as a 4th mode, then sort all four most-used first so the donut
  // and legend agree. Total = every interaction (runs + listens).
  const rows: { mode: InteractionKind; count: number }[] = [
    ...byMode.map(m => ({ mode: m.mode as InteractionKind, count: m.count })),
    ...(listens > 0 ? [{ mode: 'listen' as InteractionKind, count: listens }] : [])
  ].sort((a, b) => b.count - a.count)
  const total = rows.reduce((s, m) => s + m.count, 0)

  let offset = 0
  const segments = rows.map(m => {
    const pct = total > 0 ? m.count / total : 0
    const dash = pct * circumference
    const seg = { mode: m.mode, count: m.count, pct, dash, offset }
    offset += dash
    return seg
  })

  return (
    <div className="flex flex-col items-center gap-3">
      <svg viewBox="0 0 120 120" width={120} height={120} onMouseLeave={() => setTip(null)}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--surface3)" strokeWidth={strokeW} />
        {segments.map((seg, i) => (
          <circle
            key={i}
            cx={cx} cy={cy} r={r}
            fill="none"
            stroke={MODE_COLORS[seg.mode] ?? 'var(--muted)'}
            strokeWidth={strokeW}
            strokeDasharray={`${seg.dash} ${circumference - seg.dash}`}
            strokeDashoffset={circumference / 4 - seg.offset}
            style={{ transition: 'stroke-dasharray 0.4s ease', cursor: 'pointer' }}
            onMouseMove={e => setTip({ x: e.clientX, y: e.clientY, text: `${MODE_LABELS[seg.mode] ?? seg.mode} · ${seg.count} (${fmtPct(seg.pct)})` })}
          />
        ))}
        <text x={cx} y={cy - 4} textAnchor="middle" fontSize={18} fontWeight="bold" fill="var(--on-surface)">{total}</text>
        <text x={cx} y={cy + 12} textAnchor="middle" fontSize={9} fill="var(--muted)">total</text>
      </svg>
      <div className="flex flex-col gap-1 w-full">
        {rows.map(m => (
          <div key={m.mode} className="flex items-center gap-2 text-sm">
            <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: MODE_COLORS[m.mode] ?? 'var(--muted)' }} />
            <span className="text-on-surface flex-1">{MODE_LABELS[m.mode] ?? m.mode}</span>
            <span className="text-muted text-xs">{m.count}</span>
            <span className="text-muted text-xs w-8 text-right">{fmtPct(total > 0 ? m.count / total : 0)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Top Apps ──────────────────────────────────────────────────────────────────

function TopApps({
  apps,
  total,
  setTip
}: {
  apps: AnalyticsData['topApps']
  total: number
  setTip: (t: TipState) => void
}): JSX.Element {
  const maxCount = Math.max(...apps.map(a => a.count), 1)
  return (
    <div className="flex flex-col gap-1.5" onMouseLeave={() => setTip(null)}>
      {apps.map((app, i) => {
        const pct = (app.count / maxCount) * 100
        const pctOfTotal = total > 0 ? Math.round((app.count / total) * 100) : 0
        const shortName = app.app.length > 22 ? app.app.slice(0, 21) + '…' : app.app
        return (
          <div
            key={i}
            className="flex items-center gap-2 cursor-pointer"
            onMouseMove={e => setTip({ x: e.clientX, y: e.clientY, text: `${app.app} · ${app.count} run${app.count !== 1 ? 's' : ''} (${pctOfTotal}%)` })}
          >
            <span className="text-xs text-muted w-4 text-right">{i + 1}</span>
            <AppIcon app={app.app} size={16} />
            <span className="text-xs text-on-surface w-28 truncate">{shortName}</span>
            <ProgressBar pct={pct} />
            <span className="text-xs text-muted w-8 text-right">{pctOfTotal}%</span>
          </div>
        )
      })}
    </div>
  )
}

// ── Models Used ───────────────────────────────────────────────────────────────
// Ranked bar list of every model used in the range (most-used first). Mirrors
// TopApps — surfaces the full mix so frequent model-switching is visible, not
// hidden behind the single "top model" badge.
function TopModels({
  models,
  total,
  setTip
}: {
  models: AnalyticsData['byModel']
  total: number
  setTip: (t: TipState) => void
}): JSX.Element {
  const maxCount = Math.max(...models.map(m => m.count), 1)
  return (
    <div className="flex flex-col gap-1.5" onMouseLeave={() => setTip(null)}>
      {models.map((m, i) => {
        const pct = (m.count / maxCount) * 100
        const pctOfTotal = total > 0 ? Math.round((m.count / total) * 100) : 0
        const name = m.model === 'unknown' ? '(unknown)' : m.model
        const shortName = name.length > 22 ? name.slice(0, 21) + '…' : name
        return (
          <div
            key={i}
            className="flex items-center gap-2 cursor-pointer"
            onMouseMove={e => setTip({ x: e.clientX, y: e.clientY, text: `${name} · ${m.count} run${m.count !== 1 ? 's' : ''} (${pctOfTotal}%)` })}
          >
            <span className="text-xs text-muted w-4 text-right">{i + 1}</span>
            <span className="text-xs text-on-surface w-32 truncate">{shortName}</span>
            <ProgressBar pct={pct} />
            <span className="text-xs text-muted w-8 text-right">{pctOfTotal}%</span>
          </div>
        )
      })}
    </div>
  )
}

// ── Duration Histogram ────────────────────────────────────────────────────────

// Full-width bucketed histogram. Bars stretch to fill the card (flex), so it never
// sits as a small fixed-width chart hugging the left edge. The count tag (above the
// bar) and axis label (below) are HTML, so they stay crisp regardless of width.
// Used for both run response-time and suggestion generation-time distributions.
function DistributionHistogram({
  buckets,
  unit,
  setTip
}: {
  buckets: { label: string; count: number }[]
  /** Noun for the tooltip ("run", "suggestion"). */
  unit: string
  setTip: (t: TipState) => void
}): JSX.Element {
  const maxCount = Math.max(...buckets.map(b => b.count), 1)
  const totalCount = buckets.reduce((s, b) => s + b.count, 0)
  const barAreaH = 64

  return (
    <div className="flex items-end gap-2" style={{ height: barAreaH + 22 }} onMouseLeave={() => setTip(null)}>
      {buckets.map((b, i) => {
        const bh = Math.max((b.count / maxCount) * barAreaH, b.count > 0 ? 4 : 0)
        const pct = totalCount > 0 ? Math.round((b.count / totalCount) * 100) : 0
        return (
          <div
            key={i}
            className="flex-1 flex flex-col items-center justify-end cursor-pointer h-full"
            onMouseMove={e => setTip({ x: e.clientX, y: e.clientY, text: `${b.label} · ${b.count} ${unit}${b.count !== 1 ? 's' : ''} (${pct}%)` })}
          >
            <span className="text-xlg leading-none mb-1" style={{ color: 'var(--violet)', minHeight: '0.6rem' }}>
              {b.count > 0 ? b.count : ''}
            </span>
            <div
              className="w-full rounded"
              style={{ height: bh, background: 'var(--violet-bg-subtle)', border: '1px solid var(--violet)' }}
            />
            <span className="text-xlg text-muted leading-none mt-1.5 whitespace-nowrap">{b.label}</span>
          </div>
        )
      })}
    </div>
  )
}

// ── Time-of-Day Ring ──────────────────────────────────────────────────────────

// Hour labels sit at a few fixed positions across the 24-hour axis. Kept as HTML
// (positioned by %) so they stay crisp while the SVG stretches to card width.
const HOUR_LABELS = [0, 6, 12, 18, 23]

function HourChart({
  byHour,
  setTip
}: {
  byHour: AnalyticsData['byHour']
  setTip: (t: TipState) => void
}): JSX.Element {
  const maxCount = Math.max(...byHour.map(h => h.count), 1)
  const gap = 2
  const chartH = 52
  const w = 320
  const barW = (w - gap * 23) / 24

  return (
    <div>
      {/* Stretch to card width (preserveAspectRatio="none") — same trick as
          ActivityBars — so the chart fills the card instead of sitting at a fixed
          263px. Axis labels live in HTML below, immune to the x-stretch. */}
      <svg viewBox={`0 0 ${w} ${chartH}`} width="100%" height={chartH} preserveAspectRatio="none" style={{ display: 'block' }} onMouseLeave={() => setTip(null)}>
        {byHour.map((h, i) => {
          const x = i * (barW + gap)
          const bh = Math.max((h.count / maxCount) * (chartH - 4), h.count > 0 ? 3 : 0)
          const isNight = h.hour < 6 || h.hour >= 22
          const isPeak = h.count === maxCount && h.count > 0
          const hourRange = `${fmtHour(h.hour)}–${fmtHour((h.hour + 1) % 24)}`
          return (
            <g
              key={i}
              style={{ cursor: 'pointer' }}
              onMouseMove={e => setTip({ x: e.clientX, y: e.clientY, text: `${hourRange} · ${h.count} run${h.count !== 1 ? 's' : ''}` })}
            >
              <rect x={x} y={0} width={barW} height={chartH} fill="transparent" />
              <rect
                x={x} y={chartH - bh} width={barW} height={bh}
                rx={2}
                fill={isPeak ? 'var(--amber)' : isNight ? 'var(--violet-bg-subtle)' : 'var(--cyan-bg-subtle)'}
                stroke={isPeak ? 'var(--amber)' : isNight ? 'var(--violet)' : 'var(--cyan)'}
                strokeWidth={0.5}
                opacity={0.9}
              />
            </g>
          )
        })}
      </svg>
      <div className="relative h-3.5 mt-0.5">
        {HOUR_LABELS.map(hr => (
          <span
            key={hr}
            className="absolute text-xlg text-muted"
            style={{ left: `${((hr + 0.5) / 24) * 100}%`, transform: 'translateX(-50%)' }}
          >
            {fmtHour(hr)}
          </span>
        ))}
      </div>
    </div>
  )
}

// ── Chars In/Out Twin Bar ─────────────────────────────────────────────────────

function CharsTwinBar({ input, output }: { input: number; output: number }): JSX.Element {
  const max = Math.max(input, output, 1)

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted w-16">You typed</span>
        <ProgressBar pct={(input / max) * 100} height="h-3" />
        <span className="text-xs text-on-surface w-14 text-right font-mono">{fmtCount(input)}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted w-16">It wrote</span>
        <ProgressBar pct={(output / max) * 100} height="h-3" color="var(--green)" />
        <span className="text-xs text-on-surface w-14 text-right font-mono">{fmtCount(output)}</span>
      </div>
    </div>
  )
}

// ── Trend Line Chart ──────────────────────────────────────────────────────────

type MetricId = 'runs' | 'cumulative' | 'speed' | 'success' | 'chars'

const METRICS: { id: MetricId; label: string; color: string; fmt: (v: number) => string }[] = [
  { id: 'runs', label: 'Runs', color: 'cyan', fmt: v => String(Math.round(v)) },
  { id: 'cumulative', label: 'Total', color: 'amber', fmt: v => String(Math.round(v)) },
  { id: 'speed', label: 'Speed', color: 'violet', fmt: v => `${v.toFixed(1)}s` },
  { id: 'success', label: 'Success', color: 'green', fmt: v => `${Math.round(v)}%` },
  { id: 'chars', label: 'Chars', color: 'accent', fmt: v => fmtCount(Math.round(v)) }
]

// Derive the per-bucket series for a metric. `runs` is the raw count per bucket
// (hour/day/week); `cumulative` is the running total. Speed/success carry the
// bucket's average; empty buckets read as 0.
function seriesFor(days: AnalyticsData['series'], metric: MetricId): number[] {
  if (metric === 'runs') return days.map(d => d.count)
  if (metric === 'cumulative') {
    let acc = 0
    return days.map(d => (acc += d.count))
  }
  if (metric === 'speed') return days.map(d => d.avgDur)
  if (metric === 'success') return days.map(d => (d.count > 0 ? (d.ok / d.count) * 100 : 0))
  return days.map(d => d.chars)
}

function LineChart({
  days,
  metric,
  setTip
}: {
  days: AnalyticsData['series']
  metric: MetricId
  setTip: (t: TipState) => void
}): JSX.Element {
  const cfg = METRICS.find(m => m.id === metric)!
  const values = seriesFor(days, metric)
  const maxVal = Math.max(...values, 1)
  const w = 320
  const h = 80
  const padTop = 8
  const padBottom = 4
  const usableH = h - padTop - padBottom
  const n = values.length

  // Map each day to an (x, y) point in the viewBox.
  const pts = values.map((v, i) => {
    const x = n > 1 ? (i / (n - 1)) * w : w / 2
    const y = padTop + (1 - v / maxVal) * usableH
    return { x, y, v, i }
  })

  const linePath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')
  const areaPath = `${linePath} L ${pts[pts.length - 1].x.toFixed(1)} ${h - padBottom} L ${pts[0].x.toFixed(1)} ${h - padBottom} Z`
  const color = `var(--${cfg.color})`
  const fillColor = `var(--${cfg.color}-bg-subtle)`

  function tipText(p: { v: number; i: number }): string {
    return `${days[p.i].label} · ${cfg.fmt(p.v)}`
  }

  // The SVG stretches to card width with preserveAspectRatio="none", so its x
  // scale ≠ y scale. SVG <circle> elements get squished into ovals by that. We
  // draw the line/area in the (distorted-but-fine) SVG, but render the DOTS as
  // absolutely-positioned HTML divs (positioned by %) so they stay perfectly
  // round at any width. Same trick keeps the hover hit-areas clean.
  return (
    <div className="relative" style={{ height: h }} onMouseLeave={() => setTip(null)}>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" style={{ display: 'block' }}>
        <path d={areaPath} fill={fillColor} opacity={0.6} />
        <path d={linePath} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      </svg>
      {pts.map(p => (
        <div
          key={p.i}
          className="absolute rounded-full"
          style={{
            left: `${(p.x / w) * 100}%`,
            top: `${(p.y / h) * 100}%`,
            width: 5,
            height: 5,
            background: color,
            transform: 'translate(-50%, -50%)'
          }}
        />
      ))}
      {/* hover hit columns — transparent, full-height */}
      {pts.map(p => (
        <div
          key={`hit-${p.i}`}
          className="absolute top-0 h-full cursor-pointer"
          style={{ left: `${(p.x / w) * 100}%`, width: `${100 / Math.max(n, 1)}%`, transform: 'translateX(-50%)' }}
          onMouseMove={e => setTip({ x: e.clientX, y: e.clientY, text: tipText(p) })}
        />
      ))}
    </div>
  )
}

// ── Speech Card ───────────────────────────────────────────────────────────────

// Compact so it fits a KPI card: 45s → "45s", 13m3s → "13m", 90m → "1.5h".
function fmtListenTime(totalSeconds: number): string {
  if (totalSeconds < 60) return `${Math.round(totalSeconds)}s`
  const mins = totalSeconds / 60
  if (mins < 60) return `${Math.round(mins)}m`
  const hrs = mins / 60
  return `${hrs.toFixed(1).replace(/\.0$/, '')}h`
}

function SpeechSparkline({ wordsByDay }: { wordsByDay: SpeechData['wordsByDay'] }): JSX.Element {
  const values = wordsByDay.map(d => d.words)
  const maxVal = Math.max(...values, 1)
  const w = 320
  const h = 80
  const padTop = 8
  const padBottom = 4
  const usableH = h - padTop - padBottom
  const n = values.length

  const pts = values.map((v, i) => ({
    x: n > 1 ? (i / (n - 1)) * w : w / 2,
    y: padTop + (1 - v / maxVal) * usableH,
    v,
    i
  }))

  const linePath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')
  const areaPath = `${linePath} L ${pts[pts.length - 1].x.toFixed(1)} ${h - padBottom} L ${pts[0].x.toFixed(1)} ${h - padBottom} Z`

  return (
    <div>
      {/* Dots as HTML divs (not SVG circles) so they stay round under the
          non-uniform x-stretch — same reason as LineChart. */}
      <div className="relative" style={{ height: h }}>
        <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" style={{ display: 'block' }}>
          <path d={areaPath} fill="var(--cyan-bg-subtle)" opacity={0.6} />
          <path d={linePath} fill="none" stroke="var(--cyan)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        </svg>
        {pts.map(p => (
          <div
            key={p.i}
            className="absolute rounded-full"
            style={{ left: `${(p.x / w) * 100}%`, top: `${(p.y / h) * 100}%`, width: 5, height: 5, background: 'var(--cyan)', transform: 'translate(-50%, -50%)' }}
          />
        ))}
      </div>
      <div className="flex justify-between mt-1.5">
        <span className="text-xlg text-muted truncate">{wordsByDay[0]?.date}</span>
        <span className="text-xlg text-muted shrink-0 px-2">words spoken</span>
        <span className="text-xlg text-muted truncate text-right">{wordsByDay[wordsByDay.length - 1]?.date}</span>
      </div>
    </div>
  )
}

function SpeechCard({ speech }: { speech: SpeechData }): JSX.Element {
  return (
    <div className={cardCls}>
      <div className="grid grid-cols-4 gap-2.5 mb-4">
        <KpiChip label="Words" value={fmtCount(speech.totalWords)} color="cyan" icon={TypeIcon} />
        <KpiChip label="WPM" value={String(Math.round(speech.avgWpm))} sub="avg" color="violet" icon={Gauge} />
        <KpiChip label="Listened" value={fmtListenTime(speech.totalSeconds)} color="amber" icon={Mic} />
        <KpiChip label="Listens" value={fmtCount(speech.sessions)} color="green" icon={Activity} />
      </div>
      {speech.wordsByDay.length > 1 && (
        <SpeechSparkline wordsByDay={speech.wordsByDay} />
      )}
    </div>
  )
}

// ── Feedback Card ─────────────────────────────────────────────────────────────
// The eval surface for the 👍/👎 feedback loop. KPIs up top, then three over-time
// charts (approval %, 👍/👎 per run, rated coverage %) sharing the run x-axis, then
// the "what you've taught it" correction list. Lives in its own block — never
// folded into the run KPIs.

// Generic single-line trend over feedback buckets, same idiom as LineChart (line
// + area in a non-uniform SVG, dots as HTML divs so they stay round). `valueFor`
// maps a bucket to its plotted value; `fmt`/`color` style it; `hasData` greys out
// buckets with no ratings so a quiet day reads as a gap, not a 0% crash.
function FeedbackLine({
  series,
  valueFor,
  hasData,
  fmt,
  color,
  maxVal,
  setTip
}: {
  series: FeedbackSeriesBucket[]
  valueFor: (b: FeedbackSeriesBucket) => number
  hasData: (b: FeedbackSeriesBucket) => boolean
  fmt: (v: number) => string
  color: string
  /** Y-axis ceiling. Pass 1 for ratios (0–1), or a computed max for per-run counts. */
  maxVal: number
  setTip: (t: TipState) => void
}): JSX.Element {
  const w = 320
  const h = 80
  const padTop = 8
  const padBottom = 4
  const usableH = h - padTop - padBottom
  const n = series.length
  const max = Math.max(maxVal, 0.0001)

  const pts = series.map((b, i) => ({
    x: n > 1 ? (i / (n - 1)) * w : w / 2,
    y: padTop + (1 - valueFor(b) / max) * usableH,
    v: valueFor(b),
    on: hasData(b),
    i
  }))

  const linePath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')
  const areaPath = `${linePath} L ${pts[pts.length - 1].x.toFixed(1)} ${h - padBottom} L ${pts[0].x.toFixed(1)} ${h - padBottom} Z`

  return (
    <div className="relative" style={{ height: h }} onMouseLeave={() => setTip(null)}>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" style={{ display: 'block' }}>
        <path d={areaPath} fill={`var(--${color}-bg-subtle)`} opacity={0.6} />
        <path d={linePath} fill="none" stroke={`var(--${color})`} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      </svg>
      {pts.map(p => (
        <div
          key={p.i}
          className="absolute rounded-full"
          style={{
            left: `${(p.x / w) * 100}%`,
            top: `${(p.y / h) * 100}%`,
            width: 5,
            height: 5,
            // Empty buckets render a hollow grey dot so a no-rating gap is obvious.
            background: p.on ? `var(--${color})` : 'var(--surface3)',
            transform: 'translate(-50%, -50%)'
          }}
        />
      ))}
      {pts.map(p => (
        <div
          key={`hit-${p.i}`}
          className="absolute top-0 h-full cursor-pointer"
          style={{ left: `${(p.x / w) * 100}%`, width: `${100 / Math.max(n, 1)}%`, transform: 'translateX(-50%)' }}
          onMouseMove={e => setTip({ x: e.clientX, y: e.clientY, text: `${series[p.i].label} · ${p.on ? fmt(p.v) : 'no ratings'}` })}
        />
      ))}
    </div>
  )
}

// Stacked 👍/👎-per-run bars: 👍 (green, bottom) + 👎 (red, top), height = votes/run
// in that bucket. Shows satisfaction rising + issues falling at a glance. Scaled to
// the max per-run total so a heavy-feedback bucket reads tall.
function FeedbackVoteBars({ series, setTip }: { series: FeedbackSeriesBucket[]; setTip: (t: TipState) => void }): JSX.Element {
  const perRun = (b: FeedbackSeriesBucket, votes: number): number => (b.runs > 0 ? votes / b.runs : 0)
  const maxTotal = Math.max(...series.map(b => perRun(b, b.up) + perRun(b, b.down)), 0.0001)
  const w = 320
  const chartH = 64
  const n = series.length
  const gap = n > 40 ? 1 : 2
  const barW = (w - gap * (n - 1)) / n

  const tip = (b: FeedbackSeriesBucket): string => {
    const parts: string[] = []
    if (b.up > 0) parts.push(`${b.up}👍`)
    if (b.down > 0) parts.push(`${b.down}👎`)
    return `${b.label} · ${parts.length ? parts.join(' ') : 'no ratings'}${b.runs > 0 ? ` of ${b.runs} run${b.runs !== 1 ? 's' : ''}` : ''}`
  }

  return (
    <svg viewBox={`0 0 ${w} ${chartH}`} width="100%" height={chartH} preserveAspectRatio="none" style={{ display: 'block' }} onMouseLeave={() => setTip(null)}>
      {series.map((b, i) => {
        const x = i * (barW + gap)
        const upH = (perRun(b, b.up) / maxTotal) * (chartH - 4)
        const downH = (perRun(b, b.down) / maxTotal) * (chartH - 4)
        const hasAny = b.up + b.down > 0
        return (
          <g key={b.key} onMouseMove={e => setTip({ x: e.clientX, y: e.clientY, text: tip(b) })} style={{ cursor: 'pointer' }}>
            <rect x={x} y={0} width={barW} height={chartH} fill="transparent" />
            {upH > 0 && <rect x={x} y={chartH - upH} width={barW} height={Math.max(upH, 2)} rx={2} fill="var(--green)" opacity={0.9} />}
            {downH > 0 && <rect x={x} y={chartH - upH - downH} width={barW} height={Math.max(downH, 2)} rx={2} fill="var(--red)" opacity={0.9} />}
            {!hasAny && <rect x={x} y={chartH - 2} width={barW} height={2} rx={1} fill="var(--surface3)" />}
          </g>
        )
      })}
    </svg>
  )
}

const FB_MODE_TINT: Record<AppMode, string> = { rewrite: 'cyan', ask: 'violet', act: 'amber', write: 'cyan' }

// Shared x/y axis strip under a feedback chart: first bucket label (left), the
// y-axis meaning (center), last bucket label (right) — mirrors the Trends chart so
// every over-time chart reads the same way.
function FbAxis({ series, yLabel }: { series: FeedbackSeriesBucket[]; yLabel: string }): JSX.Element {
  return (
    <div className="flex justify-between mt-1.5">
      <span className="text-xlg text-muted truncate">{series[0]?.label}</span>
      <span className="text-xlg text-muted shrink-0 px-2">{yLabel}</span>
      <span className="text-xlg text-muted truncate text-right">{series[series.length - 1]?.label}</span>
    </div>
  )
}

function FeedbackCard({ f, setTip }: { f: FeedbackData; setTip: (t: TipState) => void }): JSX.Element {
  const trendUp = f.trendDelta >= 0
  return (
    <div className={cardCls}>
      {/* KPI row — approval leads (the headline eval number). */}
      <div className="grid grid-cols-3 gap-2.5 mb-4">
        <KpiChip label="Approval" value={fmtPct(f.approvalRate)} sub={`${f.up}👍 ${f.down}👎`} color="green" icon={ThumbsUp} />
        <KpiChip label="Praises" value={String(f.praises)} sub="what worked" color="green" icon={ThumbsUp} />
        <KpiChip label="Corrections" value={String(f.corrections)} sub="what to fix" color="red" icon={ThumbsDown} />
        <KpiChip label="Rated" value={fmtPct(f.ratedCoverage)} sub={`${f.rated} of ${f.totalRuns} runs`} color="cyan" icon={Percent} />
        <KpiChip
          label="Trend"
          value={`${trendUp ? '+' : ''}${Math.round(f.trendDelta * 100)}pt`}
          sub="approval shift"
          color={trendUp ? 'green' : 'red'}
          icon={TrendingUp}
        />
      </div>

      {/* 1. Approval rate over time — the eval line. Climbs = getting better. */}
      <div className={cardTitleCls}>👍 Approval rate over time</div>
      <FeedbackLine
        series={f.series}
        valueFor={b => (b.up + b.down > 0 ? b.up / (b.up + b.down) : 0)}
        hasData={b => b.up + b.down > 0}
        fmt={v => fmtPct(v)}
        color="green"
        maxVal={1}
        setTip={setTip}
      />
      <FbAxis series={f.series} yLabel="% approved" />

      {/* 2. 👍/👎 per run over time — satisfaction up, issues down, stacked. */}
      <div className={`${cardTitleCls} mt-4`}>👍 / 👎 per run over time</div>
      <FeedbackVoteBars series={f.series} setTip={setTip} />
      <FbAxis series={f.series} yLabel="votes per run" />
      <div className="flex gap-3 mt-2">
        <span className="flex items-center gap-1 text-xlg text-muted">
          <span className="w-2 h-2 rounded-full inline-block" style={{ background: 'var(--green)' }} />
          👍 per run
        </span>
        <span className="flex items-center gap-1 text-xlg text-muted">
          <span className="w-2 h-2 rounded-full inline-block" style={{ background: 'var(--red)' }} />
          👎 per run
        </span>
      </div>

      {/* 3. Rated coverage over time — how much activity gets feedback. */}
      <div className={`${cardTitleCls} mt-4`}>📊 Rated coverage over time</div>
      <FeedbackLine
        series={f.series}
        valueFor={b => (b.runs > 0 ? (b.up + b.down) / b.runs : 0)}
        hasData={b => b.runs > 0}
        fmt={v => fmtPct(v)}
        color="cyan"
        maxVal={1}
        setTip={setTip}
      />
      <FbAxis series={f.series} yLabel="% of runs rated" />

      {/* What you've taught it — the recent notes feeding the model, both sides.
          👍 praises (green, "keep doing") and 👎 corrections (red, "fix"), newest
          first, each tagged with a left accent + arrow so the two read apart. */}
      {f.recent.length > 0 && (
        <>
          <div className={`${cardTitleCls} mt-4`}>✍️ What you've taught it</div>
          <div className="flex flex-col gap-1.5">
            {f.recent.map((c, i) => {
              const isPraise = c.rating === 'up'
              const accent = isPraise ? 'var(--green)' : 'var(--red)'
              return (
                <div
                  key={i}
                  className="rounded-md px-2.5 py-2 bg-surface2 border border-surface3 border-l-2"
                  style={{ borderLeftColor: accent }}
                >
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <span
                      className="text-micro uppercase tracking-wide font-bold px-1.5 py-0.5 rounded"
                      style={{ color: `var(--${FB_MODE_TINT[c.mode]})`, background: `var(--${FB_MODE_TINT[c.mode]}-bg-subtle)` }}
                    >
                      {MODE_LABELS[c.mode] ?? c.mode}
                    </span>
                    {c.instruction && (
                      <span className="text-xlg text-muted truncate" title={c.instruction}>"{c.instruction}"</span>
                    )}
                  </div>
                  <div className="text-xs text-on-surface leading-snug">
                    <span style={{ color: accent }}>{isPraise ? '✓ liked: ' : '→ wanted: '}</span>
                    {c.note}
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

// ── Suggestions Card ──────────────────────────────────────────────────────────
// Proactive cursor-suggestion analytics — its OWN block, never folded into the
// run KPIs. Funnel (shown → accepted), what the user picks (by mode), where they
// land (top apps), and generation latency over time (the perf watch).

// 850 → "850ms", 2400 → "2.4s".
function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1).replace(/\.0$/, '')}s`
}

// Compact mode donut for the Suggestions "What you pick" — pairs with the bars to
// its right (which act as the legend, so this carries no labels of its own). Lighter
// than the breakdown ModeDonut: no listen slice, no internal sort/legend, just the
// ring. Colored by MODE_COLORS so the slice and its bar match.
function MiniModeDonut({ byMode, setTip }: {
  byMode: { mode: AppMode; count: number }[]
  setTip: (t: TipState) => void
}): JSX.Element {
  const r = 30
  const strokeW = 11
  const c = 40
  const circ = 2 * Math.PI * r
  const total = byMode.reduce((s, m) => s + m.count, 0)

  let offset = 0
  const segs = byMode.map(m => {
    const pct = total > 0 ? m.count / total : 0
    const dash = pct * circ
    const seg = { ...m, pct, dash, offset }
    offset += dash
    return seg
  })

  return (
    <svg viewBox="0 0 80 80" width={80} height={80} onMouseLeave={() => setTip(null)} className="shrink-0">
      <circle cx={c} cy={c} r={r} fill="none" stroke="var(--surface3)" strokeWidth={strokeW} />
      {segs.map((seg, i) => (
        <circle
          key={i}
          cx={c} cy={c} r={r}
          fill="none"
          stroke={MODE_COLORS[seg.mode]}
          strokeWidth={strokeW}
          strokeDasharray={`${seg.dash} ${circ - seg.dash}`}
          strokeDashoffset={circ / 4 - seg.offset}
          style={{ transition: 'stroke-dasharray 0.4s ease', cursor: 'pointer' }}
          onMouseMove={e => setTip({ x: e.clientX, y: e.clientY, text: `${MODE_LABELS[seg.mode]} · ${seg.count} (${fmtPct(seg.pct)})` })}
        />
      ))}
      <text x={c} y={c + 4} textAnchor="middle" fontSize={16} fontWeight="bold" fill="var(--on-surface)">{total}</text>
    </svg>
  )
}

// Horizontal ranked bars (accepted-by-mode, top-apps). One home for both lists.
// Optional per-row `color` tints the fill — "What you pick" passes mode colors so
// each bar reads as its mode; "Where shown" omits it (apps aren't modes → brand).
// Optional per-row `app` renders the real bundle icon (top-apps rows); mode rows
// leave it unset so no icon shows.
function SuggestionBars({ rows, total, unit, setTip }: {
  rows: { label: string; count: number; color?: string; app?: string }[]
  total: number
  unit: string
  setTip: (t: TipState) => void
}): JSX.Element {
  const maxCount = Math.max(...rows.map(r => r.count), 1)
  return (
    <div className="flex flex-col gap-1.5" onMouseLeave={() => setTip(null)}>
      {rows.map((r, i) => {
        const pct = (r.count / maxCount) * 100
        const pctOfTotal = total > 0 ? Math.round((r.count / total) * 100) : 0
        const short = r.label.length > 22 ? r.label.slice(0, 21) + '…' : r.label
        return (
          <div
            key={i}
            className="flex items-center gap-2 cursor-pointer"
            onMouseMove={e => setTip({ x: e.clientX, y: e.clientY, text: `${r.label} · ${r.count} ${unit}${r.count !== 1 ? 's' : ''} (${pctOfTotal}%)` })}
          >
            {r.app && <AppIcon app={r.app} size={15} />}
            <span className="text-xs text-on-surface w-20 truncate">{short}</span>
            <ProgressBar pct={pct} color={r.color} />
            <span className="text-xs text-muted w-8 text-right">{pctOfTotal}%</span>
          </div>
        )
      })}
    </div>
  )
}

// Decision → label + color token. One home so the stacked bar + legend agree.
const DECISION_META: Record<SuggestionDecisionId, { label: string; color: string }> = {
  accepted: { label: 'Accepted', color: 'green' },
  rejected: { label: 'Dismissed', color: 'amber' },
  superseded: { label: 'Replaced', color: 'violet' },
  ignored: { label: 'Ignored', color: 'cyan' }
}

// Single stacked bar of every decision made on a shown suggestion, with a legend
// below. Reads "what happened to each suggestion" at a glance.
function DecisionBar({ rows, total, setTip }: {
  rows: SuggestionsData['byDecision']
  total: number
  setTip: (t: TipState) => void
}): JSX.Element {
  return (
    <div onMouseLeave={() => setTip(null)}>
      <div className="flex h-3 rounded-full overflow-hidden bg-surface2">
        {rows.map((r, i) => {
          const pct = total > 0 ? (r.count / total) * 100 : 0
          const m = DECISION_META[r.decision]
          return (
            <div
              key={i}
              className="h-full cursor-pointer"
              style={{ width: `${pct}%`, background: `var(--${m.color})` }}
              onMouseMove={e => setTip({ x: e.clientX, y: e.clientY, text: `${m.label} · ${r.count} (${Math.round(pct)}%)` })}
            />
          )
        })}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2">
        {rows.map((r, i) => {
          const m = DECISION_META[r.decision]
          const pct = total > 0 ? Math.round((r.count / total) * 100) : 0
          return (
            <span key={i} className="flex items-center gap-1.5 text-xlg text-muted">
              <span className="inline-block rounded-full" style={{ width: 7, height: 7, background: `var(--${m.color})` }} />
              {m.label} <span className="text-on-surface font-medium">{r.count}</span>
              <span className="text-muted">· {pct}%</span>
            </span>
          )
        })}
      </div>
    </div>
  )
}

function SuggestionsCard({ s, setTip }: { s: SuggestionsData; setTip: (t: TipState) => void }): JSX.Element {
  return (
    <div className={cardCls}>
      {/* Funnel KPIs */}
      <div className="grid grid-cols-4 gap-2.5 mb-4">
        <KpiChip label="Shown" value={fmtCount(s.shown)} color="cyan" icon={Lightbulb} />
        <KpiChip label="Accepted" value={fmtCount(s.accepted)} color="green" icon={CheckIcon} />
        <KpiChip label="Accept rate" value={fmtPct(s.acceptRate)} color="accent" icon={Activity} />
        <KpiChip
          label="Avg gen"
          value={s.gen ? fmtMs(s.gen.avgMs) : '–'}
          sub={s.gen ? `p95 ${fmtMs(s.gen.p95Ms)}` : 'no timing'}
          color="violet"
          icon={Timer}
        />
      </div>

      {/* Decision breakdown — what happened to each shown suggestion */}
      {s.byDecision.length > 0 && (
        <div className="mb-4">
          <div className={cardTitleCls}>Decision on each</div>
          <DecisionBar rows={s.byDecision} total={s.shown} setTip={setTip} />
        </div>
      )}

      {/* What they pick + where it lands */}
      <div className="grid grid-cols-2 gap-3 mb-3">
        <div>
          <div className={cardTitleCls}>What you pick</div>
          {s.byMode.length > 0
            ? (
              <div className="flex items-center gap-3">
                <MiniModeDonut byMode={s.byMode} setTip={setTip} />
                <div className="flex-1 min-w-0">
                  <SuggestionBars rows={s.byMode.map(m => ({ label: MODE_LABELS[m.mode], count: m.count, color: MODE_COLORS[m.mode] }))} total={s.accepted} unit="accept" setTip={setTip} />
                </div>
              </div>
            )
            : <span className="text-xs text-muted">None accepted yet</span>}
        </div>
        <div>
          <div className={cardTitleCls}>Where shown</div>
          {s.topApps.length > 0
            ? <SuggestionBars rows={s.topApps.map(a => ({ label: a.app, count: a.count, app: a.app }))} total={s.shown} unit="time" setTip={setTip} />
            : <span className="text-xs text-muted">No app data</span>}
        </div>
      </div>

      {/* Generation time spread — distribution by latency (not by date). Shows
          where generations land (most 1–2s, a few slow), the more useful read. */}
      {s.gen && s.gen.distribution?.some(b => b.count > 0) && (
        <div>
          <div className={cardTitleCls}>
            Generation time · {s.gen.samples} timed · p50 {fmtMs(s.gen.p50Ms)}
          </div>
          <DistributionHistogram buckets={s.gen.distribution} unit="suggestion" setTip={setTip} />
        </div>
      )}
    </div>
  )
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

function Sk({ w, h = 12, className = '' }: { w?: string; h?: number; className?: string }): JSX.Element {
  return <div className={`skeleton ${className}`} style={{ width: w ?? '100%', height: h }} />
}

// Mirrors the real layout's structure (KPI grid → heatmap → daily → breakdown)
// so the window paints a full, recognizable frame instantly instead of a spinner.
function AnalyticsSkeleton(): JSX.Element {
  return (
    <div className="pt-3" aria-busy="true">
      {/* KPI chips */}
      <div className="grid grid-cols-3 gap-2.5 mb-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-2 rounded-lg px-3 py-3 bg-surface1 border border-surface3">
            <Sk w="55%" h={10} />
            <Sk w="50%" h={22} className="mt-1" />
            <Sk w="40%" h={7} />
          </div>
        ))}
      </div>
      {/* badges */}
      <div className="flex gap-2 mb-4">
        <Sk w="92px" h={22} className="rounded-full" />
        <Sk w="104px" h={22} className="rounded-full" />
      </div>
      {/* heatmap card */}
      <Sk w="40%" h={10} className="mt-4 mb-2" />
      <div className={cardCls}><Sk h={84} /></div>
      {/* daily card */}
      <Sk w="48%" h={10} className="mt-4 mb-2" />
      <div className={cardCls}><Sk h={64} /></div>
      {/* breakdown */}
      <Sk w="30%" h={10} className="mt-4 mb-2" />
      <div className="grid grid-cols-2 gap-3">
        <div className={cardCls.replace(' mb-3', '')}><Sk h={150} /></div>
        <div className={cardCls.replace(' mb-3', '')}><Sk h={150} /></div>
      </div>
    </div>
  )
}

// ── Empty State ───────────────────────────────────────────────────────────────

function EmptyState(): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-muted">
      <span style={{ fontSize: 40 }}>📊</span>
      <span className="text-lg font-semibold text-on-surface">No activity yet</span>
      <span className="text-sm text-center max-w-xs leading-relaxed">
        Use {CONFIG.PRODUCT_NAME} to rewrite text, ask questions, run actions, or dictate by voice. Your stats will appear here.
      </span>
    </div>
  )
}

// ── Range Tab Strip ───────────────────────────────────────────────────────────

const RANGES: { id: AnalyticsRange; label: string }[] = [
  { id: 'daily', label: 'Today' },
  { id: 'weekly', label: 'Week' },
  { id: 'monthly', label: 'Month' },
  { id: 'alltime', label: 'All Time' }
]

// Range-aware section headers so the charts read correctly per granularity
// (the old "Daily runs, last 1 days" / hardcoded "52 weeks" were misleading).
const ACTIVITY_LABEL: Record<AnalyticsRange, string> = {
  daily: 'Activity, today hourly',
  weekly: 'Activity, last 7 days',
  monthly: 'Activity, last 30 days',
  alltime: 'Activity, 52 weeks'
}
const RUNS_LABEL: Record<AnalyticsRange, string> = {
  daily: 'Runs & listens by hour',
  weekly: 'Runs & listens by day, last 7 days',
  monthly: 'Runs & listens by day, last 30 days',
  alltime: 'Runs & listens by week, 52 weeks'
}

// ── Section SSOT + sticky jump-nav ────────────────────────────────────────────
// ONE list defines every dashboard section: its anchor id, nav-chip label/icon,
// and whether it shows for the current data. The jump-nav and the section headers
// BOTH read this — add a section here once and it gets a nav chip + a scroll
// anchor for free, always in sync. `nav` short label feeds the chip; the header
// can still render a longer range-aware title via SectionHeader's `title` prop.
type SectionId =
  | 'activity' | 'runs' | 'trends' | 'codesessions' | 'agentusage' | 'speech' | 'suggestions'
  | 'feedback' | 'breakdown' | 'performance' | 'timeofday' | 'insight'

interface SectionDef {
  id: SectionId
  /** Short chip label. */
  nav: string
  icon: LucideIcon
  /** Visible for this data? Always-on sections return true. */
  show: (d: AnalyticsData) => boolean
}

const ANALYTICS_SECTIONS: SectionDef[] = [
  { id: 'activity', nav: 'Activity', icon: Activity, show: () => true },
  { id: 'runs', nav: 'Runs', icon: Play, show: () => true },
  { id: 'trends', nav: 'Trends', icon: TrendingUp, show: () => true },
  { id: 'codesessions', nav: 'Code sessions', icon: Layers, show: d => !!d.agentSessions },
  { id: 'agentusage', nav: 'Agent usage', icon: Coins, show: d => !!d.agentSpend },
  { id: 'speech', nav: 'Speech', icon: Mic, show: d => !!d.speech },
  { id: 'suggestions', nav: 'Suggestions', icon: Lightbulb, show: d => !!d.suggestions },
  { id: 'feedback', nav: 'Feedback', icon: ThumbsUp, show: d => !!d.feedback },
  { id: 'breakdown', nav: 'Breakdown', icon: Gauge, show: () => true },
  { id: 'performance', nav: 'Performance', icon: Timer, show: () => true },
  { id: 'timeofday', nav: 'Time of day', icon: Clock, show: () => true },
  { id: 'insight', nav: 'Tips', icon: Sparkles, show: () => true }
]

// A section header that doubles as a scroll anchor. `scroll-mt` offsets the sticky
// nav so the header isn't hidden under it after a jump.
function SectionHeader({ id, title }: { id: SectionId; title: string }): JSX.Element {
  return (
    <div id={`sec-${id}`} className={`${sectionCls} scroll-mt-12`}>
      {title}
    </div>
  )
}

// Sticky horizontal-scroll chip bar — one chip per visible section, click to jump.
// Scrolls horizontally on overflow so every section is reachable from the top. The
// chips come straight from ANALYTICS_SECTIONS (SSOT), filtered by `show(data)`.
function SectionNav({ data }: { data: AnalyticsData }): JSX.Element {
  const visible = ANALYTICS_SECTIONS.filter(s => s.show(data))
  const jump = (id: SectionId): void => {
    document.getElementById(`sec-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  return (
    <div className="sticky top-0 z-30 -mx-5 py-2 bg-bg border-b border-surface3 mb-3">
      {/* Padding lives on the scroll track (not the sticky wrapper) so the first
          and last chips get edge breathing room AND can scroll fully into view —
          padding on the wrapper would clip the first chip under the page gutter. */}
      <div className="flex gap-1.5 overflow-x-auto no-scrollbar px-5">
        {visible.map(s => {
          const Icon = s.icon
          return (
            <Button
              variant="bare"
              key={s.id}
              onClick={() => jump(s.id)}
              className="flex items-center gap-1.5 shrink-0 text-xlg font-semibold text-muted border border-surface3 bg-surface1 rounded-full px-2.5 py-1 hover:bg-surface2 hover:text-on-surface transition-colors whitespace-nowrap"
            >
              <Icon size={12} strokeWidth={2.5} />
              {s.nav}
            </Button>
          )
        })}
      </div>
    </div>
  )
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function AnalyticsApp(): JSX.Element {
  const [data, setData] = useState<AnalyticsData | null>(null)
  const [range, setRange] = useState<AnalyticsRange>('alltime')
  const [loading, setLoading] = useState(true)
  const [insight, setInsight] = useState<string>('')
  const [insightLoading, setInsightLoading] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [tip, setTip] = useState<TipState>(null)
  const [metric, setMetric] = useState<MetricId>('runs')

  // Stats only — fast, no LLM. The AI insight is manual now (user clicks
  // "Generate"); it doesn't auto-fire on load/range-change. Switching range or
  // refreshing clears any prior insight so it can't go stale against new stats.
  const fetchData = useCallback((r: AnalyticsRange) => {
    setLoading(true)
    setInsight('')
    setInsightLoading(false)
    window.api.analyticsRequest(r).then(d => {
      setData(d)
      setLastUpdated(new Date())
      setLoading(false)
    })
  }, [])

  // Manual AI-insight trigger. Routes through the selected backend in main.
  const generateInsight = useCallback(() => {
    setInsight('')
    setInsightLoading(true)
    window.api.analyticsInsight(range)
      .then(text => setInsight(text))
      .catch(() => setInsight(''))
      .finally(() => setInsightLoading(false))
  }, [range])

  // Restore the last-picked range on open (persisted in PREFS), so the user
  // doesn't have to re-toggle to Week/Month every time they reopen the window.
  useEffect(() => {
    document.title = `${CONFIG.BRAND_NAME} Analytics`
    window.api.analyticsInitialRange().then(r => {
      setRange(r)
      fetchData(r)
    })
  }, [fetchData])

  function handleRangeChange(r: AnalyticsRange): void {
    setRange(r)
    fetchData(r)
  }

  const successColor =
    !data ? 'green'
    : data.successRate >= 0.9 ? 'green'
    : data.successRate >= 0.7 ? 'amber'
    : 'red'

  return (
    <WindowFrame title={`${CONFIG.APP_NAME} Analytics`}>
      <div className="px-5 pb-8 pt-4">
        {/* Range tabs */}
        <SegmentedControl items={RANGES} active={range} onChange={handleRangeChange} />

        {loading && <AnalyticsSkeleton />}

        {!loading && data && data.totalRuns === 0 && data.totalListens === 0 && data.totalCaptures === 0 && !data.suggestions && !data.feedback && <EmptyState />}

        {!loading && data && (data.totalRuns > 0 || data.totalListens > 0 || data.totalCaptures > 0 || data.suggestions || data.feedback) && (
          <>
            {/* ── Hero KPIs ─────────────────────────────────────────────── */}
            {/* Runs + Listens lead — our two main interactions. */}
            <div className="grid grid-cols-3 gap-2.5 mb-3">
              <KpiChip label="Runs" value={String(data.totalRuns)} sub={fmtRunModeSplit(data.byMode)} color="cyan" icon={Play} />
              <KpiChip label="Listens" value={String(data.totalListens)} color="green" icon={Mic} />
              <KpiChip label="Captured" value={String(data.totalCaptures)} sub="shots + recordings" color="violet" icon={Camera} />
              <KpiChip label="Saved" value={`~${data.estimatedMinsSaved}m`} sub="estimated" color="amber" icon={Clock} />
              <KpiChip label="Success" value={fmtPct(data.successRate)} color={successColor} icon={Check} />
              <KpiChip label="Avg Speed" value={fmtDur(data.avgDurationS)} color="violet" icon={Gauge} />
              <KpiChip label="Generated" value={fmtCount(data.totalCharsGenerated)} sub="chars" color="accent" icon={Sparkles} />
            </div>

            {/* Stat chips — each reads "Label: value" so the number isn't ambiguous.
                The label is muted; the value carries the chip's tint. Streak shows
                whenever there's activity; the run-only chips need a top model. */}
            <div className="flex flex-wrap gap-2 mb-4">
              {data.currentStreak > 0 && (
                <Badge color="orange">
                  <span>🔥</span>
                  <span className="text-muted font-medium">Streak</span>
                  <span>{data.currentStreak}d</span>
                  {data.longestStreak > data.currentStreak && (
                    <span className="text-muted font-medium">· best {data.longestStreak}d</span>
                  )}
                </Badge>
              )}
              {data.topModel && (
                <>
                <Badge color="amber">
                  <span>🤖</span>
                  <span className="text-muted font-medium">{data.byModel.length > 1 ? 'Top model' : 'Model'}</span>
                  <span>{data.topModel}</span>
                  {data.byModel.length > 1 && (
                    <span className="text-muted font-medium">· {data.byModel.length} used</span>
                  )}
                </Badge>
                <Badge color="accent">
                  <span>🎯</span>
                  <span className="text-muted font-medium">Ran with context</span>
                  <span>{fmtPct(data.ctxAttachedPct)} of runs</span>
                </Badge>
                {data.avgTurnCount > 0 && (
                  <Badge color="cyan">
                    <span>💬</span>
                    <span className="text-muted font-medium">Avg conversation</span>
                    <span>{data.avgTurnCount.toFixed(1)} turns</span>
                  </Badge>
                )}
                </>
              )}
            </div>

            {/* Sticky jump-nav — chips for every visible section (SSOT). */}
            <SectionNav data={data} />

            {/* ── Activity ──────────────────────────────────────────────── */}
            <SectionHeader id="activity" title={ACTIVITY_LABEL[range]} />
            <div className={cardCls}>
              <ActivityGrid series={data.series} granularity={data.granularity} heatmap={data.heatmap} setTip={setTip} />
            </div>

            <SectionHeader id="runs" title={RUNS_LABEL[range]} />
            <div className={cardCls}>
              <ActivityBars days={data.series} setTip={setTip} />
              <div className="flex gap-3 mt-2">
                <span className="flex items-center gap-1 text-xlg text-muted">
                  <span className="w-2 h-2 rounded-full inline-block" style={{ background: RUN_COLOR }} />
                  runs
                </span>
                <span className="flex items-center gap-1 text-xlg text-muted">
                  <span className="w-2 h-2 rounded-full inline-block" style={{ background: LISTEN_COLOR }} />
                  listens
                </span>
              </div>
              <div className="text-xlg text-muted mt-2">{RUN_MEANS}</div>
            </div>

            {/* ── Trends ────────────────────────────────────────────────── */}
            <SectionHeader id="trends" title="Trends" />
            <div className={cardCls}>
              <SegmentedControl
                items={METRICS.map(m => ({ id: m.id, label: m.label, activeColor: `var(--${m.color})` }))}
                active={metric}
                onChange={setMetric}
                textSize="text-xs"
                activeWeight={700}
                className="mb-3"
              />
              <LineChart days={data.series} metric={metric} setTip={setTip} />
              <div className="flex justify-between mt-1.5">
                <span className="text-xlg text-muted">{data.series[0]?.label}</span>
                <span className="text-xlg text-muted">
                  {metric === 'runs' ? 'runs per period' : metric === 'cumulative' ? 'cumulative total' : metric === 'speed' ? 'avg seconds' : metric === 'success' ? '% success' : 'chars'}
                </span>
                <span className="text-xlg text-muted">{data.series[data.series.length - 1]?.label}</span>
              </div>
            </div>

            {data.agentSessions && (
              <>
                <SectionHeader id="codesessions" title="Code sessions" />
                <AgentSessionsCard data={data.agentSessions} className={cardCls} setTip={setTip} />
              </>
            )}

            {data.agentSpend && (
              <>
                <SectionHeader id="agentusage" title="Agent usage" />
                <AgentSpendCard data={data.agentSpend} className={cardCls} setTip={setTip} />
              </>
            )}

            {/* ── Speech ────────────────────────────────────────────────── */}
            {data.speech && (
              <>
                <SectionHeader id="speech" title="Speech" />
                <SpeechCard speech={data.speech} />
              </>
            )}

            {/* ── Suggestions (proactive companion — its own block) ──────── */}
            {data.suggestions && (
              <>
                <SectionHeader id="suggestions" title="Suggestions" />
                <SuggestionsCard s={data.suggestions} setTip={setTip} />
              </>
            )}

            {/* ── Feedback & learning (👍/👎 loop eval — its own block) ───── */}
            {data.feedback && (
              <>
                <SectionHeader id="feedback" title="Feedback & learning" />
                <FeedbackCard f={data.feedback} setTip={setTip} />
              </>
            )}

            {/* ── Breakdown ─────────────────────────────────────────────── */}
            <SectionHeader id="breakdown" title="Breakdown" />
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div className={cardCls.replace(' mb-3', '')}>
                <div className={cardTitleCls}>What you use</div>
                <ModeDonut byMode={data.byMode} listens={data.totalListens} setTip={setTip} />
              </div>
              <div className={cardCls.replace(' mb-3', '')}>
                <div className={cardTitleCls}>Top apps</div>
                {data.topApps.length > 0
                  ? <TopApps apps={data.topApps} total={data.totalRuns} setTip={setTip} />
                  : <span className="text-xs text-muted">No app data</span>
                }
              </div>
            </div>

            {/* Models used — full split, so frequent switching is visible */}
            {data.byModel.length > 0 && (
              <div className={cardCls}>
                <div className={cardTitleCls}>Models used</div>
                <TopModels models={data.byModel} total={data.totalRuns} setTip={setTip} />
              </div>
            )}

            {/* Mode mix over time — rewrite / ask / act / listen per bucket */}
            <div className={cardCls}>
              <div className={cardTitleCls}>
                Mode mix {data.granularity === 'hour' ? 'by hour' : data.granularity === 'week' ? 'by week' : 'by day'}
              </div>
              <ModeStackChart days={data.series} setTip={setTip} />
            </div>

            {/* ── Performance ───────────────────────────────────────────── */}
            <SectionHeader id="performance" title="Performance" />
            <div className={cardCls}>
              <div className={cardTitleCls}>How fast</div>
              <DistributionHistogram buckets={data.durationBuckets} unit="run" setTip={setTip} />
            </div>

            <div className={cardCls}>
              <div className={cardTitleCls}>How much text</div>
              <CharsTwinBar input={data.totalCharsInput} output={data.totalCharsGenerated} />
            </div>

            {/* ── Time of Day ───────────────────────────────────────────── */}
            <SectionHeader id="timeofday" title="Time of day" />
            <div className={cardCls}>
              <div className={cardTitleCls}>When you use {CONFIG.PRODUCT_NAME}</div>
              <HourChart byHour={data.byHour} setTip={setTip} />
              <div className="flex gap-3 mt-2">
                <span className="flex items-center gap-1 text-xlg text-muted">
                  <span className="w-2 h-2 rounded-full inline-block" style={{ background: 'var(--amber)' }} />
                  peak hour
                </span>
                <span className="flex items-center gap-1 text-xlg text-muted">
                  <span className="w-2 h-2 rounded-full inline-block" style={{ background: 'var(--violet-bg-subtle)', border: '1px solid var(--violet)' }} />
                  night (10p–6a)
                </span>
                <span className="flex items-center gap-1 text-xlg text-muted">
                  <span className="w-2 h-2 rounded-full inline-block" style={{ background: 'var(--cyan-bg-subtle)', border: '1px solid var(--cyan)' }} />
                  daytime
                </span>
              </div>
            </div>

            {/* ── AI Insight ────────────────────────────────────────────── */}
            {/* Manual: the user clicks Generate to run the LLM. It goes through
                the selected backend in main, so it works on claude/codex/etc. */}
            <div className="flex items-center justify-between mt-1">
              <div id="sec-insight" className={`${sectionCls} scroll-mt-12`}>Tips</div>
              <Button
                variant="ghost"
                onClick={generateInsight}
                disabled={insightLoading}
                className="disabled:opacity-50"
              >
                {insightLoading ? 'Generating…' : insight ? 'Regenerate' : 'Generate'}
              </Button>
            </div>
            {(insightLoading || insight) && (
              <div
                className="rounded-md p-4 mb-3"
                style={{
                  background: 'var(--accent-bg-subtle)',
                  border: '1px solid var(--accent-border-subtle)'
                }}
              >
                <div className="text-xs uppercase text-muted font-bold tracking-wider mb-2">
                  Generated by {data.topModel || 'Claude'}
                </div>
                {insight ? (
                  <p className="text-md text-on-surface leading-relaxed" style={{ fontStyle: 'italic' }}>
                    {insight}
                  </p>
                ) : (
                  <div className="flex flex-col gap-2">
                    <Sk w="100%" h={12} />
                    <Sk w="80%" h={12} />
                  </div>
                )}
              </div>
            )}

            {/* ── Footer ────────────────────────────────────────────────── */}
            <div className="flex items-center justify-between mt-4">
              <span className="text-xs text-muted">
                {lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString()}` : ''}
                {data.dataSpanDays > 0 ? ` · ${data.dataSpanDays} day${data.dataSpanDays !== 1 ? 's' : ''} of data` : ''}
              </span>
              <Button
                variant="ghost"
                onClick={() => fetchData(range)}
              >
                Refresh
              </Button>
            </div>
          </>
        )}
      </div>
      <Tooltip tip={tip} />
    </WindowFrame>
  )
}

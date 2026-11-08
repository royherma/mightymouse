import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { CSSProperties, JSX, ReactNode } from 'react'
import {
  AlertCircle,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Check,
  ExternalLink,
  LayoutGrid,
  Loader2,
  RefreshCw,
  Wrench
} from 'lucide-react'
import type { MightyProject } from '../../../shared/types'
import { CONFIG } from '../../../shared/config'
import {
  REPORT_RANGES,
  REPORT_ROWS_SHOWN,
  cardStatus,
  cardTypical,
  formatReportDelta,
  formatReportValue,
  heroCard,
  needsDecision,
  reportDelta,
  reportEnvLabel,
  reportFunnel,
  reportTarget,
  reportsConfigFixPrompt,
  reportsFixPrompt,
  reportsPlanPrompt,
  reportsSetupPrompt,
  standCurve,
  typicalGap,
  type ProjectReport,
  type ReportCard,
  type ReportCardResult,
  type ReportOutput,
  type ReportRange
} from '../../../shared/reports'
import {
  benchmarkSource,
  playbookFor,
  playbookGoal,
  typicalText
} from '../../../shared/playbooks'
import { timeAgo } from '../mighty/mighty-shared'
import { Button } from './Button'
import { ProjectAvatar } from './ProjectIcon'
import { SegmentedControl } from './SegmentedControl'
import './KeysPanel.css'
import './InfraPanel.css'
import './ReportsPanel.css'

const L = CONFIG.UI_LABELS
const SETUP_POLL_MS = 4_000
const LAST_PROJECT_KEY = 'mm.reports.project'
const HOME = 'home'
const RANGE_ITEMS = REPORT_RANGES.map((r) => ({
  id: String(r) as `${ReportRange}`,
  label: r === 7 ? L.REPORTS_RANGE_7 : L.REPORTS_RANGE_30
}))

type AgentState = { starting: true } | { error: string } | { pane: string }

const DECIDED_KEY = 'mm.reports.decided'
const DECIDED_EVENT = 'mm-reports-decided'

function callKey(report: ProjectReport, card: ReportCard): string {
  return `${report.projectId}:${report.env ?? ''}:${card.id}`
}

function readDecided(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(DECIDED_KEY) ?? '{}') as Record<string, string>
  } catch {
    return {}
  }
}

function decidedAt(report: ProjectReport, card: ReportCard): string | null {
  const result = report.results[card.id]
  return result?.ok ? String(result.output.value) : null
}

function markDecided(report: ProjectReport, card: ReportCard): void {
  const value = decidedAt(report, card)
  if (value === null) return
  try {
    localStorage.setItem(
      DECIDED_KEY,
      JSON.stringify({ ...readDecided(), [callKey(report, card)]: value })
    )
  } catch {
    return
  }
  window.dispatchEvent(new Event(DECIDED_EVENT))
}

function useDecidedRefresh(): void {
  const [, setTick] = useState(0)
  useEffect(() => {
    const bump = (): void => setTick((t) => t + 1)
    window.addEventListener(DECIDED_EVENT, bump)
    window.addEventListener('storage', bump)
    return () => {
      window.removeEventListener(DECIDED_EVENT, bump)
      window.removeEventListener('storage', bump)
    }
  }, [])
}

function isOpenCall(report: ProjectReport, card: ReportCard): boolean {
  if (!needsDecision(cardStatus(card, report.results[card.id]))) return false
  const value = decidedAt(report, card)
  return value === null || readDecided()[callKey(report, card)] !== value
}

function decisionCount(report: ProjectReport | undefined): number {
  if (!report || report.state !== 'ready') return 0
  return report.cards.filter((c) => isOpenCall(report, c)).length
}

function showFirstCall(): void {
  const tile = document.querySelector<HTMLElement>('.reports-tile[data-open-call]')
  if (!tile) return
  tile.scrollIntoView({ behavior: 'smooth', block: 'center' })
  tile.removeAttribute('data-flash')
  void tile.offsetWidth
  tile.setAttribute('data-flash', '')
}

function readLastProject(): string | null {
  try {
    return localStorage.getItem(LAST_PROJECT_KEY)
  } catch {
    return null
  }
}

function rememberProject(id: string): void {
  try {
    localStorage.setItem(LAST_PROJECT_KEY, id)
  } catch {
    return
  }
}

function shownOutput(result: ReportCardResult | undefined): ReportOutput | undefined {
  if (!result) return undefined
  return result.ok ? result.output : result.lastGood?.output
}

function Spark({
  series,
  axis,
  typical
}: {
  series: [string, number][]
  axis?: boolean
  typical?: { value: number; text: string }
}): JSX.Element | null {
  const fade = useId()
  if (series.length < 2) return null
  const values = series.map((p) => p[1])
  const domain = typical ? [...values, typical.value] : values
  const min = Math.min(...domain)
  const span = Math.max(...domain) - min || 1
  const y = (v: number): number => 92 - ((v - min) / span) * 84
  const points = values.map((v, i) => [(i / (values.length - 1)) * 100, y(v)])
  const line = points
    .map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`)
    .join(' ')
  const [endX, endY] = points[points.length - 1]
  return (
    <div className="reports-spark-wrap">
      <div className="reports-spark" data-typical={typical ? '' : undefined}>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id={fade} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" className="reports-spark-stop" />
              <stop offset="1" className="reports-spark-stop" data-end="" />
            </linearGradient>
          </defs>
          <path d={`${line} L100 100 L0 100 Z`} fill={`url(#${fade})`} />
          <path d={line} className="reports-spark-line" vectorEffect="non-scaling-stroke" />
        </svg>
        {/* The dot is HTML, not an SVG circle: the stretched viewBox would smear a circle into an oval. */}
        <span className="reports-spark-dot" style={{ left: `${endX}%`, top: `${endY}%` }} />
        {typical && (
          <span
            className="reports-spark-typical"
            data-below={y(typical.value) < 30 || undefined}
            style={{ top: `${y(typical.value)}%` }}
          >
            <span>
              {L.REPORTS_TYPICAL} {typical.text}
            </span>
          </span>
        )}
      </div>
      {axis && (
        <div className="reports-spark-axis">
          <span>{series[0][0]}</span>
          <span>{series[series.length - 1][0]}</span>
        </div>
      )}
    </div>
  )
}

function Delta({
  card,
  output,
  range
}: {
  card: ReportCard
  output: ReportOutput
  range: ReportRange
}): JSX.Element | null {
  const raw = reportDelta(output)
  if (raw === null || output.previous === undefined) return null
  const delta = Math.abs(raw) < 0.0005 ? 0 : raw
  const tone = delta === 0 ? 'flat' : (card.better === 'up') === delta > 0 ? 'good' : 'bad'
  const Arrow = delta >= 0 ? ArrowUpRight : ArrowDownRight
  return (
    <span
      className="reports-delta"
      data-tone={tone}
      title={`${L.REPORTS_VS_PREVIOUS} ${range} ${L.REPORTS_DAYS_BEFORE}: ${formatReportValue(output.previous, card.unit)}`}
    >
      {delta !== 0 && <Arrow size={12} strokeWidth={2.5} />}
      {formatReportDelta(delta)}
    </span>
  )
}

function TargetLine({
  card,
  output
}: {
  card: ReportCard
  output: ReportOutput
}): JSX.Element | null {
  const target = reportTarget(card, output)
  if (target === undefined) return null
  const gap = card.better === 'up' ? target - output.value : output.value - target
  const missed = gap > 0
  return (
    <span className="reports-target" data-missed={missed || undefined}>
      {L.REPORTS_TARGET} {formatReportValue(target, card.unit)}
      {missed &&
        ` · ${formatReportValue(gap, card.unit)} ${card.better === 'up' ? 'to go' : 'over'}`}
    </span>
  )
}

function Typical({
  card,
  output,
  niche,
  agent,
  onStart,
  onOpenAgent
}: {
  card: ReportCard
  output: ReportOutput
  niche: string | undefined
  agent: AgentState | undefined
  onStart: (message: string) => void
  onOpenAgent?: (pane: string) => void
}): JSX.Element | null {
  const fade = useId()
  const found = cardTypical(card, niche)
  if (!found) return null
  const { metric, typical } = found
  const behind =
    card.better === 'up' ? output.value < typical.value : output.value > typical.value
  const play = behind ? playbookFor(metric.id) : undefined
  const top = typical.top
  const curve = standCurve(output.value, typical.value, top)
  const reached =
    top !== undefined && (card.better === 'up' ? output.value >= top : output.value <= top)
  const marks = [
    { kind: 'typical', label: L.REPORTS_TYPICAL, value: typical.value },
    ...(top !== undefined ? [{ kind: 'top', label: L.REPORTS_TOP_QUARTER, value: top }] : [])
  ]
  const you = `${L.REPORTS_YOU} ${formatReportValue(output.value, card.unit)}`
  return (
    <div className="reports-typical" data-behind={behind || undefined}>
      <span className="reports-tile-title">
        {card.title} · {L.REPORTS_STAND} {typical.group}
      </span>
      <div
        className="reports-curve"
        role="img"
        aria-label={[you, ...marks.map((m) => `${m.label} ${typicalText(metric, m.value)}`)].join(
          ', '
        )}
      >
        <div className="reports-curve-plot">
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <linearGradient id={fade} x1={card.better === 'up' ? 0 : 1} x2={card.better === 'up' ? 1 : 0}>
                <stop offset="0" className="reports-curve-stop" data-tone="bad" />
                <stop offset="0.4" className="reports-curve-stop" data-tone="mid" />
                <stop offset="1" className="reports-curve-stop" data-tone="good" />
              </linearGradient>
            </defs>
            <path d={`${curve.path} L100 100 L0 100 Z`} fill={`url(#${fade})`} />
            <path d={curve.path} className="reports-curve-line" vectorEffect="non-scaling-stroke" />
          </svg>
          {marks.map((m) => (
            <span
              key={m.kind}
              className="reports-curve-mark"
              data-kind={m.kind}
              data-flip={curve.x(m.value) > 62 || undefined}
              style={{ left: `${curve.x(m.value)}%`, top: `${curve.y(m.value)}%` }}
            >
              <span>
                {m.label} {typicalText(metric, m.value)}
              </span>
            </span>
          ))}
          <span
            className="reports-curve-mark"
            data-kind="you"
            style={{ left: `${curve.x(output.value)}%`, top: `${curve.y(output.value)}%` }}
          />
        </div>
        <div className="reports-curve-axis">
          <span
            className="reports-curve-you"
            style={{ '--at': `${curve.x(output.value)}%` } as CSSProperties}
          >
            {you}
          </span>
        </div>
      </div>
      <span className="reports-typical-gap">
        {reached && `${L.REPORTS_STAND_TOP} ${typical.group}. `}
        {typicalGap(card, output.value, typical.value)}
      </span>
      <span className="reports-note">
        {L.REPORTS_TYPICAL_FOR} {typical.group}. {benchmarkSource(typical)}.{' '}
        <Button
          variant="bare"
          className="reports-source"
          onClick={() => void window.api.openExternal(typical.url)}
        >
          {L.REPORTS_TYPICAL_SOURCE}
          <ExternalLink size={11} strokeWidth={2.5} />
        </Button>
      </span>
      {play && (
        <AgentButton
          agent={agent}
          onStart={() => onStart(playbookGoal(play.type, play.playbook))}
          onOpenAgent={onOpenAgent}
          label={play.playbook.title}
        />
      )}
    </div>
  )
}

function Tile({
  card,
  result,
  range,
  hero,
  loading,
  agent,
  open,
  niche,
  onFix,
  onPlan,
  onDecided,
  onOpenAgent
}: {
  card: ReportCard
  result: ReportCardResult | undefined
  range: ReportRange
  hero: boolean
  loading: boolean
  agent: AgentState | undefined
  open: boolean
  niche: string | undefined
  onFix: () => void
  onPlan: () => void
  onDecided: () => void
  onOpenAgent?: (pane: string) => void
}): JSX.Element {
  const status = cardStatus(card, result)
  const output = shownOutput(result)
  const broken = result && !result.ok ? result : null
  const found = open ? undefined : cardTypical(card, niche)
  return (
    <div
      className="reports-tile"
      data-hero={hero || undefined}
      data-status={status}
      data-open-call={open || undefined}
      onAnimationEnd={(e) => e.currentTarget.removeAttribute('data-flash')}
    >
      <div className="reports-tile-head">
        <span className="reports-tile-title">{card.title}</span>
        {card.link && (
          <Button
            variant="bare"
            className="reports-source"
            title={L.REPORTS_SOURCE}
            onClick={() => void window.api.openExternal(card.link as string)}
          >
            {card.provider ?? ''}
            <ExternalLink size={11} strokeWidth={2.5} />
          </Button>
        )}
      </div>

      {!output && (status === 'waiting' || loading) ? (
        <div className="reports-skeleton" data-hero={hero || undefined} />
      ) : (
        <>
          <div className="reports-value-row" data-dim={broken ? '' : undefined}>
            <span className="reports-value">
              {output ? formatReportValue(output.value, card.unit) : '-'}
            </span>
            {output && !broken && <Delta card={card} output={output} range={range} />}
          </div>
          <span className="reports-meta">
            {broken?.lastGood
              ? `${L.REPORTS_LAST_GOOD} · ${timeAgo(broken.lastGood.ranAt)}`
              : output && !broken && <TargetLine card={card} output={output} />}
          </span>
          <div className="reports-spark-slot">
            {output?.series && !broken && (
              <Spark
                series={output.series}
                axis={hero}
                typical={
                  found && {
                    value: found.typical.value,
                    text: typicalText(found.metric, found.typical.value)
                  }
                }
              />
            )}
          </div>
          <span className="reports-tile-note" title={output?.note}>
            {!broken && output?.note}
          </span>
        </>
      )}

      {broken ? (
        <div className="reports-call" data-tone="broken">
          <span className="reports-call-text" title={broken.error}>
            <AlertCircle size={12} strokeWidth={2.5} /> {L.REPORTS_BROKEN}:{' '}
            <span className="reports-call-detail">{broken.error}</span>
          </span>
          <span className="reports-call-actions">
            <AgentButton
              agent={agent}
              onStart={onFix}
              onOpenAgent={onOpenAgent}
              variant="secondary"
              compact={!hero}
            />
          </span>
        </div>
      ) : open ? (
        <div className="reports-call">
          <span className="reports-call-text">{card.decides || card.title}</span>
          <span className="reports-call-actions">
            <AgentButton
              agent={agent}
              onStart={onPlan}
              onOpenAgent={onOpenAgent}
              label={L.REPORTS_PLAN_FIX}
              variant="secondary"
              compact={!hero}
            />
            {hero ? (
              <Button variant="text" onClick={onDecided}>
                {L.REPORTS_DECIDED}
              </Button>
            ) : (
              <Button
                variant="icon"
                title={L.REPORTS_DECIDED}
                aria-label={L.REPORTS_DECIDED}
                onClick={onDecided}
              >
                <Check size={13} strokeWidth={2.5} />
              </Button>
            )}
          </span>
        </div>
      ) : (
        <span className="reports-decides">{card.decides}</span>
      )}
    </div>
  )
}

function AgentButton({
  agent,
  onStart,
  onOpenAgent,
  label = L.REPORTS_FIX,
  variant = 'primary',
  compact = false
}: {
  agent: AgentState | undefined
  onStart: () => void
  onOpenAgent?: (pane: string) => void
  label?: string
  variant?: 'primary' | 'secondary'
  compact?: boolean
}): JSX.Element {
  if (compact) {
    const running = agent !== undefined && ('pane' in agent || 'starting' in agent)
    const open = agent && 'pane' in agent && onOpenAgent ? () => onOpenAgent(agent.pane) : undefined
    return (
      <Button
        variant="icon"
        title={running ? L.REPORTS_AGENT_FIXING : label}
        aria-label={running ? L.REPORTS_AGENT_FIXING : label}
        onClick={running ? open : onStart}
      >
        {running ? (
          <Loader2 size={13} strokeWidth={2.5} data-spin="" />
        ) : (
          <Wrench size={13} strokeWidth={2.5} />
        )}
      </Button>
    )
  }
  if (agent && 'pane' in agent)
    return (
      <Button variant="ghost" onClick={onOpenAgent ? () => onOpenAgent(agent.pane) : undefined}>
        <span className="infra-btn-inner">
          <Loader2 size={12} strokeWidth={2.5} data-spin="" />
          {L.REPORTS_AGENT_FIXING}
        </span>
      </Button>
    )
  const starting = agent !== undefined && 'starting' in agent
  return (
    <Button variant={variant} disabled={starting} onClick={onStart}>
      <span className="infra-btn-inner">
        {starting ? (
          <Loader2 size={12} strokeWidth={2.5} data-spin="" />
        ) : (
          <Wrench size={12} strokeWidth={2.5} />
        )}
        {starting ? L.REPORTS_STARTING : agent ? L.REPORTS_TRY_AGAIN : label}
      </span>
    </Button>
  )
}

function Funnel({
  report,
  agents,
  onStart,
  onOpenAgent
}: {
  report: ProjectReport
  agents: Record<string, AgentState>
  onStart: (key: string, message: string) => void
  onOpenAgent?: (pane: string) => void
}): JSX.Element | null {
  const { steps, leak } = reportFunnel(report)
  if (!steps.length) return null
  const short = leak?.typical ? Math.round(leak.typical.expected - leak.output.value) : 0
  const play = leak?.typical ? playbookFor(leak.typical.metric.id) : undefined
  return (
    <div className="reports-funnel">
      <span className="reports-tile-title">{L.REPORTS_FUNNEL}</span>
      <div className="reports-funnel-steps">
        {steps.map((s) => {
          const text = formatReportValue(s.output.value, s.card.unit)
          const typical = s.typical
          return (
            <div key={s.card.id} className="reports-funnel-step" data-leak={s === leak || undefined}>
              <span className="reports-funnel-name">{s.card.title}</span>
              <span className="reports-funnel-track">
                <span
                  className="reports-funnel-block"
                  data-tone={typical ? (typical.behind ? 'bad' : 'good') : undefined}
                  style={{ width: `${s.width}%` }}
                >
                  {text}
                </span>
                {typical?.behind && typical.expected > s.output.value && (
                  <span className="reports-funnel-ghost">
                    {L.REPORTS_TYPICAL} {formatReportValue(Math.round(typical.expected), 'count')}
                  </span>
                )}
              </span>
              <span className="reports-funnel-rate" data-tone={typical ? (typical.behind ? 'bad' : 'good') : undefined}>
                {s.each !== undefined && `${formatReportValue(s.each, 'usd')} ${L.REPORTS_FUNNEL_EACH}`}
                {s.share &&
                  `${formatReportValue(s.share.value, 'percent')} ${L.REPORTS_FUNNEL_OF} ${s.share.of.title.toLowerCase()}`}
                {typical &&
                  ` · ${L.REPORTS_TYPICAL.toLowerCase()} ${typicalText(typical.metric, typical.benchmark.value)}`}
              </span>
            </div>
          )
        })}
      </div>
      {leak?.typical && (
        <div className="reports-leak">
          <span className="reports-leak-label">{L.REPORTS_LEAK}</span>
          <span className="reports-leak-text">
            {formatReportValue(short, 'count')} {leak.card.title.toLowerCase()} {L.REPORTS_LEAK_SHORT}{' '}
            {leak.typical.benchmark.group}
          </span>
          <span className="reports-leak-hint">
            {L.REPORTS_LEAK_HINT} {benchmarkSource(leak.typical.benchmark)}.
          </span>
          <AgentButton
            agent={agents[callKey(report, leak.card)]}
            onStart={() =>
              onStart(
                callKey(report, leak.card),
                play
                  ? playbookGoal(play.type, play.playbook)
                  : reportsPlanPrompt(leak.card, leak.output, report.env)
              )
            }
            onOpenAgent={onOpenAgent}
            label={play ? play.playbook.title : L.REPORTS_PLAN_FIX}
          />
        </div>
      )}
    </div>
  )
}

function Breakdown({ report }: { report: ProjectReport }): JSX.Element | null {
  const withRows = report.cards.filter((c) => {
    const r = report.results[c.id]
    return r?.ok && (r.output.rows?.length ?? 0) > 0
  })
  const [pick, setPick] = useState<string | null>(null)
  const card = withRows.find((c) => c.id === pick) ?? withRows[0]
  if (!card) return null
  const result = report.results[card.id]
  const rows = result?.ok ? (result.output.rows ?? []) : []
  const max = Math.max(...rows.map((r) => r[1]), 1)
  return (
    <div className="reports-rows">
      <div className="reports-rows-head">
        {withRows.length > 1 ? (
          <SegmentedControl
            items={withRows.map((c) => ({ id: c.id, label: c.title }))}
            active={card.id}
            onChange={setPick}
            textSize="text-xs"
            className=""
          />
        ) : (
          <span className="reports-tile-title">{card.title}</span>
        )}
      </div>
      {rows.slice(0, REPORT_ROWS_SHOWN).map(([label, n]) => (
        <div key={label} className="reports-row">
          <span className="reports-row-bar" style={{ width: `${(Math.max(n, 0) / max) * 100}%` }} />
          <span className="reports-row-label">{label}</span>
          <span className="reports-row-value">{formatReportValue(n, card.unit)}</span>
        </div>
      ))}
      {rows.length > REPORT_ROWS_SHOWN && (
        <span className="reports-rows-more">
          +{rows.length - REPORT_ROWS_SHOWN} {L.REPORTS_MORE}
        </span>
      )}
    </div>
  )
}

function gridColumns(tiles: number): number {
  if (tiles <= 4) return Math.max(tiles, 1)
  return tiles % 4 === 0 || tiles % 4 === 3 ? 4 : 3
}

function byDecision(report: ProjectReport): (a: ReportCard, b: ReportCard) => number {
  return (a, b) =>
    Number(needsDecision(cardStatus(b, report.results[b.id]))) -
    Number(needsDecision(cardStatus(a, report.results[a.id])))
}

function MiniStat({
  card,
  result
}: {
  card: ReportCard
  result: ReportCardResult | undefined
}): JSX.Element {
  const shown = shownOutput(result)
  return (
    <span
      className="reports-mini-stat"
      data-status={shown ? undefined : cardStatus(card, result)}
      data-dim={shown && !result?.ok ? '' : undefined}
    >
      <span className="reports-tile-title">{card.title}</span>
      <span className="reports-value">
        {shown ? formatReportValue(shown.value, card.unit) : '-'}
      </span>
    </span>
  )
}

function ProjectSummary({
  project,
  report,
  onOpen
}: {
  project: MightyProject
  report: ProjectReport
  onOpen: () => void
}): JSX.Element {
  const hero = heroCard(report.cards)
  const heroResult = hero ? report.results[hero.id] : undefined
  const heroOutput = heroResult?.ok ? heroResult.output : undefined
  const heroShown = shownOutput(heroResult)
  const toDecide = decisionCount(report)
  const urgent = [...report.cards].sort(byDecision(report)).find((c) => isOpenCall(report, c))
  const urgentResult = urgent ? report.results[urgent.id] : undefined
  const others = report.cards
    .filter((c) => c !== hero)
    .sort(byDecision(report))
    .slice(0, 3)
  const waiting = !Object.keys(report.results).length
  return (
    <Button
      variant="bare"
      className="reports-summary"
      data-needs={toDecide ? '' : undefined}
      onClick={onOpen}
    >
      <span className="reports-summary-head">
        <ProjectAvatar
          icon={project.icon}
          imagePath={project.imagePath}
          size={16}
          className="rounded-sm"
        />
        <span className="reports-summary-name">{project.name}</span>
        {report.env && report.envs.length > 1 && (
          <span className="reports-summary-env">{reportEnvLabel(report.env)}</span>
        )}
        {toDecide > 0 && <span className="reports-rail-count">{toDecide}</span>}
      </span>
      {waiting ? (
        <span className="reports-skeleton" />
      ) : (
        <>
          {hero && (
            <span className="reports-summary-hero">
              <span className="reports-tile-title">{hero.title}</span>
              <span
                className="reports-mini-hero"
                data-dim={!heroOutput && heroShown ? '' : undefined}
              >
                <span className="reports-value" data-status={cardStatus(hero, heroResult)}>
                  {heroShown ? formatReportValue(heroShown.value, hero.unit) : '-'}
                </span>
                {heroOutput && <Delta card={hero} output={heroOutput} range={report.range} />}
              </span>
              {heroOutput?.series && <Spark series={heroOutput.series} />}
            </span>
          )}
          {others.length > 0 && (
            <span className="reports-mini-stats">
              {others.map((c) => (
                <MiniStat key={c.id} card={c} result={report.results[c.id]} />
              ))}
            </span>
          )}
          {urgent && (
            <span className="reports-decides" data-needs="">
              {urgentResult && !urgentResult.ok
                ? `${urgent.title}: ${L.REPORTS_BROKEN}`
                : urgent.decides || urgent.title}
            </span>
          )}
        </>
      )}
    </Button>
  )
}

function ReportsHome({
  projects,
  reports,
  range,
  onRange,
  onOpen
}: {
  projects: MightyProject[]
  reports: Record<string, ProjectReport>
  range: ReportRange
  onRange: (r: ReportRange) => void
  onOpen: (id: string) => void
}): JSX.Element {
  const withFolder = projects.filter((p) => reports[p.id]?.state !== 'no-folder')
  const ready = withFolder
    .filter((p) => reports[p.id]?.state === 'ready')
    .sort((a, b) => decisionCount(reports[b.id]) - decisionCount(reports[a.id]))
  const loadingCount = withFolder.filter((p) => !reports[p.id]).length
  const pending = withFolder.filter((p) => {
    const state = reports[p.id]?.state
    return state === 'none' || state === 'invalid'
  })
  const total = ready.reduce((n, p) => n + decisionCount(reports[p.id]), 0)
  const running = ready.some((p) => reports[p.id].running)
  const refreshAll = (): void => ready.forEach((p) => void window.api.reports.refresh(p.id, range))
  return (
    <>
      <div className="keys-main-head reports-home-head">
        <LayoutGrid size={18} strokeWidth={2} className="reports-empty-icon" />
        <span className="keys-scope-name">{L.REPORTS_HOME}</span>
        {ready.length > 0 && (
          <span className="keys-count" data-tone={total ? 'amber' : 'green'}>
            {total ? `${total} ${L.REPORTS_NEEDS_DECISION}` : L.REPORTS_ALL_ON_TRACK}
          </span>
        )}
        <span className="keys-head-actions">
          <SegmentedControl
            items={RANGE_ITEMS}
            active={String(range) as `${ReportRange}`}
            onChange={(id) => onRange(Number(id) as ReportRange)}
            textSize="text-xs"
            className=""
          />
          <Button variant="ghost" onClick={refreshAll} disabled={running || !ready.length}>
            <span className="infra-btn-inner">
              <RefreshCw size={12} strokeWidth={2.5} data-spin={running ? '' : undefined} />
              {running ? L.REPORTS_REFRESHING : L.REPORTS_REFRESH_ALL}
            </span>
          </Button>
        </span>
      </div>
      <div className="keys-main-body">
        {ready.length + loadingCount > 0 ? (
          <div className="reports-summary-grid">
            {ready.map((p) => (
              <ProjectSummary
                key={p.id}
                project={p}
                report={reports[p.id]}
                onOpen={() => onOpen(p.id)}
              />
            ))}
            {Array.from({ length: loadingCount }, (_, i) => (
              <div key={i} className="reports-skeleton" data-hero="" />
            ))}
          </div>
        ) : (
          <div className="keys-no-folder">{L.REPORTS_HOME_EMPTY}</div>
        )}
        {pending.length > 0 && (
          <div className="reports-pending-wrap">
            <span className="reports-tile-title">{L.REPORTS_NOT_SET_UP}</span>
            <div className="reports-pending-list">
              {pending.map((p) => (
                <Button
                  key={p.id}
                  variant="bare"
                  className="reports-pending"
                  onClick={() => onOpen(p.id)}
                >
                  <ProjectAvatar
                    icon={p.icon}
                    imagePath={p.imagePath}
                    size={14}
                    className="rounded-sm"
                  />
                  <span>{p.name}</span>
                  <span className="reports-pending-cta">
                    {reports[p.id]?.state === 'invalid' ? L.REPORTS_FIX : L.REPORTS_SET_UP}
                  </span>
                </Button>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  )
}

export function ReportsPanel({
  onOpenAgent
}: {
  onOpenAgent?: (pane: string) => void
}): JSX.Element {
  const [projects, setProjects] = useState<MightyProject[]>([])
  const [reports, setReports] = useState<Record<string, ProjectReport>>({})
  const [selected, setSelected] = useState<string | null>(null)
  const [range, setRange] = useState<ReportRange>(7)
  const [env, setEnv] = useState<string | undefined>(undefined)
  const [agents, setAgents] = useState<Record<string, AgentState>>({})
  useDecidedRefresh()
  const [, setMinute] = useState(0)
  const view = useRef({ range, env, selected })
  useEffect(() => {
    view.current = { range, env, selected }
  }, [range, env, selected])

  const accept = (r: ProjectReport): void => {
    const v = view.current
    if (r.range !== v.range) return
    if (r.projectId === v.selected && v.env !== undefined && r.env !== v.env) return
    if (r.projectId !== v.selected && r.envs.length > 0 && r.env !== r.envs[0]) return
    setReports((cur) => ({ ...cur, [r.projectId]: r }))
    if (r.projectId === v.selected && v.env === undefined && r.env) setEnv(r.env)
  }

  useEffect(() => {
    void window.api.mighty
      .listProjects()
      .then((list) => {
        const live = list.filter((p) => !p.archived)
        setProjects(live)
        const last = readLastProject()
        const first = live.find((p) => p.id === last)?.id ?? HOME
        setSelected(first)
        if (first !== HOME)
          live.forEach(
            (p) => p.id !== first && void window.api.reports.get(p.id, 7, true).then(accept)
          )
      })
      .catch(() => setProjects([]))
    const off = window.api.reports.onChanged(accept)
    const tick = setInterval(() => setMinute((m) => m + 1), 60_000)
    return () => {
      off()
      clearInterval(tick)
    }
  }, [])

  useEffect(() => {
    if (selected === HOME)
      projects.forEach((p) => void window.api.reports.get(p.id, range, true).then(accept))
    else if (selected) void window.api.reports.get(selected, range, true, env).then(accept)
  }, [selected, range, env, projects])

  const report = selected ? reports[selected] : undefined
  const setupKey = selected ? `setup:${selected}` : ''
  const setupAgent = agents[setupKey]

  useEffect(() => {
    if (!selected || !setupAgent || !('pane' in setupAgent) || report?.state === 'ready') return
    const poll = setInterval(
      () => void window.api.reports.get(selected, range, true, env).then(accept),
      SETUP_POLL_MS
    )
    return () => clearInterval(poll)
  }, [selected, setupAgent, report?.state, range, env])

  const project = projects.find((p) => p.id === selected) ?? null
  const hero = useMemo(() => (report ? heroCard(report.cards) : undefined), [report])
  const inFunnel = new Set(report ? reportFunnel(report).steps.map((s) => s.card.id) : [])
  const ordered =
    report && hero
      ? [hero, ...report.cards.filter((c) => c !== hero)].filter((c) => !inFunnel.has(c.id))
      : []
  const toDecide = decisionCount(report)
  const loading = report?.running === true

  const choose = (id: string): void => {
    rememberProject(id)
    setSelected(id)
    setEnv(undefined)
  }

  const startAgent = (key: string, message: string): void => {
    if (!project?.repoFolder) return
    setAgents((cur) => ({ ...cur, [key]: { starting: true } }))
    void window.api
      .codeStartAgent({ project: project.name, cwd: project.repoFolder, inApp: true, message })
      .then((result) =>
        setAgents((cur) => ({
          ...cur,
          [key]: result.ok
            ? result.pane
              ? { pane: result.pane }
              : { error: '' }
            : { error: result.reason ?? '' }
        }))
      )
      .catch(() =>
        setAgents((cur) => ({ ...cur, [key]: { error: 'Something went wrong on this Mac.' } }))
      )
  }

  const refresh = (): void => {
    if (selected) void window.api.reports.refresh(selected, range, env).then(accept)
  }

  const setupView = (message: string, title: string, body: string, label: string): JSX.Element => (
    <div className="reports-empty">
      <BarChart3 size={22} strokeWidth={2} className="reports-empty-icon" />
      <span className="reports-empty-title">{title}</span>
      <span className="reports-empty-body">{body}</span>
      {setupAgent && 'pane' in setupAgent ? (
        <Button
          variant="ghost"
          onClick={onOpenAgent ? () => onOpenAgent(setupAgent.pane) : undefined}
        >
          <span className="infra-btn-inner">
            <Loader2 size={12} strokeWidth={2.5} data-spin="" />
            {L.REPORTS_SETTING_UP} · {L.REPORTS_OPEN_AGENT}
          </span>
        </Button>
      ) : (
        <AgentButton
          agent={setupAgent}
          onStart={() => startAgent(setupKey, message)}
          label={label}
        />
      )}
      {setupAgent && 'error' in setupAgent && setupAgent.error && (
        <span className="reports-empty-error">{setupAgent.error}</span>
      )}
    </div>
  )

  return (
    <div className="keys-panel reports-panel">
      <div className="keys-rail">
        <Button
          variant="bare"
          className="keys-rail-row"
          data-active={selected === HOME || undefined}
          onClick={() => choose(HOME)}
        >
          <LayoutGrid size={16} strokeWidth={2} />
          <span className="keys-rail-name">{L.REPORTS_HOME}</span>
        </Button>
        {projects.map((p) => {
          const r = reports[p.id]
          const count = decisionCount(r)
          return (
            <Button
              key={p.id}
              variant="bare"
              className="keys-rail-row"
              data-active={selected === p.id || undefined}
              onClick={() => choose(p.id)}
            >
              <ProjectAvatar
                icon={p.icon}
                imagePath={p.imagePath}
                size={16}
                className="rounded-sm"
              />
              <span className="keys-rail-name">{p.name}</span>
              {count > 0 && <span className="reports-rail-count">{count}</span>}
            </Button>
          )
        })}
      </div>

      <div className="keys-main">
        {selected === HOME ? (
          <ReportsHome
            projects={projects}
            reports={reports}
            range={range}
            onRange={setRange}
            onOpen={choose}
          />
        ) : (
          <>
            <div className="keys-main-head">
              {project && (
                <ProjectAvatar
                  icon={project.icon}
                  imagePath={project.imagePath}
                  size={20}
                  className="rounded-sm"
                />
              )}
              <span className="keys-scope-name">{project?.name ?? ''}</span>
              {report?.state === 'ready' &&
                Object.keys(report.results).length > 0 &&
                (toDecide ? (
                  <Button
                    variant="bare"
                    className="keys-count reports-jump"
                    data-tone="amber"
                    title={L.REPORTS_SHOW_CALL}
                    onClick={showFirstCall}
                  >
                    {toDecide} {L.REPORTS_NEEDS_DECISION}
                  </Button>
                ) : (
                  <span className="keys-count" data-tone="green">
                    {L.REPORTS_ALL_ON_TRACK}
                  </span>
                ))}
              {report?.state === 'ready' && (
                <span className="keys-head-actions">
                  {report.envs.length > 1 && report.env && (
                    <SegmentedControl
                      items={report.envs.map((e) => ({ id: e, label: reportEnvLabel(e) }))}
                      active={report.env}
                      onChange={setEnv}
                      textSize="text-xs"
                      className=""
                    />
                  )}
                  <SegmentedControl
                    items={RANGE_ITEMS}
                    active={String(range) as `${ReportRange}`}
                    onChange={(id) => setRange(Number(id) as ReportRange)}
                    textSize="text-xs"
                    className=""
                  />
                  {report.refreshedAt && !loading && (
                    <span className="keys-count">
                      {L.REPORTS_UPDATED} {timeAgo(report.refreshedAt)}
                    </span>
                  )}
                  <Button variant="ghost" onClick={refresh} disabled={loading}>
                    <span className="infra-btn-inner">
                      <RefreshCw size={12} strokeWidth={2.5} data-spin={loading ? '' : undefined} />
                      {loading ? L.REPORTS_REFRESHING : L.REPORTS_REFRESH}
                    </span>
                  </Button>
                </span>
              )}
            </div>

            {!project ? (
              <div className="keys-no-folder">{L.REPORTS_NO_PROJECT}</div>
            ) : !report ? (
              <div className="keys-main-body">
                <div className="reports-skeleton" data-hero="" />
              </div>
            ) : report.state === 'no-folder' ? (
              <div className="keys-no-folder">{L.REPORTS_NO_FOLDER}</div>
            ) : report.state === 'none' ? (
              setupView(
                reportsSetupPrompt(report.keyNames, report.business, report.brief),
                L.REPORTS_EMPTY_TITLE,
                L.REPORTS_EMPTY_BODY,
                L.REPORTS_SET_UP
              )
            ) : report.state === 'invalid' ? (
              setupView(
                reportsConfigFixPrompt(report.problems),
                L.REPORTS_INVALID,
                report.problems.join(' · '),
                L.REPORTS_FIX
              )
            ) : (
              <div className="keys-main-body reports-body">
                {report.problems.length > 0 && (
                  <div className="reports-problems">{report.problems.join(' · ')}</div>
                )}
                <Funnel
                  report={report}
                  agents={agents}
                  onStart={startAgent}
                  onOpenAgent={onOpenAgent}
                />
                <div
                  className="reports-grid"
                  style={{ '--cols': gridColumns(ordered.length - (hero ? 1 : 0)) } as CSSProperties}
                >
                  {ordered.map((card) => (
                    <Tile
                      key={card.id}
                      card={card}
                      result={report.results[card.id]}
                      range={report.range}
                      hero={card === hero}
                      loading={loading}
                      agent={agents[callKey(report, card)]}
                      open={isOpenCall(report, card)}
                      niche={report.brief?.niche}
                      onOpenAgent={onOpenAgent}
                      onFix={() => {
                        const r = report.results[card.id]
                        if (r && !r.ok)
                          startAgent(
                            callKey(report, card),
                            reportsFixPrompt(card, r.error, report.env)
                          )
                      }}
                      onPlan={() => {
                        const r = report.results[card.id]
                        if (r?.ok)
                          startAgent(
                            callKey(report, card),
                            reportsPlanPrompt(card, r.output, report.env)
                          )
                      }}
                      onDecided={() => markDecided(report, card)}
                    />
                  ))}
                </div>
                {ordered.map((card) => {
                  const r = report.results[card.id]
                  if (!r?.ok || isOpenCall(report, card)) return null
                  return (
                    <Typical
                      key={card.id}
                      card={card}
                      output={r.output}
                      niche={report.brief?.niche}
                      agent={agents[callKey(report, card)]}
                      onStart={(message) => startAgent(callKey(report, card), message)}
                      onOpenAgent={onOpenAgent}
                    />
                  )
                })}
                <Breakdown key={`${report.projectId}:${report.env ?? ''}`} report={report} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function projectFor(cwd: string, projects: MightyProject[]): MightyProject | undefined {
  return projects
    .filter((p) => p.repoFolder && (cwd === p.repoFolder || cwd.startsWith(`${p.repoFolder}/`)))
    .sort((a, b) => (b.repoFolder ?? '').length - (a.repoFolder ?? '').length)[0]
}

export function ReportsRailSection({
  cwd,
  section
}: {
  cwd: string
  section: (props: { badge?: ReactNode; children: ReactNode }) => JSX.Element
}): JSX.Element | null {
  const [report, setReport] = useState<ProjectReport | null>(null)
  useDecidedRefresh()
  useEffect(() => {
    let live = true
    let projectId = ''
    void window.api.mighty.listProjects().then((list) => {
      const project = projectFor(
        cwd,
        list.filter((p) => !p.archived)
      )
      if (!project || !live) return
      projectId = project.id
      void window.api.reports.get(project.id, 7, true).then((r) => live && setReport(r))
    })
    const off = window.api.reports.onChanged(
      (r) =>
        r.projectId === projectId &&
        r.range === 7 &&
        setReport((cur) => (cur && cur.env !== r.env ? cur : r))
    )
    return () => {
      live = false
      off()
    }
  }, [cwd])
  if (!report || report.state === 'no-folder') return null
  const open = (): void => {
    rememberProject(report.projectId)
    void window.api.mighty.openCode('reports')
  }
  const toDecide = decisionCount(report)
  const hero = heroCard(report.cards)
  const heroResult = hero ? report.results[hero.id] : undefined
  const heroOutput = shownOutput(heroResult)
  const others = report.cards
    .filter((c) => c !== hero)
    .sort(byDecision(report))
    .slice(0, 2)
  return section({
    badge: toDecide > 0 ? `${toDecide} ${L.REPORTS_NEEDS_DECISION}` : undefined,
    children:
      report.state !== 'ready' || !hero ? (
        <div className="reports-mini">
          <span className="reports-note">{L.REPORTS_RAIL_EMPTY}</span>
          <Button variant="ghost" onClick={open}>
            {L.REPORTS_RAIL_OPEN}
          </Button>
        </div>
      ) : !Object.keys(report.results).length ? (
        <span className="reports-skeleton" />
      ) : (
        <Button variant="bare" className="reports-mini" onClick={open} title={L.REPORTS_RAIL_OPEN}>
          <span className="reports-tile-title">{hero.title}</span>
          <span
            className="reports-mini-hero"
            data-dim={heroOutput && !heroResult?.ok ? '' : undefined}
          >
            <span
              className="reports-value"
              data-status={heroOutput ? undefined : cardStatus(hero, heroResult)}
            >
              {heroOutput ? formatReportValue(heroOutput.value, hero.unit) : '-'}
            </span>
            {heroOutput && heroResult?.ok && <Delta card={hero} output={heroOutput} range={7} />}
          </span>
          {others.length > 0 && (
            <span className="reports-mini-stats">
              {others.map((c) => (
                <MiniStat key={c.id} card={c} result={report.results[c.id]} />
              ))}
            </span>
          )}
        </Button>
      )
  })
}

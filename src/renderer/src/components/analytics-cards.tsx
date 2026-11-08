import { JSX, MouseEvent } from 'react'
import { Archive, PlayCircle, Layers, Coins, Cpu, Bot, type LucideIcon } from 'lucide-react'
import type { AgentSessionsData, AgentSpendData } from '../../../shared/types'
import type { TipState } from './Tooltip'

export function KpiChip({
  label,
  value,
  sub,
  color,
  icon: Icon
}: {
  label: string
  value: string
  sub?: string
  color: string
  icon?: LucideIcon
}): JSX.Element {
  return (
    <div
      className="flex flex-col rounded-lg px-3 py-3"
      style={{ background: `var(--${color}-bg-subtle)`, border: `1px solid var(--${color}-border-subtle)` }}
    >
      <div className="flex items-center gap-1.5 min-w-0">
        {Icon && (
          <span
            className="flex items-center justify-center rounded-md shrink-0"
            style={{ width: 20, height: 20, background: `var(--${color})`, color: 'var(--bg)' }}
          >
            <Icon size={12} strokeWidth={2.5} />
          </span>
        )}
        <span className="text-xlg uppercase tracking-wide font-bold leading-tight min-w-0 truncate" style={{ color: `var(--${color})` }} title={label}>
          {label}
        </span>
      </div>
      <span className="text-2xl font-bold text-on-surface leading-none mt-2.5 whitespace-nowrap">{value}</span>
      <span className="text-micro text-muted font-medium mt-2 leading-none min-h-[0.875rem] truncate" title={sub ?? ''}>{sub ?? ''}</span>
    </div>
  )
}

const STARTED_COLOR = 'var(--green)'
const ARCHIVED_COLOR = 'var(--violet)'

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

function SessionBars({ buckets, setTip }: { buckets: AgentSessionsData['byBucket']; setTip: (t: TipState) => void }): JSX.Element {
  const max = Math.max(...buckets.flatMap((b) => [b.started, b.archived]), 1)
  const chartH = 64
  const w = 320
  const gap = 3
  const slot = (w - gap * (buckets.length - 1)) / buckets.length
  const barW = slot / 2
  return (
    <svg
      viewBox={`0 0 ${w} ${chartH}`}
      width="100%"
      height={chartH}
      preserveAspectRatio="none"
      style={{ display: 'block' }}
      onMouseLeave={() => setTip(null)}
    >
      {buckets.map((b, i) => {
        const x = i * (slot + gap)
        const startedH = (b.started / max) * (chartH - 4)
        const archivedH = (b.archived / max) * (chartH - 4)
        const text = `${b.label} · ${plural(b.started, 'started')}, ${b.archived} archived`
        const onMove = (e: MouseEvent): void => setTip({ x: e.clientX, y: e.clientY, text })
        return (
          <g key={i} style={{ cursor: 'pointer' }} onMouseMove={onMove}>
            <rect x={x} y={0} width={slot} height={chartH} fill="transparent" />
            {b.started > 0 && <rect x={x} y={chartH - startedH} width={barW} height={Math.max(startedH, 3)} rx={2} fill={STARTED_COLOR} opacity={0.85} />}
            {b.archived > 0 && <rect x={x + barW} y={chartH - archivedH} width={barW} height={Math.max(archivedH, 3)} rx={2} fill={ARCHIVED_COLOR} opacity={0.85} />}
            {b.started + b.archived === 0 && <rect x={x} y={chartH - 2} width={slot} height={2} rx={1} fill="var(--surface3)" />}
          </g>
        )
      })}
    </svg>
  )
}

function Legend({ color, label }: { color: string; label: string }): JSX.Element {
  return (
    <span className="flex items-center gap-1 text-xlg text-muted">
      <span className="w-2 h-2 rounded-full inline-block" style={{ background: color }} />
      {label}
    </span>
  )
}

export function AgentSessionsCard({ data, className, setTip }: { data: AgentSessionsData; className: string; setTip: (t: TipState) => void }): JSX.Element {
  const net = data.started - data.archived
  return (
    <div className={className}>
      <div className="grid grid-cols-3 gap-2.5 mb-4">
        <KpiChip label="Started" value={String(data.started)} color="green" icon={PlayCircle} />
        <KpiChip label="Archived" value={String(data.archived)} color="violet" icon={Archive} />
        <KpiChip label="Piling up" value={net > 0 ? `+${net}` : String(net)} sub="started minus archived" color="amber" icon={Layers} />
      </div>
      {data.byBucket.length > 1 && (
        <>
          <SessionBars buckets={data.byBucket} setTip={setTip} />
          <div className="flex gap-3 mt-2">
            <Legend color={STARTED_COLOR} label="started" />
            <Legend color={ARCHIVED_COLOR} label="archived" />
          </div>
        </>
      )}
    </div>
  )
}

function fmtUsd(n: number): string {
  return `$${Math.round(n).toLocaleString()}`
}

function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`
  return String(Math.round(n))
}

type SpendBucket = AgentSpendData['byBucket'][0]

function StackBars({ buckets, segments, tip, setTip }: {
  buckets: SpendBucket[]
  segments: { color: string; value: (b: SpendBucket) => number }[]
  tip: (b: SpendBucket) => string
  setTip: (t: TipState) => void
}): JSX.Element {
  const totalOf = (b: SpendBucket): number => segments.reduce((sum, s) => sum + s.value(b), 0)
  const max = Math.max(...buckets.map(totalOf), 1)
  const chartH = 72
  const w = 320
  const gap = 3
  const slot = (w - gap * (buckets.length - 1)) / buckets.length
  return (
    <svg viewBox={`0 0 ${w} ${chartH}`} width="100%" height={chartH} preserveAspectRatio="none" style={{ display: 'block' }} onMouseLeave={() => setTip(null)}>
      {buckets.map((b, i) => {
        const x = i * (slot + gap)
        const onMove = (e: MouseEvent): void => setTip({ x: e.clientX, y: e.clientY, text: tip(b) })
        let y = chartH
        return (
          <g key={i} style={{ cursor: 'pointer' }} onMouseMove={onMove}>
            <rect x={x} y={0} width={slot} height={chartH} fill="transparent" />
            {totalOf(b) === 0 && <rect x={x} y={chartH - 2} width={slot} height={2} rx={1} fill="var(--surface3)" />}
            {segments.map((s, j) => {
              const h = (s.value(b) / max) * (chartH - 4)
              if (h <= 0) return null
              y -= h
              return <rect key={j} x={x} y={y} width={slot} height={h} fill={s.color} opacity={0.85} />
            })}
          </g>
        )
      })}
    </svg>
  )
}

const NEW_INPUT_COLOR = 'var(--cyan)'
const CACHED_COLOR = 'var(--violet)'
const OUTPUT_COLOR = 'var(--green)'
const VALUE_COLOR = 'var(--amber)'

export function AgentSpendCard({ data, className, setTip }: { data: AgentSpendData; className: string; setTip: (t: TipState) => void }): JSX.Element {
  const newInput = data.input + data.cacheWrite
  const tokens = newInput + data.cacheRead + data.output
  const cachedPct = tokens > 0 ? Math.round((data.cacheRead / tokens) * 100) : 0
  return (
    <div className={className}>
      <div className="grid grid-cols-3 gap-2.5 mb-4">
        <KpiChip label="API value" value={fmtUsd(data.usd)} sub="pay-as-you-go price of this work" color="amber" icon={Coins} />
        <KpiChip label="Tokens" value={fmtTokens(tokens)} sub={`${cachedPct}% reused from cache`} color="violet" icon={Cpu} />
        <KpiChip label="Sessions" value={data.sessions.toLocaleString()} sub="Claude Code" color="cyan" icon={Bot} />
      </div>
      {data.byBucket.length > 1 && (
        <>
          <span className="text-xlg text-muted block mb-1">API value</span>
          <StackBars
            buckets={data.byBucket}
            segments={[{ color: VALUE_COLOR, value: (b) => b.usd }]}
            tip={(b) => `${b.label} · ${fmtUsd(b.usd)}`}
            setTip={setTip}
          />
          <span className="text-xlg text-muted block mt-4 mb-1">Tokens</span>
          <StackBars
            buckets={data.byBucket}
            segments={[
              { color: CACHED_COLOR, value: (b) => b.cacheRead },
              { color: NEW_INPUT_COLOR, value: (b) => b.input + b.cacheWrite },
              { color: OUTPUT_COLOR, value: (b) => b.output }
            ]}
            tip={(b) => `${b.label} · ${fmtTokens(b.cacheRead)} cached, ${fmtTokens(b.input + b.cacheWrite)} new in, ${fmtTokens(b.output)} out`}
            setTip={setTip}
          />
          <div className="flex gap-3 mt-2">
            <Legend color={CACHED_COLOR} label={`cached ${fmtTokens(data.cacheRead)}`} />
            <Legend color={NEW_INPUT_COLOR} label={`new in ${fmtTokens(newInput)}`} />
            <Legend color={OUTPUT_COLOR} label={`out ${fmtTokens(data.output)}`} />
          </div>
        </>
      )}
    </div>
  )
}

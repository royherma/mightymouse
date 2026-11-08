import { useEffect, useRef, useState } from 'react'
import { BadgeCheck, Check, RotateCw, ShieldCheck, Target, TrendingUp, X, Zap } from 'lucide-react'
import { Button } from './Button'
import { SegmentedControl } from './SegmentedControl'
import { Tooltip, useTooltip, type TipState } from './Tooltip'
import {
  PULSE_AXES,
  PULSE_VERDICTS,
  pulseAxisPrompt,
  pulseDot,
  pulseToneColor,
  type PulseAxis,
  type PulseRow,
  type PulseScope,
  type PulseState
} from '../../../shared/session-pulse'
import { copyText } from '../../../main/phone-remote/react/clipboard'

type Tab = 'now' | 'latest' | 'all' | 'alerts'

const R = 130
const C = 160
const SPARK_POINTS = 12
const TW = 380
const TH = 264
const [PL, PR, PT, PB] = [30, 8, 10, 42]
const MONO = "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace"

function latency(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function stamp(at: number): string {
  return new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' })
}

function shortClock(at: number): string {
  return clock(at).replace(/\s?[AP]M$/i, '')
}

function axisLabel(rows: readonly PulseRow[], i: number): string {
  const d = new Date(rows[i].at)
  const prev = i > 0 ? new Date(rows[i - 1].at) : null
  if (!prev || prev.toDateString() !== d.toDateString()) {
    if (rows.some((r) => new Date(r.at).toDateString() !== d.toDateString()))
      return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  }
  const sameMinute = rows.some((r, j) => j !== i && shortClock(r.at) === shortClock(rows[i].at))
  return sameMinute
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }).replace(/\s?[AP]M$/i, '')
    : shortClock(rows[i].at)
}

function isAlert(row: PulseRow): boolean {
  return PULSE_VERDICTS[row.verdict].tone !== 'good'
}

function tint(color: string, pct: number): string {
  return `color-mix(in srgb, ${color} ${pct}%, transparent)`
}

function Verdict(props: { row: PulseRow; onChip: (prompt: string) => Promise<unknown>; onAnswer?: () => void }): React.JSX.Element {
  const verdict = PULSE_VERDICTS[props.row.verdict]
  const [sentFor, setSentFor] = useState<number | null>(null)
  const sent = sentFor === props.row.at
  const send = (): void => {
    if (!verdict.chip) return
    void props.onChip(verdict.chip.prompt).then(() => setSentFor(props.row.at))
  }
  return (
    <div
      className="flex flex-col gap-1.5 px-3.5 py-3"
      style={{
        borderRadius: 12,
        background: `color-mix(in srgb, ${pulseToneColor(verdict.tone)} 13%, var(--surface1))`
      }}
    >
      <b className="text-sm">{verdict.title}</b>
      <span className="text-xs text-muted">{verdict.body}</span>
      {verdict.chip && (
        <Button
          variant="bare"
          className="self-start mt-0.5 rounded-full px-3 py-1.5 text-xs font-semibold flex items-center gap-1 transition-[filter] hover:brightness-105 active:scale-[.97]"
          style={{
            background: sent ? 'var(--surface2)' : 'var(--accent)',
            color: sent ? 'var(--on-surface)' : 'var(--on-accent)'
          }}
          onClick={send}
          disabled={sent}
        >
          {sent && <Check size={12} strokeWidth={2.5} style={{ color: 'var(--green)' }} />}
          {sent ? 'Sent to the agent' : verdict.chip.label}
        </Button>
      )}
      {props.row.verdict === 'needs_you' && props.onAnswer && (
        <Button variant="primary" className="self-start mt-0.5 text-xs" onClick={props.onAnswer}>
          Answer it
        </Button>
      )}
    </div>
  )
}

const AXIS_ICON = { goal: Target, prog: TrendingUp, proof: BadgeCheck, move: Zap, safe: ShieldCheck }

function axisTip(a: PulseAxis): React.ReactNode {
  return (
    <>
      <div style={{ color: 'var(--on-surface)', fontWeight: 500 }}>{a.means}</div>
      <div>
        Higher is better · 0 {a.levels[0]} → 1 {a.levels[a.levels.length - 1]}
      </div>
    </>
  )
}

function axisHover(setTip: (t: TipState) => void, a: PulseAxis): React.DOMAttributes<Element> {
  const show = (e: React.MouseEvent): void => setTip({ x: e.clientX, y: e.clientY, text: axisTip(a) })
  return { onMouseEnter: show, onMouseMove: show, onMouseLeave: () => setTip(null) }
}

function score(v: number): string {
  return (v / 100).toFixed(2)
}

function Radar(props: { row: PulseRow }): React.JSX.Element {
  const [tip, setTip] = useState<TipState>(null)
  const pt = (i: number, v: number): [number, number] => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / PULSE_AXES.length
    return [C + Math.cos(a) * R * (v / 100), C + Math.sin(a) * R * (v / 100)]
  }
  const ring = (v: number): string => PULSE_AXES.map((_, i) => pt(i, v).join(',')).join(' ')
  return (
    <>
    <svg viewBox="-40 -24 400 368" className="w-full h-auto" style={{ overflow: 'visible' }}>
      {[25, 50, 75, 100].map((v) => (
        <polygon key={v} points={ring(v)} fill="none" stroke="var(--surface3)" strokeWidth={1} />
      ))}
      {PULSE_AXES.map((a, i) => {
        const [x, y] = pt(i, 100)
        const [lx, ly] = pt(i, 118)
        const anchor = Math.abs(lx - C) < 5 ? 'middle' : lx > C ? 'start' : 'end'
        const Icon = AXIS_ICON[a.key]
        const ix = anchor === 'middle' ? lx - 7 : anchor === 'start' ? lx : lx - 14
        return (
          <g key={a.key}>
            <line x1={C} y1={C} x2={x} y2={y} stroke="var(--surface3)" />
            <g {...axisHover(setTip, a)} style={{ cursor: 'help' }}>
              <Icon x={ix} y={ly - 16} width={14} height={14} color={a.color} strokeWidth={2.25} />
              <text x={lx} y={ly + 9} textAnchor={anchor} fontSize={12} fontWeight={500} fill={a.color}>
                {a.label}
              </text>
            </g>
          </g>
        )
      })}
      <polygon
        points={PULSE_AXES.map((a, i) => pt(i, props.row.scores[a.key]).join(',')).join(' ')}
        fill={tint('var(--accent)', 22)}
        stroke="var(--accent)"
        strokeWidth={2}
        strokeLinejoin="round"
      />
      {PULSE_AXES.map((a, i) => {
        const [x, y] = pt(i, props.row.scores[a.key])
        return (
          <circle
            key={a.key}
            cx={x}
            cy={y}
            r={4.5}
            fill="var(--surface1)"
            stroke={a.color}
            strokeWidth={2}
          />
        )
      })}
    </svg>
    <Tooltip tip={tip} />
    </>
  )
}

function Strip(props: { rows: readonly PulseRow[]; upTo: number }): React.JSX.Element {
  const [tip, setTip] = useState<TipState>(null)
  const recent = props.rows.slice(Math.max(0, props.upTo + 1 - SPARK_POINTS), props.upTo + 1)
  const row = recent[recent.length - 1]
  const xs = (i: number): number => (recent.length > 1 ? 2 + (i * 56) / (recent.length - 1) : 58)
  const ys = (v: number): number => 24 - v * 0.22
  return (
    <div className="grid grid-cols-5 gap-1.5 justify-items-center text-center">
      {PULSE_AXES.map((a) => {
        const value = row.scores[a.key]
        const color = a.color
        const Icon = AXIS_ICON[a.key]
        const pts = recent.map((r, i) => [xs(i), ys(r.scores[a.key])] as const)
        const last = pts[pts.length - 1]
        const line = pts.length > 1 ? pts : [[2, last[1]] as const, last]
        return (
          <div key={a.key} className="flex flex-col items-center gap-0.5 w-full min-w-0" {...axisHover(setTip, a)}>
            <svg
              viewBox="0 0 60 26"
              preserveAspectRatio="none"
              className="w-full"
              style={{ height: 26 }}
            >
              <polyline
                points={line.map((p) => p.join(',')).join(' ')}
                fill="none"
                stroke={color}
                strokeWidth={1.8}
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
              <circle cx={last[0]} cy={last[1]} r={2.4} fill={color} />
            </svg>
            <b style={{ font: `600 11px ${MONO}`, color, fontVariantNumeric: 'tabular-nums' }}>
              {score(value)}
            </b>
            <span
              className="flex items-center gap-1 whitespace-nowrap uppercase"
              style={{ font: `500 10px ${MONO}`, letterSpacing: '.04em', color: 'var(--muted)' }}
            >
              <Icon size={10} strokeWidth={2.5} color={color} />
              {a.label}
            </span>
          </div>
        )
      })}
      <Tooltip tip={tip} />
    </div>
  )
}

function History(props: {
  rows: readonly PulseRow[]
  selected: number
  onPick: (i: number) => void
}): React.JSX.Element {
  const { rows } = props
  const [tip, setTip] = useState<TipState>(null)
  const [hover, setHover] = useState<number | null>(null)
  const [focus, setFocus] = useState<PulseAxis['key'] | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const span = Math.max(1, rows.length - 1)
  const tx = (i: number): number =>
    rows.length > 1 ? PL + (i * (TW - PL - PR)) / span : (PL + TW - PR) / 2
  const ty = (v: number): number => PT + ((100 - v) * (TH - PT - PB)) / 100
  const labelEvery = Math.ceil(rows.length / 8)
  const band = rows.length > 1 ? (TW - PL - PR) / span : 40

  const pointAt = (e: { clientX: number; clientY: number }): DOMPoint | null => {
    const m = svgRef.current?.getScreenCTM()
    return m ? new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse()) : null
  }
  const indexAt = (e: { clientX: number; clientY: number }): number => {
    const p = pointAt(e)
    if (!p) return rows.length - 1
    return Math.max(0, Math.min(rows.length - 1, Math.round((p.x - PL) / band)))
  }
  const lineAt = (e: { clientX: number; clientY: number }): PulseAxis['key'] | null => {
    const p = pointAt(e)
    if (!p || rows.length < 2) return null
    const f = Math.max(0, Math.min(span, (p.x - PL) / band))
    const lo = Math.floor(f)
    const hi = Math.min(span, lo + 1)
    let best: PulseAxis['key'] | null = null
    let gap = 9
    for (const a of PULSE_AXES) {
      const v = rows[lo].scores[a.key] + (rows[hi].scores[a.key] - rows[lo].scores[a.key]) * (f - lo)
      const d = Math.abs(ty(v) - p.y)
      if (d < gap) {
        gap = d
        best = a.key
      }
    }
    return best
  }
  const move = (e: React.PointerEvent): void => {
    const i = indexAt(e)
    const row = rows[i]
    const line = lineAt(e)
    const shown = line ? PULSE_AXES.filter((a) => a.key === line) : PULSE_AXES
    setHover(i)
    setFocus(line)
    setTip({
      x: e.clientX,
      y: e.clientY,
      text: (
        <div className="flex flex-col gap-0.5">
          <b>
            Check {i + 1} · {stamp(row.at)} · {PULSE_VERDICTS[row.verdict].title}
          </b>
          {shown.map((a) => {
            const Icon = AXIS_ICON[a.key]
            return (
              <span key={a.key} className="flex justify-between gap-3" style={{ fontFamily: MONO }}>
                <span className="flex items-center gap-1" style={{ color: a.color }}>
                  <Icon size={11} strokeWidth={2.5} />
                  {a.label}
                </span>
                {score(row.scores[a.key])}
              </span>
            )
          })}
        </div>
      )
    })
  }

  return (
    <>
      <svg ref={svgRef} viewBox={`0 0 ${TW} ${TH}`} className="w-full h-auto block">
        {rows.map((r, i) =>
          isAlert(r) ? (
            <rect
              key={`b${r.at}`}
              x={tx(i) - band / 2}
              y={PT}
              width={band}
              height={TH - PT - PB}
              rx={4}
              fill={tint(pulseToneColor(PULSE_VERDICTS[r.verdict].tone), 12)}
            />
          ) : null
        )}
        {[0, 25, 50, 75, 100].map((v) => (
          <g key={v}>
            <line x1={PL} x2={TW - PR} y1={ty(v)} y2={ty(v)} stroke="var(--surface3)" />
            <text
              x={PL - 8}
              y={ty(v) + 4}
              textAnchor="end"
              fontSize={11}
              fontFamily={MONO}
              fill="var(--muted)"
            >
              {v}
            </text>
          </g>
        ))}
        {rows.map((r, i) =>
          i === rows.length - 1 || (i % labelEvery === 0 && rows.length - 1 - i >= labelEvery / 2) ? (
            <text
              key={`x${r.at}`}
              x={tx(i)}
              y={TH - 24}
              textAnchor="middle"
              fontSize={11}
              fontFamily={MONO}
              fill="var(--muted)"
            >
              {i + 1}
              <tspan x={tx(i)} dy={14} fontSize={9.5} opacity={0.75}>
                {axisLabel(rows, i)}
              </tspan>
            </text>
          ) : null
        )}
        {PULSE_AXES.map((a) => (
          <path
            key={a.key}
            d={rows.map((r, i) => `${i ? 'L' : 'M'}${tx(i)},${ty(r.scores[a.key])}`).join('')}
            fill="none"
            stroke={a.color}
            strokeWidth={a.key === focus ? 3.5 : a.key === 'goal' ? 3 : 1.8}
            strokeLinejoin="round"
            strokeLinecap="round"
            opacity={focus ? (a.key === focus ? 1 : 0.15) : a.key === 'goal' ? 1 : 0.85}
            style={{ transition: 'opacity 120ms, stroke-width 120ms' }}
          />
        ))}
        <line
          x1={tx(props.selected)}
          x2={tx(props.selected)}
          y1={PT}
          y2={TH - PB}
          stroke="var(--on-surface)"
          strokeDasharray="3 3"
        />
        {hover !== null && (
          <g style={{ pointerEvents: 'none' }}>
            <line x1={tx(hover)} x2={tx(hover)} y1={PT} y2={TH - PB} stroke="var(--muted)" />
            {PULSE_AXES.filter((a) => !focus || a.key === focus).map((a) => (
              <circle
                key={a.key}
                cx={tx(hover)}
                cy={ty(rows[hover].scores[a.key])}
                r={4.5}
                fill="var(--surface1)"
                stroke={a.color}
                strokeWidth={2.2}
              />
            ))}
          </g>
        )}
        <rect
          x={0}
          y={0}
          width={TW}
          height={TH}
          fill="transparent"
          style={{ cursor: 'crosshair' }}
          onPointerMove={move}
          onPointerLeave={() => {
            setHover(null)
            setFocus(null)
            setTip(null)
          }}
          onClick={(e) => props.onPick(indexAt(e))}
        />
      </svg>
      <div className="flex flex-wrap gap-x-2.5 gap-y-1 justify-center text-muted" style={{ fontSize: 11 }}>
        {PULSE_AXES.map((a) => {
          const Icon = AXIS_ICON[a.key]
          return (
            <span key={a.key} className="flex items-center gap-1" {...axisHover(setTip, a)}>
              <Icon size={12} strokeWidth={2.5} color={a.color} />
              {a.label}
            </span>
          )
        })}
      </div>
      <Tooltip tip={tip} />
    </>
  )
}

function MiniShape(props: { row: PulseRow; color: string; size?: number }): React.JSX.Element {
  const pt = (i: number, v: number): string => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / PULSE_AXES.length
    return `${22 + Math.cos(a) * 19 * (v / 100)},${22 + Math.sin(a) * 19 * (v / 100)}`
  }
  const ring = (v: number): string => PULSE_AXES.map((_, i) => pt(i, v)).join(' ')
  return (
    <svg viewBox="0 0 44 44" width={props.size ?? 44} height={props.size ?? 44} className="shrink-0">
      <polygon points={ring(100)} fill="none" stroke="var(--surface3)" />
      <polygon points={ring(50)} fill="none" stroke="var(--surface3)" strokeDasharray="2 2" />
      <polygon
        points={PULSE_AXES.map((a, i) => pt(i, props.row.scores[a.key])).join(' ')}
        fill={tint(props.color, 28)}
        stroke={props.color}
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
    </svg>
  )
}

function Alerts(props: {
  rows: readonly PulseRow[]
  selected: number
  onPick: (i: number) => void
}): React.JSX.Element {
  const alerts = props.rows
    .map((row, i) => ({ row, i }))
    .filter(({ row }) => isAlert(row))
    .reverse()
  if (alerts.length === 0) {
    return (
      <span className="text-xs text-muted text-center">
        No alerts yet. Every scored reply looked fine.
      </span>
    )
  }
  return (
    <div className="flex flex-col gap-1.5 overflow-y-auto" style={{ maxHeight: 300 }}>
      {alerts.map(({ row, i }) => {
        const v = PULSE_VERDICTS[row.verdict]
        const tone = pulseToneColor(v.tone)
        const current = i === props.selected
        const low = PULSE_AXES.reduce((m, a) => (row.scores[a.key] < row.scores[m.key] ? a : m))
        return (
          <Button
            key={row.at}
            variant="bare"
            className="flex items-center gap-3 text-left pl-3 pr-2 py-2 transition-colors hover:bg-surface2"
            style={{
              borderRadius: 10,
              border: `1px solid ${current ? 'var(--accent)' : 'var(--surface3)'}`,
              borderLeft: `3px solid ${tone}`,
              background: current ? tint('var(--accent)', 8) : 'var(--surface1)'
            }}
            onClick={() => props.onPick(i)}
          >
            <div className="flex flex-col gap-0.5 flex-1 min-w-0">
              <b style={{ fontSize: 13 }}>{v.title}</b>
              <small className="text-muted" style={{ font: `500 11px ${MONO}` }}>
                check {i + 1} · {stamp(row.at)}
              </small>
              <small style={{ font: `500 11px ${MONO}`, color: low.color }}>
                lowest: {low.label} {(row.scores[low.key] / 100).toFixed(2)}
              </small>
            </div>
            <MiniShape row={row} color={tone} />
          </Button>
        )
      })}
    </div>
  )
}

function zeros(): Record<string, number> {
  return Object.fromEntries(PULSE_AXES.map((a) => [a.key, 0]))
}

const ROW_NOTE = {
  copied: 'Copied - paste it in the chat',
  sent: 'Sent to the agent',
  failed: "Didn't reach the agent"
}

function Now(props: {
  row?: PulseRow
  scoring: boolean
  onCheck: () => void
  onSend?: (prompt: string) => Promise<boolean>
}): React.JSX.Element {
  const { row, scoring, onCheck, onSend } = props
  const [shown, setShown] = useState(zeros)
  const shownRef = useRef(shown)
  const [note, setNote] = useState<{ key: PulseAxis['key']; kind: keyof typeof ROW_NOTE } | null>(
    null
  )
  const sending = useRef(false)
  const { tip, hoverProps } = useTooltip()
  useEffect(() => {
    if (!note) return
    const t = setTimeout(() => setNote(null), 1600)
    return () => clearTimeout(t)
  }, [note])
  const copy = (a: PulseAxis): void => {
    if (!row || !copyText(pulseAxisPrompt(a, row.scores[a.key]))) return
    setNote({ key: a.key, kind: 'copied' })
  }
  const send = (a: PulseAxis): void => {
    if (!row || !onSend || sending.current) return
    sending.current = true
    void onSend(pulseAxisPrompt(a, row.scores[a.key]))
      .catch(() => false)
      .then((ok) => setNote({ key: a.key, kind: ok ? 'sent' : 'failed' }))
      .finally(() => {
        sending.current = false
      })
  }
  useEffect(() => {
    const target = scoring || !row ? zeros() : row.scores
    const from = shownRef.current
    const start = performance.now()
    let frame = 0
    const step = (t: number): void => {
      const k = Math.min(1, (t - start) / 700)
      const ease = 1 - (1 - k) ** 3
      const next = Object.fromEntries(
        PULSE_AXES.map((a) => [a.key, from[a.key] + (target[a.key] - from[a.key]) * ease])
      )
      shownRef.current = next
      setShown(next)
      if (k < 1) frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [row, scoring])
  return (
    <div className="flex flex-col gap-1 w-full p-1.5" style={{ borderRadius: 12 }}>
      {PULSE_AXES.map((a) => {
        const Icon = AXIS_ICON[a.key]
        const kind = note?.key === a.key ? note.kind : null
        return (
          <Button
            key={a.key}
            variant="bare"
            disabled={scoring || !row}
            onClick={(e) => {
              if (e.detail < 2) copy(a)
            }}
            onDoubleClick={() => send(a)}
            className="flex items-center gap-3 w-full text-left px-1.5 py-1.5 transition-colors hover:bg-surface2 active:scale-[.99]"
            style={{ borderRadius: 10 }}
            {...hoverProps(
              <>
                {axisTip(a)}
                <div>Click to copy a prompt for the agent.</div>
                {onSend && <div>Double click to send it, with anything you&apos;ve typed.</div>}
              </>
            )}
          >
            <span
              className="flex items-center justify-center shrink-0"
              style={{ width: 28, height: 28, borderRadius: 8, background: tint(a.color, 14), color: a.color }}
            >
              <Icon size={15} strokeWidth={2.25} />
            </span>
            <div className="flex flex-col gap-1.5 flex-1 min-w-0">
              <div className="flex items-baseline justify-between">
                <span style={{ fontSize: 13, fontWeight: 500 }}>{a.label}</span>
                <span
                  className="flex items-center gap-1"
                  style={{
                    font: `600 11px ${MONO}`,
                    color: kind === 'failed' ? 'var(--red)' : kind ? 'var(--green)' : a.color,
                    fontVariantNumeric: 'tabular-nums'
                  }}
                >
                  {kind && kind !== 'failed' && <Check size={11} strokeWidth={2.5} />}
                  {kind ? ROW_NOTE[kind] : (shown[a.key] / 100).toFixed(2)}
                </span>
              </div>
              <div className="w-full" style={{ height: 6, borderRadius: 999, background: tint(a.color, 14) }}>
                <div
                  style={{
                    height: '100%',
                    width: `${shown[a.key]}%`,
                    borderRadius: 999,
                    background: `linear-gradient(90deg, ${tint(a.color, 55)}, ${a.color})`,
                    boxShadow: `0 0 8px ${tint(a.color, 45)}`
                  }}
                />
              </div>
            </div>
          </Button>
        )
      })}
      <Button
        variant="bare"
        disabled={scoring}
        onClick={onCheck}
        className="flex items-center gap-1.5 self-center mt-1 px-2.5 py-1 rounded-full transition-colors hover:bg-surface2"
        style={{ font: `500 11px ${MONO}`, color: 'var(--muted)' }}
      >
        <RotateCw size={11} className={scoring ? 'animate-spin' : undefined} />
        {scoring ? 'Checking…' : 'Tap to check again'}
      </Button>
      <Tooltip tip={tip} />
    </div>
  )
}

function ScopePicker(props: { scope: PulseScope; onScope: (scope: PulseScope) => void }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-surface3 pt-3">
      <span className="text-xs text-muted whitespace-nowrap">Score replies in</span>
      <SegmentedControl
        items={[
          { id: 'all', label: 'All sessions' },
          { id: 'this', label: 'This one' },
          { id: 'off', label: 'Off' }
        ]}
        active={props.scope}
        onChange={props.onScope}
        textSize="text-[12px] whitespace-nowrap"
        activeWeight={500}
        inactiveColor="var(--text-muted-medium)"
        className=""
      />
    </div>
  )
}

export interface PulsePanelProps {
  sessionRef: string
  state: PulseState
  onScore: (force: boolean) => void
  onScope?: (scope: PulseScope) => void
  onChip: (prompt: string) => Promise<unknown>
  onAxisSend?: (prompt: string) => Promise<boolean>
  onAnswer?: () => void
  onClose?: () => void
}

export function PulsePanel(props: PulsePanelProps): React.JSX.Element {
  const { sessionRef, state, onScore, onScope, onChip, onAxisSend, onAnswer, onClose } = props
  const [tab, setTab] = useState<Tab>('now')
  const [picked, setPicked] = useState<{ ref: string; count: number; index: number } | null>(null)
  const { rows } = state
  const selected =
    picked && picked.ref === sessionRef && picked.count === rows.length
      ? picked.index
      : rows.length - 1
  const row = rows[selected]
  const pick = (index: number): void => setPicked({ ref: sessionRef, count: rows.length, index })
  const alertCount = rows.filter(isAlert).length
  const dot = pulseDot(row)

  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-semibold" style={{ fontSize: 13 }}>
          <span className="session-pulse-dot" style={{ background: dot, color: dot }} />
          Pulse
        </div>
        <div className="flex items-center gap-2">
          <span
            style={{
              font: `500 11px ${MONO}`,
              color: 'var(--muted)',
              fontVariantNumeric: 'tabular-nums'
            }}
          >
            {state.scoring ? 'Scoring…' : row ? `check ${selected + 1} · ${latency(row.ms)}` : ''}
          </span>
          {onClose && (
            <Button
              variant="bare"
              className="session-pulse-close"
              title="Hide Pulse"
              aria-expanded
              onClick={onClose}
            >
              <X size={14} />
            </Button>
          )}
        </div>
      </div>

      {!state.scoring && state.error && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs" style={{ color: 'var(--red)' }}>
            {state.error}
          </span>
          <Button
            variant="ghost"
            className="text-xs flex items-center gap-1"
            onClick={() => onScore(false)}
          >
            <RotateCw size={12} /> Retry
          </Button>
        </div>
      )}

      {!row ? (
        <span className="text-xs text-muted">
          {!state.enabled
            ? 'Not scoring this session.'
            : state.scoring
              ? 'Scoring the latest reply…'
              : 'Scores appear after the next reply.'}
        </span>
      ) : (
        <>
          <SegmentedControl
            items={[
              { id: 'now', label: 'Now' },
              { id: 'latest', label: 'Shape' },
              { id: 'all', label: 'All replies' },
              { id: 'alerts', label: alertCount > 0 ? `Alerts ${alertCount}` : 'Alerts' }
            ]}
            active={tab}
            onChange={setTab}
            textSize="text-[12.5px] whitespace-nowrap"
            activeWeight={500}
            inactiveColor="var(--text-muted-medium)"
            className="session-pulse-tabs"
          />
          <div
            className={`flex flex-col gap-2.5 ${tab === 'latest' ? 'justify-center' : 'justify-start'}`}
            style={{ minHeight: 330 }}
          >
            {tab === 'now' && (
              <Now
                row={row}
                scoring={state.scoring === true}
                onCheck={() => onScore(true)}
                onSend={onAxisSend}
              />
            )}
            {tab === 'latest' && (
              <>
                <Radar row={row} />
                <Strip rows={rows} upTo={selected} />
              </>
            )}
            {tab === 'all' && <History rows={rows} selected={selected} onPick={pick} />}
            {tab === 'alerts' && <Alerts rows={rows} selected={selected} onPick={pick} />}
          </div>
          <Verdict row={row} onChip={onChip} onAnswer={onAnswer} />
        </>
      )}
      {onScope && state.scope && <ScopePicker scope={state.scope} onScope={onScope} />}
    </>
  )
}

export function PulseCell(props: {
  row?: PulseRow
  hoverProps: (text: React.ReactNode) => Record<string, unknown>
}): React.JSX.Element {
  const { row } = props
  if (!row) return <span className="code-session-pulse" data-empty="">-</span>
  const verdict = PULSE_VERDICTS[row.verdict]
  const color = pulseToneColor(verdict.tone)
  return (
    <span
      className="code-session-pulse"
      {...props.hoverProps(
        <span className="flex flex-col gap-0.5">
          <strong>{verdict.body}</strong>
          {PULSE_AXES.map((axis) => (
            <span key={axis.key}>
              {axis.label}: {row.scores[axis.key]}
            </span>
          ))}
        </span>
      )}
    >
      <MiniShape row={row} color={color} size={22} />
      <span className="code-session-pulse-dot" style={{ background: color }} />
      <span className="code-session-pulse-word">{verdict.title}</span>
    </span>
  )
}

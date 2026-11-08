import { JSX, useRef } from 'react'

export interface DialLevel {
  id: string
  label: string
  short?: string
  hint: string
}

const W = 236
const R = 86
const CX = W / 2
const CY = 104
const LABEL_GAP = 22

const point = (f: number, r: number): [number, number] => [CX - r * Math.cos(Math.PI * f), CY - r * Math.sin(Math.PI * f)]

function arc(from: number, to: number): string {
  const [x1, y1] = point(from, R)
  const [x2, y2] = point(to, R)
  return `M${x1.toFixed(1)} ${y1.toFixed(1)} A${R} ${R} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`
}

export function ThinkingDial({ levels, value, onChange, label, children }: {
  levels: DialLevel[]
  value: string
  onChange: (id: string) => void
  label: string
  children?: React.ReactNode
}): JSX.Element {
  const svgRef = useRef<SVGSVGElement>(null)
  const n = Math.max(1, levels.length - 1)
  const at = Math.max(0, levels.findIndex((l) => l.id === value))
  const current = levels[at]
  const [kx, ky] = point(at / n, R)

  const pickAt = (clientX: number, clientY: number): void => {
    const box = svgRef.current?.getBoundingClientRect()
    if (!box) return
    const x = ((clientX - box.left) / box.width) * W - CX
    const y = CY - ((clientY - box.top) / box.height) * (CY + 20)
    const f = 1 - Math.atan2(Math.max(0, y), x) / Math.PI
    const next = levels[Math.round(Math.min(1, Math.max(0, f)) * n)]
    if (next && next.id !== value) onChange(next.id)
  }

  const step = (by: number): void => {
    const next = levels[Math.min(levels.length - 1, Math.max(0, at + by))]
    if (next) onChange(next.id)
  }

  return (
    <div className="mm-dial-box">
      <div
        className="mm-dial"
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={n}
        aria-valuenow={at}
        aria-valuetext={current?.label}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight' || e.key === 'ArrowUp') step(1)
          else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') step(-1)
          else return
          e.preventDefault()
        }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          pickAt(e.clientX, e.clientY)
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) pickAt(e.clientX, e.clientY)
        }}
      >
        <svg ref={svgRef} viewBox={`0 0 ${W} ${CY + 20}`} width={W} height={CY + 20} overflow="visible">
          <defs>
            <linearGradient id="mm-dial-fill" x1="0" x2="1">
              <stop offset="0" stopColor="var(--accent-brand)" />
              <stop offset="1" stopColor="var(--violet)" />
            </linearGradient>
          </defs>
          <path d={arc(0, 1)} className="mm-dial-track" />
          {at > 0 && <path d={arc(0, at / n)} className="mm-dial-fill" />}
          {levels.map((l, k) => {
            const [x, y] = point(k / n, R)
            const [lx, ly] = point(k / n, R + LABEL_GAP)
            const f = k / n
            return (
              <g key={l.id} className="mm-dial-stop" data-on={k <= at || undefined} data-cur={k === at || undefined}>
                {k !== at && <circle cx={x} cy={y} r={3} />}
                <text x={lx} y={ly + 4} textAnchor={f < 0.3 ? 'end' : f > 0.7 ? 'start' : 'middle'}>
                  {l.short ?? l.label}
                </text>
              </g>
            )
          })}
          <circle cx={kx} cy={ky} r={11} className="mm-dial-knob" data-on={at > 0 || undefined} />
        </svg>
        <div className="mm-dial-value">
          <b>{current?.label}</b>
          <span>{current?.hint}</span>
        </div>
      </div>
      <div className="mm-dial-side">
        <span className="mm-pick-head">{label}</span>
        {children}
      </div>
    </div>
  )
}

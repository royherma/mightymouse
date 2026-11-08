import type { CSSProperties, JSX } from 'react'
import type { HideoutVitals } from '../../../shared/hideout'

const HISTORY = 90
const CHART_W = 448
const CHART_H = 56
const STEP = CHART_W / (HISTORY - 1)

function heat(pct: number): string {
  return pct >= 80 ? 'var(--red)' : pct >= 50 ? 'var(--amber)' : 'var(--cyan)'
}

function rate(bytes: number): string {
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB/s`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB/s`
  return `${Math.round(bytes)} B/s`
}

function onFor(s: number): string {
  const d = Math.floor(s / 86_400)
  const h = Math.floor((s % 86_400) / 3600)
  return d ? `on for ${d}d ${h}h` : `on for ${h}h ${Math.floor((s % 3600) / 60)}m`
}

function wifiWord(rssi: number): { word: string; bars: number } {
  if (rssi >= -55) return { word: 'Excellent', bars: 4 }
  if (rssi >= -65) return { word: 'Good', bars: 3 }
  if (rssi >= -75) return { word: 'Fair', bars: 2 }
  return { word: 'Weak', bars: 1 }
}

function Heartbeat({ cpu }: { cpu: number[] }): JSX.Element {
  const now = cpu[cpu.length - 1] ?? 0
  const y = (v: number): number => CHART_H - 4 - (v / 100) * (CHART_H - 12)
  const full = cpu.length >= HISTORY
  const x0 = full ? CHART_W - (cpu.length - 1) * STEP : 0
  const xEnd = x0 + (cpu.length - 1) * STEP
  const pts = cpu.map((v, i) => `${(x0 + i * STEP).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const color = heat(now)
  return (
    <div className="beat" style={{ '--beat': color } as CSSProperties}>
      <div className="beat-read">
        <b>{Math.round(now)}%</b>
        <span>CPU</span>
      </div>
      <svg className="beat-chart" viewBox={`0 0 ${CHART_W} ${CHART_H}`} preserveAspectRatio="none" aria-hidden>
        <defs>
          <linearGradient id="hx-beat-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={color} stopOpacity=".16" />
            <stop offset="1" stopColor={color} stopOpacity="0" />
          </linearGradient>
          <clipPath id="hx-beat-clip">
            <rect
              key={cpu.length}
              className="reveal"
              x="-4"
              y="-8"
              width={xEnd + 8}
              height={CHART_H + 16}
              style={{ '--from': `${cpu.length > 1 ? (xEnd - STEP + 8) / (xEnd + 8) : 1}` } as CSSProperties}
            />
          </clipPath>
        </defs>
        <line x1="0" x2={CHART_W} y1={y(50)} y2={y(50)} className="grid" />
        {cpu.length > 1 ? (
          <g
            key={cpu.length + Math.round(now * 10)}
            className={full ? 'scroll' : ''}
            clipPath={full ? undefined : 'url(#hx-beat-clip)'}
            style={{ '--step': `${STEP}px` } as CSSProperties}
          >
            <polygon
              points={`${x0},${CHART_H} ${pts} ${xEnd},${CHART_H}`}
              fill="url(#hx-beat-fill)"
            />
            <polyline
              points={pts}
              fill="none"
              stroke={color}
              strokeWidth="1.5"
              strokeLinejoin="round"
              strokeLinecap="round"
              className="line"
            />
          </g>
        ) : null}
        <circle cx={Math.max(0, xEnd)} cy={y(now)} r="3" fill={color} className="tip" />
      </svg>
    </div>
  )
}

function Stat({
  label,
  value,
  sub,
  children
}: {
  label: string
  value: string
  sub?: string
  children?: JSX.Element
}): JSX.Element {
  return (
    <div className="stat">
      <span className="k">{label}</span>
      <b>{value}</b>
      {sub ? <span className="s">{sub}</span> : null}
      {children}
    </div>
  )
}

function Meter({ pct, color }: { pct: number; color: string }): JSX.Element {
  return (
    <span className="meter-bar" aria-hidden>
      <i style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: color }} />
    </span>
  )
}

export function HideoutVitalsCard({ v }: { v: HideoutVitals | null }): JSX.Element {
  const head = (
    <div className="ph">
      This Mac
      {v ? (
        <span className="vmeta">
          {v.chip} · {v.cores} cores · {onFor(v.uptimeS)}
        </span>
      ) : null}
    </div>
  )
  if (!v) {
    return (
      <section className="vitals">
        {head}
        <div className="empty">Reading this Mac...</div>
      </section>
    )
  }
  const memPct = v.memTotalGb ? (v.memUsedGb / v.memTotalGb) * 100 : 0
  const wifi = v.wifi ? wifiWord(v.wifi.rssi) : null
  const busiest = Math.max(1, ...v.top.map((t) => t.pct))
  return (
    <section className="vitals">
      {head}
      <Heartbeat cpu={v.cpu} />
      <div className="stats">
        <Stat label="Memory" value={`${v.memUsedGb.toFixed(0)} / ${Math.round(v.memTotalGb)} GB`}>
          <Meter pct={memPct} color={heat(memPct)} />
        </Stat>
        <Stat
          label="Wi-Fi"
          value={wifi ? wifi.word : 'Off'}
          sub={
            v.wifi
              ? [v.wifi.band, v.wifi.rateMbps ? `${v.wifi.rateMbps} Mbps` : '']
                  .filter(Boolean)
                  .join(' · ')
              : 'wired or offline'
          }
        >
          <span className="wbars" aria-hidden>
            {[1, 2, 3, 4].map((n) => (
              <i key={n} className={wifi && n <= wifi.bars ? 'lit' : ''} />
            ))}
          </span>
        </Stat>
        <Stat label="Network" value={`↓ ${rate(v.netDown)}`} sub={`↑ ${rate(v.netUp)}`} />
        {v.battery.percent !== null ? (
          <Stat
            label="Battery"
            value={`${v.battery.percent}%`}
            sub={v.battery.charging ? 'charging' : 'on battery'}
          >
            <Meter
              pct={v.battery.percent}
              color={v.battery.percent < 20 && !v.battery.charging ? 'var(--red)' : 'var(--green)'}
            />
          </Stat>
        ) : null}
      </div>
      {v.top.length ? (
        <div className="busy">
          {v.top.map((t) => (
            <div key={t.name} className="app">
              <span className="n">{t.name}</span>
              <span className="fill">
                <i style={{ width: `${(t.pct / busiest) * 100}%`, background: heat(t.pct) }} />
              </span>
              <b>{t.pct < 1 ? '<1' : Math.round(t.pct)}%</b>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  )
}

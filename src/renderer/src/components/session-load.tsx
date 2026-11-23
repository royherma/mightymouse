import { useEffect, useState } from 'react'
import type { SessionLoad } from '../../../shared/types'

const POLL_MS = 3000
const BUSY_PCT = 25
const WARM_PCT = 5

export function useSessionLoads(on: boolean): Record<string, SessionLoad> {
  const [loads, setLoads] = useState<Record<string, SessionLoad>>({})
  useEffect(() => {
    if (!on) return
    let alive = true
    const refresh = (): void => {
      if (document.hidden) return
      void window.api.agentRelaySessionLoads().then((next) => {
        if (alive) setLoads(next)
      })
    }
    refresh()
    const timer = setInterval(refresh, POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [on])
  return loads
}

export function formatMem(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`
}

function formatCpu(pct: number): string {
  return pct < 1 ? '<1%' : `${Math.round(pct)}%`
}

function tone(pct: number): 'busy' | 'warm' | 'idle' {
  return pct >= BUSY_PCT ? 'busy' : pct >= WARM_PCT ? 'warm' : 'idle'
}

function LoadTip({ load }: { load: SessionLoad }): React.JSX.Element {
  return (
    <span className="flex flex-col gap-0.5">
      <strong>
        {formatCpu(load.cpuPct)} of your computer · {formatMem(load.memMb)}
      </strong>
      <span>The agent itself: {formatCpu(load.agentCpuPct)}</span>
      {load.top.length > 0 && <span>Things it started:</span>}
      {load.top.map((p) => (
        <span key={p.name}>
          {p.name}
          {p.count > 1 ? ` ×${p.count}` : ''} · {formatCpu(p.cpuPct)} · {formatMem(p.memMb)}
        </span>
      ))}
    </span>
  )
}

export function LoadCell(props: {
  load?: SessionLoad
  hoverProps: (text: React.ReactNode) => Record<string, unknown>
}): React.JSX.Element {
  const { load } = props
  if (!load) return <span className="code-session-load" data-empty="">-</span>
  return (
    <span className="code-session-load" data-tone={tone(load.cpuPct)} {...props.hoverProps(<LoadTip load={load} />)}>
      <span className="code-session-load-cpu">{formatCpu(load.cpuPct)}</span>
      <span className="code-session-load-mem">{formatMem(load.memMb)}</span>
    </span>
  )
}

export function LoadBadge({ load }: { load?: SessionLoad }): React.JSX.Element | null {
  if (!load) return null
  return (
    <span className="code-session-load" data-tone={tone(load.cpuPct)} title={`${formatCpu(load.cpuPct)} CPU · ${formatMem(load.memMb)} memory`}>
      <span className="code-session-load-cpu">{formatCpu(load.cpuPct)}</span>
      <span className="code-session-load-mem">{formatMem(load.memMb)}</span>
    </span>
  )
}

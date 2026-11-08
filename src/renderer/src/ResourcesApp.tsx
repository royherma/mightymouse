import { JSX, useEffect, useRef, useState } from 'react'
import { WindowFrame, LoadingBody } from './WindowFrame'
import { CONFIG } from '../../shared/config'
import type { ResourceRow, ResourceSnapshot } from '../../shared/types'
import { ResourceSparkline, buildSparklinePath } from './components/ResourceSparkline'
import { ResourceTrendChart, type ResourceMetric } from './components/ResourceTrendChart'
import { SegmentedControl } from './components/SegmentedControl'
import { ProgressBar } from './components/ProgressBar'
import { AppIcon } from './components/AppIcon'
import ownIcon from './assets/app-icon.png'
import { Button } from './components/Button'

const MAX_ROWS = 12
const SWAP_MARGIN = 0.15
const SWAP_STREAK_NEEDED = 2

function fmtMem(bytes: number): string {
  const gb = bytes / 1024 / 1024 / 1024
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  return `${Math.round(bytes / 1024 / 1024)} MB`
}

function fmtMetric(value: number, metric: ResourceMetric): string {
  return metric === 'cpu' ? value.toFixed(1) : fmtMem(value)
}

function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, value))
}

function smoothed(samples: number[], fallback: number): number {
  if (!samples.length) return fallback
  const last = samples.slice(-3)
  return last.reduce((sum, value) => sum + value, 0) / last.length
}

function processLabel(count: number): string {
  if (count === 1) return CONFIG.UI_LABELS.RESOURCES_ONE_PROCESS
  return CONFIG.UI_LABELS.RESOURCES_PROCESSES.replace('{n}', String(count))
}

function stableOrder(
  rows: ResourceRow[],
  display: Map<string, number>,
  prevOrder: string[],
  leadStreaks: Map<string, number>
): string[] {
  const byId = new Map(rows.map((row) => [row.id, row]))
  const known = prevOrder.filter((id) => byId.has(id))
  const fresh = rows.map((row) => row.id).filter((id) => !known.includes(id))
  const order = [...known, ...fresh]

  for (let i = 0; i < order.length - 1; i++) {
    const upperId = order[i]
    const lowerId = order[i + 1]
    const upperVal = display.get(upperId) ?? 0
    const lowerVal = display.get(lowerId) ?? 0
    if (lowerVal <= upperVal) {
      leadStreaks.delete(lowerId + '>' + upperId)
      continue
    }
    const streakKey = lowerId + '>' + upperId
    const beatsByMargin = lowerVal - upperVal > upperVal * SWAP_MARGIN
    const streak = (leadStreaks.get(streakKey) ?? 0) + 1
    leadStreaks.set(streakKey, streak)
    if (beatsByMargin || streak >= SWAP_STREAK_NEEDED) {
      order[i] = lowerId
      order[i + 1] = upperId
      leadStreaks.delete(streakKey)
    }
  }
  return order
}

function ranked(rows: ResourceRow[], display: Map<string, number>): string[] {
  return [...rows]
    .sort((a, b) => (display.get(b.id) ?? 0) - (display.get(a.id) ?? 0))
    .map((row) => row.id)
}

const APP_ALIAS: Record<string, string> = {
  MobileCal: 'Calendar',
  MobileMail: 'Mail',
  MobileSMS: 'Messages'
}

function LetterIcon({ name, size = 22 }: { name: string; size?: number }): JSX.Element {
  const letter = (name.trim()[0] || '?').toUpperCase()
  return (
    <span
      className="rounded-[5px] bg-surface3 shrink-0 flex items-center justify-center font-semibold text-muted"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.5) }}
      title={CONFIG.UI_LABELS.RESOURCES_SYSTEM_PROCESS}
    >
      {letter}
    </span>
  )
}

function RowIcon({ name, bundled, size = 22 }: { name: string; bundled: boolean; size?: number }): JSX.Element {
  if (name === CONFIG.APP_NAME || name === CONFIG.PRODUCT_NAME) {
    return <img src={ownIcon} width={size} height={size} className="rounded-[5px] shrink-0" alt="" />
  }
  const lookup = APP_ALIAS[name]
  if (!bundled && !lookup) return <LetterIcon name={name} size={size} />
  return <AppIcon app={lookup ?? name} size={size} fallback={<LetterIcon name={name} size={size} />} />
}

function askAbout(name: string, cores: number, mem: number, processes: string): string {
  return `What is ${name} doing? It's using ${cores.toFixed(1)} CPU cores and ${fmtMem(mem)} (${processes}).`
}

function Meter({ label, value, hint, pct }: { label: string; value: string; hint?: string; pct: number }): JSX.Element {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted">{label}</div>
      <div className="flex items-baseline gap-1.5 mt-0.5">
        <span className="text-2xl font-semibold tabular-nums leading-none tracking-tight">{value}</span>
        {hint ? <span className="text-xs text-muted">{hint}</span> : null}
      </div>
      <div className="flex mt-2">
        <ProgressBar pct={clampPct(pct)} height="h-1" />
      </div>
    </div>
  )
}

export default function ResourcesApp(): JSX.Element {
  const [snapshot, setSnapshot] = useState<ResourceSnapshot | null>(null)
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(true)
  const [metric, setMetric] = useState<ResourceMetric>('cpu')
  const [isolatedId, setIsolatedId] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [asked, setAsked] = useState(false)
  const liveRef = useRef(true)
  const hasData = useRef(false)
  const seenAt = useRef(0)
  const orderRef = useRef<string[]>([])
  const leadStreaksRef = useRef<Map<string, number>>(new Map())
  const metricRef = useRef(metric)

  const apply = (next: ResourceSnapshot): void => {
    if (next.sampledAt > 0 && next.sampledAt >= seenAt.current) {
      seenAt.current = next.sampledAt
      hasData.current = true
      setSnapshot(next)
      setError(false)
      setLoading(false)
      return
    }
    if (next.failed && !hasData.current) {
      setError(true)
      setLoading(false)
    }
  }

  useEffect(() => {
    liveRef.current = true
    const off = window.api.onResourcesUpdated((next) => {
      if (liveRef.current) apply(next)
    })
    void window.api.resourcesSnapshot().then((next) => {
      if (liveRef.current) apply(next)
    }).catch(() => {
      if (!liveRef.current) return
      setError(true)
      setLoading(false)
    })
    return () => {
      liveRef.current = false
      off()
    }
  }, [])

  const retry = (): void => {
    setError(false)
    setLoading(true)
    void window.api.resourcesSnapshot().then((next) => {
      if (liveRef.current) apply(next)
    }).catch(() => {
      if (!liveRef.current) return
      setError(true)
      setLoading(false)
    })
  }

  const allRows = snapshot?.rows ?? []
  const coreDisplay = new Map(allRows.map((row) => [row.id, smoothed(row.spark, row.cores)]))
  const memDisplay = new Map(allRows.map((row) => [row.id, smoothed(row.memSpark, row.memBytes)]))
  const display = metric === 'cpu' ? coreDisplay : memDisplay
  const switched = metricRef.current !== metric
  if (switched) {
    metricRef.current = metric
    leadStreaksRef.current.clear()
  }
  const order =
    switched || orderRef.current.length === 0
      ? ranked(allRows, display)
      : stableOrder(allRows, display, orderRef.current, leadStreaksRef.current)
  orderRef.current = order
  const byId = new Map(allRows.map((row) => [row.id, row]))
  const rows = order
    .map((id) => byId.get(id))
    .filter((row): row is ResourceRow => row !== undefined)
    .slice(0, MAX_ROWS)

  const totalCores = snapshot?.totalCores ?? 0
  const totalMem = snapshot?.totalMemBytes ?? 0
  const usedCores = allRows.reduce((sum, row) => sum + (coreDisplay.get(row.id) ?? 0), 0)
  const free = snapshot?.memFreePercent
  const swap = snapshot?.swapUsedBytes

  const frame = (body: JSX.Element): JSX.Element => (
    <WindowFrame
      title={`${CONFIG.APP_NAME} Resources`}
      action={
        <SegmentedControl
          items={[
            { id: 'cpu', label: CONFIG.UI_LABELS.RESOURCES_CORES_COL },
            { id: 'mem', label: CONFIG.UI_LABELS.RESOURCES_MEM_COL }
          ]}
          active={metric}
          onChange={setMetric}
          textSize="text-xs"
          className="mb-0 w-36"
        />
      }
    >
      {body}
    </WindowFrame>
  )

  if (loading && !snapshot) return frame(<LoadingBody label={CONFIG.UI_LABELS.RESOURCES_LOADING} />)

  if (error && !snapshot) {
    return frame(
      <div className="flex flex-col items-center justify-center gap-3 h-[calc(100vh-2.75rem)]">
        <div className="text-lg text-on-surface">{CONFIG.UI_LABELS.RESOURCES_ERROR}</div>
        <Button
          onClick={retry}
        >
          {CONFIG.UI_LABELS.RESOURCES_RETRY}
        </Button>
      </div>
    )
  }

  const selected = openId ? byId.get(openId) ?? null : null
  const selectedCores = selected ? coreDisplay.get(selected.id) ?? selected.cores : 0
  const selectedMem = selected ? memDisplay.get(selected.id) ?? selected.memBytes : 0

  return frame(
    <div className="flex items-start">
    <div className="flex-1 min-w-0 px-5 pt-4 pb-6">
      <div className="grid grid-cols-3 gap-6 mb-4">
        <Meter
          label={CONFIG.UI_LABELS.RESOURCES_CORES_COL}
          value={usedCores.toFixed(1)}
          hint={CONFIG.UI_LABELS.RESOURCES_OF.replace('{n}', String(totalCores || '-'))}
          pct={totalCores > 0 ? (usedCores / totalCores) * 100 : 0}
        />
        <Meter
          label={CONFIG.UI_LABELS.RESOURCES_MEM_COL}
          value={free === null || free === undefined ? '-' : `${Math.round(free)}%`}
          hint={CONFIG.UI_LABELS.RESOURCES_FREE}
          pct={free ?? 0}
        />
        <Meter
          label={CONFIG.UI_LABELS.RESOURCES_SWAP}
          value={!swap ? CONFIG.UI_LABELS.RESOURCES_NONE : fmtMem(swap)}
          pct={!swap || totalMem <= 0 ? 0 : (swap / totalMem) * 100}
        />
      </div>

      <ResourceTrendChart
        points={snapshot?.trend ?? []}
        rows={allRows}
        metric={metric}
        isolatedId={isolatedId}
        onIsolate={setIsolatedId}
        formatValue={(value) => fmtMetric(value, metric)}
        otherLabel={CONFIG.UI_LABELS.RESOURCES_OTHER}
      />

      {rows.length === 0 ? (
        <div className="text-sm text-muted py-6">{CONFIG.UI_LABELS.RESOURCES_EMPTY}</div>
      ) : (
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-3 px-2 pb-1 text-xs">
            <span className="w-[22px] shrink-0" />
            <span className="w-[34%] text-muted">{CONFIG.UI_LABELS.RESOURCES_NAME_COL}</span>
            <span className="flex-1" />
            {(['cpu', 'mem'] as const).map((id) => (
              <Button
                variant="bare"
                key={id}
                onClick={() => setMetric(id)}
                className={`text-right    ${
                  id === 'cpu' ? 'w-14' : 'w-20'
                } ${metric === id ? 'text-on-surface font-semibold' : 'text-muted'}`}
              >
                {id === 'cpu' ? CONFIG.UI_LABELS.RESOURCES_CORES_COL : CONFIG.UI_LABELS.RESOURCES_MEM_COL}
              </Button>
            ))}
          </div>
          {rows.map((row) => {
            const open = openId === row.id
            const cores = coreDisplay.get(row.id) ?? row.cores
            const mem = memDisplay.get(row.id) ?? row.memBytes
            const shown = metric === 'cpu' ? cores : mem
            const pct =
              metric === 'cpu'
                ? totalCores > 0
                  ? (shown / totalCores) * 100
                  : 0
                : totalMem > 0
                  ? (shown / totalMem) * 100
                  : 0
            return (
              <div key={row.id} className={`rounded-lg ${open ? 'bg-accent-wash' : 'hover:bg-surface2'} transition-colors`}>
                <Button
                  variant="bare"
                  aria-expanded={open}
                  onClick={() => {
                    setAsked(false)
                    setOpenId(open ? null : row.id)
                  }}
                  className="w-full flex items-center gap-3 px-2 py-2 text-left"
                >
                  <RowIcon name={row.name} bundled={!!row.bundlePath} />
                  <span className="w-[34%] min-w-0 flex items-baseline gap-2">
                    <span className="truncate text-on-surface">{row.name}</span>
                    {row.detail ? <span className="text-muted text-xs shrink-0">{row.detail}</span> : null}
                  </span>
                  <span className="flex-1 flex items-center min-w-0">
                    <ProgressBar pct={clampPct(pct)} height="h-1.5" />
                  </span>
                  <span className={`w-14 text-right tabular-nums shrink-0 ${metric === 'cpu' ? 'text-on-surface' : 'text-muted'}`}>
                    {cores.toFixed(1)}
                  </span>
                  <span className={`w-20 text-right tabular-nums shrink-0 ${metric === 'mem' ? 'text-on-surface' : 'text-muted'}`}>
                    {fmtMem(mem)}
                  </span>
                </Button>
              </div>
            )
          })}
        </div>
      )}
    </div>
    {selected ? (
      <aside className="sticky top-11 w-72 shrink-0 h-[calc(100vh-2.75rem)] border-l border-surface2 overflow-y-auto px-4 py-4">
        <div className="flex items-start gap-3">
          <RowIcon name={selected.name} bundled={!!selected.bundlePath} size={28} />
          <div className="min-w-0 flex-1">
            <div className="font-semibold truncate">{selected.name}</div>
            {selected.detail ? <div className="text-xs text-muted truncate">{selected.detail}</div> : null}
          </div>
          <Button
            variant="bare"
            onClick={() => {
              setAsked(false)
              setOpenId(null)
            }}
            className="text-xs text-muted shrink-0"
          >
            {CONFIG.UI_LABELS.RESOURCES_CLOSE}
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-3 mt-4">
          <div>
            <div className="text-xs text-muted">{CONFIG.UI_LABELS.RESOURCES_CORES_COL}</div>
            <div className="text-lg font-semibold tabular-nums">{selectedCores.toFixed(1)}</div>
            <div className="text-xs text-muted">
              {CONFIG.UI_LABELS.RESOURCES_OF.replace('{n}', String(totalCores || '-'))}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted">{CONFIG.UI_LABELS.RESOURCES_MEM_COL}</div>
            <div className="text-lg font-semibold tabular-nums">{fmtMem(selectedMem)}</div>
            <div className="text-xs text-muted">
              {totalMem > 0 ? CONFIG.UI_LABELS.RESOURCES_OF.replace('{n}', fmtMem(totalMem)) : '-'}
            </div>
          </div>
        </div>
        <div className="text-xs text-muted mt-3">{processLabel(selected.pids.length)}</div>
        <div className="mt-4">
          <div className="text-xs text-muted mb-1">{CONFIG.UI_LABELS.RESOURCES_TREND_COL}</div>
          <div className="rounded-md bg-surface2">
            {buildSparklinePath(metric === 'cpu' ? selected.spark : selected.memSpark) ? (
              <ResourceSparkline samples={metric === 'cpu' ? selected.spark : selected.memSpark} />
            ) : (
              <div className="h-16 flex items-center px-2 text-xs text-muted">{CONFIG.UI_LABELS.RESOURCES_TREND_WAIT}</div>
            )}
          </div>
        </div>
        <Button
          onClick={() => {
            void window.api.resourcesAsk(askAbout(selected.name, selectedCores, selectedMem, processLabel(selected.pids.length)))
            setAsked(true)
          }}
          className="mt-4 w-full"
        >
          {CONFIG.UI_LABELS.RESOURCES_ASK}
        </Button>
        {asked ? <div className="text-xs text-muted mt-2">{CONFIG.UI_LABELS.RESOURCES_ASKED}</div> : null}
      </aside>
    ) : null}
    </div>
  )
}

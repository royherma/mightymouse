import { JSX, useState, type MouseEvent } from 'react'
import type { ResourceRow, ResourceTrendPoint } from '../../../shared/types'
import { Button } from './Button'

const WIDTH = 720
const HEIGHT = 168
const WINDOW_MS = 120_000
const GAP_MS = 5_000
const OTHER_ID = '__other__'
const BAND_COLORS = ['var(--accent)', 'var(--blue)', 'var(--green)', 'var(--violet)', 'var(--rose)']
const OTHER_COLOR = 'var(--gray-muted)'

export type ResourceMetric = 'cpu' | 'mem'

interface Band {
  id: string
  label: string
  color: string
}

function seriesMap(point: ResourceTrendPoint, metric: ResourceMetric): Record<string, number> {
  return metric === 'cpu' ? point.byId : point.memById
}

function usedOf(point: ResourceTrendPoint, metric: ResourceMetric): number {
  return metric === 'cpu' ? point.usedCores : point.usedMemBytes
}

function bandValue(
  point: ResourceTrendPoint,
  id: string,
  metric: ResourceMetric,
  bandIds: string[]
): number {
  const map = seriesMap(point, metric)
  if (id !== OTHER_ID) return map[id] ?? 0
  const claimed = bandIds.reduce((sum, bid) => sum + (map[bid] ?? 0), 0)
  return Math.max(0, usedOf(point, metric) - claimed)
}

function topBandIds(
  points: ResourceTrendPoint[],
  rowsById: Map<string, ResourceRow>,
  metric: ResourceMetric
): string[] {
  const totals = new Map<string, number>()
  for (const point of points) {
    for (const [id, value] of Object.entries(seriesMap(point, metric))) {
      totals.set(id, (totals.get(id) ?? 0) + value)
    }
  }
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id]) => id)
    .filter((id) => rowsById.has(id))
}

function runsOf(points: ResourceTrendPoint[]): ResourceTrendPoint[][] {
  const runs: ResourceTrendPoint[][] = []
  let current: ResourceTrendPoint[] = []
  for (const point of points) {
    const prev = current[current.length - 1]
    if (prev && point.at - prev.at > GAP_MS) {
      if (current.length) runs.push(current)
      current = []
    }
    current.push(point)
  }
  if (current.length) runs.push(current)
  return runs
}

export function buildStackedAreaPaths(
  points: ResourceTrendPoint[],
  bandIds: string[],
  metric: ResourceMetric,
  isolatedId: string | null
): { id: string; d: string }[] {
  if (points.length < 2) return []
  const newest = points[points.length - 1].at
  const start = newest - WINDOW_MS
  const visible = points.filter((point) => point.at >= start)
  if (visible.length < 2) return []

  const drawIds = isolatedId ? [isolatedId] : [...bandIds, OTHER_ID]
  const maxTotal = Math.max(
    ...visible.map((point) =>
      isolatedId ? bandValue(point, isolatedId, metric, bandIds) : usedOf(point, metric)
    ),
    0.0001
  )
  const xOf = (at: number): number => ((at - start) / WINDOW_MS) * WIDTH
  const pieces = new Map<string, string[]>()

  for (const run of runsOf(visible)) {
    if (run.length < 2) continue
    const cumulative = new Array<number>(run.length).fill(0)
    for (const id of drawIds) {
      const top: [number, number][] = []
      const bottom: [number, number][] = []
      run.forEach((point, i) => {
        const value = bandValue(point, id, metric, bandIds)
        const x = xOf(point.at)
        const yBottom = HEIGHT - (cumulative[i] / maxTotal) * HEIGHT
        cumulative[i] += value
        const yTop = HEIGHT - (cumulative[i] / maxTotal) * HEIGHT
        top.push([x, yTop])
        bottom.push([x, yBottom])
      })
      const topPath = top.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
      const bottomPath = [...bottom]
        .reverse()
        .map(([x, y]) => `L${x.toFixed(1)},${y.toFixed(1)}`)
        .join(' ')
      const list = pieces.get(id) ?? []
      list.push(`${topPath} ${bottomPath} Z`)
      pieces.set(id, list)
    }
  }

  return drawIds
    .filter((id) => pieces.has(id))
    .map((id) => ({ id, d: (pieces.get(id) ?? []).join(' ') }))
}

function contentX(svg: SVGSVGElement, clientX: number): number {
  const rect = svg.getBoundingClientRect()
  const box = svg.viewBox.baseVal
  const scale = Math.min(rect.width / box.width, rect.height / box.height)
  const width = box.width * scale
  const left = rect.left + (rect.width - width) / 2
  return Math.min(1, Math.max(0, (clientX - left) / width))
}

export function ResourceTrendChart({
  points,
  rows,
  metric,
  isolatedId,
  onIsolate,
  formatValue,
  otherLabel
}: {
  points: ResourceTrendPoint[]
  rows: ResourceRow[]
  metric: ResourceMetric
  isolatedId: string | null
  onIsolate: (id: string | null) => void
  formatValue: (n: number) => string
  otherLabel: string
}): JSX.Element {
  const [hover, setHover] = useState<number | null>(null)
  const rowsById = new Map(rows.map((row) => [row.id, row]))
  const bandIds = topBandIds(points, rowsById, metric)
  const paths = buildStackedAreaPaths(points, bandIds, metric, isolatedId)
  const bands: Band[] = [
    ...bandIds.map((id, i) => ({
      id,
      label: rowsById.get(id)?.name ?? id,
      color: BAND_COLORS[i % BAND_COLORS.length]
    })),
    ...(points.length >= 2 ? [{ id: OTHER_ID, label: otherLabel, color: OTHER_COLOR }] : [])
  ]
  const colorOf = new Map(bands.map((band) => [band.id, band.color]))

  const newest = points.length ? points[points.length - 1].at : 0
  const hoverPoint = hover !== null ? points[hover] ?? null : null
  const hoverX = hoverPoint ? ((hoverPoint.at - (newest - WINDOW_MS)) / WINDOW_MS) * WIDTH : 0
  const hoverEntries = hoverPoint
    ? [...bandIds.map((id) => ({ id, label: rowsById.get(id)?.name ?? id, value: seriesMap(hoverPoint, metric)[id] ?? 0 })),
        { id: OTHER_ID, label: otherLabel, value: bandValue(hoverPoint, OTHER_ID, metric, bandIds) }]
        .filter((entry) => entry.value > 0.005)
        .sort((a, b) => b.value - a.value)
        .slice(0, 3)
    : []

  const onMove = (event: MouseEvent<SVGSVGElement>): void => {
    if (points.length < 2) return
    const ratio = contentX(event.currentTarget, event.clientX)
    const start = newest - WINDOW_MS
    const target = start + ratio * WINDOW_MS
    let best = 0
    let bestDistance = Infinity
    points.forEach((point, index) => {
      if (point.at < start) return
      const distance = Math.abs(point.at - target)
      if (distance < bestDistance) {
        bestDistance = distance
        best = index
      }
    })
    setHover(best)
  }

  return (
    <div className="mb-4 rounded-lg bg-surface1 border border-surface2 px-3 pt-3 pb-2">
      <div className="relative">
        <svg
          width="100%"
          height={HEIGHT}
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="block rounded-md"
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
        >
          <line x1={0} y1={HEIGHT - 0.5} x2={WIDTH} y2={HEIGHT - 0.5} stroke="var(--surface3)" />
          {paths.map((path) => (
            <path key={path.id} d={path.d} fill={colorOf.get(path.id) ?? OTHER_COLOR} opacity={0.92} />
          ))}
          {hoverPoint && (
            <line x1={hoverX} x2={hoverX} y1={0} y2={HEIGHT} stroke="var(--on-surface)" strokeWidth={1} opacity={0.35} />
          )}
        </svg>
        {hoverEntries.length > 0 && (
          <div
            className="absolute top-2 pointer-events-none rounded-md bg-bg/95 border border-surface2 px-2 py-1 text-xs tabular-nums shadow-sm"
            style={{
              left: `${Math.min(78, Math.max(8, (hoverX / WIDTH) * 100))}%`,
              transform: 'translateX(-50%)'
            }}
          >
            {hoverEntries.map((entry) => (
              <div key={entry.id} className="flex items-center gap-1.5 whitespace-nowrap">
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: colorOf.get(entry.id) }} />
                <span className="text-on-surface">{entry.label}</span>
                <span className="text-muted">{formatValue(entry.value)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5 mt-2 min-h-[1.75rem]">
        {bands.map((band) => {
          const on = isolatedId === band.id
          const dim = isolatedId !== null && !on
          return (
            <Button
              variant="bare"
              key={band.id}
              aria-pressed={on}
              onClick={() => onIsolate(on ? null : band.id)}
              className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-xs  transition-opacity ${
                on ? 'border-accent bg-accent-wash' : 'border-transparent hover:bg-surface2'
              } ${dim ? 'opacity-40' : ''}`}
            >
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: band.color }} />
              <span className="text-on-surface">{band.label}</span>
            </Button>
          )
        })}
      </div>
    </div>
  )
}

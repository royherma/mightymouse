import { useEffect, useState } from 'react'
import type { CodeSize, CodeSizePoint } from '../../../shared/factory'
import { Button } from './Button'
import { SegmentedControl } from './SegmentedControl'

type Metric = 'lines' | 'files' | 'bytes'

const METRICS: ReadonlyArray<{ id: Metric; label: string }> = [
  { id: 'lines', label: 'Lines' },
  { id: 'files', label: 'Files' },
  { id: 'bytes', label: 'Size' }
]
const MONTH_MS = 30 * 24 * 60 * 60 * 1000
const CHART = { width: 300, height: 64 }

function format(metric: Metric, value: number): string {
  if (metric === 'bytes') {
    const mb = value / 1_000_000
    return mb < 10 ? `${mb.toFixed(2)} MB` : `${mb.toFixed(1)} MB`
  }
  if (Math.abs(value) >= 10_000) return `${Math.round(value / 1000).toLocaleString()}k`
  return value.toLocaleString()
}

function valueAt(points: CodeSizePoint[], at: number, metric: Metric): number {
  let value = 0
  for (const point of points) {
    if (point.at > at) break
    value = point[metric]
  }
  return value
}

function chartPath(points: CodeSizePoint[], metric: Metric): string {
  const first = points[0].at
  const span = Math.max(1, points[points.length - 1].at - first)
  const max = Math.max(1, ...points.map((point) => point[metric]))
  const coords = points.map((point) => {
    const x = ((point.at - first) / span) * CHART.width
    const y = CHART.height - (point[metric] / max) * CHART.height
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  return `M0,${CHART.height} L${coords.join(' L')} L${CHART.width},${CHART.height} Z`
}

function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
}

export function FactoryCodeSize({
  projectId,
  now,
  refreshKey
}: {
  projectId: string
  now: number
  refreshKey: number
}): React.JSX.Element {
  const [size, setSize] = useState<CodeSize | null>(null)
  const [error, setError] = useState('')
  const [metric, setMetric] = useState<Metric>('lines')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let live = true
    window.api
      .factoryCodeSize(projectId)
      .then((next) => live && setSize(next))
      .catch((err: unknown) => live && setError(err instanceof Error ? err.message : String(err)))
    return () => {
      live = false
    }
  }, [projectId, refreshKey, attempt])

  const body = error ? (
    <div className="factory-code-size-note">
      <p>Could not read the code history. {error}</p>
      <Button
        variant="ghost"
        className="text-sm"
        onClick={() => {
          setError('')
          setAttempt(attempt + 1)
        }}
      >
        Try again
      </Button>
    </div>
  ) : !size ? (
    <p className="factory-stats-empty">Counting your code…</p>
  ) : size.points.length < 2 ? (
    <p className="factory-stats-empty">This grows once the project has a few saved changes.</p>
  ) : (
    <>
      <SegmentedControl
        items={METRICS}
        active={metric}
        onChange={setMetric}
        textSize="text-xs"
        className="mb-2"
      />
      <p className="factory-code-size-now">
        <strong>{format(metric, size[metric])}</strong>
        <span>
          {(() => {
            const change = size[metric] - valueAt(size.points, now - MONTH_MS, metric)
            return `${change >= 0 ? '+' : '−'}${format(metric, Math.abs(change))} in 30 days`
          })()}
        </span>
      </p>
      <svg
        className="factory-code-size-chart"
        viewBox={`0 0 ${CHART.width} ${CHART.height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${METRICS.find((item) => item.id === metric)?.label} over time`}
      >
        <path d={chartPath(size.points, metric)} />
      </svg>
      <p className="factory-code-size-axis">
        <span>{shortDate(size.points[0].at)}</span>
        <span>Today</span>
      </p>
    </>
  )

  return (
    <section className="factory-stats-section factory-code-size">
      <h3>Code size</h3>
      {body}
    </section>
  )
}

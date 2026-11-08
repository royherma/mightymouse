import {
  FACTORY_AREAS,
  FACTORY_GROUPS,
  type FactoryArea,
  type FactoryGroup,
  type FactoryAttempt,
  type FactoryTask
} from '../../../shared/factory'
import { AREA_ICON, GROUP_ICON } from './FactoryDraft'
import './FactoryStats.css'

const DAY_MS = 24 * 60 * 60 * 1000
const DAYS_SHOWN = 14

function startOfDay(ms: number): number {
  const day = new Date(ms)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

function dayTitle(start: number, added: number, finished: number): string {
  const date = new Date(start)
  const weekday = date.toLocaleDateString('en-US', { weekday: 'short' })
  const month = date.toLocaleDateString('en-US', { month: 'short' })
  return `${weekday} ${date.getDate()} ${month}: ${added} added, ${finished} finished`
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function formatSpan(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${Math.max(1, minutes)}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

function formatCost(usd: number): string {
  return usd < 10 ? `$${usd.toFixed(2)}` : `$${Math.round(usd)}`
}

export function FactoryStats({
  now,
  tasks,
  attempts
}: {
  now: number
  tasks: FactoryTask[]
  attempts: FactoryAttempt[]
}): React.JSX.Element {
  const hasApproved = tasks.some((task) => task.approvedAt > 0)
  if (!hasApproved) {
    return (
      <div className="factory-stats">
        <p className="factory-stats-empty">Stats show up after your first task finishes.</p>
      </div>
    )
  }

  const todayStart = startOfDay(now)
  const days = Array.from({ length: DAYS_SHOWN }, (_, index) => {
    const start = todayStart - (DAYS_SHOWN - 1 - index) * DAY_MS
    const end = start + DAY_MS
    const added = tasks.filter((task) => task.approvedAt >= start && task.approvedAt < end).length
    const finished = tasks.filter(
      (task) => task.stage === 'merged' && task.updatedAt >= start && task.updatedAt < end
    ).length
    return { start, added, finished }
  })
  const maxDay = Math.max(1, ...days.flatMap((day) => [day.added, day.finished]))

  const costByTask = new Map<string, number>()
  for (const attempt of attempts) {
    for (const run of attempt.audit ?? []) {
      const cost = run.usage?.costUsd ?? 0
      if (cost > 0) costByTask.set(attempt.taskId, (costByTask.get(attempt.taskId) ?? 0) + cost)
    }
  }
  const counted = tasks.filter((task) => task.stage !== 'draft' && task.condition !== 'canceled')
  const tally = (list: FactoryTask[]): { count: number; cost: number } => ({
    count: list.length,
    cost: list.reduce((sum, task) => sum + (costByTask.get(task.id) ?? 0), 0)
  })
  const areaKeys = Object.keys(FACTORY_AREAS) as FactoryArea[]
  const typeGroups = [
    ...(Object.keys(FACTORY_GROUPS) as FactoryGroup[]).map((group) => ({
      key: group,
      label: FACTORY_GROUPS[group],
      Icon: GROUP_ICON[group],
      ...tally(counted.filter((task) => task.area && FACTORY_AREAS[task.area].group === group)),
      areas: areaKeys
        .filter((area) => FACTORY_AREAS[area].group === group)
        .map((area) => ({
          key: area,
          label: FACTORY_AREAS[area].label,
          Icon: AREA_ICON[area],
          ...tally(counted.filter((task) => task.area === area))
        }))
        .filter((row) => row.count > 0)
        .sort((a, b) => b.count - a.count)
    })),
    { key: 'none', label: 'No type', Icon: null, ...tally(counted.filter((task) => !task.area)), areas: [] }
  ]
    .filter((row) => row.count > 0)
    .sort((a, b) => b.count - a.count)
  const maxType = Math.max(1, ...typeGroups.map((row) => row.count))

  const merged = tasks.filter((task) => task.stage === 'merged').length
  const canceled = tasks.filter((task) => task.condition === 'canceled').length
  const blockedNow = tasks.filter((task) => task.condition === 'blocked').length
  const outcomeTotal = merged + canceled + blockedNow

  const attemptsByTask = new Map<string, FactoryAttempt[]>()
  for (const attempt of attempts) {
    const list = attemptsByTask.get(attempt.taskId)
    if (list) list.push(attempt)
    else attemptsByTask.set(attempt.taskId, [attempt])
  }
  const retriedCount = tasks.filter((task) => {
    if (task.repairsUsed > 0) return true
    const perRole = new Map<string, number>()
    for (const attempt of attemptsByTask.get(task.id) ?? []) {
      perRole.set(attempt.role, (perRole.get(attempt.role) ?? 0) + 1)
    }
    return [...perRole.values()].some((count) => count > 1)
  }).length

  const finishSpans = tasks
    .filter(
      (task) => task.stage === 'merged' && task.approvedAt > 0 && task.updatedAt > task.approvedAt
    )
    .map((task) => task.updatedAt - task.approvedAt)
  const medianSpan = median(finishSpans)

  return (
    <div className="factory-stats">
      <section className="factory-stats-section">
        <h3>Last 14 days</h3>
        <div className="factory-stats-chart">
          {days.map((day) => (
            <div
              key={day.start}
              className="factory-stats-col"
              title={dayTitle(day.start, day.added, day.finished)}
            >
              <div className="factory-stats-bars">
                <span
                  className="factory-stats-bar factory-stats-bar-added"
                  style={{ height: `${(day.added / maxDay) * 100}%` }}
                />
                <span
                  className="factory-stats-bar factory-stats-bar-finished"
                  style={{ height: `${(day.finished / maxDay) * 100}%` }}
                />
              </div>
            </div>
          ))}
        </div>
        <p className="factory-stats-legend">
          <span className="factory-stats-dot factory-stats-dot-added" />
          Added
          <span className="factory-stats-dot factory-stats-dot-finished" />
          Finished
        </p>
      </section>

      <section className="factory-stats-section">
        <h3>By type</h3>
        {typeGroups.length === 0 ? (
          <p className="factory-stats-empty">No tasks yet.</p>
        ) : (
          <div className="factory-stats-rows">
            {typeGroups.flatMap((group) => [group, ...group.areas]).map((row) => (
              <div
                className={
                  row.key in FACTORY_AREAS
                    ? 'factory-stats-row factory-stats-row-sub'
                    : 'factory-stats-row'
                }
                key={row.key}
                title={row.cost > 0 ? `${formatCost(row.cost)} of AI use` : undefined}
              >
                <span className="factory-stats-row-label">
                  {row.Icon && <row.Icon size={12} />} {row.label}
                </span>
                <span className="factory-stats-track">
                  <span
                    className="factory-stats-fill"
                    style={{ width: `${(row.count / maxType) * 100}%` }}
                  />
                </span>
                <span className="factory-stats-row-count">{row.count}</span>
                <span className="factory-stats-row-cost">
                  {row.cost > 0 ? formatCost(row.cost) : ''}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="factory-stats-section">
        <h3>How it goes</h3>
        <p className="factory-stats-line">
          {outcomeTotal > 0 ? `${merged} of ${outcomeTotal} finished` : 'Nothing finished yet'}
        </p>
        {outcomeTotal > 0 && (
          <span className="factory-stats-track">
            <span
              className="factory-stats-fill"
              style={{ width: `${(merged / outcomeTotal) * 100}%` }}
            />
          </span>
        )}
        <p className="factory-stats-line">
          {retriedCount === 0 ? 'None needed a retry' : `${retriedCount} needed a retry`}
        </p>
        <p className="factory-stats-line">
          {medianSpan === null
            ? 'No finished tasks yet'
            : `Typical time to finish: ${formatSpan(medianSpan)}`}
        </p>
      </section>
    </div>
  )
}

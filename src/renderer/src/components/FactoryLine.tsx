import { useLayoutEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  ArrowRight,
  ArrowLeft,
  Bot,
  CheckCircle2,
  FileSearch,
  Code2,
  PackageCheck,
  Inbox
} from 'lucide-react'
import {
  FACTORY_STATIONS,
  FACTORY_STATION_LABEL,
  type FactoryAttempt,
  type FactoryStation,
  type FactoryTask
} from '../../../shared/factory'
import { Button } from './Button'
import { AreaTag } from './FactoryDraft'
import './Factory.css'

const STATION_ART = {
  queued: Inbox,
  preparing: FileSearch,
  building: Code2,
  checking: CheckCircle2,
  reviewing: Bot,
  ready: PackageCheck
} as const
const STATION_DESCRIPTION: Record<FactoryStation, string> = {
  queued: 'Waiting to start',
  preparing: 'Understand and plan',
  building: 'Make the change',
  checking: 'Prove it works',
  reviewing: 'Get a second look',
  ready: 'Your turn to review'
}

export function FactoryLine({
  tasks,
  attempts,
  selectedId,
  onSelect,
  compact = false
}: {
  tasks: FactoryTask[]
  attempts: FactoryAttempt[]
  selectedId: string | null
  onSelect: (taskId: string) => void
  compact?: boolean
}): React.JSX.Element {
  const spots = useRef(new Map<string, { stage: string; x: number; y: number }>())
  const nodes = useRef(new Map<string, HTMLButtonElement | null>())
  const [open, setOpen] = useState<Partial<Record<FactoryStation, boolean>>>({})
  const cap = compact ? 1 : 3
  const repair = tasks.some((task) => task.repairsUsed > 0 && task.stage === 'building')
  const placed = tasks.map((task) => `${task.id}:${task.stage}`).join('|')
  useLayoutEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const next = new Map<string, { stage: string; x: number; y: number }>()
    for (const [id, el] of nodes.current) {
      if (!el) continue
      const box = el.getBoundingClientRect()
      const stage = el.dataset.stage ?? ''
      const last = spots.current.get(id)
      next.set(id, { stage, x: box.x, y: box.y })
      if (!last || last.stage === stage || reduced) continue
      el.animate(
        [
          { transform: `translate(${last.x - box.x}px, ${last.y - box.y}px)`, zIndex: 5 },
          { transform: 'translate(0, 0)', zIndex: 5 }
        ],
        { duration: 650, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }
      )
    }
    spots.current = next
  }, [placed, open])
  const liveTasks = new Set(
    attempts.filter((row) => row.state === 'started').map((row) => row.taskId)
  )
  return (
    <div
      className="factory-line"
      data-compact={compact || undefined}
      data-empty={tasks.length === 0 || undefined}
    >
      {repair && (
        <p className="factory-return">
          <ArrowLeft size={13} /> Sent back to Building for a fix
        </p>
      )}
      <div className="factory-board" role="list" aria-label="Task production line">
        <div className="factory-conveyor" aria-hidden />
        {FACTORY_STATIONS.map((stage) => {
          const Icon = STATION_ART[stage]
          const rows = tasks.filter((task) => task.stage === stage)
          const active = rows.some((task) => liveTasks.has(task.id))
          const blocked = rows.some(
            (task) => task.condition === 'blocked' || task.condition === 'interrupted'
          )
          const shown = open[stage] ? rows : rows.slice(0, cap)
          return (
            <section
              key={stage}
              className="factory-station"
              data-stage={stage}
              data-active={active || undefined}
              data-blocked={blocked || undefined}
              role="listitem"
              aria-label={FACTORY_STATION_LABEL[stage]}
            >
              {stage !== 'queued' && (
                <ArrowRight className="factory-station-arrow" size={16} aria-hidden />
              )}
              <div className="factory-machine" aria-hidden>
                <span className="factory-machine-beacon" />
                <span className="factory-machine-window">
                  <Icon size={22} strokeWidth={1.7} />
                </span>
                <span className="factory-machine-feet" />
              </div>
              <div className="factory-station-caption">
                <span className="font-semibold">{FACTORY_STATION_LABEL[stage]}</span>
                {rows.length > 0 && <span className="factory-station-count">{rows.length}</span>}
                <p>{STATION_DESCRIPTION[stage]}</p>
              </div>
              <div className="factory-workpieces">
                {shown.map((task) => (
                  <Button
                    key={task.id}
                    ref={(el) => {
                      if (el) nodes.current.set(task.id, el)
                      else nodes.current.delete(task.id)
                    }}
                    variant="bare"
                    className="factory-tile"
                    data-stage={task.stage}
                    data-selected={selectedId === task.id || undefined}
                    data-stopped={task.condition !== 'clear' || undefined}
                    aria-pressed={selectedId === task.id}
                    onClick={() => onSelect(task.id)}
                  >
                    <span className="factory-task-name">{task.title}</span>
                    {task.area && <AreaTag area={task.area} kind={task.kind} />}
                    <span className="factory-task-state">
                      {task.condition !== 'clear' ? (
                        <>
                          <AlertCircle size={13} /> {task.blockReason || 'Needs your help'}
                        </>
                      ) : liveTasks.has(task.id) ? (
                        <>
                          <Bot size={13} /> Working
                        </>
                      ) : stage === 'ready' ? (
                        <>
                          <CheckCircle2 size={14} /> Ready
                        </>
                      ) : task.parked ? (
                        'Parked'
                      ) : (
                        'Waiting'
                      )}
                    </span>
                    {!compact && task.activity && (
                      <span className="factory-task-activity">{task.activity}</span>
                    )}
                  </Button>
                ))}
                {rows.length > cap && (
                  <Button
                    variant="bare"
                    className="factory-more"
                    onClick={() => setOpen((current) => ({ ...current, [stage]: !current[stage] }))}
                  >
                    {open[stage] ? 'Show fewer' : `+ ${rows.length - cap} more`}
                  </Button>
                )}
              </div>
            </section>
          )
        })}
      </div>
      {!compact && tasks.length > 0 && (
        <div className="factory-line-summary" aria-live="polite">
          <span>{tasks.filter((task) => liveTasks.has(task.id)).length} working</span>
          <span>{tasks.filter((task) => task.stage === 'queued').length} queued</span>
          <span>{tasks.filter((task) => task.stage === 'ready').length} ready for you</span>
        </div>
      )}
    </div>
  )
}

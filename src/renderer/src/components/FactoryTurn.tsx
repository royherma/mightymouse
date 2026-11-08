import { useEffect, useState } from 'react'
import { Check } from 'lucide-react'
import {
  FACTORY_STATION_LABEL,
  firstSentence,
  ideaArea,
  type FactoryAttempt,
  type FactoryStation,
  type FactoryTask
} from '../../../shared/factory'
import {
  FACTORY_ACTION as ACT,
  FACTORY_RETRY_LABEL,
  FACTORY_SCREEN as S,
  FACTORY_STATE,
  FACTORY_STEPS,
  factoryHint,
  factoryState
} from '../../../shared/factory-words'
import {
  BRIEF_WORDS as W,
  defaultGoalDay,
  goalChoices,
  goalFrom,
  goalUnit
} from '../../../shared/brief'
import { GOAL_LIVE, cleanBrief, type InfraRecord } from '../../../shared/infra'
import { goalDay, metricById, typicalFor, typicalText } from '../../../shared/playbooks'
import { formatReportValue, type ProjectReport } from '../../../shared/reports'
import type { MightyProject } from '../../../shared/types'
import { Badge } from './Badge'
import { Button } from './Button'
import { Card, SectionHeader } from './Card'
import { ProgressBar } from './ProgressBar'
import { Muted } from './Text'
import { Input } from '../../../shared/ui/Input'
import { AreaTag } from './FactoryDraft'
import { ProjectAvatar } from './ProjectIcon'

type ProjectOf = (task: FactoryTask) => MightyProject | undefined

function RowText({
  task,
  sub,
  projectOf,
  onSelect
}: {
  task: FactoryTask
  sub: string
  projectOf?: ProjectOf
  onSelect: (id: string) => void
}): React.JSX.Element {
  const project = projectOf?.(task)
  return (
    <Button variant="bare" className="factory-turn-text" onClick={() => onSelect(task.id)}>
      <span className="factory-turn-title">{task.title}</span>
      <span className="factory-turn-sub">
        {project && (
          <span className="factory-turn-project">
            <ProjectAvatar icon={project.icon} imagePath={project.imagePath} size={14} />
            {project.name}
          </span>
        )}
        {task.area && <AreaTag area={task.area} kind={task.kind} />}
        {sub && <span className="truncate">{sub}</span>}
      </span>
    </Button>
  )
}

const IDEAS_SHOWN = 3

export function FactoryTurn({
  rows,
  running,
  selectedId,
  busy,
  empty,
  projectOf,
  onSelect,
  onBuild,
  onSkip,
  onRetry,
  onShip
}: {
  rows: FactoryTask[]
  running: Set<string>
  selectedId: string | null
  busy: boolean
  empty: string
  projectOf?: ProjectOf
  onSelect: (id: string) => void
  onBuild: (task: FactoryTask) => Promise<boolean>
  onSkip: (task: FactoryTask) => Promise<boolean>
  onRetry: (task: FactoryTask, rebuild: boolean) => Promise<boolean>
  onShip: (task: FactoryTask) => Promise<boolean>
}): React.JSX.Element {
  const [frozen, setFrozen] = useState<FactoryTask[] | null>(null)
  const [settled, setSettled] = useState<Record<string, { label: string; was: string }>>({})
  const [allIdeas, setAllIdeas] = useState(false)
  const [confirm, setConfirm] = useState<string | null>(null)

  const stamp = (task: FactoryTask): string => `${task.stage}:${task.condition}`
  const live = new Map(rows.map((task) => [task.id, task]))
  const done = (task: FactoryTask): string | undefined => {
    const mark = settled[task.id]
    if (!mark) return undefined
    const current = live.get(task.id)
    return !current || stamp(current) === mark.was ? mark.label : undefined
  }
  // frozen order: a row that leaves must not pull the next row's button under the pointer
  const held = frozen ?? []
  const order = [
    ...held
      .filter((task) => settled[task.id] || live.has(task.id))
      .map((task) => live.get(task.id) ?? task),
    ...rows.filter((task) => !held.some((item) => item.id === task.id))
  ]
  const ideas = order.filter((task) => task.stage === 'draft')
  const hidden = allIdeas ? [] : ideas.slice(IDEAS_SHOWN)
  const shown = order.filter((task) => !hidden.includes(task))

  const act = (
    task: FactoryTask,
    label: string,
    after: string,
    run: () => Promise<boolean>
  ): void => {
    const was = stamp(task)
    setConfirm(null)
    setSettled((current) => ({ ...current, [task.id]: { label, was } }))
    void run().then((ok) =>
      setSettled((current) =>
        ok
          ? { ...current, [task.id]: { label: after, was } }
          : Object.fromEntries(Object.entries(current).filter(([id]) => id !== task.id))
      )
    )
  }

  return (
    <section className="factory-turn" aria-label={S.turn}>
      <SectionHeader>
        {S.turn} {rows.length > 0 && <Badge size="sm">{rows.length}</Badge>}
      </SectionHeader>
      {order.length === 0 ? (
        <Card>
          <Muted>{empty}</Muted>
        </Card>
      ) : (
        <Card
          className="factory-rows"
          role="list"
          onMouseEnter={() => setFrozen(rows)}
          onMouseLeave={() => {
            setFrozen(null)
            setSettled({})
            setConfirm(null)
          }}
        >
          {shown.map((task) => {
            const state = factoryState(task, running.has(task.id))
            const stuck = state === 'stuck' || state === 'interrupted'
            const mark = done(task)
            const sub =
              state === 'idea'
                ? task.outcome !== task.title
                  ? task.outcome
                  : ''
                : stuck
                  ? firstSentence(task.blockReason) || FACTORY_STATE[state].means
                  : FACTORY_STATE[state].means
            return (
              <div
                key={task.id}
                role="listitem"
                className="factory-row"
                data-state={stuck ? 'stuck' : state}
                data-selected={selectedId === task.id || undefined}
                data-done={mark ? '' : undefined}
              >
                <span className="factory-row-tag">
                  <Badge size="sm" color={stuck ? 'red' : state === 'ready' ? 'green' : 'accent'}>
                    {FACTORY_STATE[stuck ? 'stuck' : state].label}
                  </Badge>
                </span>
                <RowText task={task} sub={sub} projectOf={projectOf} onSelect={onSelect} />
                {mark ? (
                  <span className="factory-row-done" aria-live="polite">
                    {mark}
                  </span>
                ) : state === 'idea' ? (
                  <>
                    <Button
                      variant="ghost"
                      disabled={busy}
                      title={factoryHint('skip')}
                      onClick={() => act(task, S.skipped, S.skipped, () => onSkip(task))}
                    >
                      {ACT.skip.label}
                    </Button>
                    {ideaArea(task) && !task.oversized ? (
                      <Button
                        disabled={busy}
                        title={factoryHint('build')}
                        onClick={() =>
                          act(task, FACTORY_STATE.waiting.label, FACTORY_STATE.waiting.label, () =>
                            onBuild(task)
                          )
                        }
                      >
                        {ACT.build.label}
                      </Button>
                    ) : (
                      <Button onClick={() => onSelect(task.id)}>
                        {task.oversized ? S.open : S.needsArea}
                      </Button>
                    )}
                  </>
                ) : stuck ? (
                  <>
                    {(task.stage === 'checking' || task.stage === 'reviewing') && (
                      <Button
                        variant="ghost"
                        disabled={busy}
                        title={factoryHint('rebuild')}
                        onClick={() =>
                          act(task, S.rebuilding, S.rebuilding, () => onRetry(task, true))
                        }
                      >
                        {ACT.rebuild.label}
                      </Button>
                    )}
                    <Button
                      disabled={busy}
                      title={factoryHint('retry')}
                      onClick={() => act(task, S.retrying, S.retrying, () => onRetry(task, false))}
                    >
                      {FACTORY_RETRY_LABEL[task.stage] ?? ACT.retry.label}
                    </Button>
                  </>
                ) : task.prUrl ? (
                  <>
                    <Button
                      variant="ghost"
                      title={factoryHint('changes')}
                      onClick={() => void window.api.openExternal(task.prUrl)}
                    >
                      {ACT.changes.label}
                    </Button>
                    <Button
                      variant="success"
                      disabled={busy}
                      title={factoryHint('ship')}
                      onBlur={() => confirm === task.id && setConfirm(null)}
                      onClick={() =>
                        confirm === task.id
                          ? act(task, ACT.shipping.label, FACTORY_STATE.shipped.label, () =>
                              onShip(task)
                            )
                          : setConfirm(task.id)
                      }
                    >
                      {confirm === task.id ? ACT.shipConfirm.label : ACT.ship.label}
                    </Button>
                  </>
                ) : (
                  <Button variant="ghost" onClick={() => onSelect(task.id)}>
                    {S.open}
                  </Button>
                )}
              </div>
            )
          })}
          {ideas.length > IDEAS_SHOWN && (
            <div className="factory-rows-more">
              <Button variant="bare" onClick={() => setAllIdeas(!allIdeas)}>
                {allIdeas ? S.fewerIdeas : S.moreIdeas(hidden.length)}
              </Button>
            </div>
          )}
        </Card>
      )}
    </section>
  )
}

export function FactoryWorking({
  rows,
  attempts,
  now,
  selectedId,
  projectOf,
  onSelect
}: {
  rows: FactoryTask[]
  attempts: FactoryAttempt[]
  now: number
  selectedId: string | null
  projectOf?: ProjectOf
  onSelect: (id: string) => void
}): React.JSX.Element | null {
  if (rows.length === 0) return null
  return (
    <section className="factory-working" aria-label={S.working}>
      <SectionHeader>
        {S.working} <Badge size="sm">{rows.length}</Badge>
      </SectionHeader>
      <Card className="factory-rows" role="list">
        {rows.map((task) => {
          const at = FACTORY_STEPS.findIndex((step) => step === task.stage)
          const started = attempts.find((row) => row.taskId === task.id && row.state === 'started')
          const station = FACTORY_STATION_LABEL[task.stage as FactoryStation]
          const label = started
            ? `${station} · ${S.minutes(Math.max(1, Math.round((now - started.startedAt) / 60_000)))}`
            : task.parked
              ? S.parked
              : FACTORY_STATE.waiting.label
          const sub = task.repairsUsed > 0 && task.stage === 'building' ? S.fixing : task.activity
          return (
            <div
              key={task.id}
              role="listitem"
              className="factory-row"
              data-selected={selectedId === task.id || undefined}
            >
              <span className="factory-strip" role="img" aria-label={station}>
                <ProgressBar
                  pct={(Math.max(0, at) / FACTORY_STEPS.length) * 100}
                  segments={FACTORY_STEPS.length}
                  activeSegment={started ? at + 1 : undefined}
                  height="h-1.5"
                />
              </span>
              <RowText
                task={task}
                sub={started ? sub : ''}
                projectOf={projectOf}
                onSelect={onSelect}
              />
              <span className="factory-row-step">{label}</span>
            </div>
          )
        })}
      </Card>
    </section>
  )
}

export function FactoryGoal({ mightyId }: { mightyId: string }): React.JSX.Element | null {
  const [record, setRecord] = useState<InfraRecord | null | undefined>(undefined)
  const [report, setReport] = useState<ProjectReport | null>(null)
  const [editing, setEditing] = useState(false)
  const [goalId, setGoalId] = useState('')
  const [target, setTarget] = useState('')
  const [by, setBy] = useState('')
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    void window.api.infra
      .list()
      .then(
        (all) => live && setRecord(all.find((item) => item.projectId === mightyId)?.record ?? null)
      )
    void window.api.reports.get(mightyId, 7, true).then((next) => live && setReport(next))
    const offInfra = window.api.infra.onChanged(
      (next) => next.projectId === mightyId && setRecord(next.record)
    )
    const offReports = window.api.reports.onChanged(
      (next) => next.projectId === mightyId && next.range === 7 && setReport(next)
    )
    return () => {
      live = false
      offInfra()
      offReports()
    }
  }, [mightyId])

  if (record === undefined) return null
  const brief = record?.brief
  const types = record?.business ?? []
  const goal = brief?.goal
  const choices = goalChoices(types, brief?.niche)
  const picked = choices.find((choice) => choice.id === goalId) ?? choices[0]
  const metric = goal && goal.metric !== GOAL_LIVE ? metricById(goal.metric) : undefined
  const typical = metric && typicalFor(metric, brief?.niche)
  const card = metric && report?.cards.find((item) => item.metric === metric.id)
  const result = card && report?.results[card.id]
  const value = result ? (result.ok ? result.output : result.lastGood?.output)?.value : undefined
  const show = (n: number): string =>
    metric && !metric.unit && card
      ? formatReportValue(n, card.unit)
      : metric
        ? typicalText(metric, n)
        : ''
  const reach =
    metric && value !== undefined && goal?.target
      ? Math.max(
          0,
          Math.min(1, metric.better === 'down' ? goal.target / value : value / goal.target)
        )
      : undefined

  const pick = (id: string): void => {
    const choice = choices.find((item) => item.id === id) ?? choices[0]
    setGoalId(choice.id)
    setTarget(String((choice.id === goal?.metric ? goal.target : undefined) ?? choice.target ?? ''))
    setBy(goal?.by ?? defaultGoalDay(new Date()))
    setFailed(false)
    setEditing(true)
  }
  const save = (): void => {
    setSaving(true)
    setFailed(false)
    void window.api.infra
      .setBrief(mightyId, cleanBrief({ ...brief, goal: goalFrom(picked, target, by) }) ?? {})
      .then(
        (got) => (got.record ? setEditing(false) : setFailed(true)),
        () => setFailed(true)
      )
      .finally(() => setSaving(false))
  }

  return (
    <section className="factory-goal" aria-label={W.goal}>
      <SectionHeader>{W.goal}</SectionHeader>
      {editing || !goal ? (
        <div className="factory-goal-ask">
          {!goal && <p className="factory-goal-question">{W.goalAsk}</p>}
          <div className="factory-area-pills">
            {choices.map((choice) => (
              <Button
                key={choice.id}
                variant="bare"
                className="factory-area-pill"
                role="radio"
                aria-checked={editing && choice.id === picked.id}
                title={choice.hint}
                onClick={() => pick(choice.id)}
              >
                {editing && choice.id === picked.id && <Check size={12} strokeWidth={2.5} />}
                {choice.label}
                {choice.typical && ` · ${choice.typical}`}
              </Button>
            ))}
          </div>
          {types.length === 0 && (
            <Muted>
              {S.noKind}{' '}
              <Button
                variant="bare"
                className="factory-goal-change"
                onClick={() => void window.api.mighty.openCode('infra')}
              >
                {S.openInfra}
              </Button>
            </Muted>
          )}
          {editing && (
            <div className="factory-goal-edit">
              {picked.target !== undefined && (
                <label>
                  {W.aim}
                  <Input
                    type="number"
                    step="any"
                    value={target}
                    aria-label={`${W.aim} ${picked.label}`}
                    onChange={(event) => setTarget(event.target.value)}
                  />
                  {goalUnit(picked.id)} {W.by}
                  <Input
                    type="date"
                    value={by}
                    aria-label={W.by}
                    onChange={(event) => setBy(event.target.value)}
                  />
                </label>
              )}
              <Button busy={saving} onClick={save}>
                {W.setGoal}
              </Button>
              <Button variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              {failed && <Muted>{W.failed}</Muted>}
            </div>
          )}
        </div>
      ) : (
        <div className="factory-goal-line">
          <div>
            <p className="factory-goal-what">{metric?.label ?? W.live}</p>
            <Muted>
              {metric ? goal.by && `${W.by} ${goalDay(goal.by)} · ` : `${W.liveHint} `}
              <Button
                variant="bare"
                className="factory-goal-change"
                onClick={() => pick(goal.metric)}
              >
                {W.change}
              </Button>
            </Muted>
          </div>
          {metric && (
            <>
              <p className="factory-goal-num">
                {value !== undefined && (
                  <>
                    {show(value)} <span aria-hidden>&rarr;</span>{' '}
                  </>
                )}
                {goal.target !== undefined && <em>{show(goal.target)}</em>}
              </p>
              <div className="factory-goal-meter">
                {reach !== undefined && (
                  <span className="factory-goal-bar" aria-hidden>
                    <ProgressBar pct={reach * 100} />
                  </span>
                )}
                <Muted>
                  {value === undefined && (
                    <>
                      {S.notMeasured} ·{' '}
                      <Button
                        variant="bare"
                        className="factory-goal-change"
                        onClick={() => void window.api.mighty.openCode('reports')}
                      >
                        {S.openReports}
                      </Button>
                      {typical && ' · '}
                    </>
                  )}
                  {typical &&
                    S.typical(typical.group, typicalText(metric, typical.value), typical.by)}
                </Muted>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  )
}

import { useEffect, useRef, useState } from 'react'
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Info,
  LayoutGrid,
  Pause,
  Play,
  RefreshCw,
  SlidersHorizontal
} from 'lucide-react'
import {
  FACTORY,
  FACTORY_MODEL_CHOICES,
  FACTORY_MODEL_DEFAULTS,
  FACTORY_MODEL_STATIONS,
  FACTORY_MODEL_STATION_LABEL,
  explainIdle,
  ideaArea,
  type FactoryAttempt,
  type FactoryProject,
  type FactorySnapshot,
  type FactoryTask
} from '../../../shared/factory'
import type { MightyProject } from '../../../shared/types'
import { Button } from './Button'
import { FactoryLine } from './FactoryLine'
import { Input } from '../../../shared/ui/Input'
import { ProjectAvatar } from './ProjectIcon'
import { FactorySeed } from './FactorySeed'
import { FactoryStats } from './FactoryStats'
import { FactoryCodeSize } from './FactoryCodeSize'
import { AreaTag, FactoryDraft } from './FactoryDraft'
import { FactoryTaskDetail } from './FactoryTaskDetail'
import { FactoryGoal, FactoryTurn, FactoryWorking } from './FactoryTurn'
import { FACTORY_SCREEN as S } from '../../../shared/factory-words'
import { SegmentedControl } from './SegmentedControl'
import './KeysPanel.css'
import './Factory.css'

const RAIL_WIDTH_KEY = 'factory.railWidth'
const RAIL_WIDTH = { min: 320, default: 440, max: 760 }
const LIST_WIDTH_KEY = 'factory.listWidth'
const LIST_WIDTH = { min: 160, default: 210, max: 360 }

function readSize(key: string, fallback: number): number {
  try {
    const value = Number(localStorage.getItem(key))
    return value > 0 ? value : fallback
  } catch {
    return fallback
  }
}

function saveSize(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(Math.round(value)))
  } catch {
    return
  }
}

function dragSize(
  down: React.MouseEvent,
  measure: (ev: MouseEvent) => number,
  onSize: (value: number) => void,
  key: string
): void {
  down.preventDefault()
  let last = 0
  const move = (ev: MouseEvent): void => {
    last = measure(ev)
    onSize(last)
  }
  const up = (): void => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
    document.body.style.cursor = ''
    if (last) saveSize(key, last)
  }
  document.body.style.cursor = getComputedStyle(down.currentTarget).cursor
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}

export function FactoryPanel({
  projects,
  focusTaskId,
  onFocusHandled,
  showList = true,
  showRail = true
}: {
  projects: MightyProject[]
  focusTaskId?: string | null
  onFocusHandled?: () => void
  showList?: boolean
  showRail?: boolean
}): React.JSX.Element {
  const [railWidth, setRailWidth] = useState(() => readSize(RAIL_WIDTH_KEY, RAIL_WIDTH.default))
  const [listWidth, setListWidth] = useState(() => readSize(LIST_WIDTH_KEY, LIST_WIDTH.default))
  const layoutRef = useRef<HTMLDivElement>(null)
  const [snapshot, setSnapshot] = useState<FactorySnapshot | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [stale, setStale] = useState(false)
  const [scope, setScope] = useState('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [appliedFocus, setAppliedFocus] = useState<string | null>(null)
  const [limitsOpen, setLimitsOpen] = useState(false)

  if (focusTaskId && focusTaskId !== appliedFocus) {
    setAppliedFocus(focusTaskId)
    setSelectedId(focusTaskId)
    const task = snapshot?.tasks.find((item) => item.id === focusTaskId)
    const match = projects.find(
      (item) => item.agentProjectId === task?.projectId || item.id === task?.projectId
    )
    if (match) setScope(match.id)
  }

  useEffect(() => {
    let active = true
    const pull = (): void => {
      void window.api.factoryGet().then(
        (next) => {
          if (!active) return
          setSnapshot(next)
          setError('')
          setLoading(false)
          setStale(false)
        },
        (err: unknown) => {
          if (!active) return
          setError(err instanceof Error ? err.message : 'The factory could not be loaded.')
          setLoading(false)
          setStale(false)
        }
      )
    }
    pull()
    const timer = window.setInterval(() => {
      setStale(true)
      pull()
    }, FACTORY.uiPollMs)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    if (!focusTaskId) return
    onFocusHandled?.()
  }, [focusTaskId, onFocusHandled])

  const refresh = (): void => {
    void window.api.factoryGet().then(
      (next) => {
        setSnapshot(next)
        setError('')
        setLoading(false)
        setStale(false)
      },
      (err: unknown) => {
        setError(err instanceof Error ? err.message : 'The factory could not be loaded.')
        setLoading(false)
        setStale(false)
      }
    )
  }

  const apply = async (action: () => Promise<FactorySnapshot>): Promise<boolean> => {
    setStale(true)
    try {
      setSnapshot(await action())
      setError('')
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That change did not save.')
      refresh()
      return false
    } finally {
      setStale(false)
    }
  }

  if (loading) {
    return (
      <div className="space-y-3 p-4" aria-busy="true">
        <div className="h-8 animate-pulse rounded-sm bg-surface2" />
        <div className="h-40 animate-pulse rounded-sm bg-surface2" />
      </div>
    )
  }

  const factories = snapshot?.projects ?? []
  const mighty = projects.find((project) => project.id === scope)
  const factory = resolveFactory(scope, mighty, factories)
  const tasks = (snapshot?.tasks ?? []).filter((task) => !factory || task.projectId === factory.id)
  const selected = (snapshot?.tasks ?? []).find((task) => task.id === selectedId) ?? null
  const idle = snapshot
    ? explainIdle(
        {
          now: snapshot.generatedAt,
          globalPaused: snapshot.globalPaused,
          globalSlots: snapshot.globalSlots,
          stopAfter: snapshot.stopAfter,
          projects: snapshot.projects,
          tasks: snapshot.tasks,
          attempts: snapshot.attempts
        },
        factory?.id ?? null
      )
    : null
  const onLine = tasks.filter(
    (task) => task.stage !== 'draft' && task.stage !== 'merged' && task.condition !== 'canceled'
  )
  const drafts = tasks
    .filter((task) => task.stage === 'draft' && task.condition !== 'canceled')
    .sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt)
  const shown = selected
  const needs = waitingOnYou(tasks)
  const turn = [
    ...needs.filter((task) => task.condition === 'clear'),
    ...needs.filter((task) => task.condition !== 'clear'),
    ...drafts
  ]
  const advance = (from: string): void =>
    setSelectedId(turn.find((task) => task.id !== from)?.id ?? null)
  const projectOf = factory
    ? undefined
    : (task: FactoryTask): MightyProject | undefined => {
        const owner = factories.find((item) => item.id === task.projectId)
        return projects.find(
          (item) => item.id === owner?.mightyId || item.agentProjectId === task.projectId
        )
      }
  const shownDrafts = drafts.filter((task) => task.projectId === shown?.projectId)
  const draftIndex = shown ? shownDrafts.findIndex((task) => task.id === shown.id) : -1
  const working = new Set(
    (snapshot?.attempts ?? []).filter((row) => row.state === 'started').map((row) => row.taskId)
  )
  const atOnce = factory
    ? [...new Set(['1', '2', '3', '4', String(factory.tasksAtOnce)])].map((id) => ({
        id,
        label: id
      }))
    : []
  const railOpen = showRail && !!shown
  const paused = factory ? factory.paused : scope === 'all' && !!snapshot?.globalPaused
  const columns = [
    showList ? `${listWidth}px 1px` : '',
    'minmax(0, 1fr)',
    railOpen ? `1px ${railWidth}px` : ''
  ]
    .filter(Boolean)
    .join(' ')

  const taskPanel = !snapshot ? null : shown?.stage === 'draft' ? (
    <FactoryDraft
      key={shown.id}
      draft={shown}
      busy={stale}
      canUp={draftIndex > 0}
      canDown={draftIndex >= 0 && draftIndex < shownDrafts.length - 1}
      onSave={(patch) =>
        void apply(() => window.api.factoryDraft({ action: 'edit', taskId: shown.id, ...patch }))
      }
      onUp={() => void apply(() => reorderDrafts(shownDrafts, draftIndex, draftIndex - 1))}
      onDown={() => void apply(() => reorderDrafts(shownDrafts, draftIndex, draftIndex + 1))}
      onSplit={() =>
        void apply(() => window.api.factoryDraft({ action: 'split', taskId: shown.id }))
      }
      onQueue={() => {
        advance(shown.id)
        void apply(() =>
          window.api.factoryApprove({ projectId: shown.projectId, taskIds: [shown.id] })
        )
      }}
      onReject={() => {
        advance(shown.id)
        void apply(() => window.api.factoryDraft({ action: 'reject', taskId: shown.id }))
      }}
    />
  ) : shown ? (
    <FactoryTaskDetail
      key={shown.id}
      task={shown}
      attempts={snapshot.attempts}
      evidence={snapshot.evidence}
      auditEvents={snapshot.auditEvents}
      onClose={() => setSelectedId(null)}
      onCancel={() => void apply(() => window.api.factoryCancel(shown.id))}
      onRestore={() => void apply(() => window.api.factoryRestore(shown.id))}
      onPark={() =>
        void apply(() => window.api.factoryPark({ taskId: shown.id, parked: !shown.parked }))
      }
      onRetry={(options) => {
        advance(shown.id)
        void apply(() => window.api.factoryRetry(shown.id, options))
      }}
      onMerge={() => apply(() => window.api.factoryMerge(shown.id)).then(() => advance(shown.id))}
    />
  ) : null
  const back = shown && (
    <Button variant="bare" className="factory-side-back" onClick={() => setSelectedId(null)}>
      <ArrowLeft size={14} /> {factory ? 'Project' : 'All projects'}
    </Button>
  )

  return (
    <div
      className="factory-shell flex min-h-0 flex-1 flex-col gap-3 p-3"
      data-stale={stale ? '' : undefined}
    >
      {error && (
        <div className="rounded-sm border border-surface3 p-2 text-sm" role="alert">
          <p>{error}</p>
          {snapshot && (
            <p className="text-muted">
              Last update: {snapshot && new Date(snapshot.generatedAt).toLocaleTimeString()}. The
              line may be out of date.
            </p>
          )}
          <Button className="mt-2" variant="ghost" onClick={refresh}>
            Retry
          </Button>
        </div>
      )}
      <div
        className="factory-layout"
        ref={layoutRef}
        style={{ '--factory-columns': columns } as React.CSSProperties}
      >
        {showList && (
          <FactoryRail
            projects={projects}
            factories={factories}
            scope={scope}
            onScope={(id) => {
              setScope(id)
              setSelectedId(null)
            }}
          />
        )}
        {showList && (
          <div
            className="agent-projects-grip factory-list-grip"
            role="separator"
            aria-orientation="vertical"
            title="Drag to resize · double-click to reset"
            onMouseDown={(down) =>
              dragSize(
                down,
                (ev) => {
                  const left = layoutRef.current?.getBoundingClientRect().left ?? 0
                  return Math.max(LIST_WIDTH.min, Math.min(LIST_WIDTH.max, ev.clientX - left))
                },
                setListWidth,
                LIST_WIDTH_KEY
              )
            }
            onDoubleClick={() => {
              setListWidth(LIST_WIDTH.default)
              saveSize(LIST_WIDTH_KEY, LIST_WIDTH.default)
            }}
          />
        )}
        <div className="factory-canvas">
          <div className="factory-topbar">
            <h1>
              {factory
                ? displayName(factory)
                : (mighty?.name ?? (factories.length ? 'All projects' : 'Factory'))}
            </h1>
            <div className="factory-top-tools">
              {scope === 'all' && snapshot && factories.length > 0 && (
                <Button
                  variant="ghost"
                  onClick={() =>
                    void apply(() =>
                      window.api.factoryPause({ projectId: null, paused: !snapshot.globalPaused })
                    )
                  }
                >
                  {snapshot.globalPaused ? <Play size={14} /> : <Pause size={14} />}
                  {snapshot.globalPaused ? 'Resume everywhere' : 'Pause everywhere'}
                </Button>
              )}
              {factory && (
                <>
                  {FACTORY.maxSlots > 1 && (
                    <span className="factory-at-once" title="How many tasks run at the same time">
                      At a time
                      <SegmentedControl
                        items={atOnce}
                        active={String(factory.tasksAtOnce)}
                        textSize="text-xs"
                        className="factory-segments"
                        onChange={(id) =>
                          void apply(() =>
                            window.api.factoryLimits({
                              projectId: factory.id,
                              tasksAtOnce: Number(id)
                            })
                          )
                        }
                      />
                    </span>
                  )}
                  <Button
                    variant="icon"
                    aria-label={factory.paused ? 'Resume' : 'Pause'}
                    title={factory.paused ? 'Resume' : 'Pause'}
                    data-on={factory.paused || undefined}
                    onClick={() => {
                      const paused = !factory.paused
                      setSnapshot((current) =>
                        current
                          ? {
                              ...current,
                              projects: current.projects.map((item) =>
                                item.id === factory.id ? { ...item, paused } : item
                              )
                            }
                          : current
                      )
                      void apply(() => window.api.factoryPause({ projectId: factory.id, paused }))
                    }}
                  >
                    {factory.paused ? <Play size={16} /> : <Pause size={16} />}
                  </Button>
                  <Button
                    variant="icon"
                    aria-label="Limits"
                    title="Limits"
                    aria-expanded={limitsOpen}
                    data-on={limitsOpen || undefined}
                    onClick={() => setLimitsOpen(!limitsOpen)}
                  >
                    <SlidersHorizontal size={16} />
                  </Button>
                </>
              )}
              <Button
                variant="icon"
                aria-label="Refresh"
                title="Refresh"
                onClick={() => void apply(() => window.api.factoryReconcile())}
              >
                <RefreshCw size={16} className={stale ? 'animate-spin' : undefined} />
              </Button>
            </div>
          </div>
          {factory && limitsOpen && (
            <>
              <StationModels snapshot={snapshot} onApply={apply} />
              <Limits
                project={factory}
                globalPaused={snapshot?.globalPaused ?? false}
                onApply={apply}
              />
            </>
          )}
          {(idle || paused) && (
            <p className="factory-idle">
              <Info size={14} /> {idle ?? S.paused}
            </p>
          )}
          {scope !== 'all' && mighty && !factory && (
            <Setup mighty={mighty} onSnapshot={setSnapshot} onReady={(id) => setScope(id)} />
          )}
          {scope === 'all' && factories.length === 0 && (
            <div className="factory-first-run">
              <div>
                <p className="text-md font-semibold">Start with one project</p>
                <p className="mt-1 text-sm text-muted">
                  {projects.length === 0
                    ? S.firstRun
                    : 'Choose a project on the left. Your work will move through this line, then come back ready for your review.'}
                </p>
              </div>
              <FactoryLine tasks={[]} attempts={[]} selectedId={null} onSelect={() => undefined} />
              {projects.length === 0 && <QuickStart onSnapshot={setSnapshot} onReady={setScope} />}
            </div>
          )}
          {snapshot &&
            (factory || (scope === 'all' && factories.length > 0)) &&
            (shown && !showRail ? (
              <section className="factory-island factory-task-island" aria-label="Task">
                {back}
                {taskPanel}
              </section>
            ) : (
              <div className="factory-column">
                {factory && factory.setupBlockers.length > 0 && (
                  <SetupFix key={factory.id} project={factory} onApply={apply} />
                )}
                {factory && <FactoryGoal key={factory.mightyId} mightyId={factory.mightyId} />}
                <FactoryTurn
                  rows={turn}
                  running={working}
                  selectedId={selectedId}
                  busy={stale}
                  empty={factory ? S.turnEmpty : S.turnEmptyAll}
                  projectOf={projectOf}
                  onSelect={setSelectedId}
                  onBuild={(task) =>
                    apply(async () => {
                      if (!task.area)
                        await window.api.factoryDraft({
                          action: 'edit',
                          taskId: task.id,
                          area: ideaArea(task)
                        })
                      return window.api.factoryApprove({
                        projectId: task.projectId,
                        taskIds: [task.id]
                      })
                    })
                  }
                  onSkip={(task) =>
                    apply(() => window.api.factoryDraft({ action: 'reject', taskId: task.id }))
                  }
                  onRetry={(task, rebuild) =>
                    apply(() => window.api.factoryRetry(task.id, { note: '', rebuild }))
                  }
                  onShip={(task) => apply(() => window.api.factoryMerge(task.id))}
                />
                {factory && (
                  <FactorySeed
                    key={factory.id}
                    now={snapshot.generatedAt}
                    projectId={factory.id}
                    mightyId={factory.mightyId}
                    planError={snapshot.planError ?? ''}
                    attempts={snapshot.attempts}
                    onSnapshot={setSnapshot}
                  />
                )}
                <FactoryWorking
                  rows={onLine.filter((task) => !needs.includes(task))}
                  attempts={snapshot.attempts}
                  now={snapshot.generatedAt}
                  selectedId={selectedId}
                  projectOf={projectOf}
                  onSelect={setSelectedId}
                />
                <Shipped
                  projectId={factory?.id}
                  now={snapshot.generatedAt}
                  tasks={tasks}
                  attempts={snapshot.attempts}
                  projectOf={projectOf}
                  onSelect={setSelectedId}
                />
              </div>
            ))}
        </div>
        {railOpen && (
          <>
            <div
              className="agent-projects-grip"
              role="separator"
              aria-orientation="vertical"
              title="Drag to resize · double-click to reset"
              onMouseDown={(down) =>
                dragSize(
                  down,
                  (ev) => {
                    const right = layoutRef.current?.getBoundingClientRect().right ?? 0
                    return Math.max(RAIL_WIDTH.min, Math.min(RAIL_WIDTH.max, right - ev.clientX))
                  },
                  setRailWidth,
                  RAIL_WIDTH_KEY
                )
              }
              onDoubleClick={() => {
                setRailWidth(RAIL_WIDTH.default)
                saveSize(RAIL_WIDTH_KEY, RAIL_WIDTH.default)
              }}
            />
            <aside className="factory-rail-right factory-task-island" aria-label="Task">
              {back}
              {taskPanel}
            </aside>
          </>
        )}
      </div>
    </div>
  )
}

async function reorderDrafts(
  rows: FactoryTask[],
  from: number,
  to: number
): Promise<FactorySnapshot> {
  const next = rows.slice()
  const [moved] = next.splice(from, 1)
  let snap = await window.api.factoryGet()
  if (!moved) return snap
  next.splice(to, 0, moved)
  for (const [index, row] of next.entries()) {
    snap = await window.api.factoryDraft({ action: 'reorder', taskId: row.id, priority: index })
  }
  return snap
}

function FactoryRail({
  projects,
  factories,
  scope,
  onScope
}: {
  projects: MightyProject[]
  factories: FactoryProject[]
  scope: string
  onScope: (id: string) => void
}): React.JSX.Element {
  const isActive = (project: MightyProject): boolean =>
    factories.some((item) => item.mightyId === project.id || item.id === project.agentProjectId)
  const open = projects
    .filter((project) => !project.archived)
    .sort((a, b) => Number(isActive(b)) - Number(isActive(a)))
  const away = projects.filter((project) => project.archived)
  return (
    <aside className="keys-rail factory-rail" aria-label="Projects">
      <Button
        variant="bare"
        className="keys-rail-row"
        data-active={scope === 'all' || undefined}
        onClick={() => onScope('all')}
      >
        <LayoutGrid size={16} />
        <span className="keys-rail-name">All projects</span>
      </Button>
      {open.map((project) => (
        <RailRow
          key={project.id}
          project={project}
          active={isActive(project)}
          picked={scope === project.id}
          onScope={onScope}
        />
      ))}
      {away.length > 0 && (
        <details className="factory-rail-away">
          <summary>Put away · {away.length}</summary>
          {away.map((project) => (
            <RailRow
              key={project.id}
              project={project}
              active={false}
              picked={scope === project.id}
              onScope={onScope}
            />
          ))}
        </details>
      )}
    </aside>
  )
}

function RailRow({
  project,
  active,
  picked,
  onScope
}: {
  project: MightyProject
  active: boolean
  picked: boolean
  onScope: (id: string) => void
}): React.JSX.Element {
  const label = project.archived ? 'Bring back' : 'Put away'
  return (
    <div className="factory-project-line">
      <Button
        variant="bare"
        className="keys-rail-row"
        data-active={picked || undefined}
        onClick={() => onScope(project.id)}
      >
        <ProjectAvatar
          icon={project.icon}
          imagePath={project.imagePath}
          size={16}
          className="rounded-sm"
        />
        <span className="keys-rail-name">{project.name}</span>
        {active && <span className="factory-project-live" aria-label="Factory active" />}
      </Button>
      <Button
        variant="icon"
        className="factory-project-away"
        aria-label={label}
        title={label}
        onClick={() =>
          void window.api.mighty.upsertProject({
            ...project,
            archived: !project.archived,
            updated: new Date().toISOString()
          })
        }
      >
        {project.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
      </Button>
    </div>
  )
}

function QuickStart({
  onSnapshot,
  onReady
}: {
  onSnapshot: (next: FactorySnapshot) => void
  onReady: (scope: string) => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const start = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const link = await window.api.mighty.pickProjectFolder()
      if (!link) return
      const now = new Date().toISOString()
      const id = crypto.randomUUID()
      const name = link.repoFolder.split('/').filter(Boolean).at(-1) || 'New project'
      const project = await window.api.mighty.upsertProject({
        id,
        name,
        created: now,
        updated: now,
        repoFolder: link.repoFolder,
        agentProjectId: link.agentProjectId
      })
      if (!project) throw new Error('That project could not be saved.')
      onSnapshot(
        await window.api.factorySetup({
          mightyId: project.id,
          name: project.name,
          repoRoot: link.repoFolder,
          projectId: link.agentProjectId
        })
      )
      onReady(project.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That project could not be started.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="factory-quick-start">
      <p className="font-semibold">Connect your first project</p>
      <p className="mt-1 text-sm text-muted">
        Choose its folder once. Factory will make a safe copy for every task.
      </p>
      <Button className="mt-3" disabled={busy} onClick={() => void start()}>
        {busy ? 'Connecting…' : 'Choose a project folder'}
      </Button>
      {error && <p className="mt-2 text-sm text-accent">{error}</p>}
    </div>
  )
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

function waitingOnYou(tasks: FactoryTask[]): FactoryTask[] {
  return tasks.filter(
    (task) =>
      task.condition !== 'canceled' &&
      task.stage !== 'draft' &&
      task.stage !== 'merged' &&
      (task.condition !== 'clear' || task.stage === 'ready')
  )
}

function displayName(project: FactoryProject): string {
  return project.name === 'ShowAndTell' ? 'MightyMouse' : project.name
}

function SetupFix({
  project,
  onApply
}: {
  project: FactoryProject
  onApply: (action: () => Promise<FactorySnapshot>) => Promise<boolean>
}): React.JSX.Element {
  const [checks, setChecks] = useState(project.checkCommands.join('\n'))
  const [busy, setBusy] = useState(false)
  const save = (): void => {
    setBusy(true)
    void onApply(() =>
      window.api.factorySetup({
        mightyId: project.mightyId,
        name: project.name,
        repoRoot: project.repoRoot,
        projectId: project.id,
        integrationRef: project.integrationRef || undefined,
        checkCommands: checks
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
      })
    ).finally(() => setBusy(false))
  }
  return (
    <form
      className="factory-setup-fix"
      onSubmit={(event) => {
        event.preventDefault()
        save()
      }}
    >
      <ul className="factory-blockers" role="alert">
        {project.setupBlockers.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <Input
        aria-label={S.testWith}
        placeholder={`${S.testWith}, ${S.testExample}`}
        value={checks}
        onChange={(event) => setChecks(event.target.value)}
      />
      <Button type="submit" busy={busy}>
        {S.checkAgain}
      </Button>
    </form>
  )
}

function Shipped({
  projectId,
  now,
  tasks,
  attempts,
  projectOf,
  onSelect
}: {
  projectId?: string
  now: number
  tasks: FactoryTask[]
  attempts: FactoryAttempt[]
  projectOf?: (task: FactoryTask) => MightyProject | undefined
  onSelect: (id: string) => void
}): React.JSX.Element {
  const since = now - WEEK_MS
  const finished = tasks
    .filter((task) => task.stage === 'merged' && task.condition !== 'canceled')
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const week = finished.filter((task) => task.updatedAt >= since)
  const canceled = tasks
    .filter((task) => task.condition === 'canceled' && task.stage !== 'draft')
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const list = (rows: FactoryTask[]): React.JSX.Element => (
    <div className="factory-overview-list">
      <ul>
        {rows.map((task) => (
          <li key={task.id}>
            <Button variant="bare" onClick={() => onSelect(task.id)}>
              <span>{task.title}</span>
              <span className="factory-overview-meta">
                {task.area && <AreaTag area={task.area} kind={task.kind} />}
                {projectOf?.(task) && (
                  <span className="factory-overview-project">{projectOf(task)?.name}</span>
                )}
              </span>
            </Button>
          </li>
        ))}
      </ul>
    </div>
  )
  return (
    <details className="factory-shipped">
      <summary>
        {S.shipped} <b>{week.length}</b>
        {week[0] && <span className="truncate">{week[0].title}</span>}
      </summary>
      {finished.length === 0 ? (
        <p className="text-sm text-muted">{S.shippedEmpty}</p>
      ) : (
        list(finished.slice(0, 5))
      )}
      {canceled.length > 0 && (
        <details className="factory-overview-canceled">
          <summary>Canceled ({canceled.length})</summary>
          {list(canceled)}
        </details>
      )}
      <details className="factory-overview-more">
        <summary>How it is going</summary>
        <FactoryStats now={now} tasks={tasks} attempts={attempts} />
        {projectId && (
          <FactoryCodeSize
            key={projectId}
            projectId={projectId}
            now={now}
            refreshKey={finished.length}
          />
        )}
      </details>
    </details>
  )
}

const MODEL_ITEMS = FACTORY_MODEL_CHOICES.map((id) => ({
  id,
  label: id[0].toUpperCase() + id.slice(1)
}))

function StationModels({
  snapshot,
  onApply
}: {
  snapshot: FactorySnapshot | null
  onApply: (action: () => Promise<FactorySnapshot>) => Promise<boolean>
}): React.JSX.Element {
  const models = snapshot?.models ?? FACTORY_MODEL_DEFAULTS
  return (
    <div
      className="factory-station-models"
      title="Opus and Fable think harder and cost more. Sonnet and Haiku are cheaper for routine work."
    >
      {FACTORY_MODEL_STATIONS.map((station) => (
        <span key={station} className="factory-at-once">
          {FACTORY_MODEL_STATION_LABEL[station]}
          <SegmentedControl
            items={MODEL_ITEMS}
            active={models[station]}
            textSize="text-xs"
            className="factory-segments"
            onChange={(id) => {
              const choice = FACTORY_MODEL_CHOICES.find((item) => item === id)
              if (choice)
                void onApply(() => window.api.factoryLimits({ models: { [station]: choice } }))
            }}
          />
        </span>
      ))}
    </div>
  )
}

function Limits({
  project,
  globalPaused,
  onApply
}: {
  project: FactoryProject
  globalPaused: boolean
  onApply: (action: () => Promise<FactorySnapshot>) => Promise<boolean>
}): React.JSX.Element {
  const [minutes, setMinutes] = useState('')
  return (
    <details className="text-sm">
      <summary>Limits</summary>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {FACTORY.maxSlots > 1 && (
          <label>
            Slots
            <input
              className="ml-2 w-14 rounded-sm border border-surface3 bg-transparent px-2 py-1"
              type="number"
              min={1}
              max={8}
              defaultValue={4}
              onBlur={(event) =>
                void onApply(() =>
                  window.api.factoryLimits({ globalSlots: Number(event.target.value) })
                )
              }
            />
          </label>
        )}
        <label>
          Repairs
          <input
            className="ml-2 w-14 rounded-sm border border-surface3 bg-transparent px-2 py-1"
            type="number"
            min={0}
            max={5}
            defaultValue={project.repairs}
            onBlur={(event) =>
              void onApply(() =>
                window.api.factoryLimits({
                  projectId: project.id,
                  repairs: Number(event.target.value)
                })
              )
            }
          />
        </label>
        <label>
          Stop after minutes
          <input
            className="ml-2 w-16 rounded-sm border border-surface3 bg-transparent px-2 py-1"
            type="number"
            min={1}
            value={minutes}
            onChange={(event) => setMinutes(event.target.value)}
          />
        </label>
        <Button
          variant="ghost"
          onClick={() =>
            void onApply(() =>
              window.api.factoryLimits({
                stopAfter: minutes ? Date.now() + Number(minutes) * 60_000 : null
              })
            )
          }
        >
          Set cutoff
        </Button>
        <Button
          variant="ghost"
          onClick={() =>
            void onApply(() => window.api.factoryPause({ projectId: null, paused: !globalPaused }))
          }
        >
          {globalPaused ? 'Resume everywhere' : 'Pause everywhere'}
        </Button>
      </div>
    </details>
  )
}

function Setup({
  mighty,
  onSnapshot,
  onReady
}: {
  mighty: MightyProject
  onSnapshot: (next: FactorySnapshot) => void
  onReady: (scopeId: string) => void
}): React.JSX.Element {
  const [branch, setBranch] = useState('')
  const [checks, setChecks] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const start = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      let repo = mighty.repoFolder
      let projectId = mighty.agentProjectId
      if (!repo) {
        const link = await window.api.mighty.pickProjectFolder()
        if (!link) return
        repo = link.repoFolder
        projectId = link.agentProjectId
      }
      const next = await window.api.factorySetup({
        mightyId: mighty.id,
        name: mighty.name,
        repoRoot: repo,
        projectId,
        integrationRef: branch || undefined,
        checkCommands: checks
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
      })
      onSnapshot(next)
      onReady(mighty.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The factory could not start.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="factory-setup">
      <FactoryLine tasks={[]} attempts={[]} selectedId={null} onSelect={() => undefined} />
      <div className="factory-setup-card">
        <p className="text-md font-semibold">Start Factory for {mighty.name}</p>
        <p className="mt-1 text-sm text-muted">
          It makes a safe copy for each task, runs the usual checks, then brings the pull request
          back to you.
        </p>
        <Button className="mt-3" disabled={busy} onClick={() => void start()}>
          {busy ? 'Starting…' : 'Start Factory'}
        </Button>
        <details className="factory-advanced">
          <summary>Change the defaults</summary>
          <p className="mt-2 text-sm text-muted">
            Only use this if this project needs a different branch or check command.
          </p>
          <input
            className="mt-2 w-full rounded-sm border border-surface3 bg-transparent px-2 py-1 text-sm"
            aria-label="Branch"
            placeholder="Branch to merge into"
            value={branch}
            onChange={(event) => setBranch(event.target.value)}
          />
          <textarea
            className="mt-2 w-full rounded-sm border border-surface3 bg-transparent px-2 py-1 text-sm"
            rows={2}
            aria-label="Check commands"
            placeholder="Checks to run, one per line"
            value={checks}
            onChange={(event) => setChecks(event.target.value)}
          />
        </details>
        {error && <p className="mt-2 text-sm text-accent">{error}</p>}
      </div>
    </div>
  )
}

function resolveFactory(
  scope: string,
  mighty: MightyProject | undefined,
  factories: FactoryProject[]
): FactoryProject | undefined {
  if (scope === 'all') return undefined
  if (!mighty)
    return factories.find((project) => project.id === scope || project.mightyId === scope)
  return factories.find(
    (project) => project.mightyId === mighty.id || project.id === mighty.agentProjectId
  )
}

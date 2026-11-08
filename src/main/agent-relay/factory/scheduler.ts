import { join } from 'path'
import { COORDINATION } from '../../../shared/coordination'
import {
  FACTORY,
  factoryArea,
  type AcceptanceLine,
  type FactoryModels,
  type FactorySnapshot,
  type FactoryTranscript
} from '../../../shared/factory'
import { PATHS } from '../../store/paths'
import {
  confirmStopped,
  mergePull,
  pidAlive,
  readFactoryArtifact,
  readFactoryTranscript,
  readbackPull,
  reconcileDead,
  refreshTask,
  runAttempt,
  stopAttempt
} from './execution'
import { seedFactory, setupFactory, type SetupInput } from './planning'
import { pendingLaunches, planDispatch } from './transitions'
import { FactoryStore } from './store'

let store: FactoryStore | null = null
let timer: ReturnType<typeof setInterval> | null = null
let ticking = false
const inflight = new Set<string>()
let lastReadback = 0

export function getFactoryStore(): FactoryStore {
  if (!store) store = new FactoryStore(join(PATHS.ROOT, COORDINATION.database))
  return store
}

export function startFactoryCoordinator(): void {
  const db = getFactoryStore()
  if (timer) return
  for (const attempt of db.activeAttempts()) {
    if (attempt.role !== 'plan' || attempt.state !== 'started') continue
    db.interruptStarted(
      attempt.id,
      'The app restarted during the idea scan.'
    )
    stopAttempt(attempt)
  }
  void tick(db)
  timer = setInterval(() => void tick(db), FACTORY.pollMs)
}

export function factorySnapshot(): FactorySnapshot {
  return getFactoryStore().snapshot()
}

export async function factorySetup(input: SetupInput): Promise<FactorySnapshot> {
  const db = getFactoryStore()
  const project = await setupFactory(db, input)
  if (!project.setupBlockers.length && !db.tasks().some((task) => task.projectId === project.id)) {
    seedFactory(db, { projectId: project.id, source: 'audit' })
    void tick(db)
  }
  return factorySnapshot()
}

export function factorySeed(input: Parameters<typeof seedFactory>[1]): FactorySnapshot {
  const started = seedFactory(getFactoryStore(), input)
  if (started.started) void tick(getFactoryStore())
  return factorySnapshot()
}

export function factoryApprove(projectId: string, taskIds: string[]): FactorySnapshot {
  getFactoryStore().approve(projectId, taskIds)
  void tick(getFactoryStore())
  return factorySnapshot()
}

export function factoryPause(projectId: string | null, paused: boolean): FactorySnapshot {
  getFactoryStore().setPaused(projectId ? { projectId, paused } : { paused })
  if (!paused) void tick(getFactoryStore())
  return factorySnapshot()
}

export async function factoryCancel(taskId: string): Promise<FactorySnapshot> {
  const db = getFactoryStore()
  const live = db.activeAttempts().filter((attempt) => attempt.taskId === taskId)
  for (const attempt of live) {
    stopAttempt(attempt)
    const gone = await confirmStopped(attempt.pid)
    if (!gone) throw new Error('The worker is still running, so this task keeps its slot.')
  }
  db.cancel(taskId)
  return factorySnapshot()
}

export function factoryRestore(taskId: string): FactorySnapshot {
  getFactoryStore().restore(taskId)
  return factorySnapshot()
}

export function factoryPark(taskId: string, parked: boolean): FactorySnapshot {
  getFactoryStore().park(taskId, parked)
  if (!parked) void tick(getFactoryStore())
  return factorySnapshot()
}

export function factoryPriority(projectId: string, priority: number): FactorySnapshot {
  getFactoryStore().setPriority(projectId, Math.max(0, Math.min(5, priority)))
  return factorySnapshot()
}

export function factoryDraft(input: {
  action: 'edit' | 'reject' | 'split' | 'reorder'
  taskId: string
  title?: string
  outcome?: string
  acceptance?: AcceptanceLine[]
  scope?: string[]
  dependsOn?: string[]
  priority?: number
  area?: string
  kind?: string
}): FactorySnapshot {
  const db = getFactoryStore()
  if (input.action === 'reject') db.rejectDraft(input.taskId)
  else if (input.action === 'split') db.splitDraft(input.taskId)
  else if (input.action === 'reorder')
    db.updateDraft(input.taskId, { priority: input.priority ?? 0 })
  else {
    db.updateDraft(input.taskId, {
      title: input.title,
      outcome: input.outcome,
      acceptance: input.acceptance,
      scope: input.scope,
      dependsOn: input.dependsOn,
      area: input.area === undefined ? undefined : factoryArea(input.area),
      kind: input.kind
    })
  }
  return factorySnapshot()
}

export async function factoryRetry(
  taskId: string,
  note = '',
  rebuild = false
): Promise<FactorySnapshot> {
  const db = getFactoryStore()
  const task = db.task(taskId)
  if (!task) throw new Error('That task is not in the factory.')
  if (task.stage === 'ready' && task.blockReason === 'The target branch moved.') {
    await refreshTask(db, task)
    void tick(db)
    return factorySnapshot()
  }
  for (const attempt of db.activeAttempts()) {
    if (attempt.taskId !== taskId || inflight.has(attempt.id)) continue
    if (attempt.state === 'started' && attempt.pid > 0 && !pidAlive(attempt.pid))
      await reconcileDead(db, attempt)
  }
  db.retry(taskId, note, rebuild)
  void tick(db)
  return factorySnapshot()
}

export async function factoryReconcile(): Promise<FactorySnapshot> {
  const db = getFactoryStore()
  for (const attempt of db.activeAttempts()) {
    if (inflight.has(attempt.id)) continue
    if (attempt.state === 'started' && attempt.pid > 0 && !pidAlive(attempt.pid))
      await reconcileDead(db, attempt)
  }
  for (const task of db.tasks()) {
    if (task.stage === 'ready') await readbackPull(db, task)
  }
  void tick(db)
  return factorySnapshot()
}

export async function factoryMerge(taskId: string): Promise<FactorySnapshot> {
  const db = getFactoryStore()
  const task = db.task(taskId)
  if (!task) throw new Error('That task is not in the factory.')
  await mergePull(db, task)
  return factorySnapshot()
}

export function factoryTranscript(attemptId: string): FactoryTranscript {
  return readFactoryTranscript(getFactoryStore(), attemptId)
}

export function factoryArtifact(evidenceId: string): string {
  return readFactoryArtifact(getFactoryStore(), evidenceId)
}

export function factoryLimits(patch: {
  projectId?: string
  tasksAtOnce?: number
  globalSlots?: number
  repairs?: number
  stopAfter?: number | null
  models?: Partial<FactoryModels>
}): FactorySnapshot {
  getFactoryStore().setLimits(patch)
  return factorySnapshot()
}

async function tick(db: FactoryStore): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    for (const attempt of db.activeAttempts()) {
      if (attempt.state !== 'started' || inflight.has(attempt.id)) continue
      if (attempt.pid > 0 && !pidAlive(attempt.pid)) await reconcileDead(db, attempt)
      else if (attempt.timeoutAt > 0 && Date.now() >= attempt.timeoutAt) {
        const row = db.interruptStarted(attempt.id, 'The attempt timed out. Files were kept.')
        if (row) stopAttempt(row)
      }
    }
    if (Date.now() - lastReadback > 30_000) {
      lastReadback = Date.now()
      for (const task of db.tasks()) {
        if (task.stage === 'ready') await readbackPull(db, task)
      }
    }
    for (const action of planDispatch(db.schedView())) {
      if (action.kind === 'interrupt') {
        const row = db.interruptStarted(action.attemptId, 'The attempt timed out. Files were kept.')
        if (row) stopAttempt(row)
        continue
      }
      db.insertDispatch(action)
    }
    const view = db.schedView()
    for (const attempt of pendingLaunches(view)) {
      if (inflight.has(attempt.id)) continue
      inflight.add(attempt.id)
      void runAttempt(db, attempt).finally(() => inflight.delete(attempt.id))
    }
  } finally {
    ticking = false
  }
}

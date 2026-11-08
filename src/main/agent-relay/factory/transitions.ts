import {
  FACTORY,
  isAdmitted,
  roleForStage,
  stageForRole,
  type FactoryAttempt,
  type FactoryProject,
  type FactoryTask,
  type SchedAction,
  type SchedView
} from '../../../shared/factory'

function occupied(attempts: FactoryAttempt[]): number {
  return attempts.filter((attempt) => attempt.state !== 'finished').length
}

function busyTask(attempts: FactoryAttempt[]): Set<string> {
  return new Set(
    attempts
      .filter((attempt) => attempt.state !== 'finished' && attempt.taskId)
      .map((attempt) => attempt.taskId)
  )
}

function depsMerged(task: FactoryTask, tasks: FactoryTask[]): boolean {
  return task.dependsOn.every((id) =>
    tasks.some((item) => item.id === id && item.stage === 'merged')
  )
}

function nextGeneration(taskId: string, attempts: FactoryAttempt[]): number {
  const seen = attempts
    .filter((attempt) => attempt.taskId === taskId)
    .map((attempt) => attempt.generation)
  return (seen.length ? Math.max(...seen) : 0) + 1
}

const CONTINUE_RANK: Record<string, number> = {
  reviewing: 0,
  checking: 1,
  building: 2,
  preparing: 3
}

function projectRank(project: FactoryProject): number {
  return project.lastDispatchAt - project.priority * FACTORY.priorityHeadroomMs
}

function interrupts(view: SchedView): SchedAction[] {
  const actions: SchedAction[] = []
  for (const attempt of view.attempts) {
    if (attempt.state !== 'started' || attempt.timeoutAt <= 0 || view.now < attempt.timeoutAt)
      continue
    actions.push({
      kind: 'interrupt',
      attemptId: attempt.id,
      taskId: attempt.taskId,
      runId: attempt.runId,
      pid: attempt.pid
    })
  }
  return actions
}

function canContinue(task: FactoryTask, tasks: FactoryTask[]): boolean {
  if (task.parked || task.condition !== 'clear') return false
  if (task.oversized) return false
  const role = roleForStage(task.stage)
  if (!role || (role === 'prepare' && task.stage === 'queued')) return false
  if (task.stage === 'preparing' || task.stage === 'queued') return depsMerged(task, tasks)
  return true
}

export function planDispatch(view: SchedView): SchedAction[] {
  const actions = interrupts(view)
  const interrupted = new Set(
    actions.map((action) => (action.kind === 'interrupt' ? action.taskId : ''))
  )
  if (view.globalPaused || (view.stopAfter !== null && view.now >= view.stopAfter)) return actions

  let room = view.globalSlots - occupied(view.attempts)
  if (room <= 0) return actions
  const busy = busyTask(view.attempts)
  const projects = [...view.projects].sort(
    (a, b) => projectRank(a) - projectRank(b) || a.id.localeCompare(b.id)
  )
  const admitted = new Map(
    projects.map((project) => [
      project.id,
      view.tasks.filter((task) => task.projectId === project.id && isAdmitted(task)).length
    ])
  )

  const take = (task: FactoryTask, project: FactoryProject): boolean => {
    if (room <= 0 || busy.has(task.id) || interrupted.has(task.id)) return false
    const role = roleForStage(task.stage)
    if (!role) return false
    actions.push({
      kind: 'dispatch',
      taskId: task.id,
      projectId: project.id,
      role,
      stage: stageForRole(role, task.stage),
      generation: nextGeneration(task.id, view.attempts)
    })
    busy.add(task.id)
    room -= 1
    return true
  }

  for (const project of projects) {
    if (project.paused || project.setupBlockers.length > 0) continue
    const running = view.tasks
      .filter((task) => task.projectId === project.id && CONTINUE_RANK[task.stage] !== undefined)
      .filter((task) => canContinue(task, view.tasks))
      .sort(
        (a, b) =>
          (CONTINUE_RANK[a.stage] ?? 9) - (CONTINUE_RANK[b.stage] ?? 9) ||
          b.priority - a.priority ||
          a.createdAt - b.createdAt
      )
    for (const task of running) take(task, project)
  }

  for (const project of projects) {
    if (room <= 0) break
    if (project.paused || project.setupBlockers.length > 0) continue
    const ready = view.tasks.filter(
      (task) => task.projectId === project.id && task.stage === 'ready'
    ).length
    if (ready >= project.readyCap) continue
    if ((admitted.get(project.id) ?? 0) >= project.tasksAtOnce) continue
    const next = view.tasks
      .filter(
        (task) =>
          task.projectId === project.id &&
          task.stage === 'queued' &&
          task.condition === 'clear' &&
          !task.parked &&
          !task.oversized &&
          depsMerged(task, view.tasks)
      )
      .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt)[0]
    if (next && take(next, project)) admitted.set(project.id, (admitted.get(project.id) ?? 0) + 1)
  }

  return actions
}

export function pendingLaunches(view: SchedView): FactoryAttempt[] {
  if (view.globalPaused || (view.stopAfter !== null && view.now >= view.stopAfter)) return []
  let room =
    view.globalSlots - view.attempts.filter((attempt) => attempt.state === 'started').length
  if (room <= 0) return []
  const admitted = new Map(
    view.projects.map((project) => [
      project.id,
      view.tasks.filter((task) => task.projectId === project.id && isAdmitted(task)).length
    ])
  )
  const added = new Map<string, number>()
  const pending = view.attempts
    .filter((attempt) => attempt.state === 'pending')
    .sort((a, b) => a.generation - b.generation || a.id.localeCompare(b.id))
  const launches: FactoryAttempt[] = []
  for (const attempt of pending) {
    if (room <= 0) break
    const project = view.projects.find((item) => item.id === attempt.projectId)
    if (!project || project.paused || project.setupBlockers.length > 0) continue
    const task = attempt.taskId ? view.tasks.find((item) => item.id === attempt.taskId) : undefined
    if (attempt.role !== 'plan') {
      if (
        !task ||
        task.stage === 'draft' ||
        task.condition === 'canceled' ||
        task.condition === 'interrupted' ||
        task.parked
      ) {
        continue
      }
      const addsSeat = !isAdmitted(task)
      const seats = (admitted.get(project.id) ?? 0) + (added.get(project.id) ?? 0)
      if (addsSeat && seats >= project.tasksAtOnce) continue
      if (addsSeat) {
        const ready = view.tasks.filter(
          (item) => item.projectId === project.id && item.stage === 'ready'
        ).length
        if (ready >= project.readyCap) continue
        added.set(project.id, (added.get(project.id) ?? 0) + 1)
      }
    }
    launches.push(attempt)
    room -= 1
  }
  return launches
}

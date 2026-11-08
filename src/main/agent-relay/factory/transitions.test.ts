import { describe, expect, it } from 'vitest'
import {
  FACTORY,
  type FactoryAttempt,
  type FactoryProject,
  type FactoryTask,
  type SchedView
} from '../../../shared/factory'
import { pendingLaunches, planDispatch } from './transitions'

function project(partial: Partial<FactoryProject> = {}): FactoryProject {
  return {
    id: 'p1',
    mightyId: 'm1',
    name: 'Acme',
    repoRoot: '/repo',
    integrationRef: 'dev',
    workflowVersion: 1,
    backend: 'claude',
    checkCommands: ['make tc'],
    tasksAtOnce: FACTORY.tasksAtOnce,
    repairs: FACTORY.repairs,
    attemptMs: FACTORY.attemptMs,
    stallMs: FACTORY.stallMs,
    readyCap: FACTORY.readyCap,
    paused: false,
    priority: 0,
    lastDispatchAt: 0,
    setupBlockers: [],
    batchId: 'b1',
    updatedAt: 0,
    ...partial
  }
}

function task(partial: Partial<FactoryTask> = {}): FactoryTask {
  return {
    id: 't1',
    projectId: 'p1',
    title: 'Fix onboarding',
    outcome: 'A new user finishes setup',
    source: 'write',
    sourceDetail: '',
    acceptance: [{ text: 'Setup completes', command: '' }],
    scope: [],
    dependsOn: [],
    priority: 0,
    stage: 'queued',
    condition: 'clear',
    blockReason: '',
    nextAction: '',
    repairNote: '',
    branch: '',
    baseSha: '',
    commitSha: '',
    worktree: '',
    batchId: 'b1',
    repairsUsed: 0,
    workflowVersion: 1,
    parked: false,
    oversized: false,
    duplicateOf: '',
    prUrl: '',
    activity: '',
    approvedAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...partial
  }
}

function attempt(partial: Partial<FactoryAttempt> = {}): FactoryAttempt {
  return {
    id: 'a1',
    taskId: 't1',
    projectId: 'p1',
    role: 'build',
    generation: 1,
    dispatchKey: 't1:build:1',
    state: 'started',
    pid: 10,
    runId: 'run-1',
    runDir: '/tmp/run',
    timeoutAt: 0,
    brief: '',
    result: '',
    startedAt: 1,
    finishedAt: 0,
    ...partial
  }
}

function view(partial: Partial<SchedView> = {}): SchedView {
  return {
    now: 1_000,
    globalPaused: false,
    globalSlots: FACTORY.globalSlots,
    stopAfter: null,
    projects: [project()],
    tasks: [task()],
    attempts: [],
    ...partial
  }
}

describe('planDispatch', () => {
  it('admits one queued task and does not dispatch a second copy while that attempt is pending', () => {
    const first = planDispatch(view())
    expect(first).toEqual([
      expect.objectContaining({
        kind: 'dispatch',
        taskId: 't1',
        role: 'prepare',
        stage: 'preparing',
        generation: 1
      })
    ])
    const again = planDispatch(
      view({
        attempts: [
          attempt({ role: 'prepare', state: 'pending', dispatchKey: 't1:prepare:1', timeoutAt: 0 })
        ]
      })
    )
    expect(again.filter((action) => action.kind === 'dispatch')).toEqual([])
  })

  it('holds the project cap when a blocked task is still admitted', () => {
    const actions = planDispatch(
      view({
        tasks: [
          task({ id: 'blocked', stage: 'building', condition: 'blocked' }),
          task({ id: 'other', stage: 'building', condition: 'blocked', createdAt: 2 }),
          task({ id: 'waiting', createdAt: 3 })
        ]
      })
    )
    expect(actions).toEqual([])
  })

  it('starts a queued task after a blocked one is parked', () => {
    const actions = planDispatch(
      view({
        tasks: [
          task({ id: 'blocked', stage: 'building', condition: 'blocked', parked: true }),
          task({
            id: 'other',
            stage: 'checking',
            condition: 'blocked',
            parked: true,
            createdAt: 2
          }),
          task({ id: 'waiting', createdAt: 3 })
        ]
      })
    )
    expect(actions.map((action) => action.kind === 'dispatch' && action.taskId)).toEqual([
      'waiting'
    ])
  })

  it('does not start a task until its upstream task is merged', () => {
    const held = planDispatch(
      view({
        tasks: [
          task({ id: 'api', stage: 'ready' }),
          task({ id: 'ui', dependsOn: ['api'], createdAt: 2 })
        ]
      })
    )
    expect(held).toEqual([])
    const open = planDispatch(
      view({
        tasks: [
          task({ id: 'api', stage: 'merged' }),
          task({ id: 'ui', dependsOn: ['api'], createdAt: 2 })
        ]
      })
    )
    expect(open).toEqual([expect.objectContaining({ kind: 'dispatch', taskId: 'ui' })])
  })

  it('interrupts a timed-out attempt and does not launch a replacement', () => {
    const actions = planDispatch(
      view({
        tasks: [task({ id: 't1', stage: 'building' })],
        attempts: [attempt({ timeoutAt: 500 })]
      })
    )
    expect(actions.map((action) => action.kind)).toEqual(['interrupt'])
  })

  it('keeps checking a task that is already on the line when the ready queue is full', () => {
    const ready = Array.from({ length: FACTORY.readyCap }, (_, index) =>
      task({ id: `ready-${index}`, stage: 'ready', createdAt: index })
    )
    const actions = planDispatch(
      view({
        tasks: [
          ...ready,
          task({ id: 'checking', stage: 'checking', createdAt: 20 }),
          task({ id: 'queued', createdAt: 21 })
        ]
      })
    )
    expect(actions).toEqual([
      expect.objectContaining({ kind: 'dispatch', taskId: 'checking', role: 'check' })
    ])
  })

  it('does not start work on a paused project, and a global pause still interrupts', () => {
    expect(planDispatch(view({ projects: [project({ paused: true })] }))).toEqual([])
    const actions = planDispatch(
      view({
        globalPaused: true,
        tasks: [task({ stage: 'building' })],
        attempts: [attempt({ timeoutAt: 10 })]
      })
    )
    expect(actions.map((action) => action.kind)).toEqual(['interrupt'])
  })

  it('prefers the idle project once the priority head start has been used', () => {
    const now = 10 * FACTORY.priorityHeadroomMs
    const actions = planDispatch(
      view({
        now,
        globalSlots: 1,
        projects: [
          project({ id: 'hot', name: 'Hot', priority: 1, lastDispatchAt: now }),
          project({ id: 'cold', name: 'Cold', priority: 0, lastDispatchAt: 0 })
        ],
        tasks: [
          task({ id: 'hot-task', projectId: 'hot' }),
          task({ id: 'cold-task', projectId: 'cold' })
        ]
      })
    )
    expect(actions).toEqual([expect.objectContaining({ taskId: 'cold-task' })])
  })

  it('does not launch a pending attempt while paused or past the cutoff, then launches that same attempt once', () => {
    const pending = attempt({
      id: 'pending-1',
      role: 'prepare',
      state: 'pending',
      pid: 0,
      dispatchKey: 't1:prepare:1'
    })
    const held = view({ attempts: [pending], globalPaused: true })
    expect(pendingLaunches(held)).toEqual([])
    expect(planDispatch(held).filter((action) => action.kind === 'dispatch')).toEqual([])
    const cutoff = view({ attempts: [pending], stopAfter: 500 })
    expect(pendingLaunches(cutoff)).toEqual([])
    expect(
      pendingLaunches(view({ attempts: [pending], projects: [project({ paused: true })] }))
    ).toEqual([])
    const resumed = view({ attempts: [pending] })
    expect(pendingLaunches(resumed).map((item) => item.id)).toEqual(['pending-1'])
    expect(planDispatch(resumed).filter((action) => action.kind === 'dispatch')).toEqual([])
    expect(pendingLaunches(resumed).map((item) => item.id)).toEqual(['pending-1'])
  })

  it('does not launch a pending attempt for a draft', () => {
    expect(
      pendingLaunches(
        view({
          tasks: [task({ stage: 'draft' })],
          attempts: [attempt({ state: 'pending', pid: 0, role: 'prepare' })]
        })
      )
    ).toEqual([])
    expect(planDispatch(view({ tasks: [task({ stage: 'draft' })] }))).toEqual([])
  })

  it('gives the priority project the open slot when both have been waiting', () => {
    const actions = planDispatch(
      view({
        now: 1_000,
        globalSlots: 1,
        projects: [
          project({ id: 'hot', priority: 2, lastDispatchAt: 0 }),
          project({ id: 'cold', priority: 0, lastDispatchAt: 0 })
        ],
        tasks: [
          task({ id: 'hot-task', projectId: 'hot' }),
          task({ id: 'cold-task', projectId: 'cold' })
        ]
      })
    )
    expect(actions).toEqual([expect.objectContaining({ taskId: 'hot-task' })])
  })
})

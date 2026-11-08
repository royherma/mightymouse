import { spawn } from 'child_process'
import { describe, expect, it } from 'vitest'
import {
  FACTORY,
  deadWorkerReason,
  type FactoryProject,
  type FactoryTask
} from '../../../shared/factory'
import { confirmStopped, killPid } from './execution'
import { FactoryStore } from './store'
import { planDispatch } from './transitions'

function project(): FactoryProject {
  return {
    id: 'p1',
    mightyId: 'm1',
    name: 'Acme',
    repoRoot: '/repo',
    integrationRef: 'dev',
    workflowVersion: 1,
    backend: 'claude',
    checkCommands: ['make tc'],
    tasksAtOnce: 2,
    repairs: 1,
    attemptMs: FACTORY.attemptMs,
    stallMs: FACTORY.stallMs,
    readyCap: 5,
    paused: false,
    priority: 0,
    lastDispatchAt: 0,
    setupBlockers: [],
    batchId: '',
    updatedAt: 1
  }
}

function seed(db: FactoryStore, title: string, dependsOn: string[] = []): FactoryTask {
  return db.insertDrafts('p1', 'write', '', [
    {
      title,
      outcome: `${title} outcome`,
      acceptance: ['It works'],
      scope: [],
      dependsOn,
      sourceFile: '',
      area: 'engineering',
      oversized: false
    }
  ])[0]
}

describe('factory store', () => {
  it('rejects a missing dependency and a cycle, and accepts one that already exists', () => {
    const db = new FactoryStore(':memory:')
    db.saveProject(project())
    const api = seed(db, 'API change')
    db.approve('p1', [api.id])
    const missing = seed(db, 'Missing', ['not a task'])
    expect(() => db.approve('p1', [missing.id])).toThrow(/not in this factory/)
    const waiting = seed(db, 'UI', ['API change'])
    db.approve('p1', [waiting.id])
    expect(db.task(waiting.id)?.dependsOn).toEqual([api.id])
    const left = seed(db, 'Left', ['Right'])
    const right = seed(db, 'Right', ['Left'])
    expect(() => db.approve('p1', [left.id, right.id])).toThrow(/depend on each other/)
  })

  it('does not dispatch an unapproved draft', () => {
    const db = new FactoryStore(':memory:')
    db.saveProject(project())
    seed(db, 'Still a draft')
    expect(planDispatch(db.schedView()).filter((action) => action.kind === 'dispatch')).toEqual([])
  })

  it('keeps a dead worker interrupted when a commit exists, and cancel clears the slot', () => {
    const db = new FactoryStore(':memory:')
    db.saveProject(project())
    const task = seed(db, 'Build it')
    db.approve('p1', [task.id])
    const pending = db.insertDispatch({
      kind: 'dispatch',
      taskId: task.id,
      projectId: 'p1',
      role: 'build',
      stage: 'building',
      generation: 1
    })
    expect(pending).not.toBeNull()
    expect(db.markStarted(pending!.id, pending!.generation, Date.now() + 1000, 'run', '/tmp')).toBe(
      true
    )
    db.interruptStarted(pending!.id, deadWorkerReason('abc1234ffff', 'basebase'))
    const interrupted = db.task(task.id)
    expect(interrupted?.condition).toBe('interrupted')
    expect(interrupted?.stage).toBe('building')
    expect(interrupted?.blockReason).toContain('abc1234')
    expect(planDispatch(db.schedView()).filter((action) => action.kind === 'dispatch')).toEqual([])
    db.retry(task.id)
    const again = db.insertDispatch({
      kind: 'dispatch',
      taskId: task.id,
      projectId: 'p1',
      role: 'build',
      stage: 'building',
      generation: 2
    })
    db.markStarted(again!.id, again!.generation, Date.now() + 1000, 'run-2', '/tmp')
    db.cancel(task.id)
    expect(db.activeAttempts().some((attempt) => attempt.state === 'started')).toBe(false)
  })

  it('does not report a live process as stopped', async () => {
    const child = spawn('sleep', ['30'])
    try {
      expect(await confirmStopped(child.pid ?? 0, 80)).toBe(false)
      killPid(child.pid ?? 0)
      expect(await confirmStopped(child.pid ?? 0, 1000)).toBe(true)
    } finally {
      killPid(child.pid ?? 0)
    }
  })
})

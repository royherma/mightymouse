import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseClaudeJsonOutput } from '../../backend/parse'
import {
  FACTORY,
  interpretPull,
  parsePlanDrafts,
  type FactoryEvidence,
  type FactoryProject
} from '../../../shared/factory'
import { FactoryStore } from './store'
import { pendingLaunches, planDispatch } from './transitions'

const roots: string[] = []

function git(cwd: string, args: string[]): string {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
  )
  return execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim()
}

function repo(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `factory-${name}-`))
  roots.push(dir)
  git(dir, ['init', '-b', 'dev'])
  git(dir, ['config', 'user.email', 'factory@example.com'])
  git(dir, ['config', 'user.name', 'Factory'])
  writeFileSync(join(dir, 'README'), name)
  git(dir, ['add', '.'])
  git(dir, ['commit', '-m', 'init'])
  return dir
}

function project(id: string, root: string): FactoryProject {
  return {
    id,
    mightyId: id,
    name: id,
    repoRoot: root,
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

function evidence(taskId: string, attemptId: string, commitSha: string): FactoryEvidence {
  return {
    id: `${attemptId}-check`,
    taskId,
    attemptId,
    commitSha,
    criterion: '',
    command: 'make tc',
    cwd: '/tmp',
    exitCode: 0,
    artifactPath: '',
    artifactHash: 'hash',
    provenance: 'coordinator',
    stale: false,
    createdAt: 1
  }
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe('factory acceptance', () => {
  const cappedSlots = FACTORY.maxSlots
  beforeAll(() => {
    ;(FACTORY as { maxSlots: number }).maxSlots = FACTORY.globalSlots
  })
  afterAll(() => {
    ;(FACTORY as { maxSlots: number }).maxSlots = cappedSlots
  })

  it('runs two projects through checks, pause, repair, and a confirmed merge', () => {
    const one = repo('one')
    const two = repo('two')
    git(one, ['worktree', 'add', '-b', 'factory/a', join(one, 'a'), 'dev'])
    git(two, ['worktree', 'add', '-b', 'factory/b', join(two, 'b'), 'dev'])
    expect(git(join(one, 'a'), ['rev-parse', '--show-toplevel'])).not.toBe(
      git(join(two, 'b'), ['rev-parse', '--show-toplevel'])
    )

    const brief = [
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: '{"tasks":[{"title":"Ignore"}]}' }] }
      }),
      JSON.stringify({
        type: 'result',
        result:
          '{"tasks":[{"title":"From the brief","outcome":"The brief becomes one task","acceptance":["The brief is covered"],"scope":[],"dependsOn":[]}]}'
      })
    ].join('\n')
    const generatedDrafts = parsePlanDrafts(parseClaudeJsonOutput(brief) ?? '', 'brief')
    expect(generatedDrafts.drafts.map((draft) => draft.title)).toEqual(['From the brief'])

    const db = new FactoryStore(':memory:')
    db.saveProject(project('one', one))
    db.saveProject(project('two', two))
    const manual = db.insertDrafts('one', 'write', '', [
      {
        title: 'Manual one',
        outcome: 'First manual task',
        acceptance: ['First is done'],
        scope: [],
        dependsOn: [],
        sourceFile: '',
        area: 'engineering',
        oversized: false
      },
      {
        title: 'Manual two',
        outcome: 'Second manual task',
        acceptance: ['Second is done'],
        scope: [],
        dependsOn: [],
        sourceFile: '',
        area: 'engineering',
        oversized: false
      }
    ])
    const generated = db.insertDrafts('one', 'brief', 'goal', generatedDrafts.drafts)
    const other = db.insertDrafts('two', 'write', '', [
      {
        title: 'Other project',
        outcome: 'The other factory',
        acceptance: ['Other is done'],
        scope: [],
        dependsOn: [],
        sourceFile: '',
        area: 'engineering',
        oversized: false
      }
    ])
    db.approve('one', [manual[0].id, manual[1].id])
    db.approve('two', [other[0].id])
    expect(db.task(generated[0].id)?.stage).toBe('draft')

    const firstWave = planDispatch(db.schedView()).filter((action) => action.kind === 'dispatch')
    expect(firstWave.filter((action) => action.projectId === 'one')).toHaveLength(1)
    expect(firstWave.filter((action) => action.projectId === 'two')).toHaveLength(1)
    expect(firstWave.some((action) => action.taskId === generated[0].id)).toBe(false)
    const firstAction = firstWave.find((action) => action.projectId === 'one')!
    const first = db.insertDispatch(firstAction)!
    const secondWave = planDispatch(db.schedView()).filter((action) => action.kind === 'dispatch')
    const secondAction = secondWave.find((action) => action.projectId === 'one')!
    expect(secondAction.taskId).not.toBe(firstAction.taskId)
    const secondPending = db.insertDispatch(secondAction)!
    const extra = db.insertDrafts('one', 'write', '', [
      {
        title: 'Manual three',
        outcome: 'Should wait',
        acceptance: ['Third waits'],
        scope: [],
        dependsOn: [],
        sourceFile: '',
        area: 'engineering',
        oversized: false
      }
    ])
    db.approve('one', [extra[0].id])
    expect(
      planDispatch(db.schedView()).some(
        (action) => action.kind === 'dispatch' && action.taskId === extra[0].id
      )
    ).toBe(false)

    expect(pendingLaunches({ ...db.schedView(), globalPaused: true })).toEqual([])
    expect(pendingLaunches(db.schedView()).some((attempt) => attempt.id === first.id)).toBe(true)
    expect(
      planDispatch(db.schedView()).some(
        (action) => action.kind === 'dispatch' && action.taskId === manual[0].id
      )
    ).toBe(false)

    db.markStarted(first.id, first.generation, Date.now() + 1000, 'run', '/tmp')
    db.applyResult(first.id, first.generation, {
      kind: 'checked',
      commitSha: '',
      failures: ['make tc exited 2.']
    })
    expect(db.task(first.taskId)?.stage).toBe('building')
    expect(db.task(first.taskId)?.repairsUsed).toBe(1)
    const repair = db.insertDispatch({
      kind: 'dispatch',
      taskId: first.taskId,
      projectId: 'one',
      role: 'build',
      stage: 'building',
      generation: 2
    })!
    db.markStarted(repair.id, repair.generation, Date.now() + 1000, 'run-2', '/tmp')
    db.applyResult(repair.id, repair.generation, {
      kind: 'checked',
      commitSha: '',
      failures: ['make tc exited 2.']
    })
    expect(db.task(first.taskId)?.condition).toBe('blocked')

    const second = secondPending
    db.markStarted(second.id, second.generation, Date.now() + 1000, 'run-b', '/tmp')
    db.applyResult(second.id, second.generation, {
      kind: 'built',
      commitSha: 'abc1234',
      followups: []
    })
    const check = db.insertDispatch({
      kind: 'dispatch',
      taskId: second.taskId,
      projectId: 'one',
      role: 'check',
      stage: 'checking',
      generation: 2
    })!
    db.markStarted(check.id, check.generation, Date.now() + 1000, 'run-c', '/tmp')
    db.applyResult(
      check.id,
      check.generation,
      { kind: 'checked', commitSha: 'abc1234', failures: [] },
      [evidence(second.taskId, check.id, 'abc1234')]
    )
    expect(db.task(second.taskId)?.stage).toBe('reviewing')
    const review = db.insertDispatch({
      kind: 'dispatch',
      taskId: second.taskId,
      projectId: 'one',
      role: 'review',
      stage: 'reviewing',
      generation: 3
    })!
    db.markStarted(review.id, review.generation, Date.now() + 1000, 'run-r', '/tmp')
    db.applyResult(review.id, review.generation, {
      kind: 'opened',
      prUrl: 'https://example.com/pull/1'
    })
    expect(db.task(second.taskId)?.stage).toBe('ready')
    expect(interpretPull({ state: 'OPEN' }, 'devsha')).toBe('open')
    expect(db.task(second.taskId)?.stage).toBe('ready')
    expect(interpretPull({ state: 'MERGED' }, 'devsha')).toBe('merged')
    db.markMerged(second.taskId)
    expect(db.task(second.taskId)?.stage).toBe('merged')
  })
})

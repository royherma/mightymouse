import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { FactoryStore } from './store'
import { handleMaterials, materialContext, taskDirectory } from './materials'
import { FACTORY } from '../../../shared/factory'

const roots: string[] = []
const stores: FactoryStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture(): { root: string; store: FactoryStore; taskId: string } {
  const root = mkdtempSync(join(tmpdir(), 'factory-materials-'))
  roots.push(root)
  const store = new FactoryStore(join(root, 'factory.sqlite'))
  stores.push(store)
  store.saveProject({
    id: 'project',
    mightyId: 'mighty',
    name: 'Example',
    repoRoot: root,
    integrationRef: 'dev',
    workflowVersion: 1,
    backend: 'claude',
    checkCommands: ['true'],
    tasksAtOnce: 2,
    repairs: 2,
    attemptMs: FACTORY.attemptMs,
    stallMs: FACTORY.stallMs,
    readyCap: 5,
    paused: false,
    priority: 0,
    lastDispatchAt: 0,
    setupBlockers: [],
    batchId: '',
    updatedAt: Date.now()
  })
  const task = store.insertDrafts('project', 'write', '', [
    {
      title: 'Make reconnect work',
      outcome: 'Reconnect after Wi-Fi returns',
      acceptance: ['Reconnect works'],
      scope: [],
      dependsOn: [],
      sourceFile: '',
      area: 'engineering',
      oversized: false
    }
  ])[0]
  return { root, store, taskId: task.id }
}
const noOpen = async (): Promise<string> => ''

describe('persistent factory materials', () => {
  it('copies input bytes, survives reopening, and exposes references to the next build', async () => {
    const { root, store, taskId } = fixture()
    const original = join(root, 'original.md')
    writeFileSync(original, 'Reconnect after Wi-Fi returns')
    const result = await handleMaterials(
      store,
      root,
      {
        action: 'add',
        taskId,
        name: 'brief.md',
        data: readFileSync(original),
        origin: 'reference'
      },
      noOpen
    )
    rmSync(original)
    await handleMaterials(
      store,
      root,
      { action: 'note', taskId, text: 'Keep pairing intact' },
      noOpen
    )
    const reopened = new FactoryStore(join(root, 'factory.sqlite'))
    stores.push(reopened)
    const preview = await handleMaterials(
      reopened,
      root,
      { action: 'preview', taskId, fileId: result.files[0].id },
      noOpen
    )
    expect(preview.preview).toBe('Reconnect after Wi-Fi returns')
    expect(preview.notes[0].text).toBe('Keep pairing intact')
    expect(materialContext(reopened, root, taskId)).toContain('brief.md')
    expect(materialContext(reopened, root, taskId)).toContain('Keep pairing intact')
  })

  it('rejects executable types, false image signatures, missing tasks and changes to approved references', async () => {
    const { root, store, taskId } = fixture()
    const add = (name: string, id = taskId): Promise<unknown> =>
      handleMaterials(
        store,
        root,
        { action: 'add', taskId: id, name, data: Buffer.from('not an image'), origin: 'reference' },
        noOpen
      )
    await expect(add('script.html')).rejects.toThrow('Use a PNG')
    await expect(add('picture.png')).rejects.toThrow('contents do not match')
    await expect(add('brief.txt', 'missing')).rejects.toThrow('not in the factory')
    store.approve('project', [taskId])
    await expect(add('brief.txt')).rejects.toThrow('References are locked')
    expect(store.materials(taskId).files).toHaveLength(0)
  })

  it('discovers generated outputs without treating them as evidence and rejects symlink escapes', async () => {
    const { root, store, taskId } = fixture()
    const dir = taskDirectory(root, taskId)
    writeFileSync(join(dir, 'outputs', 'result.md'), 'Generated result')
    const listed = await handleMaterials(store, root, { action: 'list', taskId }, noOpen)
    expect(listed.files).toHaveLength(1)
    expect(listed.files[0].origin).toBe('output')
    expect(store.snapshot().evidence).toHaveLength(0)
    const external = join(root, 'external.txt')
    writeFileSync(external, 'outside')
    rmSync(join(dir, listed.files[0].path))
    symlinkSync(external, join(dir, listed.files[0].path))
    await expect(
      handleMaterials(
        store,
        root,
        { action: 'preview', taskId, fileId: listed.files[0].id },
        noOpen
      )
    ).rejects.toThrow('outside this task')
    const other = 'symlink-task'
    mkdirSync(join(root, 'elsewhere'))
    symlinkSync(join(root, 'elsewhere'), join(root, 'factory', 'tasks', other))
    expect(() => taskDirectory(root, other)).toThrow('symbolic links')
  })

  it('retains finished attempts in the UI snapshot', () => {
    const { store, taskId } = fixture()
    store.approve('project', [taskId])
    const attempt = store.insertDispatch({
      kind: 'dispatch',
      taskId,
      projectId: 'project',
      role: 'prepare',
      stage: 'preparing',
      generation: 1
    })!
    store.markStarted(attempt.id, attempt.generation, Date.now() + 1000, 'run', '/tmp')
    store.applyResult(attempt.id, attempt.generation, {
      kind: 'prepared',
      branch: 'factory/example',
      baseSha: 'base',
      worktree: '/tmp/example'
    })
    expect(store.snapshot().attempts.find((row) => row.id === attempt.id)?.state).toBe('finished')
  })
})

it('refreshes plain suggestions but preserves references added while planning', async () => {
  const { store, root } = fixture()
  const drafts = store.insertDrafts(
    'project',
    'audit',
    '',
    ['Plain idea', 'With reference'].map((title) => ({
      title,
      outcome: title,
      acceptance: ['Specific behavior'],
      scope: [],
      dependsOn: [],
      sourceFile: 'file.ts',
      area: 'engineering',
      oversized: false
    }))
  )
  const attempt = store.insertPlan(
    'project',
    JSON.stringify({
      source: 'audit',
      goal: 'Useful work',
      replaceDrafts: drafts.map((task) => ({ id: task.id, updatedAt: task.updatedAt }))
    })
  )
  store.markStarted(attempt.id, attempt.generation, Date.now() + 1000, 'plan', root)
  await handleMaterials(
    store,
    root,
    {
      action: 'add',
      taskId: drafts[1].id,
      origin: 'reference',
      name: 'brief.txt',
      data: Buffer.from('Keep this')
    },
    noOpen
  )
  store.applyResult(attempt.id, attempt.generation, {
    kind: 'planned',
    error: '',
    drafts: [
      {
        title: 'Better idea',
        outcome: 'Fix a confirmed problem',
        acceptance: ['Problem no longer occurs'],
        scope: [],
        dependsOn: [],
        sourceFile: 'file.ts',
        area: 'engineering',
        oversized: false
      }
    ]
  })
  expect(store.task(drafts[0].id)?.condition).toBe('canceled')
  expect(store.task(drafts[1].id)?.condition).toBe('clear')
  expect(
    store.tasks().filter((task) => task.source === 'audit' && task.condition === 'clear')
  ).toHaveLength(2)
})

it('deduplicates idea scans and exposes progress and interruption errors', () => {
  const { store, root } = fixture()
  const plan = store.insertPlan('project', JSON.stringify({ source: 'audit', goal: 'Useful work' }))
  expect(store.insertPlan('project', '{}').id).toBe(plan.id)
  store.markStarted(plan.id, plan.generation, Date.now() + FACTORY.planTimeoutMs, 'plan', root)
  store.noteActivity(plan.id, 'Choosing useful changes')
  expect(
    JSON.parse(store.snapshot().attempts.find((row) => row.id === plan.id)!.result).activity
  ).toBe('Choosing useful changes')
  store.interruptStarted(plan.id, 'The idea scan timed out. Try again.')
  expect(store.snapshot().planError).toContain('timed out')
  const next = store.insertPlan('project', '{}')
  expect(next.id).not.toBe(plan.id)
  expect(store.snapshot().planError).toBe('')
})

import { randomUUID } from 'crypto'
import {
  FACTORY,
  type DraftSeed,
  type FactoryProject,
  type FactorySource
} from '../../../shared/factory'
import { inferChecks, probeRepo } from './execution'
import type { FactoryStore } from './store'

export interface SetupInput {
  mightyId: string
  name: string
  repoRoot: string
  integrationRef?: string
  checkCommands?: string[]
  projectId?: string
}

export async function setupFactory(
  store: FactoryStore,
  input: SetupInput
): Promise<FactoryProject> {
  const repoRoot = input.repoRoot.trim()
  const probe = await probeRepo(repoRoot, (input.integrationRef ?? '').trim())
  const checks = (input.checkCommands ?? []).map((line) => line.trim()).filter(Boolean)
  const checkCommands = checks.length ? checks : inferChecks(repoRoot)
  const blockers = [...probe.blockers]
  if (!checkCommands.length)
    blockers.push('Say how to test this project, so a finished task can prove it works.')
  const existing = input.projectId
    ? store.project(input.projectId)
    : store.projects().find((project) => project.repoRoot === repoRoot)
  const project: FactoryProject = {
    id: existing?.id ?? input.projectId ?? randomUUID(),
    mightyId: input.mightyId,
    name: input.name.trim() || existing?.name || 'Project',
    repoRoot,
    integrationRef: probe.ref || existing?.integrationRef || '',
    workflowVersion: FACTORY.workflowVersion,
    backend: 'claude',
    checkCommands,
    tasksAtOnce: existing?.tasksAtOnce ?? FACTORY.tasksAtOnce,
    repairs: existing?.repairs ?? FACTORY.repairs,
    attemptMs: existing?.attemptMs ?? FACTORY.attemptMs,
    stallMs: existing?.stallMs ?? FACTORY.stallMs,
    readyCap: existing?.readyCap ?? FACTORY.readyCap,
    paused: existing?.paused ?? false,
    priority: existing?.priority ?? 0,
    lastDispatchAt: existing?.lastDispatchAt ?? 0,
    setupBlockers: blockers,
    batchId: existing?.batchId ?? '',
    updatedAt: Date.now()
  }
  return store.saveProject(project)
}

export function seedFactory(
  store: FactoryStore,
  input: {
    projectId: string
    source: Extract<FactorySource, 'write' | 'brief' | 'audit'>
    goal?: string
    text?: string
    paths?: string[]
    drafts?: DraftSeed[]
  }
): { started: boolean } {
  const project = store.project(input.projectId)
  if (!project) throw new Error('Start the factory for this project first.')
  if (project.setupBlockers.length) throw new Error(project.setupBlockers[0])
  if (input.source === 'write') {
    const drafts = (input.drafts ?? []).filter(
      (draft) => draft.title.trim() && draft.outcome.trim()
    )
    if (!drafts.length) throw new Error('Write a task first.')
    store.insertDrafts(project.id, 'write', '', drafts)
    return { started: false }
  }
  const goal = (input.goal ?? '').trim() || (input.source === 'audit' ? FACTORY.suggestionGoal : '')
  if (!goal) throw new Error('Say what you want found.')
  store.insertPlan(
    project.id,
    JSON.stringify({
      source: input.source,
      goal,
      text: input.text ?? '',
      paths: input.paths ?? [],
      replaceDrafts:
        input.source === 'audit'
          ? store
              .tasks()
              .filter(
                (task) =>
                  task.projectId === project.id &&
                  task.source === 'audit' &&
                  task.stage === 'draft' &&
                  task.condition === 'clear'
              )
              .map((task) => ({ id: task.id, updatedAt: task.updatedAt }))
          : []
    })
  )
  return { started: true }
}

import { ipcMain, shell } from 'electron'
import { PATHS } from '../store/paths'
import { handleMaterials } from '../agent-relay/factory/materials'
import type { FactoryMaterialRequest } from '../../shared/factory'
import { CHANNELS } from '../../shared/ipc'
import {
  FACTORY_MODEL_CHOICES,
  FACTORY_MODEL_STATIONS,
  factoryArea,
  type AcceptanceLine,
  type DraftSeed,
  type FactoryModels
} from '../../shared/factory'
import type { SetupInput } from '../agent-relay/factory/planning'
import {
  getFactoryStore,
  factoryArtifact,
  factoryApprove,
  factoryCancel,
  factoryDraft,
  factoryLimits,
  factoryMerge,
  factoryPark,
  factoryPause,
  factoryPriority,
  factoryReconcile,
  factoryRestore,
  factoryRetry,
  factorySeed,
  factorySetup,
  factorySnapshot,
  factoryTranscript
} from '../agent-relay/factory/scheduler'
import { factoryCodeSize } from '../agent-relay/factory/code-size'

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message)
  return value as Record<string, unknown>
}

function requiredText(value: unknown, message: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(message)
  return value
}

function optionalText(value: unknown, message: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(message)
  return value
}

function optionalId(value: unknown, message: string): string | undefined {
  if (value === undefined) return undefined
  return requiredText(value, message)
}

function texts(value: unknown, message: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(message)
  }
  return value
}

function acceptanceLines(value: unknown, message: string): AcceptanceLine[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error(message)
  return value.flatMap((item) => {
    if (typeof item === 'string') {
      const text = item.trim()
      return text ? [{ text, command: '' }] : []
    }
    const row = record(item, message)
    const text = requiredText(row.text, message)
    if (row.command !== undefined && typeof row.command !== 'string') throw new Error(message)
    const command = typeof row.command === 'string' ? row.command.trim() : ''
    return [{ text, command }]
  })
}

function optionalTexts(value: unknown, message: string): string[] | undefined {
  if (value === undefined) return undefined
  return texts(value, message)
}

function flag(value: unknown, message: string): boolean {
  if (typeof value !== 'boolean') throw new Error(message)
  return value
}

function count(value: unknown, message: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(message)
  return value
}

function optionalCount(value: unknown, message: string): number | undefined {
  if (value === undefined) return undefined
  return count(value, message)
}

function stopAfterOf(value: unknown): number | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  return count(value, 'Choose when the factory should stop.')
}

function modelsOf(value: unknown): Partial<FactoryModels> | undefined {
  if (value === undefined) return undefined
  const input = record(value, 'Choose a model for each station.')
  const models: Partial<FactoryModels> = {}
  for (const station of FACTORY_MODEL_STATIONS) {
    const tier = input[station]
    if (tier === undefined) continue
    const choice = FACTORY_MODEL_CHOICES.find((item) => item === tier)
    if (!choice) throw new Error('Choose a model from the list.')
    models[station] = choice
  }
  return models
}

function seedSource(value: unknown): 'write' | 'brief' | 'audit' {
  if (value === 'write' || value === 'brief' || value === 'audit') return value
  throw new Error('Choose how to add the tasks.')
}

function draftAction(value: unknown): 'edit' | 'reject' | 'split' | 'reorder' {
  if (value === 'edit' || value === 'reject' || value === 'split' || value === 'reorder') {
    return value
  }
  throw new Error('Choose what to do with this draft.')
}

function draftSeed(value: unknown): DraftSeed {
  const item = record(value, 'Write each task with a title and what done looks like.')
  if (typeof item.sourceFile !== 'string') {
    throw new Error('Write each task with a title and what done looks like.')
  }
  return {
    title: requiredText(item.title, 'Write each task with a title and what done looks like.'),
    outcome: requiredText(item.outcome, 'Write each task with a title and what done looks like.'),
    acceptance: texts(item.acceptance, 'Write each task with a title and what done looks like.'),
    scope: texts(item.scope, 'Write each task with a title and what done looks like.'),
    dependsOn: texts(item.dependsOn, 'Write each task with a title and what done looks like.'),
    sourceFile: item.sourceFile,
    oversized: flag(item.oversized, 'Write each task with a title and what done looks like.'),
    area: factoryArea(item.area)
  }
}

function setupInput(value: unknown): SetupInput {
  const body = record(value, 'Name the project and choose its folder.')
  return {
    mightyId: requiredText(body.mightyId, 'Pick the project first.'),
    name: requiredText(body.name, 'Name the project.'),
    repoRoot: requiredText(body.repoRoot, 'Choose the project folder.'),
    integrationRef: optionalText(body.integrationRef, 'Name the branch to land on.'),
    checkCommands: optionalTexts(body.checkCommands, 'List the commands that prove a task works.'),
    projectId: optionalId(body.projectId, 'That project is not in the factory.')
  }
}

export function registerFactoryHandlers(): void {
  ipcMain.handle(CHANNELS.factoryMaterials, (_e, request: FactoryMaterialRequest) =>
    handleMaterials(getFactoryStore(), PATHS.ROOT, request, shell.openPath)
  )
  ipcMain.handle(CHANNELS.factoryGet, () => factorySnapshot())

  ipcMain.handle(CHANNELS.factorySetup, (_e, body: unknown) => factorySetup(setupInput(body)))

  ipcMain.handle(CHANNELS.factorySeed, (_e, body: unknown) => {
    const input = record(body, 'Choose a project and how to add the tasks.')
    const drafts = input.drafts
    if (drafts !== undefined && !Array.isArray(drafts))
      throw new Error('Write the tasks as a list.')
    return factorySeed({
      projectId: requiredText(input.projectId, 'Choose a project to add tasks to.'),
      source: seedSource(input.source),
      goal: optionalText(input.goal, 'Say what you want found.'),
      text: optionalText(input.text, 'Paste the brief first.'),
      paths: optionalTexts(input.paths, 'Choose the folders to read.'),
      drafts: drafts === undefined ? undefined : drafts.map(draftSeed)
    })
  })

  ipcMain.handle(CHANNELS.factoryApprove, (_e, body: unknown) => {
    const input = record(body, 'Choose the tasks to approve.')
    return factoryApprove(
      requiredText(input.projectId, 'Choose a project to approve.'),
      texts(input.taskIds, 'Choose the tasks to approve.')
    )
  })

  ipcMain.handle(CHANNELS.factoryPause, (_e, body: unknown) => {
    const input = record(body, 'Choose whether the factory is paused.')
    if (
      input.projectId !== null &&
      (typeof input.projectId !== 'string' || !input.projectId.trim())
    ) {
      throw new Error('Choose a project, or pause every project.')
    }
    return factoryPause(
      input.projectId,
      flag(input.paused, 'Choose whether the factory is paused.')
    )
  })

  ipcMain.handle(CHANNELS.factoryCancel, (_e, taskId: unknown) =>
    factoryCancel(requiredText(taskId, 'Choose a task to cancel.'))
  )

  ipcMain.handle(CHANNELS.factoryRestore, (_e, taskId: unknown) =>
    factoryRestore(requiredText(taskId, 'Choose a task to restore.'))
  )

  ipcMain.handle(CHANNELS.factoryPark, (_e, body: unknown) => {
    const input = record(body, 'Choose a task to park.')
    return factoryPark(
      requiredText(input.taskId, 'Choose a task to park.'),
      flag(input.parked, 'Choose whether this task is parked.')
    )
  })

  ipcMain.handle(CHANNELS.factoryPriority, (_e, body: unknown) => {
    const input = record(body, 'Choose how soon this project runs.')
    return factoryPriority(
      requiredText(input.projectId, 'Choose a project to move.'),
      count(input.priority, 'Choose how soon this project runs.')
    )
  })

  ipcMain.handle(CHANNELS.factoryDraft, (_e, body: unknown) => {
    const input = record(body, 'Choose what to do with this draft.')
    return factoryDraft({
      action: draftAction(input.action),
      taskId: requiredText(input.taskId, 'Choose a draft.'),
      title: optionalText(input.title, 'Name the task.'),
      outcome: optionalText(input.outcome, 'Say what done looks like.'),
      acceptance: acceptanceLines(input.acceptance, 'List what the task has to prove.'),
      scope: optionalTexts(input.scope, 'List the files this task may touch.'),
      dependsOn: optionalTexts(input.dependsOn, 'List the tasks this one waits on.'),
      priority: optionalCount(input.priority, 'Choose how soon this task runs.'),
      area: optionalText(input.area, 'Pick an area.'),
      kind: optionalText(input.kind, 'Pick a kind.')
    })
  })

  ipcMain.handle(CHANNELS.factoryRetry, async (_e, taskId: unknown, options: unknown) => {
    const input = options === undefined ? {} : record(options, 'Choose how to try again.')
    return factoryRetry(
      requiredText(taskId, 'Choose a task to try again.'),
      optionalText(input.note, 'Write the note as text.') ?? '',
      input.rebuild === undefined ? false : flag(input.rebuild, 'Choose where it starts again.')
    )
  })

  ipcMain.handle(CHANNELS.factoryReconcile, async () => factoryReconcile())

  ipcMain.handle(CHANNELS.factoryMerge, async (_e, taskId: unknown) =>
    factoryMerge(requiredText(taskId, 'Choose a task to merge.'))
  )

  ipcMain.handle(CHANNELS.factoryTranscript, (_e, attemptId: unknown, reveal: unknown) => {
    const transcript = factoryTranscript(requiredText(attemptId, 'Choose a run to read.'))
    if (reveal === true && transcript.file) shell.showItemInFolder(transcript.file)
    return transcript
  })

  ipcMain.handle(CHANNELS.factoryArtifact, (_e, evidenceId: unknown) =>
    factoryArtifact(requiredText(evidenceId, 'Choose a check log to open.'))
  )

  ipcMain.handle(CHANNELS.factoryLimits, (_e, body: unknown) => {
    const input = record(body, 'Choose how many tasks can run.')
    return factoryLimits({
      projectId: optionalId(input.projectId, 'Choose a project.'),
      tasksAtOnce: optionalCount(
        input.tasksAtOnce,
        'Choose how many tasks this project runs at once.'
      ),
      globalSlots: optionalCount(input.globalSlots, 'Choose how many tasks can run at once.'),
      repairs: optionalCount(input.repairs, 'Choose how many repairs a task gets.'),
      stopAfter: stopAfterOf(input.stopAfter),
      models: modelsOf(input.models)
    })
  })

  ipcMain.handle(CHANNELS.factoryCodeSize, (_e, projectId: unknown) => {
    const project = getFactoryStore().project(requiredText(projectId, 'Choose a project.'))
    if (!project) throw new Error('That project is not in the factory.')
    return factoryCodeSize(project.repoRoot, project.integrationRef)
  })
}

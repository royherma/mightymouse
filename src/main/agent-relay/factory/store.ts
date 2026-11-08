import { randomUUID } from 'crypto'
import { chmodSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import Database from 'better-sqlite3'
import { COORDINATION } from '../../../shared/coordination'
import {
  FACTORY,
  FACTORY_EVENT,
  acceptanceTexts,
  bindDependencies,
  FACTORY_MODEL_CHOICES,
  FACTORY_MODEL_DEFAULTS,
  FACTORY_MODEL_STATIONS,
  factoryArea,
  factoryKind,
  isAdmitted,
  readAcceptance,
  normalizeTitle,
  type DispatchAction,
  type DraftSeed,
  type FactoryAttempt,
  type FactoryRunAudit,
  type FactoryAuditEvent,
  type FactoryBlocker,
  type FactoryCondition,
  type FactoryEvidence,
  type FactoryModels,
  type FactoryProject,
  type FactorySnapshot,
  type FactorySource,
  type FactoryStage,
  type FactoryTask,
  type FactoryMaterials,
  type SchedView,
  type StageResult
} from '../../../shared/factory'

type TaskPatch = Partial<FactoryTask>

function json(value: unknown): string {
  return JSON.stringify(value)
}

function strings(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    return []
  }
}

export class FactoryStore {
  private db: Database.Database

  constructor(
    path: string,
    private now: () => number = Date.now
  ) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    }
    this.db = new Database(path)
    this.db.pragma(`busy_timeout = ${COORDINATION.busyTimeoutMs}`)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = FULL')
    this.db.pragma('foreign_keys = ON')
    if (path !== ':memory:') chmodSync(path, 0o600)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS factory_meta (
        key TEXT PRIMARY KEY, value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS factory_projects (
        id TEXT PRIMARY KEY, mightyId TEXT NOT NULL, name TEXT NOT NULL, repoRoot TEXT NOT NULL,
        integrationRef TEXT NOT NULL, workflowVersion INTEGER NOT NULL, backend TEXT NOT NULL,
        checkCommands TEXT NOT NULL, tasksAtOnce INTEGER NOT NULL, repairs INTEGER NOT NULL,
        attemptMs INTEGER NOT NULL, stallMs INTEGER NOT NULL, readyCap INTEGER NOT NULL,
        paused INTEGER NOT NULL, priority INTEGER NOT NULL, lastDispatchAt INTEGER NOT NULL,
        setupBlockers TEXT NOT NULL, batchId TEXT NOT NULL, updatedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS factory_tasks (
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL, title TEXT NOT NULL, outcome TEXT NOT NULL,
        source TEXT NOT NULL, sourceDetail TEXT NOT NULL, acceptance TEXT NOT NULL, scope TEXT NOT NULL,
        dependsOn TEXT NOT NULL, priority INTEGER NOT NULL, stage TEXT NOT NULL, condition TEXT NOT NULL,
        blockReason TEXT NOT NULL, nextAction TEXT NOT NULL, repairNote TEXT NOT NULL, branch TEXT NOT NULL,
        baseSha TEXT NOT NULL, commitSha TEXT NOT NULL, worktree TEXT NOT NULL, batchId TEXT NOT NULL,
        repairsUsed INTEGER NOT NULL, workflowVersion INTEGER NOT NULL, parked INTEGER NOT NULL,
        oversized INTEGER NOT NULL, duplicateOf TEXT NOT NULL, prUrl TEXT NOT NULL, activity TEXT NOT NULL,
        approvedAt INTEGER NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
        area TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS factory_tasks_project ON factory_tasks(projectId, stage);
      CREATE TABLE IF NOT EXISTS factory_attempts (
        id TEXT PRIMARY KEY, taskId TEXT NOT NULL, projectId TEXT NOT NULL, role TEXT NOT NULL,
        generation INTEGER NOT NULL, dispatchKey TEXT NOT NULL UNIQUE, state TEXT NOT NULL,
        pid INTEGER NOT NULL, runId TEXT NOT NULL, runDir TEXT NOT NULL, timeoutAt INTEGER NOT NULL,
        brief TEXT NOT NULL, result TEXT NOT NULL, startedAt INTEGER NOT NULL, finishedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS factory_evidence (
        id TEXT PRIMARY KEY, taskId TEXT NOT NULL, attemptId TEXT NOT NULL, commitSha TEXT NOT NULL,
        criterion TEXT NOT NULL, command TEXT NOT NULL, cwd TEXT NOT NULL, exitCode INTEGER NOT NULL,
        artifactPath TEXT NOT NULL, artifactHash TEXT NOT NULL, provenance TEXT NOT NULL,
        stale INTEGER NOT NULL, createdAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS factory_evidence_task ON factory_evidence(taskId, createdAt);
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, actor TEXT NOT NULL,
        kind TEXT NOT NULL, target TEXT NOT NULL, at INTEGER NOT NULL, detail TEXT NOT NULL
      );
    `)
    const taskColumns = this.db.pragma('table_info(factory_tasks)') as { name: string }[]
    if (!taskColumns.some((column) => column.name === 'area'))
      this.db.exec(`ALTER TABLE factory_tasks ADD COLUMN area TEXT NOT NULL DEFAULT '';
        ALTER TABLE factory_tasks ADD COLUMN kind TEXT NOT NULL DEFAULT '';`)
    this.setMeta('schemaVersion', String(this.meta('schemaVersion', String(FACTORY.schemaVersion))))
    if (!this.meta('globalSlots', '')) this.setMeta('globalSlots', String(FACTORY.globalSlots))
    if (!this.meta('globalPaused', '')) this.setMeta('globalPaused', '0')
  }

  close(): void {
    this.db.close()
  }

  snapshot(): FactorySnapshot {
    const projects = this.projects()
    const names = new Map(projects.map((project) => [project.id, project.name]))
    const tasks = this.tasks()
    const blockers: FactoryBlocker[] = tasks
      .filter(
        (task) => !task.parked && (task.condition === 'blocked' || task.condition === 'interrupted')
      )
      .map((task) => ({
        taskId: task.id,
        projectId: task.projectId,
        projectName: names.get(task.projectId) ?? task.projectId,
        title: task.title,
        question: task.blockReason || task.repairNote || 'This task stopped.',
        nextAction: task.nextAction || 'Open the task and choose what happens next.'
      }))
    return {
      auditEvents: this.db
        .prepare('SELECT seq, target, kind, at, detail FROM events WHERE actor=? ORDER BY seq')
        .all(FACTORY.actor) as FactoryAuditEvent[],
      generatedAt: this.now(),
      globalPaused: this.meta('globalPaused', '0') === '1',
      globalSlots: this.slots(),
      stopAfter: this.stopAfter(),
      models: this.models(),
      projects,
      tasks,
      attempts: this.attempts(),
      evidence: this.evidence(),
      blockers,
      planError: this.meta('planError', '')
    }
  }

  schedView(): SchedView {
    const snap = this.snapshot()
    return {
      now: snap.generatedAt,
      globalPaused: snap.globalPaused,
      globalSlots: snap.globalSlots,
      stopAfter: snap.stopAfter,
      projects: snap.projects,
      tasks: snap.tasks,
      attempts: this.attempts()
    }
  }

  saveProject(project: FactoryProject): FactoryProject {
    this.db
      .prepare(
        `INSERT INTO factory_projects (
          id, mightyId, name, repoRoot, integrationRef, workflowVersion, backend, checkCommands,
          tasksAtOnce, repairs, attemptMs, stallMs, readyCap, paused, priority, lastDispatchAt,
          setupBlockers, batchId, updatedAt
        ) VALUES (
          @id, @mightyId, @name, @repoRoot, @integrationRef, @workflowVersion, @backend, @checkCommands,
          @tasksAtOnce, @repairs, @attemptMs, @stallMs, @readyCap, @paused, @priority, @lastDispatchAt,
          @setupBlockers, @batchId, @updatedAt
        )
        ON CONFLICT(id) DO UPDATE SET
          mightyId=excluded.mightyId, name=excluded.name, repoRoot=excluded.repoRoot,
          integrationRef=excluded.integrationRef, checkCommands=excluded.checkCommands,
          tasksAtOnce=excluded.tasksAtOnce, repairs=excluded.repairs, attemptMs=excluded.attemptMs,
          stallMs=excluded.stallMs, readyCap=excluded.readyCap, setupBlockers=excluded.setupBlockers,
          updatedAt=excluded.updatedAt`
      )
      .run({
        ...project,
        paused: project.paused ? 1 : 0,
        checkCommands: json(project.checkCommands),
        setupBlockers: json(project.setupBlockers)
      })
    this.event(project.id, FACTORY_EVENT.setup, project.id, { name: project.name })
    return this.project(project.id)!
  }

  insertDrafts(
    projectId: string,
    source: FactorySource,
    sourceDetail: string,
    drafts: DraftSeed[]
  ): FactoryTask[] {
    const existing = this.tasks().filter(
      (task) => task.projectId === projectId && task.condition !== 'canceled'
    )
    const created = this.db.transaction(() => {
      const rows: FactoryTask[] = []
      drafts.forEach((draft, index) => {
        const titleKey = normalizeTitle(draft.title)
        const prior = existing.find((task) => normalizeTitle(task.title) === titleKey)
        if (prior?.stage === 'merged' || (source === 'audit' && prior)) return
        if (
          source === 'audit' &&
          existing.filter((task) => task.source === 'audit' && task.stage === 'draft').length +
            rows.length >=
            FACTORY.maxDrafts
        )
          return
        const id = randomUUID()
        const row = this.blankTask({
          id,
          projectId,
          title: draft.title,
          outcome: draft.outcome,
          source,
          sourceDetail: draft.sourceFile || sourceDetail,
          area: draft.area ?? '',
          kind: draft.kind ?? '',
          acceptance: draft.acceptance.map((text) => ({ text, command: '' })),
          scope: draft.scope,
          dependsOn: draft.dependsOn,
          priority: existing.length + index,
          oversized: draft.oversized,
          duplicateOf: prior ? prior.title : ''
        })
        this.insertTask(row)
        rows.push(row)
      })
      return rows
    })()
    return created
  }

  updateDraft(
    taskId: string,
    patch: Pick<
      TaskPatch,
      'title' | 'outcome' | 'acceptance' | 'scope' | 'dependsOn' | 'priority' | 'area' | 'kind'
    >
  ): FactoryTask {
    const task = this.requireTask(taskId)
    if (task.stage !== 'draft')
      throw new Error('Approved work stays as approved. Add a new task to change it.')
    const next: TaskPatch = {}
    if (patch.title !== undefined) next.title = patch.title
    if (patch.outcome !== undefined) next.outcome = patch.outcome
    if (patch.acceptance !== undefined) next.acceptance = patch.acceptance
    if (patch.scope !== undefined) next.scope = patch.scope
    if (patch.dependsOn !== undefined) next.dependsOn = patch.dependsOn
    if (patch.priority !== undefined) next.priority = patch.priority
    if (patch.area !== undefined || patch.kind !== undefined) {
      next.area = factoryArea(patch.area ?? task.area)
      next.kind = factoryKind(next.area, patch.kind ?? task.kind)
    }
    next.oversized = (next.acceptance ?? task.acceptance).length > FACTORY.maxAcceptance
    this.patchTask(taskId, next)
    return this.requireTask(taskId)
  }

  rejectDraft(taskId: string): void {
    const task = this.requireTask(taskId)
    if (task.stage !== 'draft') throw new Error('Only a draft can be rejected.')
    this.db.prepare('DELETE FROM factory_tasks WHERE id=?').run(taskId)
  }

  splitDraft(taskId: string): FactoryTask[] {
    const task = this.requireTask(taskId)
    if (task.stage !== 'draft') throw new Error('Only a draft can be split.')
    return this.db.transaction(() => {
      this.db.prepare('DELETE FROM factory_tasks WHERE id=?').run(taskId)
      const midpoint = Math.ceil(task.acceptance.length / 2)
      const first = task.acceptance.slice(0, midpoint)
      const second = task.acceptance.slice(midpoint)
      return this.insertDrafts(task.projectId, task.source, task.sourceDetail, [
        {
          title: `${task.title} (part 1)`,
          outcome: task.outcome,
          acceptance: acceptanceTexts(first.length ? first : task.acceptance),
          scope: task.scope,
          dependsOn: [],
          sourceFile: task.sourceDetail,
          oversized: false,
          area: task.area,
          kind: task.kind
        },
        {
          title: `${task.title} (part 2)`,
          outcome: task.outcome,
          acceptance: acceptanceTexts(
            second.length ? second : [{ text: 'Finish the rest of the outcome', command: '' }]
          ),
          scope: task.scope,
          dependsOn: [],
          sourceFile: task.sourceDetail,
          oversized: false,
          area: task.area,
          kind: task.kind
        }
      ])
    })()
  }

  approve(projectId: string, taskIds: string[]): FactoryTask[] {
    const project = this.project(projectId)
    if (!project) throw new Error('Start the factory for this project first.')
    if (project.setupBlockers.length) throw new Error(project.setupBlockers[0])
    const chosen = taskIds.map((id) => this.requireTask(id))
    if (chosen.some((task) => task.projectId !== projectId || task.stage !== 'draft')) {
      throw new Error('Approve drafts from this project.')
    }
    if (chosen.some((task) => task.oversized || task.acceptance.length === 0)) {
      throw new Error('Split the oversized task before it can run.')
    }
    const untagged = chosen.find((task) => !task.area)
    if (untagged) throw new Error(`Pick an area for "${untagged.title}" before it runs.`)
    const batchId = randomUUID()
    const existing = this.tasks().filter(
      (task) =>
        task.projectId === projectId &&
        task.condition !== 'canceled' &&
        !chosen.some((item) => item.id === task.id)
    )
    const linked = bindDependencies(
      chosen.map((task) => ({ id: task.id, title: task.title, dependsOn: task.dependsOn })),
      existing.map((task) => ({ id: task.id, title: task.title, dependsOn: task.dependsOn }))
    )
    this.db.transaction(() => {
      const at = this.now()
      for (const task of linked) {
        this.db
          .prepare(
            `UPDATE factory_tasks
             SET stage='queued', dependsOn=?, batchId=?, workflowVersion=?, approvedAt=?, updatedAt=?, oversized=0
             WHERE id=?`
          )
          .run(json(task.dependsOn), batchId, project.workflowVersion, at, at, task.id)
      }
      this.db
        .prepare('UPDATE factory_projects SET batchId=?, updatedAt=? WHERE id=?')
        .run(batchId, at, projectId)
      this.event(projectId, FACTORY_EVENT.approved, batchId, { tasks: taskIds.length })
    })()
    return taskIds.map((id) => this.requireTask(id))
  }

  setPaused(scope: { projectId?: string; paused: boolean }): void {
    if (scope.projectId) {
      this.db
        .prepare('UPDATE factory_projects SET paused=?, updatedAt=? WHERE id=?')
        .run(scope.paused ? 1 : 0, this.now(), scope.projectId)
      return
    }
    this.setMeta('globalPaused', scope.paused ? '1' : '0')
  }

  setPriority(projectId: string, priority: number): void {
    this.db
      .prepare('UPDATE factory_projects SET priority=?, updatedAt=? WHERE id=?')
      .run(priority, this.now(), projectId)
  }

  setLimits(patch: {
    projectId?: string
    tasksAtOnce?: number
    globalSlots?: number
    repairs?: number
    stopAfter?: number | null
    models?: Partial<FactoryModels>
  }): void {
    if (patch.models) this.setMeta('models', JSON.stringify({ ...this.models(), ...patch.models }))
    if (patch.globalSlots !== undefined)
      this.setMeta('globalSlots', String(Math.max(1, Math.min(8, patch.globalSlots))))
    if (patch.stopAfter !== undefined)
      this.setMeta('stopAfter', patch.stopAfter === null ? '' : String(patch.stopAfter))
    if (!patch.projectId) return
    const project = this.project(patch.projectId)
    if (!project) return
    this.db
      .prepare('UPDATE factory_projects SET tasksAtOnce=?, repairs=?, updatedAt=? WHERE id=?')
      .run(
        patch.tasksAtOnce !== undefined
          ? Math.max(1, Math.min(6, patch.tasksAtOnce))
          : project.tasksAtOnce,
        patch.repairs !== undefined ? Math.max(0, Math.min(5, patch.repairs)) : project.repairs,
        this.now(),
        patch.projectId
      )
  }

  park(taskId: string, parked: boolean): FactoryTask {
    const task = this.requireTask(taskId)
    if (task.condition !== 'blocked' && parked)
      throw new Error('Park a blocked task so another one can start.')
    this.patchTask(taskId, { parked })
    return this.requireTask(taskId)
  }

  cancel(taskId: string): FactoryTask {
    const task = this.requireTask(taskId)
    this.db.transaction(() => {
      const at = this.now()
      this.db
        .prepare(
          `UPDATE factory_attempts SET state='finished', finishedAt=?, result=? WHERE taskId=? AND state!='finished'`
        )
        .run(at, json({ kind: 'canceled' }), taskId)
      this.patchTask(taskId, {
        condition: 'canceled',
        blockReason: 'Canceled.',
        nextAction: 'The branch and evidence are kept.',
        activity: 'Canceled'
      })
      this.event(task.projectId, FACTORY_EVENT.canceled, taskId, { title: task.title })
    })()
    return this.requireTask(taskId)
  }

  restore(taskId: string): FactoryTask {
    const task = this.requireTask(taskId)
    if (task.condition !== 'canceled') throw new Error('Only a canceled task can be restored.')
    this.patchTask(
      taskId,
      task.stage === 'draft'
        ? { condition: 'clear', blockReason: '', nextAction: '', activity: 'Restored' }
        : {
            condition: 'interrupted',
            blockReason: 'Restored after it was canceled.',
            nextAction: 'Try again to pick up from what it left on the branch.',
            activity: 'Restored'
          }
    )
    return this.requireTask(taskId)
  }

  retry(taskId: string, note = '', rebuild = false): FactoryTask {
    const task = this.requireTask(taskId)
    if (task.condition !== 'interrupted' && task.condition !== 'blocked') {
      throw new Error('This task is not waiting on you.')
    }
    if (rebuild && !['building', 'checking', 'reviewing'].includes(task.stage)) {
      throw new Error('Only a task that has started building can go back to Building.')
    }
    const live = this.attempts().find(
      (attempt) => attempt.taskId === taskId && attempt.state !== 'finished' && attempt.pid > 0
    )
    if (live) throw new Error('That task is still running.')
    const repairNote = [
      note.trim() && `From the person who owns this task: ${note.trim()}`,
      task.blockReason && `The last try stopped: ${task.blockReason}`,
      task.repairNote
    ]
      .filter(Boolean)
      .join('\n\n')
      .slice(0, 8_000)
    this.patchTask(taskId, {
      condition: 'clear',
      blockReason: '',
      nextAction: '',
      parked: false,
      repairNote,
      ...(rebuild && {
        stage: 'building' as const,
        repairsUsed: Math.max(0, task.repairsUsed - 1),
        activity: 'Sent back to build'
      })
    })
    return this.requireTask(taskId)
  }

  activeAttempts(): FactoryAttempt[] {
    return this.attempts().filter((attempt) => attempt.state !== 'finished')
  }

  insertDispatch(action: DispatchAction): FactoryAttempt | null {
    return this.db.transaction(() => {
      const task = this.task(action.taskId)
      if (!task || task.condition !== 'clear' || task.parked) return null
      const active = this.attempts().some(
        (attempt) => attempt.taskId === task.id && attempt.state !== 'finished'
      )
      if (active) return null
      const generation =
        (
          this.db
            .prepare('SELECT MAX(generation) AS generation FROM factory_attempts WHERE taskId=?')
            .get(task.id) as { generation: number | null } | undefined
        )?.generation ?? 0
      const next = (generation ?? 0) + 1
      const row: FactoryAttempt = {
        id: randomUUID(),
        taskId: task.id,
        projectId: task.projectId,
        role: action.role,
        generation: next,
        dispatchKey: `${task.id}:${action.role}:${next}`,
        state: 'pending',
        pid: 0,
        runId: '',
        runDir: '',
        timeoutAt: 0,
        brief: task.repairNote,
        result: '',
        startedAt: 0,
        finishedAt: 0
      }
      this.db
        .prepare(
          `INSERT INTO factory_attempts (
            id, taskId, projectId, role, generation, dispatchKey, state, pid, runId, runDir, timeoutAt,
            brief, result, startedAt, finishedAt
          ) VALUES (
            @id, @taskId, @projectId, @role, @generation, @dispatchKey, @state, @pid, @runId, @runDir, @timeoutAt,
            @brief, @result, @startedAt, @finishedAt
          )`
        )
        .run(row)
      const at = this.now()
      this.patchTask(task.id, { stage: action.stage, activity: 'Waiting for a free slot' })
      if (action.role === 'prepare') {
        this.db
          .prepare('UPDATE factory_projects SET lastDispatchAt=? WHERE id=?')
          .run(at, task.projectId)
      }
      this.event(task.projectId, FACTORY_EVENT.dispatch, task.id, {
        role: action.role,
        title: task.title
      })
      return row
    })()
  }

  insertPlan(projectId: string, brief: string): FactoryAttempt {
    const running = this.activeAttempts().find(
      (attempt) => attempt.projectId === projectId && attempt.role === 'plan'
    )
    if (running) return running
    this.setMeta('planError', '')
    const occupied = this.attempts().filter((attempt) => attempt.state !== 'finished').length
    if (occupied >= this.slots()) throw new Error('All factory slots are in use.')
    const id = randomUUID()
    const row: FactoryAttempt = {
      id,
      taskId: '',
      projectId,
      role: 'plan',
      generation: 1,
      dispatchKey: `plan:${id}`,
      state: 'pending',
      pid: 0,
      runId: '',
      runDir: '',
      timeoutAt: 0,
      brief,
      result: '',
      startedAt: 0,
      finishedAt: 0
    }
    this.db
      .prepare(
        `INSERT INTO factory_attempts (
          id, taskId, projectId, role, generation, dispatchKey, state, pid, runId, runDir, timeoutAt,
          brief, result, startedAt, finishedAt
        ) VALUES (
          @id, @taskId, @projectId, @role, @generation, @dispatchKey, @state, @pid, @runId, @runDir, @timeoutAt,
          @brief, @result, @startedAt, @finishedAt
        )`
      )
      .run(row)
    return row
  }

  markStarted(
    attemptId: string,
    generation: number,
    timeoutAt: number,
    runId: string,
    runDir: string
  ): boolean {
    const at = this.now()
    const changed = this.db
      .prepare(
        `UPDATE factory_attempts
         SET state='started', startedAt=?, timeoutAt=?, runId=?, runDir=?
         WHERE id=? AND generation=? AND state='pending'`
      )
      .run(at, timeoutAt, runId, runDir, attemptId, generation)
    if (changed.changes === 0) return false
    const attempt = this.attempt(attemptId)
    if (attempt?.taskId) this.patchTask(attempt.taskId, { activity: 'Starting' })
    return true
  }

  setPid(attemptId: string, generation: number, pid: number): void {
    this.db
      .prepare(`UPDATE factory_attempts SET pid=? WHERE id=? AND generation=? AND state='started'`)
      .run(pid, attemptId, generation)
  }

  noteActivity(attemptId: string, text: string): void {
    const attempt = this.attempt(attemptId)
    if (!attempt || attempt.state !== 'started') return
    if (attempt.role === 'plan') {
      this.db
        .prepare("UPDATE factory_attempts SET result=? WHERE id=? AND state='started'")
        .run(json({ activity: text.slice(0, 160) }), attempt.id)
      return
    }
    if (!attempt.taskId) return
    this.patchTask(attempt.taskId, { activity: text.slice(0, 160) })
  }

  applyResult(
    attemptId: string,
    generation: number,
    result: StageResult,
    evidence: FactoryEvidence[] = []
  ): boolean {
    return this.db.transaction(() => {
      const attempt = this.attempt(attemptId)
      if (!attempt || attempt.generation !== generation || attempt.state !== 'started') return false
      const at = this.now()
      this.db
        .prepare(
          `UPDATE factory_attempts SET state='finished', finishedAt=?, result=?, pid=0 WHERE id=?`
        )
        .run(at, json(result), attemptId)
      if (attempt.role === 'plan') {
        this.setMeta(
          'planError',
          result.kind === 'planned'
            ? result.error
            : result.kind === 'interrupted' || result.kind === 'blocked'
              ? result.reason
              : 'The idea scan stopped. Try again.'
        )
        if (result.kind === 'planned' && result.drafts.length) {
          const brief = this.readBrief(attempt.brief)
          if (brief.source === 'audit') {
            for (const prior of brief.replaceDrafts) {
              const task = this.task(prior.id)
              if (
                task?.projectId !== attempt.projectId ||
                task.stage !== 'draft' ||
                task.updatedAt !== prior.updatedAt
              )
                continue
              const materials = this.materials(task.id)
              if (materials.files.length || materials.notes.length) continue
              this.patchTask(task.id, {
                condition: 'canceled',
                activity: 'Replaced by refreshed ideas'
              })
            }
          }
          const created = this.insertDrafts(
            attempt.projectId,
            brief.source === 'audit' ? 'audit' : 'brief',
            brief.goal,
            result.drafts
          )
          for (const task of created) this.setMeta(`origin:${task.id}`, attempt.id)
        }
        return true
      }
      const task = attempt.taskId ? this.task(attempt.taskId) : null
      if (!task) return true
      const project = this.project(task.projectId)
      this.land(task, project, result, evidence)
      return true
    })()
  }

  interruptStarted(attemptId: string, reason: string): FactoryAttempt | null {
    const attempt = this.attempt(attemptId)
    if (!attempt || attempt.state !== 'started') return null
    this.db.transaction(() => {
      const at = this.now()
      this.db
        .prepare(
          `UPDATE factory_attempts SET state='finished', finishedAt=?, result=?, pid=0 WHERE id=? AND state='started'`
        )
        .run(at, json({ kind: 'interrupted', reason }), attemptId)
      if (attempt.role === 'plan') this.setMeta('planError', reason)
      if (attempt.taskId) {
        this.patchTask(attempt.taskId, {
          condition: 'interrupted',
          blockReason: reason,
          nextAction: 'Retry picks up from what it left on the branch.',
          activity: 'Interrupted'
        })
        this.event(attempt.projectId, FACTORY_EVENT.interrupted, attempt.taskId, { reason })
      }
    })()
    return attempt
  }

  task(id: string): FactoryTask | null {
    const row = this.db.prepare('SELECT * FROM factory_tasks WHERE id=?').get(id) as
      | TaskRow
      | undefined
    return row ? this.toTask(row) : null
  }

  project(id: string): FactoryProject | null {
    const row = this.db.prepare('SELECT * FROM factory_projects WHERE id=?').get(id) as
      | ProjectRow
      | undefined
    return row ? this.toProject(row) : null
  }

  attempt(id: string): FactoryAttempt | null {
    const row = this.db.prepare('SELECT * FROM factory_attempts WHERE id=?').get(id) as
      | AttemptRow
      | undefined
    return row ? this.toAttempt(row) : null
  }

  projects(): FactoryProject[] {
    return (
      this.db.prepare('SELECT * FROM factory_projects ORDER BY name').all() as ProjectRow[]
    ).map((row) => this.toProject(row))
  }

  tasks(): FactoryTask[] {
    return (
      this.db.prepare('SELECT * FROM factory_tasks ORDER BY priority, createdAt').all() as TaskRow[]
    ).map((row) => this.toTask(row))
  }

  private attempts(): FactoryAttempt[] {
    return (this.db.prepare('SELECT * FROM factory_attempts').all() as AttemptRow[]).map((row) =>
      this.toAttempt(row)
    )
  }

  evidenceById(id: string): FactoryEvidence | null {
    const row = this.db.prepare('SELECT * FROM factory_evidence WHERE id=?').get(id) as
      | EvidenceRow
      | undefined
    return row ? this.toEvidence(row) : null
  }

  private evidence(): FactoryEvidence[] {
    return (
      this.db.prepare('SELECT * FROM factory_evidence ORDER BY createdAt').all() as EvidenceRow[]
    ).map((row) => this.toEvidence(row))
  }

  private land(
    task: FactoryTask,
    project: FactoryProject | null,
    result: StageResult,
    evidence: FactoryEvidence[]
  ): void {
    const repairs = project?.repairs ?? FACTORY.repairs
    const repair = (findings: string): void => {
      if (task.repairsUsed >= repairs) {
        this.block(
          task,
          findings || 'The checks still fail.',
          'Read the finding and tell the factory what to do.'
        )
        return
      }
      this.patchTask(task.id, {
        stage: 'building',
        condition: 'clear',
        repairsUsed: task.repairsUsed + 1,
        repairNote: findings,
        blockReason: '',
        nextAction: '',
        activity: 'Sent back to build'
      })
      this.event(task.projectId, FACTORY_EVENT.advanced, task.id, {
        stage: 'building',
        repair: true
      })
    }
    if (result.kind === 'interrupted') {
      this.patchTask(task.id, {
        condition: 'interrupted',
        blockReason: result.reason,
        nextAction: 'Retry picks up from what it left on the branch.',
        activity: 'Interrupted'
      })
      this.event(task.projectId, FACTORY_EVENT.interrupted, task.id, { reason: result.reason })
      return
    }
    if (result.kind === 'blocked') {
      this.block(task, result.reason, result.nextAction)
      return
    }
    if (result.kind === 'prepared') {
      this.patchTask(task.id, {
        stage: 'building',
        branch: result.branch,
        baseSha: result.baseSha,
        worktree: result.worktree,
        activity: 'Worktree ready'
      })
      this.event(task.projectId, FACTORY_EVENT.advanced, task.id, { stage: 'building' })
      return
    }
    if (result.kind === 'built') {
      if (result.followups.length)
        this.insertDrafts(
          task.projectId,
          'followup',
          task.title,
          result.followups.map((draft) =>
            draft.area ? draft : { ...draft, area: task.area, kind: task.kind }
          )
        )
      this.patchTask(task.id, {
        stage: 'checking',
        commitSha: result.commitSha,
        activity: 'Running checks'
      })
      this.event(task.projectId, FACTORY_EVENT.advanced, task.id, { stage: 'checking' })
      return
    }
    if (result.kind === 'checked') {
      if (result.commitSha !== task.commitSha) {
        this.block(
          task,
          'The checks ran against a different commit than the one just built.',
          'Retry the build.'
        )
        return
      }
      this.insertEvidence(evidence)
      if (
        result.failures.length ||
        !this.checksCovered(task, result.commitSha, project?.checkCommands ?? [])
      ) {
        repair(result.failures.join('\n') || 'A required check has no result.')
        return
      }
      this.patchTask(task.id, { stage: 'reviewing', activity: 'In review' })
      this.event(task.projectId, FACTORY_EVENT.advanced, task.id, { stage: 'reviewing' })
      return
    }
    if (result.kind === 'reviewed') {
      this.insertEvidence(evidence)
      if (result.commitSha !== task.commitSha) {
        this.block(task, 'The review was for a different commit.', 'Retry the review.')
        return
      }
      if (!result.pass) {
        repair(result.findings || 'The review found a problem.')
        return
      }
      this.block(task, 'The review passed but no pull request was opened.', 'Retry the review.')
      return
    }
    if (result.kind === 'opened') {
      this.insertEvidence(evidence)
      this.patchTask(task.id, {
        stage: 'ready',
        condition: 'clear',
        prUrl: result.prUrl,
        repairNote: '',
        blockReason: '',
        nextAction: 'Read the pull request and merge it when you are ready.',
        activity: 'Ready for you'
      })
      this.event(task.projectId, FACTORY_EVENT.ready, task.id, {
        prUrl: result.prUrl,
        title: task.title
      })
    }
  }

  private checksCovered(task: FactoryTask, commitSha: string, commands: string[]): boolean {
    if (!commands.length) return false
    const rows = (
      this.db
        .prepare('SELECT * FROM factory_evidence WHERE taskId=? AND stale=0')
        .all(task.id) as EvidenceRow[]
    ).map((row) => this.toEvidence(row))
    const named = task.acceptance.map((line) => line.command).filter(Boolean)
    const required = [...commands, ...named.filter((command) => !commands.includes(command))]
    return required.every((command) =>
      rows.some(
        (row) =>
          row.provenance === 'coordinator' &&
          row.command === command &&
          row.commitSha === commitSha &&
          row.exitCode === 0
      )
    )
  }

  private insertEvidence(rows: FactoryEvidence[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO factory_evidence (
        id, taskId, attemptId, commitSha, criterion, command, cwd, exitCode, artifactPath, artifactHash,
        provenance, stale, createdAt
      ) VALUES (
        @id, @taskId, @attemptId, @commitSha, @criterion, @command, @cwd, @exitCode, @artifactPath, @artifactHash,
        @provenance, @stale, @createdAt
      )`
    )
    for (const row of rows) stmt.run({ ...row, stale: row.stale ? 1 : 0 })
  }

  invalidateEvidence(taskId: string): void {
    this.db.prepare('UPDATE factory_evidence SET stale=1 WHERE taskId=?').run(taskId)
  }

  markMerged(taskId: string): void {
    const task = this.task(taskId)
    if (!task || task.stage !== 'ready') return
    this.patchTask(taskId, {
      stage: 'merged',
      condition: 'clear',
      activity: 'Merged',
      nextAction: ''
    })
    this.event(task.projectId, FACTORY_EVENT.merged, taskId, { title: task.title })
  }

  refreshBase(taskId: string, baseSha: string, commitSha: string): void {
    this.invalidateEvidence(taskId)
    this.patchTask(taskId, {
      baseSha,
      commitSha,
      stage: 'checking',
      condition: 'clear',
      blockReason: '',
      nextAction: '',
      activity: 'Rechecking'
    })
  }

  flagStaleBase(taskId: string): void {
    const task = this.task(taskId)
    if (!task || task.stage !== 'ready' || task.condition === 'blocked') return
    this.patchTask(taskId, {
      condition: 'blocked',
      blockReason: 'The target branch moved.',
      nextAction: 'Retry to update this branch and run the checks again.',
      activity: 'Base moved'
    })
  }

  private block(task: FactoryTask, reason: string, nextAction: string): void {
    this.patchTask(task.id, {
      condition: 'blocked',
      blockReason: reason,
      nextAction,
      activity: 'Blocked'
    })
    this.event(task.projectId, FACTORY_EVENT.blocked, task.id, { reason, title: task.title })
  }

  private blankTask(
    partial: Partial<FactoryTask> & Pick<FactoryTask, 'id' | 'projectId' | 'title' | 'outcome'>
  ): FactoryTask {
    const at = this.now()
    return {
      source: 'write',
      sourceDetail: '',
      area: '',
      kind: '',
      acceptance: [],
      scope: [],
      dependsOn: [],
      priority: 0,
      stage: 'draft',
      condition: 'clear',
      blockReason: '',
      nextAction: '',
      repairNote: '',
      branch: '',
      baseSha: '',
      commitSha: '',
      worktree: '',
      batchId: '',
      repairsUsed: 0,
      workflowVersion: FACTORY.workflowVersion,
      parked: false,
      oversized: false,
      duplicateOf: '',
      prUrl: '',
      activity: '',
      approvedAt: 0,
      createdAt: at,
      updatedAt: at,
      ...partial
    }
  }

  private insertTask(task: FactoryTask): void {
    this.db
      .prepare(
        `INSERT INTO factory_tasks (
          id, projectId, title, outcome, source, sourceDetail, acceptance, scope, dependsOn, priority, stage,
          condition, blockReason, nextAction, repairNote, branch, baseSha, commitSha, worktree, batchId,
          repairsUsed, workflowVersion, parked, oversized, duplicateOf, prUrl, activity, approvedAt, createdAt, updatedAt,
          area, kind
        ) VALUES (
          @id, @projectId, @title, @outcome, @source, @sourceDetail, @acceptance, @scope, @dependsOn, @priority, @stage,
          @condition, @blockReason, @nextAction, @repairNote, @branch, @baseSha, @commitSha, @worktree, @batchId,
          @repairsUsed, @workflowVersion, @parked, @oversized, @duplicateOf, @prUrl, @activity, @approvedAt, @createdAt, @updatedAt,
          @area, @kind
        )`
      )
      .run(this.fromTask(task))
  }

  private patchTask(id: string, patch: TaskPatch): void {
    const task = { ...this.requireTask(id), ...patch, updatedAt: this.now() }
    this.db
      .prepare(
        `UPDATE factory_tasks SET
          title=@title, outcome=@outcome, acceptance=@acceptance, scope=@scope, dependsOn=@dependsOn,
          priority=@priority, stage=@stage, condition=@condition, blockReason=@blockReason, nextAction=@nextAction,
          repairNote=@repairNote, branch=@branch, baseSha=@baseSha, commitSha=@commitSha, worktree=@worktree,
          batchId=@batchId, repairsUsed=@repairsUsed, parked=@parked, oversized=@oversized, duplicateOf=@duplicateOf,
          prUrl=@prUrl, activity=@activity, approvedAt=@approvedAt, updatedAt=@updatedAt,
          area=@area, kind=@kind
         WHERE id=@id`
      )
      .run(this.fromTask(task))
  }

  private requireTask(id: string): FactoryTask {
    const task = this.task(id)
    if (!task) throw new Error('That task is not in the factory.')
    return task
  }

  private event(
    project: string,
    kind: string,
    target: string,
    detail: Record<string, unknown>
  ): void {
    this.db
      .prepare('INSERT INTO events(project, actor, kind, target, at, detail) VALUES(?,?,?,?,?,?)')
      .run(project, FACTORY.actor, kind, target, this.now(), json(detail))
  }

  audit(attemptId: string): FactoryRunAudit[] {
    return JSON.parse(this.meta(`audit:${attemptId}`, '[]')) as FactoryRunAudit[]
  }

  saveAudit(attemptId: string, run: FactoryRunAudit): void {
    const runs = this.audit(attemptId)
    const index = runs.findIndex((item) => item.id === run.id)
    if (index < 0) runs.push(run)
    else runs[index] = run
    this.setMeta(`audit:${attemptId}`, json(runs))
  }

  materials(taskId: string): FactoryMaterials {
    if (!this.task(taskId)) throw new Error('That task is not in the factory.')
    return JSON.parse(
      this.meta(`materials:${taskId}`, '{"files":[],"notes":[]}')
    ) as FactoryMaterials
  }

  saveMaterials(taskId: string, value: FactoryMaterials): void {
    if (!this.task(taskId)) throw new Error('That task is not in the factory.')
    this.setMeta(`materials:${taskId}`, json(value))
  }

  private meta(key: string, fallback: string): string {
    const row = this.db.prepare('SELECT value FROM factory_meta WHERE key=?').get(key) as
      | { value: string }
      | undefined
    return row?.value ?? fallback
  }

  private setMeta(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO factory_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
      )
      .run(key, value)
  }

  private slots(): number {
    const saved =
      Number(this.meta('globalSlots', String(FACTORY.globalSlots))) || FACTORY.globalSlots
    return Math.min(FACTORY.maxSlots, saved)
  }

  models(): FactoryModels {
    try {
      const saved = JSON.parse(this.meta('models', '{}')) as Record<string, string>
      const models = { ...FACTORY_MODEL_DEFAULTS }
      for (const station of FACTORY_MODEL_STATIONS) {
        const value = saved[station] === 'smart' ? 'opus' : saved[station] === 'fast' ? 'sonnet' : saved[station]
        const choice = FACTORY_MODEL_CHOICES.find((item) => item === value)
        if (choice) models[station] = choice
      }
      return models
    } catch {
      return FACTORY_MODEL_DEFAULTS
    }
  }

  private stopAfter(): number | null {
    const raw = this.meta('stopAfter', '')
    if (!raw) return null
    const value = Number(raw)
    return Number.isFinite(value) ? value : null
  }

  private readBrief(raw: string): {
    source: string
    goal: string
    replaceDrafts: { id: string; updatedAt: number }[]
  } {
    try {
      const parsed = JSON.parse(raw) as {
        source?: string
        goal?: string
        replaceDrafts?: { id: string; updatedAt: number }[]
      }
      return {
        source: parsed.source ?? 'brief',
        goal: parsed.goal ?? '',
        replaceDrafts: Array.isArray(parsed.replaceDrafts) ? parsed.replaceDrafts : []
      }
    } catch {
      return { source: 'brief', goal: '', replaceDrafts: [] }
    }
  }

  private toProject(row: ProjectRow): FactoryProject {
    return {
      ...row,
      backend: 'claude',
      checkCommands: strings(row.checkCommands),
      setupBlockers: strings(row.setupBlockers),
      paused: row.paused === 1
    }
  }

  private toTask(row: TaskRow): FactoryTask {
    return {
      ...row,
      originAttemptId: this.meta(`origin:${row.id}`, ''),
      source: row.source as FactoryTask['source'],
      area: factoryArea(row.area),
      stage: row.stage as FactoryStage,
      condition: row.condition as FactoryCondition,
      acceptance: readAcceptance(row.acceptance),
      scope: strings(row.scope),
      dependsOn: strings(row.dependsOn),
      parked: row.parked === 1,
      oversized: row.oversized === 1
    }
  }

  private fromTask(task: FactoryTask): Record<string, unknown> {
    return {
      ...task,
      acceptance: json(task.acceptance),
      scope: json(task.scope),
      dependsOn: json(task.dependsOn),
      parked: task.parked ? 1 : 0,
      oversized: task.oversized ? 1 : 0
    }
  }

  private toAttempt(row: AttemptRow): FactoryAttempt {
    return {
      ...row,
      audit: this.audit(row.id),
      role: row.role as FactoryAttempt['role'],
      state: row.state as FactoryAttempt['state']
    }
  }

  private toEvidence(row: EvidenceRow): FactoryEvidence {
    return {
      ...row,
      provenance: row.provenance as FactoryEvidence['provenance'],
      stale: row.stale === 1
    }
  }

  admittedCount(projectId: string): number {
    return this.tasks().filter((task) => task.projectId === projectId && isAdmitted(task)).length
  }
}

interface ProjectRow extends Omit<
  FactoryProject,
  'backend' | 'checkCommands' | 'setupBlockers' | 'paused'
> {
  backend: string
  checkCommands: string
  setupBlockers: string
  paused: number
}

interface TaskRow extends Omit<
  FactoryTask,
  | 'acceptance'
  | 'scope'
  | 'dependsOn'
  | 'parked'
  | 'oversized'
  | 'source'
  | 'stage'
  | 'condition'
  | 'area'
> {
  area: string
  source: string
  stage: string
  condition: string
  acceptance: string
  scope: string
  dependsOn: string
  parked: number
  oversized: number
}

interface AttemptRow extends Omit<FactoryAttempt, 'role' | 'state'> {
  role: string
  state: string
}

interface EvidenceRow extends Omit<FactoryEvidence, 'provenance' | 'stale'> {
  provenance: string
  stale: number
}

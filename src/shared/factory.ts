export const FACTORY = {
  schemaVersion: 1,
  workflowVersion: 1,
  backend: 'claude',
  pollMs: 2_000,
  uiPollMs: 5_000,
  tasksAtOnce: 1,
  globalSlots: 4,
  maxSlots: 1,
  repairs: 2,
  attemptMs: 45 * 60 * 1000,
  stallMs: 5 * 60 * 1000,
  readyCap: 5,
  maxDrafts: 2,
  planTimeoutMs: 90_000,
  planStallMs: 45_000,
  planMaxFiles: 12,
  planFileChars: 3500,
  maxAcceptance: 8,
  priorityHeadroomMs: 60_000,
  actor: 'factory',
  suggestionGoal:
    'Find the two highest-value, bounded improvements in this project. Prefer clear user benefit and work that can be proven.'
} as const

export const FACTORY_STAGES = [
  'draft',
  'queued',
  'preparing',
  'building',
  'checking',
  'reviewing',
  'ready',
  'merged'
] as const
export type FactoryStage = (typeof FACTORY_STAGES)[number]

export const FACTORY_STATIONS = [
  'queued',
  'preparing',
  'building',
  'checking',
  'reviewing',
  'ready'
] as const
export type FactoryStation = (typeof FACTORY_STATIONS)[number]

export const FACTORY_STATION_LABEL: Record<FactoryStation, string> = {
  queued: 'Waiting',
  preparing: 'Preparing',
  building: 'Building',
  checking: 'Checking',
  reviewing: 'Reviewing',
  ready: 'Ready to ship'
}

export const FACTORY_MODEL_STATIONS = ['ideas', 'build', 'review'] as const
export type FactoryModelStation = (typeof FACTORY_MODEL_STATIONS)[number]
export const FACTORY_MODEL_CHOICES = ['fable', 'opus', 'sonnet', 'haiku'] as const
export type FactoryModelChoice = (typeof FACTORY_MODEL_CHOICES)[number]
export type FactoryModels = Record<FactoryModelStation, FactoryModelChoice>

export const FACTORY_MODEL_DEFAULTS: FactoryModels = {
  ideas: 'opus',
  build: 'sonnet',
  review: 'opus'
}

export const FACTORY_MODEL_STATION_LABEL: Record<FactoryModelStation, string> = {
  ideas: 'Ideas',
  build: 'Build',
  review: 'Review'
}

export function factoryModelStation(role: string): FactoryModelStation {
  return role === 'plan' ? 'ideas' : role === 'review' ? 'review' : 'build'
}

export const FACTORY_CONDITIONS = ['clear', 'blocked', 'interrupted', 'canceled'] as const
export type FactoryCondition = (typeof FACTORY_CONDITIONS)[number]

export const FACTORY_ROLES = ['plan', 'prepare', 'build', 'check', 'review'] as const
export type FactoryRole = (typeof FACTORY_ROLES)[number]

export const FACTORY_ATTEMPT_STATES = ['pending', 'started', 'finished'] as const
export type FactoryAttemptState = (typeof FACTORY_ATTEMPT_STATES)[number]

export const FACTORY_SOURCES = ['write', 'brief', 'audit', 'followup'] as const
export type FactorySource = (typeof FACTORY_SOURCES)[number]

export const FACTORY_GROUPS = {
  rd: 'R&D',
  sm: 'Sales & Marketing',
  ga: 'General & Admin'
} as const
export type FactoryGroup = keyof typeof FACTORY_GROUPS

export const FACTORY_AREAS = {
  product: {
    group: 'rd',
    label: 'Product',
    kinds: ['Research', 'Spec', 'UX design', 'In-app copy']
  },
  engineering: {
    group: 'rd',
    label: 'Engineering',
    kinds: ['Feature', 'Bug', 'Speed', 'Cleanup', 'Infra', 'Security', 'Tests']
  },
  data: { group: 'rd', label: 'Data', kinds: ['Metrics', 'Experiments', 'Reports'] },
  marketing: {
    group: 'sm',
    label: 'Marketing',
    kinds: ['Website & SEO', 'Content', 'Ads', 'Social', 'Brand', 'Launch']
  },
  sales: {
    group: 'sm',
    label: 'Sales',
    kinds: ['Leads', 'Outreach', 'Demos', 'Pricing', 'Partners']
  },
  customers: {
    group: 'sm',
    label: 'Customers',
    kinds: ['Support', 'Onboarding', 'Feedback', 'Retention']
  },
  company: {
    group: 'ga',
    label: 'Company',
    kinds: ['Money', 'Legal', 'Hiring', 'Fundraising', 'Tools']
  }
} as const satisfies Record<
  string,
  { group: FactoryGroup; label: string; kinds: readonly string[] }
>
export type FactoryArea = keyof typeof FACTORY_AREAS

export function factoryArea(value: unknown): FactoryArea | '' {
  const key = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return Object.hasOwn(FACTORY_AREAS, key) ? (key as FactoryArea) : ''
}

export function ideaArea(
  task: Pick<FactoryTask, 'area' | 'source' | 'sourceDetail' | 'scope'>
): FactoryArea | '' {
  if (task.area) return task.area
  const fromCode = task.source === 'audit' || task.source === 'followup'
  return fromCode && (task.sourceDetail || task.scope.length) ? 'engineering' : ''
}

export function factoryKind(area: FactoryArea | '', value: unknown): string {
  if (!area || typeof value !== 'string') return ''
  const want = value.trim().toLowerCase()
  return FACTORY_AREAS[area].kinds.find((kind) => kind.toLowerCase() === want) ?? ''
}

export const FACTORY_EVENT = {
  setup: 'factory_setup',
  approved: 'factory_approved',
  dispatch: 'factory_dispatch',
  advanced: 'factory_advanced',
  blocked: 'factory_blocked',
  interrupted: 'factory_interrupted',
  canceled: 'factory_canceled',
  ready: 'factory_ready',
  merged: 'factory_merged'
} as const

export interface FactoryProject {
  id: string
  mightyId: string
  name: string
  repoRoot: string
  integrationRef: string
  workflowVersion: number
  backend: typeof FACTORY.backend
  checkCommands: string[]
  tasksAtOnce: number
  repairs: number
  attemptMs: number
  stallMs: number
  readyCap: number
  paused: boolean
  priority: number
  lastDispatchAt: number
  setupBlockers: string[]
  batchId: string
  updatedAt: number
}

export interface AcceptanceLine {
  text: string
  command: string
}

export interface FactoryTask {
  originAttemptId?: string
  id: string
  projectId: string
  title: string
  outcome: string
  source: FactorySource
  sourceDetail: string
  area: FactoryArea | ''
  kind: string
  acceptance: AcceptanceLine[]
  scope: string[]
  dependsOn: string[]
  priority: number
  stage: FactoryStage
  condition: FactoryCondition
  blockReason: string
  nextAction: string
  repairNote: string
  branch: string
  baseSha: string
  commitSha: string
  worktree: string
  batchId: string
  repairsUsed: number
  workflowVersion: number
  parked: boolean
  oversized: boolean
  duplicateOf: string
  prUrl: string
  activity: string
  approvedAt: number
  createdAt: number
  updatedAt: number
}

export interface FactoryRunAudit {
  id: string
  startedAt: number
  finishedAt: number
  exitCode: number | null
  usage: {
    input: number
    output: number
    cacheRead: number | null
    cacheWrite: number | null
    costUsd: number | null
  } | null
  models: string[]
  actions: {
    id: string
    at: number
    name: string
    detail: string
    finishedAt: number
    failed: boolean | null
  }[]
}

export function factoryUsage(raw: string): Pick<FactoryRunAudit, 'usage' | 'models'> {
  const number = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
  const models = new Set<string>()
  let usage: FactoryRunAudit['usage'] = null
  for (const line of raw.split('\n')) {
    try {
      const row = JSON.parse(line)
      if (typeof row.message?.model === 'string') models.add(row.message.model)
      if (row.type !== 'result') continue
      for (const model of Object.keys(row.modelUsage ?? {})) models.add(model)
      const input = number(row.usage?.input_tokens)
      const output = number(row.usage?.output_tokens)
      if (input !== null && output !== null)
        usage = {
          input,
          output,
          cacheRead: number(row.usage?.cache_read_input_tokens),
          cacheWrite: number(row.usage?.cache_creation_input_tokens),
          costUsd: number(row.total_cost_usd)
        }
    } catch {
      continue
    }
  }
  return { usage, models: [...models] }
}

export interface FactoryAttempt {
  id: string
  taskId: string
  projectId: string
  role: FactoryRole
  generation: number
  audit?: FactoryRunAudit[]
  dispatchKey: string
  state: FactoryAttemptState
  pid: number
  runId: string
  runDir: string
  timeoutAt: number
  brief: string
  result: string
  startedAt: number
  finishedAt: number
}

export type FactoryTranscriptEntry = { at: number } & (
  | { kind: 'prompt' | 'text' | 'thinking'; text: string }
  | { kind: 'tool'; id: string; name: string; input: string }
  | { kind: 'tool_end'; id: string; output: string; failed: boolean }
  | { kind: 'done'; exitCode: number }
)

export interface FactoryTranscript {
  entries: FactoryTranscriptEntry[]
  file: string
}

export interface FactoryEvidence {
  id: string
  taskId: string
  attemptId: string
  commitSha: string
  criterion: string
  command: string
  cwd: string
  exitCode: number
  artifactPath: string
  artifactHash: string
  provenance: 'coordinator' | 'reviewer' | 'builder'
  stale: boolean
  createdAt: number
}

export interface FactoryBlocker {
  taskId: string
  projectId: string
  projectName: string
  title: string
  question: string
  nextAction: string
}

export interface FactoryAuditEvent {
  seq: number
  target: string
  kind: string
  at: number
  detail: string
}

export interface CodeSizePoint {
  at: number
  lines: number
  files: number
  bytes: number
}

export interface CodeSize {
  lines: number
  files: number
  bytes: number
  points: CodeSizePoint[]
}

export interface FactorySnapshot {
  auditEvents?: FactoryAuditEvent[]
  generatedAt: number
  globalPaused: boolean
  globalSlots: number
  stopAfter: number | null
  models: FactoryModels
  projects: FactoryProject[]
  tasks: FactoryTask[]
  attempts: FactoryAttempt[]
  evidence: FactoryEvidence[]
  blockers: FactoryBlocker[]
  planError: string
}

export interface SchedView {
  now: number
  globalPaused: boolean
  globalSlots: number
  stopAfter: number | null
  projects: FactoryProject[]
  tasks: FactoryTask[]
  attempts: FactoryAttempt[]
}

export type DispatchAction = {
  kind: 'dispatch'
  taskId: string
  projectId: string
  role: FactoryRole
  stage: FactoryStage
  generation: number
}

export type InterruptAction = {
  kind: 'interrupt'
  attemptId: string
  taskId: string
  runId: string
  pid: number
}

export type SchedAction = DispatchAction | InterruptAction

export interface DraftSeed {
  title: string
  outcome: string
  acceptance: string[]
  scope: string[]
  dependsOn: string[]
  sourceFile: string
  oversized: boolean
  area?: FactoryArea | ''
  kind?: string
}

export type StageResult =
  | { kind: 'prepared'; branch: string; baseSha: string; worktree: string }
  | { kind: 'built'; commitSha: string; followups: DraftSeed[] }
  | { kind: 'checked'; commitSha: string; failures: string[] }
  | { kind: 'reviewed'; commitSha: string; pass: boolean; findings: string }
  | { kind: 'opened'; prUrl: string }
  | { kind: 'interrupted'; reason: string }
  | { kind: 'blocked'; reason: string; nextAction: string }
  | { kind: 'planned'; drafts: DraftSeed[]; error: string }

export function stationOf(stage: FactoryStage): FactoryStation | null {
  if (stage === 'draft' || stage === 'merged') return null
  return stage
}

export function roleForStage(stage: FactoryStage): FactoryRole | null {
  if (stage === 'queued' || stage === 'preparing') return 'prepare'
  if (stage === 'building') return 'build'
  if (stage === 'checking') return 'check'
  if (stage === 'reviewing') return 'review'
  return null
}

export function stageForRole(role: FactoryRole, from: FactoryStage): FactoryStage {
  if (role === 'prepare') return 'preparing'
  if (role === 'build') return 'building'
  if (role === 'check') return 'checking'
  if (role === 'review') return 'reviewing'
  return from
}

export function isAdmitted(task: FactoryTask): boolean {
  if (task.parked || task.condition === 'canceled') return false
  if (
    task.stage === 'draft' ||
    task.stage === 'ready' ||
    task.stage === 'merged' ||
    task.stage === 'queued'
  )
    return false
  if (task.condition === 'blocked' || task.condition === 'interrupted') return true
  return (
    task.stage === 'preparing' ||
    task.stage === 'building' ||
    task.stage === 'checking' ||
    task.stage === 'reviewing'
  )
}

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export function dependencyCycle(tasks: { id: string; dependsOn: string[] }[]): string | null {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const state = new Map<string, 'open' | 'done'>()
  const visit = (id: string): string | null => {
    const mark = state.get(id)
    if (mark === 'open') return id
    if (mark === 'done') return null
    state.set(id, 'open')
    const task = byId.get(id)
    if (task) {
      for (const dep of task.dependsOn) {
        if (!byId.has(dep)) continue
        const found = visit(dep)
        if (found) return found
      }
    }
    state.set(id, 'done')
    return null
  }
  for (const task of tasks) {
    const found = visit(task.id)
    if (found) return found
  }
  return null
}

export function bindDependencies(
  chosen: { id: string; title: string; dependsOn: string[] }[],
  existing: { id: string; title: string; dependsOn: string[] }[]
): { id: string; dependsOn: string[] }[] {
  const pool = [
    ...existing.filter((task) => !chosen.some((item) => item.id === task.id)),
    ...chosen
  ]
  const resolveOne = (name: string): string | null => {
    const key = normalizeTitle(name)
    const hit = pool.find((task) => task.id === name || normalizeTitle(task.title) === key)
    return hit?.id ?? null
  }
  const linked = chosen.map((task) => ({
    id: task.id,
    dependsOn: task.dependsOn.filter(Boolean).map((dep) => {
      const id = resolveOne(dep)
      if (!id) throw new Error('A dependency points at a task that is not in this factory.')
      return id
    })
  }))
  const graph = [
    ...pool
      .filter((task) => !chosen.some((item) => item.id === task.id))
      .map((task) => ({ id: task.id, dependsOn: task.dependsOn })),
    ...linked
  ]
  if (dependencyCycle(graph)) throw new Error('These tasks depend on each other.')
  return linked
}

export function readAcceptance(raw: string): AcceptanceLine[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const lines: AcceptanceLine[] = []
  for (const item of parsed) {
    if (typeof item === 'string' && item.trim()) {
      lines.push({ text: item.trim(), command: '' })
      continue
    }
    if (!item || typeof item !== 'object' || !('text' in item)) continue
    const text = item.text
    if (typeof text !== 'string' || !text.trim()) continue
    const command = 'command' in item && typeof item.command === 'string' ? item.command.trim() : ''
    lines.push({ text: text.trim(), command })
  }
  return lines
}

export function acceptanceTexts(lines: AcceptanceLine[]): string[] {
  return lines.map((line) => line.text)
}

export function takeAgentReply(
  result: string | null,
  exitCode: number
): { text: string } | { error: string } {
  if (exitCode !== 0 || !result?.trim()) {
    if (exitCode === -3) return { error: 'The attempt timed out.' }
    if (exitCode === -4) return { error: 'The attempt was stopped.' }
    return { error: 'The agent stopped before it finished.' }
  }
  if (/^UserPromptSubmit operation blocked by hook:/i.test(result.trim())) {
    return { error: 'A Claude startup hook stopped the attempt. Fix the hook, then try again.' }
  }
  return { text: result.trim() }
}

export function parseReview(raw: string): { pass: boolean; findings: string } | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { pass?: unknown; findings?: unknown }
    if (typeof parsed.pass !== 'boolean') return null
    return {
      pass: parsed.pass,
      findings: typeof parsed.findings === 'string' ? parsed.findings.slice(0, 4_000) : ''
    }
  } catch {
    return null
  }
}

export function firstSentence(text: string): string {
  const plain = withoutNodeWarnings(text).replace(/[^\p{L}\p{N}\s.,:;!?'"()%/-]+|-{2,}/gu, ' ')
  return (
    plain
      .trim()
      .match(/^[^\n]*?(?:[.!?](?=\s|$)|(?=\n)|$)/)?.[0]
      .replace(/\s+/g, ' ')
      .trim() ?? ''
  )
}

export function deadWorkerReason(commitSha: string, baseSha: string): string {
  const kept =
    commitSha && commitSha !== baseSha
      ? ` The commit ${commitSha.slice(0, 7)} is on the branch and was not treated as finished.`
      : ''
  return `The worker stopped before it finished.${kept}`
}

export function interpretPull(
  body: { state?: string; mergeStateStatus?: string; baseRefOid?: string },
  baseSha: string
): 'merged' | 'stale' | 'open' {
  if (body.state === 'MERGED') return 'merged'
  if (
    body.mergeStateStatus === 'DIRTY' ||
    (body.baseRefOid !== undefined &&
      body.baseRefOid !== '' &&
      baseSha !== '' &&
      body.baseRefOid !== baseSha)
  ) {
    return 'stale'
  }
  return 'open'
}

export function unmetAcceptance(task: FactoryTask, evidence: FactoryEvidence[]): string[] {
  return task.acceptance
    .map((line) => line.text)
    .filter(
      (text) =>
        !evidence.some(
          (row) =>
            row.taskId === task.id &&
            row.commitSha === task.commitSha &&
            row.commitSha !== '' &&
            !row.stale &&
            row.exitCode === 0 &&
            row.criterion === text
        )
    )
}

function asString(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function asStrings(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    .map((item) => item.trim())
    .slice(0, max)
}

export function parsePlanDrafts(
  raw: string,
  source: 'brief' | 'audit'
): { drafts: DraftSeed[]; error: string } {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start)
    return { drafts: [], error: 'The planner did not return a task list.' }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return { drafts: [], error: 'The planner did not return a task list.' }
  }
  const tasks = parsed && typeof parsed === 'object' && 'tasks' in parsed ? parsed.tasks : null
  if (!Array.isArray(tasks)) return { drafts: [], error: 'The planner did not return a task list.' }
  if (tasks.length > FACTORY.maxDrafts) {
    return { drafts: [], error: `The planner returned more than ${FACTORY.maxDrafts} tasks.` }
  }
  const drafts: DraftSeed[] = []
  for (const item of tasks) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const title = asString(row.title, 200)
    const outcome = asString(row.outcome, 4_000)
    const acceptance = asStrings(row.acceptance, 20)
    if (!title || !outcome || acceptance.length === 0) continue
    const sourceFile = asString(row.sourceFile, 500)
    if (source === 'audit' && !sourceFile) continue
    const area = factoryArea(row.area)
    drafts.push({
      area,
      kind: factoryKind(area, row.kind),
      title,
      outcome: outcome.slice(0, 2_000),
      acceptance: acceptance.slice(0, FACTORY.maxAcceptance),
      scope: asStrings(row.scope, 20),
      dependsOn: asStrings(row.dependsOn, 10),
      sourceFile,
      oversized: outcome.length > 2_000 || acceptance.length > FACTORY.maxAcceptance
    })
  }
  if (drafts.length === 0 && source === 'brief') {
    return { drafts: [], error: 'The planner did not propose a task.' }
  }
  return { drafts, error: '' }
}

export function explainIdle(view: SchedView, projectId: string | null): string | null {
  const tasks = projectId ? view.tasks.filter((task) => task.projectId === projectId) : view.tasks
  const moving = view.attempts.some(
    (attempt) =>
      attempt.state === 'started' &&
      attempt.role !== 'plan' &&
      (!projectId || attempt.projectId === projectId)
  )
  if (moving) return null
  if (view.globalPaused) return 'The factory is paused. Resume it to start the next task.'
  const project = projectId ? view.projects.find((item) => item.id === projectId) : null
  if (project?.paused) return `${project.name} is paused. Resume it to start the next task.`
  const queued = tasks.filter((task) => task.stage === 'queued' && task.condition === 'clear')
  if (queued.length === 0) {
    if (tasks.some((task) => task.stage === 'ready'))
      return 'Nothing else to run. Review what is ready, or add a task.'
    return null
  }
  const occupied = view.attempts.filter((attempt) => attempt.state !== 'finished').length
  if (occupied >= view.globalSlots)
    return view.globalSlots === 1
      ? 'Another task is running. This one starts next.'
      : 'All factory slots are in use.'
  if (project && tasks.filter(isAdmitted).length >= project.tasksAtOnce) {
    return project.tasksAtOnce === 1
      ? 'A task is already in progress. Park it if it is stuck, or wait.'
      : `${project.tasksAtOnce} tasks are already in progress. Park a blocked one or wait.`
  }
  const waiting = queued.find((task) =>
    task.dependsOn.some((id) => view.tasks.find((item) => item.id === id)?.stage !== 'merged')
  )
  if (waiting) {
    const upstream = view.tasks.find((item) => item.id === waiting.dependsOn[0])
    return upstream
      ? `Waiting until "${upstream.title}" is merged.`
      : `"${waiting.title}" is waiting on a task that is not in this factory.`
  }
  if (view.stopAfter !== null && view.now >= view.stopAfter) {
    return 'The time cutoff has passed, so no new task will start.'
  }
  return null
}

export const FACTORY_MATERIALS = {
  maxBytes: 10 * 1024 * 1024,
  maxFiles: 20,
  maxNotes: 100,
  maxNoteLength: 4000
} as const
export interface FactoryFile {
  id: string
  name: string
  mime: string
  path: string
  bytes: number
  createdAt: number
  origin: 'reference' | 'output'
}
export interface FactoryMaterials {
  files: FactoryFile[]
  notes: { id: string; text: string; createdAt: number }[]
}
export type FactoryMaterialRequest =
  | { action: 'list'; taskId: string }
  | {
      action: 'add'
      taskId: string
      name: string
      data: Uint8Array
      origin: 'reference' | 'output'
    }
  | { action: 'note'; taskId: string; text: string }
  | { action: 'preview'; taskId: string; fileId: string }
  | { action: 'open'; taskId: string; folder: 'task' | 'code' }
export interface FactoryMaterialResult extends FactoryMaterials {
  preview?: string
}

export const FACTORY_ROLE_AGENT = {
  plan: 'Planner',
  prepare: 'Setup',
  build: 'Builder',
  check: 'Checker',
  review: 'Reviewer'
} as const

export function factoryAgentName(models: string[]): string {
  const last = models.at(-1) ?? ''
  const hit = /(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?!\d)/i.exec(last)
  if (!hit) return 'Claude Code'
  const family = hit[1][0].toUpperCase() + hit[1].slice(1).toLowerCase()
  return `Claude Code · ${family} ${hit[3] ? `${hit[2]}.${hit[3]}` : hit[2]}`
}

const NODE_WARNING =
  /^\(node:\d+\) |^\(Use `node --trace-|^Reparsing as ES module because|^To eliminate this warning, add "type"|^Preparing worktree \(/

export function withoutNodeWarnings(raw: string): string {
  return raw
    .split('\n')
    .filter((line) => !NODE_WARNING.test(line))
    .join('\n')
    .trim()
}

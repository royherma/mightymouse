import { z } from 'zod'
import { ONE_EMOJI_RE } from './swipe-suggest'

export const COORDINATION = {
  version: 2,
  route: '/coord/v1',
  mcpRoute: '/coord/v1/mcp',
  database: 'coordination.sqlite',
  keyFile: 'coordination-key.txt',
  enabledFile: 'coordination-enabled.txt',
  clientsDirectory: 'coordination-clients',
  leaseMs: 300_000,
  staleMs: 120_000,
  sessionTtlMs: 72 * 60 * 60 * 1000,
  abandonMs: 24 * 60 * 60 * 1000,
  pollMs: 5_000,
  maxBodyBytes: 32_768,
  maxSessionPending: 500,
  maxPage: 100,
  busyTimeoutMs: 2_000
} as const

const id = z.string().trim().min(1).max(200)
const text = z.string().trim().min(1).max(2_000)
const refs = z.array(z.string().trim().min(1).max(2_000)).max(5)
const emoji = z
  .string()
  .trim()
  .refine((v) => ONE_EMOJI_RE.test(v), 'Use exactly one emoji.')
export const HARNESS_NAMES = ['claude', 'codex', 'gemini', 'opencode', 'cli'] as const
export const WORK_STATES = ['working', 'blocked', 'complete', 'released'] as const
export const WORK_STAGES = ['scoped', 'implemented', 'verified', 'shipped', 'observed'] as const
export const RECEIPT_STATES = ['accepted', 'declined', 'completed'] as const
export const SESSION_STATES = ['active', 'idle', 'awaiting_input'] as const
export const PROJECT_STATES = ['active', 'archived'] as const

export const registrationSchema = z
  .object({
    project: id,
    projectName: id,
    session: id,
    harness: z.enum(HARNESS_NAMES),
    label: id,
    cwd: text,
    version: z.string().max(100).default('unknown')
  })
  .strict()

export const coordinationSchemas = {
  status: z.object({ cursor: z.number().int().nonnegative().default(0) }).strict(),
  inbox: z
    .object({ limit: z.number().int().min(1).max(COORDINATION.maxPage).default(20) })
    .strict(),
  send: z
    .object({
      to: id,
      key: id,
      subject: id,
      body: text,
      refs: refs.default([]),
      work: id.optional()
    })
    .strict(),
  ack: z
    .object({ message: id, state: z.enum(RECEIPT_STATES), note: z.string().max(2_000).default('') })
    .strict(),
  claim: z.object({ work: id, title: id, acceptance: text, emoji: emoji.optional() }).strict(),
  update: z
    .object({
      work: id,
      generation: z.number().int().positive(),
      state: z.enum(WORK_STATES),
      stage: z.enum(WORK_STAGES).optional(),
      emoji: emoji.optional(),
      note: text,
      refs: refs.default([])
    })
    .strict(),
  heartbeat: z.object({ state: z.enum(SESSION_STATES).default('active') }).strict(),
  project_add: z
    .object({ project: id, name: id, tags: z.array(id).max(10).default([]), order: z.number().int().default(0) })
    .strict(),
  project_update: z
    .object({
      project: id,
      name: id.optional(),
      tags: z.array(id).max(10).optional(),
      order: z.number().int().optional()
    })
    .strict(),
  project_archive: z.object({ project: id, archived: z.boolean().default(true) }).strict(),
  // The caller must already hold an approval receipt; the service refuses an unapproved delete.
  project_delete: z.object({ project: id, approval: id }).strict()
} as const

export type CoordinationOp = keyof typeof coordinationSchemas
export type CoordinationArgs<K extends CoordinationOp> = z.output<(typeof coordinationSchemas)[K]>
export type Registration = z.output<typeof registrationSchema>
export type SessionState = (typeof SESSION_STATES)[number]
export type WorkState = (typeof WORK_STATES)[number]
export type WorkStage = (typeof WORK_STAGES)[number]
export type ReceiptState = (typeof RECEIPT_STATES)[number]
export type ProjectState = (typeof PROJECT_STATES)[number]
export type CoordinationProject = {
  id: string
  name: string
  tags: string[]
  order: number
  state: ProjectState
  createdAt: number
  updatedAt: number
}
export type CoordinationSession = Registration & {
  id: string
  lastSeen: number
  state: SessionState
  stale: boolean
}
export type CoordinationMessage = {
  id: string
  project: string
  sender: string
  recipient: string
  subject: string
  body: string
  refs: string[]
  work: string | null
  state: 'pending' | ReceiptState
  note: string
  createdAt: number
  offeredAt: number | null
  updatedAt: number
}
export type CoordinationWork = {
  project: string
  id: string
  title: string
  acceptance: string
  owner: string
  generation: number
  expiresAt: number
  state: WorkState
  stage: WorkStage
  emoji: string
  note: string
  refs: string[]
  updatedAt: number
  expired: boolean
}
export type CoordinationEvent = {
  seq: number
  project: string
  actor: string
  kind: string
  target: string
  at: number
  detail: Record<string, unknown>
}
export type CoordinationSnapshot = {
  enabled: boolean
  version: number
  projects: CoordinationProject[]
  sessions: CoordinationSession[]
  work: CoordinationWork[]
  messages: CoordinationMessage[]
  events: CoordinationEvent[]
  cursor: number
  hasMore: boolean
  generatedAt: number
}

export const COORDINATION_TOOL_DESCRIPTIONS: Record<
  Exclude<CoordinationOp, 'heartbeat'>,
  string
> = {
  status:
    'Read this project’s owners, handoffs and evidence. A reported result still needs verification.',
  inbox: 'Read addressed pending or accepted handoffs. Reading does not acknowledge them.',
  send: 'Send a short handoff to a participant in this project, by participant ID, session ID or label. Reuse the same key when retrying.',
  ack: 'Accept, decline or complete a message addressed to this session. Acceptance is not completion.',
  claim:
    'Claim a work item exclusively for five minutes. Keep its returned generation for updates. Pick one emoji standing for what this work is, so people can scan the list.',
  update:
    'Update owned work using its current generation. Verification and release stages require evidence references. Send a new emoji when the work turns into something else.',
  project_add:
    'Name a project so people can find it. Joining a directory already creates one; this gives it a real name.',
  project_update: 'Rename a project or change how it is tagged and sorted. Its work is untouched.',
  project_archive:
    'Put a finished project away, or bring it back. Everything it holds is kept and nothing is removed.',
  project_delete:
    'Permanently remove a project and everything in it. The operator must approve it first; archive instead when unsure.'
}

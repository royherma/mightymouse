import { basename } from '../../shared/attachments'
import type { PhoneRemoteMessage, RelayProjectWire } from '../../shared/phone-remote-protocol'
import type { MightyProject, RepoPull } from '../../shared/types'
import { MIGHTY } from '../store/mighty'
import { sendToPhone } from '../phone-remote/server'
import { transcriptMedia, transcriptSession } from '../phone-remote/relay-http'
import { readSessionChecklist } from '../agent-relay/session-checklist'
import { readRunningHelpers, readSessionTools, readSessionTouched, readSessionTranscript } from '../agent-relay/session-transcript'
import { projectIdeas } from '../agent-relay/project-ideas'
import { addPulseListener, scorePulse, setPulseScope, stateFor } from '../agent-relay/session-pulse'
import { resolveSessionRef } from '../agent-relay/session-control'
import { repoGitChanges, repoGitMerge, repoGitOpenPull, repoGitPull, repoGitState } from '../agent-relay/repo-git'
import { toggleTurnUndo, withUndoStates } from '../agent-relay/checkpoints'
import { listMcpConnections } from './mcp-connections'
import { projectImageBase64 } from './phone-remote-chat'
import { takeReplyImagePath } from './phone-remote-share'
import { startCodeSession } from './agent-relay'
import { getAgentModel, isModelHarness, listAgentModels, setAgentModel } from '../voice-routing/agent-models'

type Msg<T extends PhoneRemoteMessage['type']> = Extract<PhoneRemoteMessage, { type: T }>

const REQUEST_ID = /^[\w-]{1,64}$/

function codeProjects(): MightyProject[] {
  return MIGHTY.listProjects().filter((p) => !p.archived && p.repoFolder)
}

function codeProject(id: unknown): MightyProject | undefined {
  return typeof id === 'string' ? codeProjects().find((p) => p.id === id) : undefined
}

export function handleRelayStartSession(msg: Msg<'relayStartSession'>): void {
  if (typeof msg.requestId !== 'string' || !REQUEST_ID.test(msg.requestId)) return
  const reply = (ok: boolean, reason?: string): void =>
    sendToPhone({ type: 'relaySessionStarted', requestId: msg.requestId, ok, reason, startedAt: Date.now() })
  const loose = msg.projectId === ''
  const project = loose ? undefined : codeProject(msg.projectId)
  if (!loose && !project?.repoFolder) return reply(false, 'That project is not on this Mac.')
  const text = typeof msg.text === 'string' ? msg.text.trim() : ''
  const image = typeof msg.attachLabel === 'string' ? takeReplyImagePath(msg.attachLabel) : undefined
  if (!text && !image) return reply(false, 'Say what you want done first.')
  const startedAt = Date.now()
  const asked = msg.harness === 'claude' || msg.harness === 'codex' ? msg.harness : undefined
  void (asked ? Promise.resolve(null) : getAgentModel().catch(() => null)).then((choice) => {
    const saved = choice?.model ? choice : null
    return startCodeSession({
      project: project?.name ?? '',
      cwd: project?.repoFolder ?? '',
      inApp: true,
      harness: asked ?? saved?.harness,
      model: asked ? undefined : saved?.model,
      message: text,
      paths: image ? [image] : []
    }).then((started) =>
      sendToPhone({
        type: 'relaySessionStarted',
        requestId: msg.requestId,
        ok: started.ok,
        reason: started.ok ? undefined : started.reason,
        startedAt
      })
    )
  })
}

const HARNESS_NAMES: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', cursor: 'Cursor', ollama: 'Local' }
const HARNESS_ICONS: Record<string, string> = { claude: 'claude', codex: 'codex', opencode: 'opencode', cursor: 'letter:C', ollama: 'local' }

export async function handleCodeGetModels(): Promise<void> {
  const options = await listAgentModels().catch(() => [])
  const current = await getAgentModel(options).catch(() => null)
  sendToPhone({
    type: 'models',
    scope: 'code',
    current: current ? `${current.harness}:${current.model}` : '',
    options: options.map((o) => ({
      id: `${o.harness}:${o.model}`,
      label: `${HARNESS_NAMES[o.harness]} · ${o.label}`,
      icon: HARNESS_ICONS[o.harness]
    }))
  })
}

export async function handleCodeSetModel(id: string): Promise<void> {
  const [harness, ...rest] = typeof id === 'string' ? id.split(':') : []
  if (!isModelHarness(harness)) return
  await setAgentModel({ harness, model: rest.join(':') })
  await handleCodeGetModels()
}

export function handleRelayProjects(): void {
  const projects: RelayProjectWire[] = codeProjects().map((p) => ({
    id: p.id,
    name: p.name,
    icon: p.icon,
    imageBase64: projectImageBase64(p.imagePath),
    pinned: p.pinned || undefined,
    folderName: basename(p.repoFolder ?? '')
  }))
  sendToPhone({ type: 'relayProjectList', projects })
}

export function handleRelayProjectIdeas(msg: Msg<'relayProjectIdeas'>): void {
  const project = codeProject(msg.projectId)
  if (!project?.repoFolder) return
  const mode = msg.mode === 'generate' || msg.mode === 'refresh' ? msg.mode : 'cached'
  void projectIdeas(project.repoFolder, project.name, [], mode)
    .catch(() => null)
    .then((result) =>
      sendToPhone({
        type: 'relayIdeas',
        projectId: project.id,
        ideas: result?.ideas ?? [],
        at: result?.at,
        stale: result?.stale
      })
    )
}

export async function handleRelaySessionTranscript(msg: Msg<'relaySessionTranscript'>): Promise<void> {
  const session = transcriptSession(msg.label)
  if (!session) {
    sendToPhone({ type: 'relayTranscript', label: msg.label, turns: [], reason: 'no-session' })
    return
  }
  const turns = (await withUndoStates(session, readSessionTranscript(session))).map((t) => {
    const media = transcriptMedia(t)
    const videos = media.flatMap((p, i) => (/\.(mp4|mov|m4v|webm)$/i.test(p) ? [i] : []))
    return { role: t.role, at: t.at, text: t.text, recap: t.recap, media: media.length || undefined, videos: videos.length ? videos : undefined, undo: t.undo }
  })
  sendToPhone({ type: 'relayTranscript', label: msg.label, turns, reason: turns.length ? undefined : 'no-transcript' })
}

export async function handleRelaySessionUndo(msg: Msg<'relaySessionUndo'>): Promise<void> {
  const session = transcriptSession(msg.label)
  const result = session && Number.isFinite(msg.at)
    ? await toggleTurnUndo(session, msg.at, Object.keys(readSessionTouched(session).edits))
    : { ok: false as const, error: 'This session is gone.' }
  sendToPhone({ type: 'relaySessionUndone', label: msg.label, at: msg.at, result })
  await handleRelaySessionTranscript({ type: 'relaySessionTranscript', label: msg.label })
}

export function handleRelaySessionInfo(msg: Msg<'relaySessionInfo'>): void {
  const session = transcriptSession(msg.label)
  if (!session) return
  const tools = readSessionTools(session).map((t) => ({ name: t.name, kind: t.kind, calls: t.calls, lastAt: t.lastAt }))
  const connections = session.cwd ? listMcpConnections(session.cwd) : Promise.resolve([])
  void connections
    .catch(() => [])
    .then((list) =>
      sendToPhone({
        type: 'relayInfo',
        label: msg.label,
        checklist: readSessionChecklist(session.sessionId),
        helpers: readRunningHelpers(session),
        tools,
        mcpList: list.map((c) => ({ name: c.name, scope: c.scope }))
      })
    )
}

const GIT_OPS = new Set<string>(['status', 'open', 'merge'])

export async function handleRelaySessionGit(msg: Msg<'relaySessionGit'>): Promise<void> {
  if (typeof msg.label !== 'string' || msg.label.trim() === '') return
  if (!GIT_OPS.has(msg.op)) return
  const { label, op } = msg
  const reply = (rest: { github?: boolean; dirty?: number; pull?: RepoPull | null; files?: number; added?: number; removed?: number; error?: string }): void =>
    sendToPhone({ type: 'relaySessionGitState', label, op, github: false, dirty: 0, pull: null, files: 0, added: 0, removed: 0, ...rest })
  const session = resolveSessionRef(label)
  if (!session) return reply({ error: 'This session is gone.' })
  if (op !== 'status' && session.staleSince !== undefined) return reply({ error: 'This session has ended.' })
  const done = op === 'open' ? await repoGitOpenPull(label) : op === 'merge' ? await repoGitMerge(label) : null
  const [state, changes, polled] = await Promise.all([repoGitState(label), repoGitChanges(label), done?.ok ? null : repoGitPull(label)])
  reply({
    github: state?.remoteHost === 'GitHub',
    dirty: state?.dirty ?? 0,
    pull: done?.ok ? done.pull : polled,
    files: changes?.files.length ?? 0,
    added: changes?.files.reduce((n, f) => n + (f.added ?? 0), 0) ?? 0,
    removed: changes?.files.reduce((n, f) => n + (f.removed ?? 0), 0) ?? 0,
    error: done && !done.ok ? done.error : undefined
  })
}

const pulseWatch = new Map<string, string>()

function sendPulse(label: string): void {
  sendToPhone({ type: 'pulseState', label, state: stateFor(label) })
}

function watchPulse(label: unknown): label is string {
  if (typeof label !== 'string' || label === '') return false
  const sessionId = resolveSessionRef(label)?.sessionId
  if (!sessionId) return false
  if (pulseWatch.size === 0) addPulseListener((id) => {
    const labels = id === '' ? [...pulseWatch.values()] : [pulseWatch.get(id)]
    for (const label of labels) if (label) sendPulse(label)
  })
  pulseWatch.set(sessionId, label)
  return true
}

export function handlePulseGet(msg: Msg<'pulseGet'>): void {
  if (watchPulse(msg.label)) sendPulse(msg.label)
}

export function handlePulseScore(msg: Msg<'pulseScore'>): void {
  if (!watchPulse(msg.label)) return
  scorePulse(msg.label, msg.force === true)
  sendPulse(msg.label)
}

export function handlePulseSetScope(msg: Msg<'pulseSetScope'>): void {
  if (watchPulse(msg.label)) setPulseScope(msg.label, msg.scope)
}

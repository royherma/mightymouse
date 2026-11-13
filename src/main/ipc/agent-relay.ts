/**
 * Code agent relay IPC — the Settings toggle,
 * health line, and "Send test notification" button. Starting/stopping the MCP
 * listener itself lives in agent-relay/mcp/http-listener.ts; this module is
 * just the glue Settings talks to, mirroring registerPhoneRemoteHandlers()'s
 * toggle shape one level down in complexity (no QR, no pairing).
 */
import { app, ipcMain } from 'electron'
import { computeSessionPriority, claimSuggestedReply } from '../agent-relay/coordination/session-priority'
import { priorityKey, type SuggestedReply } from '../../shared/session-priority'
import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { PATHS } from '../store/paths'
import { resolveBinary } from '../platform'
import { HARNESS_NAMES } from '../../shared/coordination'
import { CHANNELS } from '../../shared/ipc'
import {
  checkIdeaDone,
  projectIdeaFeedback,
  projectIdeas,
  sessionFirstAsk,
  sessionAiTitle,
  type ProjectIdeasMode
} from '../agent-relay/project-ideas'
import { continueConductorWorkspace, listConductorWorkspaces } from '../agent-relay/conductor-import'
import { agentMessageBody, browserPageTag, cleanAttachmentPaths } from '../../shared/attachments'
import type { AgentHarness, AgentRelayStatus, AgentRelaySessionInfo, ChangeScope, McpClientId, SessionMark } from '../../shared/types'
import { importSessionArchive, markSession, rememberedSession, withRememberedSessions } from '../agent-relay/session-archive'
import type { RelayVerbWire } from '../../shared/phone-remote-protocol'
import {
  RELAY_PUSH_VERBS,
  type RelayMacAlertSettings,
  type RelayNotifyPushLevel,
  type RelayPushSettings
} from '../../shared/relay-push-filter'
import { PREFS } from '../store/prefs'
import { track } from '../analytics'
import { AGENT_SESSIONS } from '../store/agent-sessions'
import { startHandoffDelivery } from '../agent-relay/coordination/delivery'
import { ANALYTICS_EVENT, type SettingKey } from '../../shared/analytics-events'
import {
  startAgentRelayMcp,
  stopAgentRelayMcp,
  isAgentRelayMcpRunning,
  lastAgentContact,
  liveAgentSessions,
  listedAgentSessions,
  setAgentSessionsListener,
  getCoordinationService,
  setSessionTurnStartedListener,
  addSessionTurnEndedListener,
  sessionCompactingSince,
  setAgentSessionBusy,
  type AgentSession
} from '../agent-relay/mcp/http-listener'
import { isGeneratedTag, isPlaceholderName, nameFromMessage, sessionActiveAt, splitIdentity } from '../../shared/relay-status'
import { publishedNameFor } from '../agent-relay/mcp/published-names'
import { recordOpeningTurn, sendToSession, sentTurnsFor } from './phone-remote-chat'
import { routeTask } from '../agent-relay/task-router'
import type { TaskCandidate } from '../../shared/task-route'
import { setPageReplyHost } from '../agent-relay/page-reply'
import { computeAttention } from '../agent-relay/coordination/attention'
import { MIGHTY } from '../store/mighty'
import { projectImageBase64 } from './phone-remote-chat'
import { mightyProjectForCwd } from '../../shared/relay-sessions'
import { resolveOrigin, cachedWhereLabel, warmTabName, livesInApp, fitHiddenPane } from '../agent-relay/origin-resolver'
import { watchPane } from '../agent-relay/pane-stream'
import { cachedHostApp, warmHostApp } from '../agent-relay/host-app-icon'
import { endAgentDriving } from '../side-browser'
import { answerStartup, capturePaneScreen, peekStartup, sendPaneKeys, sendPickerAnswer, type PaneKey } from '../agent-relay/picker-keys'
import { noProjectFolder, watchStartup } from '../agent-relay/startup-watch'
import { homedir } from 'os'
import { canWrapUp, resolveSessionRef, startSessionWrap } from '../agent-relay/session-control'
import { makeConversationCopy, repoGitChanges, repoGitMerge, repoGitOpenPull, repoGitPull, repoGitPush, repoGitState } from '../agent-relay/repo-git'
import { SETTINGS } from '../store/settings'
import { saveCheckpoint, toggleTurnUndo, withUndoStates } from '../agent-relay/checkpoints'
import {
  availableHarnesses,
  defaultCodeUiHarness,
  showHiddenSession,
  startNewAgent,
  type NewAgentFailure,
  type NewAgentSink
} from '../voice-routing/new-agent-sink'
import { checklistProgress, readSessionChecklist } from '../agent-relay/session-checklist'
import {
  agentModelsState,
  agentReasoningEfforts,
  checkOpencodeModel,
  OPENCODE_QUIET_ENV,
  isModelHarness,
  listChatSourceModels,
  ollamaLaunch,
  setAgentModel,
  setUpAgentProvider
} from '../voice-routing/agent-models'
import {
  readRunningHelpers,
  readSessionTools,
  readSessionTouched,
  readSessionUsage,
  sessionAccountHome,
  readSessionTranscript,
  claudeTranscriptPaths
} from '../agent-relay/session-transcript'
import { affectsRecordAbove } from '../infra/scan'
import { askSideQuestion } from '../agent-relay/side-question'
import { pickedLoginEnv, planAccountFor } from '../backend/plan-logins'
import { planTierLabel } from '../../shared/plan-logins'
import { NO_AFFECTS, sessionAffects, type SessionAffects } from '../../shared/surfaces'
import { codexThreadFor, watchCodexThreads, withCodexThreads } from '../agent-relay/codex-threads'
import { CONFIG } from '../../shared/config'
import { isReasoningEffort } from '../../shared/model-sources'
import { devLog } from '../../shared/env'
import { relayRequestStore, onRelayStoreChanged, onRelayStalled, handoffResolver, type RelayResponse, type RelayResolvedVia } from '../agent-relay/store'
import { relaySnapshot } from '../agent-relay/wire'
import { senderMatchKey } from '../../shared/relay-cards'
import { sendRelayPush, sendRelayClearPush } from '../agent-relay/relay-send'
import { detectMcpClients, configureMcpClient, opencodeRelayEnv } from '../agent-relay/mcp-clients'
import { pushableDevice, sendToPhone } from '../phone-remote/server'
import { sendToPanelRenderer } from '../panel-window'
import { sendToSettingsRenderer } from '../settings-window'
import { getMightyWindow } from '../mighty/mighty-window'
import { sendToCompanion } from '../companion-window'
import { startRelayHud, dismissRelayHud } from '../hud-window'
import type { RelayResponseWire } from '../../shared/phone-remote-protocol'


/** The shim packs "repo/branch - tag" into one string, and when it had nothing
 *  better the tag is the head of the session id. That head is the only handle
 *  back to the name file, so it is pulled off the label rather than guessed. */
function idHead(label: string): string | undefined {
  const cut = label.lastIndexOf(' - ')
  return cut === -1 ? undefined : label.slice(cut + 3).trim() || undefined
}

export function rowName(s: AgentSession): string | undefined {
  const stated = s.stated ?? publishedNameFor(idHead(s.label)) ?? idHead(s.label)
  const { repo, branch } = splitIdentity(s.label)
  if (stated && !isGeneratedTag(stated) && !isPlaceholderName(stated, branch ?? repo)) return stated
  const late = pastNamingWait(s)
  const title = late && sessionAiTitle(late.cwd, late.sessionId)
  if (title) return title
  const ask = sentTurnsFor(s.sessionId ?? s.label)[0]?.text ?? (late && sessionFirstAsk(late.cwd, late.sessionId))
  return nameFromMessage(ask || undefined) ?? (isGeneratedTag(stated) ? undefined : stated)
}

function pastNamingWait(s: AgentSession): { cwd: string; sessionId: string } | undefined {
  if (!s.cwd || !s.sessionId || Date.now() - s.since < CONFIG.AGENT_RELAY.NAMING_WAIT_MS) return undefined
  return { cwd: s.cwd, sessionId: s.sessionId }
}

function reasonText(result: { reason: NewAgentFailure; detail: string }, harness: string): string {
  if (result.reason === 'cli-missing') return `${result.detail || harness} isn't installed`
  if (result.reason === 'no-terminal') return 'no terminal to open it in'
  return "the terminal didn't start"
}

function isAgentHarness(value: unknown): value is AgentHarness {
  return value === 'claude' || value === 'codex' || value === 'opencode' || value === 'cursor' || value === 'tmux'
}

function isDirectory(cwd: string): boolean {
  try {
    return statSync(cwd).isDirectory()
  } catch {
    return false
  }
}

export function currentStatus(): AgentRelayStatus {
  const enabled = PREFS.getAgentRelayEnabled()
  const running = isAgentRelayMcpRunning()
  if (!enabled || !running) return { enabled, running }

  const seen = lastAgentContact()
  const live = withCodexThreads(liveAgentSessions())
  // Count only what's live; list the faded ones too, so a blip doesn't make the
  // list jump while the number stays honest.
  const listed = withCodexThreads(listedAgentSessions())

  // A card's `from` is the STATED name, so that -- not the label -- is the join.
  // A card whose sender never named itself matches nothing and leaves every
  // session at rest, rather than blaming whichever one sorts first.
  const waitingBySender = new Map<string, number>()
  for (const r of relayRequestStore.listPending()) {
    const from = r.params.from
    if (!from) continue
    const key = senderMatchKey(from)
    waitingBySender.set(key, (waitingBySender.get(key) ?? 0) + 1)
  }
  const idleFor = handoffResolver(listed)
  const openProjects = MIGHTY.listProjects().filter((p) => !p.archived)

  const rows: AgentRelaySessionInfo[] = listed.map((s) => {
      const waiting = waitingBySender.get(senderMatchKey(s.stated ?? s.label)) ?? 0
      // Both resolvers spawn and this is synchronous, so warm here and read only
      // the CACHE below -- the first pass has no origin rows, the next one does.
      const hostBundleId = s.origin?.cmuxBundleId ?? s.origin?.hostBundleId
      warmHostApp(hostBundleId, onOriginResolved)
      warmTabName(s.origin, onOriginResolved)
      const hostApp = cachedHostApp(hostBundleId)
      const project = mightyProjectForCwd(s.cwd, openProjects)
      return {
        label: s.label,
        project: project
          ? { name: project.name, icon: project.icon, imageBase64: projectImageBase64(project.imagePath) }
          : undefined,
        // A shim too old to send its own name still has one published on this
        // Mac -- recovering it here is what turns a row of hex back into
        // "mm-look-last-commits-repo" without waiting for the agent to restart.
        stated: rowName(s),
        stale: s.staleSince !== undefined,
        // Both, not one: `stale` is what every surface branches on today, while
        // the raw stamp is what lets a card age the word ("Ended 3m ago").
        staleSince: s.staleSince,
        cwd: s.cwd,
        since: s.since,
        pid: s.facts?.pid,
        // The shim sends these on every call and they were parsed and dropped
        // right here. Passing them through is the whole of "the card says which
        // agent is running" -- no protocol change, no shim republish.
        agent: s.facts?.agent,
        effort: s.facts?.effort,
        model: s.facts?.model,
        entrypoint: s.facts?.entrypoint,
        sessionId: s.sessionId,
        origin: s.origin,
        hostAppName: hostApp?.name,
        hostAppIconPngBase64: hostApp?.iconPngBase64,
        whereLabel: cachedWhereLabel(s.origin),
        waiting,
        idleSince: idleFor(s),
        // Same value, second field: the phone spends `idleSince` once the row
        // has been seen, and the "waiting 14m" caption has to outlive that.
        handedBackAt: idleFor(s),
        // Straight off the session, not joined by sender name like `idleSince`:
        // the hooks address a row by session id, so this needs no matching and
        // cannot land on the wrong pane in a checkout that shares a name.
        busySince: s.busySince,
        lastActivityAt: s.lastActivityAt,
        lastTurnEndedAt: s.lastTurnEndedAt,
        compactingSince: sessionCompactingSince(s.sessionId),
        canWrapUp: canWrapUp(s),
        tldr: s.tldr,
        // Straight off the session like `busySince`: the agent declares how far
        // along IT is, so this needs no sender-name join and cannot be blanked
        // by a card the detail sheet fails to match.
        progress: s.progress ?? checklistProgress(s.sessionId)
      }
    })
  const remembered = withRememberedSessions(rows)
  const projectRank = new Map(openProjects.filter((p) => p.repoFolder).map((p, i) => [p.name, i] as const))
  const rankOf = (s: AgentRelaySessionInfo): number => projectRank.get(s.project?.name ?? '') ?? Infinity
  remembered.sessions.sort(
    (a, b) => rankOf(a) - rankOf(b) || Number(!!a.stale) - Number(!!b.stale) || sessionActiveAt(b) - sessionActiveAt(a)
  )
  const agent = {
    lastAgentAt: seen?.at ?? null,
    lastAgentFrom: seen?.from,
    agentCount: live.length,
    agentNames: live.map((s) => s.label),
    agentSessions: remembered.sessions,
    sessionMarks: remembered.marks
  }

  const device = pushableDevice()
  if (device.deviceId === null) {
    const reason =
      device.reason === 'no-device'
        ? 'No phone paired yet. Pair one above to get pushes.'
        : 'Your paired phone has not registered for pushes yet. Open MightyMouse on it once.'
    return { enabled, running, reason, ...agent }
  }
  return { enabled, running, deviceLabel: device.label, ...agent }
}

/** All three Code surfaces (panel + Mighty tab + the phone's sheet) read one
 *  status, so a session opening can never leave them disagreeing about how many
 *  agents are connected. The phone goes over the socket rather than IPC, but it
 *  is the same object and the same moment -- see relay-status.ts for the shared
 *  formatter that turns it into the strip both sides render. */
/** Both origin lookups are async while `currentStatus()` is synchronous, so the
 *  status that triggered them ships without the App/Where rows. This re-sends
 *  once a lookup lands. It cannot loop: the re-send's warm calls find the value
 *  cached and fire nothing. */
function onOriginResolved(): void {
  broadcastStatus()
}

export function markAgentSession(
  session: AgentRelaySessionInfo,
  change: SessionMark,
  source: 'mac' | 'phone'
): void {
  if (typeof session?.label !== 'string') return
  markSession(session, change)
  if (change.archived) AGENT_SESSIONS.archived(source)
  broadcastStatus()
}

export function importAgentSessionArchive(entries: unknown): void {
  try {
    importSessionArchive(entries)
  } catch (err) {
    devLog.warn('[agent-relay] session archive import rejected', String(err))
    return
  }
  broadcastStatus()
}

function broadcastStatus(): void {
  const status = currentStatus()
  sendToPanelRenderer(CHANNELS.agentRelayStatusChanged, status)
  getMightyWindow()?.webContents.send(CHANNELS.agentRelayStatusChanged, status)
  sendToCompanion(CHANNELS.agentRelayStatusChanged, status)
  sendToPhone({ type: 'relayStatus', status })
}

/** Cards go to both surfaces for the same reason the status does: sending only
 *  to the panel left the Mighty tab on whatever it fetched at mount, so an ask
 *  that arrived later showed in the HUD and never in the list. */
function broadcastRequests(): void {
  const snapshot = relaySnapshot(true)
  sendToPanelRenderer(CHANNELS.agentRelayRequestsChanged, snapshot)
  getMightyWindow()?.webContents.send(CHANNELS.agentRelayRequestsChanged, snapshot)
  sendToCompanion(CHANNELS.agentRelayRequestsChanged, snapshot)
}

/** Spelled out rather than built with a template literal, so SettingKey stays a
 *  closed union the compiler can check both ends of. */
const PUSH_FILTER_SETTING_KEY: Record<RelayVerbWire, SettingKey> = {
  ask: 'agent_relay_push_ask',
  approve: 'agent_relay_push_approve',
  notify: 'agent_relay_push_notify',
  show: 'agent_relay_push_show',
  photos_get: 'agent_relay_push_photos_get'
}

/** The ONE writer -- Mac Settings over IPC and the phone's alerts sheet over WS
 *  both land here, and each broadcast keeps the other surface correct.
 *  One verb per call, never the whole object: two switches flipped in quick
 *  succession would race and the loser would restore what the user just cleared. */
export function setRelayPushVerb(verb: RelayVerbWire, on: boolean): RelayPushSettings {
  if (!RELAY_PUSH_VERBS.includes(verb)) return currentPushSettings()
  PREFS.setAgentRelayPushFilter({ ...PREFS.getAgentRelayPushFilter(), [verb]: on === true })
  track(ANALYTICS_EVENT.setting_toggled, {
    key: PUSH_FILTER_SETTING_KEY[verb],
    value: String(on === true)
  })
  return broadcastPushSettings()
}

/** The notify severity floor. Same one writer, same two-surface broadcast as the
 *  verbs above: it is the same stored file and the same screen. */
export function setRelayNotifyLevel(level: RelayNotifyPushLevel): RelayPushSettings {
  const next: RelayNotifyPushLevel = level === 'problems' ? 'problems' : 'all'
  PREFS.setAgentRelayNotifyLevel(next)
  track(ANALYTICS_EVENT.setting_toggled, {
    key: 'agent_relay_push_notify_level',
    value: next
  })
  return broadcastPushSettings()
}

/** The turn-end ping. Same one writer and same broadcast as the two above, but
 *  the value is CONSUMED outside this process: the Stop hook reads the stored
 *  JSON. Nothing here has to act on it -- writing and broadcasting is the whole
 *  job, because no send path in the app fires that ping. */
export function setRelayTurnEndPing(on: boolean): RelayPushSettings {
  PREFS.setAgentRelayTurnEndPing(on === true)
  track(ANALYTICS_EVENT.setting_toggled, {
    key: 'agent_relay_push_turn_end',
    value: String(on === true)
  })
  return broadcastPushSettings()
}

function currentPushSettings(): RelayPushSettings {
  return {
    filter: PREFS.getAgentRelayPushFilter(),
    notifyLevel: PREFS.getAgentRelayNotifyLevel(),
    turnEndPing: PREFS.getAgentRelayTurnEndPing()
  }
}

/** Re-reads from PREFS rather than taking the caller's value, so both surfaces
 *  render what was actually stored. */
function broadcastPushSettings(): RelayPushSettings {
  const next = currentPushSettings()
  sendToSettingsRenderer(CHANNELS.agentRelayPushFilterChanged, next)
  sendToPhone({ type: 'relayPushFilter', ...next })
  return next
}

function refreshCoordinationScript(): string {
  const directory = join(PATHS.ROOT, 'bin')
  mkdirSync(directory, { recursive: true })
  const script = join(directory, 'mm-coord')
  copyFileSync(app.isPackaged ? join(process.resourcesPath, 'mm-coord') : join(app.getAppPath(), 'bin', 'mm-coord'), script)
  return script
}

const COORDINATION_HOOK_MARKER = '# mm-coordination'

async function installCoordinationHooks(onlyWhereInstalled: boolean): Promise<string[]> {
  const script = refreshCoordinationScript()
  const node = resolveBinary('node')
  const run = (harness: string, ...extra: string[]): Promise<{ stdout: string; stderr: string }> =>
    promisify(execFile)(node ?? process.execPath, [script, 'install', '--harness', harness, '--scope', 'user', ...extra], {
      timeout: 5_000, env: { ...process.env, MM_COORD_ROOT: PATHS.ROOT, ...(!node ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }
    })
  const lines: string[] = []
  for (const harness of HARNESS_NAMES) {
    if (harness === 'cli') continue
    if (!resolveBinary(harness)) { lines.push(harness + ': not found on this Mac.'); continue }
    try {
      if (onlyWhereInstalled) {
        const check = await run(harness, '--check').then((r) => r.stdout, (e: { stdout?: string }) => e.stdout ?? '')
        const { path, current } = JSON.parse(check) as { path: string; current: boolean }
        if (current || !existsSync(path) || !readFileSync(path, 'utf8').includes(COORDINATION_HOOK_MARKER)) continue
      }
      await run(harness)
      lines.push(harness === 'codex' ? 'Codex: configured. Review the hooks in Codex, then start a new conversation.'
        : harness + ': configured for new conversations. A handoff still needs to be tested.')
    } catch (error) {
      lines.push(harness + ': ' + (error instanceof Error ? error.message : 'Setup failed.'))
    }
  }
  return lines
}

// Hooks another copy installed dial this copy's port with that copy's key, so the port holder re-points them.
export async function adoptCoordinationHooks(): Promise<void> {
  if (!getCoordinationService().isEnabled()) return
  const lines = await installCoordinationHooks(true)
  if (lines.some((l) => l.includes('configured'))) console.log('[coordination] hooks re-pointed to this copy', lines)
}

const codeSessionHarness = new Map<string, AgentHarness>()
const codeSessionCompleted = new Set<string>()

export async function startCodeSession(
  input: unknown
): Promise<{ ok: true; pane: string } | { ok: false; reason: string }> {
  const row =
    input !== null && typeof input === 'object'
      ? (input as {
          project?: unknown
          cwd?: unknown
          harness?: unknown
          inApp?: unknown
          message?: unknown
          paths?: unknown
          model?: unknown
          resume?: unknown
          think?: unknown
          effort?: unknown
          plan?: unknown
        })
      : null
  const askedProject = typeof row?.project === 'string' ? row.project : ''
  const askedCwd = typeof row?.cwd === 'string' ? row.cwd : ''
  const loose = askedProject.trim() === '' && askedCwd.trim() === ''
  const project = loose ? CONFIG.UI_LABELS.CODE_NO_PROJECT : askedProject
  let cwd = loose ? noProjectFolder() : askedCwd
  if (project.trim() === '' || cwd.trim() === '') {
    return { ok: false as const, reason: 'Pick a project folder first.' }
  }
  if (!isAbsolute(cwd) || !isDirectory(cwd)) {
    return { ok: false as const, reason: 'That folder is not on this Mac.' }
  }
  const resuming = typeof row?.resume === 'string' && row.resume.trim() !== ''
  if (!loose && !resuming && SETTINGS.get().codeOwnCopy === true) {
    const copy = await makeConversationCopy(cwd, typeof row?.message === 'string' ? row.message : '')
    if ('error' in copy) return { ok: false as const, reason: copy.error }
    cwd = copy.cwd
  }
  const inApp = row?.inApp === true
  const local = row?.harness === 'ollama'
  const requested = local ? 'claude' : row?.harness
  let harness: AgentHarness
  if (requested === undefined || requested === null) {
    const first = inApp ? defaultCodeUiHarness() : availableHarnesses()[0]
    if (!first) {
      return { ok: false as const, reason: reasonText({ reason: 'no-terminal', detail: '' }, '') }
    }
    harness = first
  } else if (!isAgentHarness(requested)) {
    return { ok: false as const, reason: reasonText({ reason: 'no-terminal', detail: '' }, '') }
  } else {
    harness = requested
  }
  const sink: NewAgentSink = {
    kind: 'new-agent',
    id: `new-agent:${project}`,
    label: `New agent in ${project}`,
    description: `Start a coding agent in ${project}.`,
    project,
    cwd,
    hostBundleId: ''
  }
  const said = typeof row?.message === 'string' ? row.message.trim() : ''
  const files = cleanAttachmentPaths(row?.paths)
  const message = agentMessageBody(files, said)
  let model = typeof row?.model === 'string' ? row.model : ''
  let env: Record<string, string> | undefined
  if (local) {
    const launch = await ollamaLaunch(model)
    if ('error' in launch) return { ok: false as const, reason: launch.error }
    model = launch.model
    env = launch.env
  }
  const resume = typeof row?.resume === 'string' && /^[\w-]{8,}$/.test(row.resume) ? row.resume : ''
  if (resume !== '' && harness !== 'claude' && harness !== 'codex' && harness !== 'cursor') {
    return { ok: false as const, reason: 'This agent cannot pick up where it left off.' }
  }
  if (resume !== '' && harness === 'claude') {
    const saved = claudeTranscriptPaths(homedir(), cwd, resume).find((path) => existsSync(path))
    if (!saved) return { ok: false as const, reason: 'This conversation is no longer saved on this Mac, so it cannot pick up where it left off.' }
    const configDir = dirname(dirname(dirname(saved)))
    if (configDir !== join(homedir(), '.claude')) env = { ...env, CLAUDE_CONFIG_DIR: configDir }
  }
  if (!local && resume === '') env = { ...env, ...pickedLoginEnv(harness) }
  if (harness === 'opencode') {
    const problem = await checkOpencodeModel(model)
    if (problem) return { ok: false as const, reason: problem }
    env = { ...env, ...OPENCODE_QUIET_ENV, ...opencodeRelayEnv() }
  }
  const knownEfforts = agentReasoningEfforts(local ? 'ollama' : harness, model)
  if (row?.effort !== undefined && (!isReasoningEffort(row.effort) || (knownEfforts.length > 0 && !knownEfforts.includes(row.effort)))) {
    devLog.warn(`[code] effort refused harness=${harness} model=${model} effort=${String(row.effort)} known=${knownEfforts.join(',')}`)
    return { ok: false as const, reason: 'That reasoning level is not available for this model. Pick another level.' }
  }
  const started = await startNewAgent(sink, message, harness, {
    reveal: !inApp,
    model,
    resume,
    env,
    think: local || typeof row?.think !== 'boolean' ? undefined : row.think,
    effort: isReasoningEffort(row?.effort) ? row.effort : undefined,
    plan: row?.plan === true,
    readDirs: [...new Set(files.filter(isAbsolute).map(dirname))].filter((dir) => dir !== cwd && !dir.startsWith(`${cwd}/`))
  })
  if (!started.ok) return { ok: false as const, reason: reasonText(started, harness) }
  codeSessionHarness.set(started.pane, harness)
  if (inApp && started.pane !== '') watchStartup({ pane: started.pane, from: project, cwd })
  track(ANALYTICS_EVENT.code_session_started, { harness })
  if (resume !== '') return { ok: true as const, pane: started.pane }
  recordOpeningTurn({ pane: started.pane, cwd }, said, files)
  return { ok: true as const, pane: started.pane }
}

export function registerAgentRelayHandlers(): void {
  // Hooks run this copy, not the bundled one, so a stale copy silently runs old code.
  if (getCoordinationService().isEnabled()) {
    try { refreshCoordinationScript() } catch { /* A read-only data dir must not stop startup. */ }
  }

  startHandoffDelivery()
  ipcMain.handle(CHANNELS.coordinationGet, () => getCoordinationService().snapshot())
  ipcMain.handle(CHANNELS.coordinationAttention, (_e, relaySessions: AgentRelaySessionInfo[] | { requestId: string; skip?: string[] }) => {
    if (!Array.isArray(relaySessions) && typeof relaySessions?.requestId === 'string') {
      const skip = new Set(Array.isArray(relaySessions.skip) ? relaySessions.skip : [])
      const live = (currentStatus().agentSessions ?? []).filter((s) => !skip.has(priorityKey(s)))
      return computeSessionPriority(live, relaySessions.requestId, getCoordinationService().snapshot())
    }
    if (!Array.isArray(relaySessions)) throw new Error('Missing the running agents to check.')
    return computeAttention(relaySessions)
  })
  ipcMain.handle(CHANNELS.coordinationSetEnabled, async (_e, enabled: boolean) => {
    if (typeof enabled !== 'boolean') throw new Error('Choose whether shared work is on.')
    if (enabled) {
      const result = await startAgentRelayMcp()
      if (!result.ok) throw new Error(result.reason)
      PREFS.setAgentRelayEnabled(true)
    }
    return getCoordinationService().setEnabled(enabled)
  })
  ipcMain.handle(CHANNELS.coordinationRenameProject, (_e, project: string, name: string) => {
    if (typeof project !== 'string' || typeof name !== 'string' || !name.trim())
      throw new Error('Give the project a name.')
    MIGHTY.patchProjectByAgentId(project, { name: name.slice(0, 120) })
    return getCoordinationService().renameProject(project, name.slice(0, 120))
  })
  ipcMain.on(CHANNELS.agentSessionMark, (_e, session: AgentRelaySessionInfo, change: SessionMark) =>
    markAgentSession(session, change, 'mac')
  )
  ipcMain.on(CHANNELS.agentSessionImport, (_e, entries: unknown) => importAgentSessionArchive(entries))
  ipcMain.handle(CHANNELS.coordinationArchiveProject, (_e, project: string, archived: boolean) => {
    if (typeof project !== 'string' || typeof archived !== 'boolean')
      throw new Error('Choose whether this project is put away.')
    MIGHTY.patchProjectByAgentId(project, { archived })
    return getCoordinationService().archiveProject(project, archived)
  })
  ipcMain.handle(CHANNELS.coordinationSetup, async () => {
    if (!getCoordinationService().isEnabled()) throw new Error('Turn on shared work first.')
    if (!isAgentRelayMcpRunning())
      throw new Error('Another MightyMouse is handling Claude Code. Pick this one in the menu bar under "' + CONFIG.UI_LABELS.ACTIVE_COPY_SUBMENU + '" first.')
    return installCoordinationHooks(false)
  })
  setAgentSessionsListener(broadcastStatus)
  setPageReplyHost({
    find: resolveSessionRef,
    send: (session, text, files, context) => sendToSession(session, text, files, { context }),
    start: (input) => startCodeSession({ ...input, inApp: true }),
    byPane: (pane) => listedAgentSessions().find((s) => s.staleSince === undefined && s.origin?.tmuxPane === pane)
  })
  watchCodexThreads(broadcastStatus)

  // A person typing into a session answers its "your turn" ping by construction,
  // so the lock-screen card naming it is dead the moment this fires. Those
  // notifies settle at mint and never reach the store's change feed as a
  // retirement, which is why the clear cannot hang off `onRelayStoreChanged`
  // like every other card's does -- nothing there ever fires for them.
  //
  // Only cards OLDER than the turn are cleared: a notify minted mid-turn is
  // about the work now in flight, and retiring it here would delete a card the
  // agent had just posted. Fire-and-forget, same as every other clear: a
  // resolution must never wait on, or fail because of, a push.
  setSessionTurnStartedListener((sessionId) => {
    const session = liveAgentSessions().find((s) => s.sessionId === sessionId)
    if (session) void saveCheckpoint(session).catch((e: unknown) => devLog.warn('[checkpoints] save failed', e))
    const senderKey = session?.label ? senderMatchKey(session.label) : undefined
    const startedAt = Date.now()
    for (const request of relayRequestStore.idleNotifiesForSession(sessionId, senderKey)) {
      if (request.createdAt > startedAt) continue
      void sendRelayClearPush(request)
    }
  })

  addSessionTurnEndedListener((sessionId) => {
    if (codeSessionCompleted.has(sessionId)) return
    const pane = liveAgentSessions().find((s) => s.sessionId === sessionId)?.origin?.tmuxPane
    const harness = pane ? codeSessionHarness.get(pane) : undefined
    if (!harness) return
    codeSessionCompleted.add(sessionId)
    track(ANALYTICS_EVENT.code_session_completed, { harness, ok: true })
  })

  ipcMain.handle(CHANNELS.agentRelaySetEnabled, async (_e, on: boolean) => {
    const next = on === true
    PREFS.setAgentRelayEnabled(next)
    track(ANALYTICS_EVENT.setting_toggled, { key: 'agent_relay', value: String(next) })

    if (!next) {
      getCoordinationService().setEnabled(false)
      stopAgentRelayMcp()
      return currentStatus()
    }
    const result = await startAgentRelayMcp()
    if (!result.ok) {
      PREFS.setAgentRelayEnabled(false)
      return { enabled: false, running: false, reason: result.reason } satisfies AgentRelayStatus
    }
    return currentStatus()
  })

  ipcMain.handle(CHANNELS.agentRelayGetStatus, () => currentStatus())

  ipcMain.handle(CHANNELS.agentRelayGetPushFilter, () => currentPushSettings())

  ipcMain.handle(
    CHANNELS.agentRelaySetPushFilter,
    (_e, verb: RelayVerbWire, on: boolean): RelayPushSettings => setRelayPushVerb(verb, on)
  )

  ipcMain.handle(
    CHANNELS.agentRelaySetNotifyLevel,
    (_e, level: RelayNotifyPushLevel): RelayPushSettings => setRelayNotifyLevel(level)
  )

  ipcMain.handle(
    CHANNELS.agentRelaySetTurnEndPing,
    (_e, on: boolean): RelayPushSettings => setRelayTurnEndPing(on)
  )

  ipcMain.handle(CHANNELS.agentRelayGetMacAlerts, () => PREFS.getAgentRelayMacAlerts())

  // Whole-object write, unlike the phone's per-verb setters: this screen owns
  // every switch on it, so one round trip beats six.
  ipcMain.handle(
    CHANNELS.agentRelaySetMacAlerts,
    (_e, next: RelayMacAlertSettings): RelayMacAlertSettings => {
      PREFS.setAgentRelayMacAlerts(next)
      return PREFS.getAgentRelayMacAlerts()
    }
  )

  ipcMain.handle(CHANNELS.agentRelaySendTest, async () => {
    const request = relayRequestStore.mint('notify', {
      title: 'MightyMouse test push',
      body: 'If you felt that, your agents can reach you.'
    })
    const sent = await sendRelayPush(request)
    return sent.ok ? { ok: true as const } : { ok: false as const, detail: sent.detail }
  })

  ipcMain.handle(CHANNELS.agentRelayGetRequests, () => relaySnapshot(true))

  // Same store call the phone's sheet makes, so whichever surface answers first
  // wins and the other simply stops showing the card.
  ipcMain.handle(
    CHANNELS.agentRelayRespond,
    (_e, requestId: string, response: RelayResponseWire) => {
      const { via, dismissed, ...answer } = response
      // Same split as the phone's WS path: a dismiss clears the card and must
      // never be able to smuggle an answer alongside it.
      if (dismissed === true) {
        const outcome = relayRequestStore.dismiss(requestId, null)
        devLog.log('[agent-relay] mac card dismiss', { requestId, outcome })
        return outcome
      }
      const outcome = relayRequestStore.resolve(
        requestId,
        answer satisfies RelayResponse,
        null,
        via satisfies RelayResolvedVia
      )
      devLog.log('[agent-relay] mac card respond', { requestId, via, outcome })
      return outcome
    }
  )

  ipcMain.handle(CHANNELS.agentRelayUndismiss, (_e, requestId: string) =>
    relayRequestStore.undismiss(requestId)
  )

  // The session's OWN origin, looked up here rather than sent from the
  // renderer: the resolver shells out to open apps and select panes, so what it
  // acts on must come from the listener's copy, never from a wire payload any
  // renderer could shape. Returns which strategy worked so the sheet can say
  // "couldn't find it" instead of silently doing nothing.
  ipcMain.handle(CHANNELS.agentRelayRevealSession, async (_e, ref: string) => {
    const session = resolveSessionRef(ref)
    if (!session?.origin) return { ok: false as const }
    if (session.origin.tmuxPane && (await livesInApp(session.origin))) {
      const shown = await showHiddenSession(session.origin.tmuxPane, session.origin.tmuxSocket, session.cwd ?? homedir())
      return shown ? { ok: true as const, via: 'attached' } : { ok: false as const }
    }
    const via = await resolveOrigin(session.origin)
    return via === 'none' ? { ok: false as const } : { ok: true as const, via }
  })

  // Same act as the phone's `relaySessionReply`, and gated the same way: the
  // session is looked up in the listener's own list so a renderer can never
  // hand an origin to type into, and a reaped session is refused rather than
  // typed into whatever now owns that pane. Returns the transport that worked
  // so the composer can say it went nowhere instead of clearing the box.
  ipcMain.handle(
    CHANNELS.agentRelaySessionReply,
    async (_e, ref: string, text: string, paths?: string[], expected?: SuggestedReply['evidence'], page?: { url?: unknown; title?: unknown }) => {
      if (typeof ref !== 'string' || typeof text !== 'string') return { ok: false as const }
      const said = text.trim().slice(0, CONFIG.PHONE_REMOTE.CHAT_MESSAGE_MAX_CHARS)
      const files = cleanAttachmentPaths(paths)
      // An attachment IS a message, so the empty-text guard runs after the files
      // are counted -- phone-remote-chat.ts:549 refuses only when both are empty.
      if (!said && files.length === 0) return { ok: false as const }
      const session = resolveSessionRef(ref)
      if (!session || session.staleSince !== undefined) return { ok: false as const }
      if (expected) {
        const facts = currentStatus().agentSessions?.find((item) => item.sessionId === session.sessionId)
        if (!facts || facts.busySince || (facts.waiting ?? 0) > 0 || !claimSuggestedReply(session, expected, sentTurnsFor(ref))) return { ok: false as const }
      }
      const context =
        typeof page?.url === 'string' && /^https?:/.test(page.url)
          ? browserPageTag({ url: page.url, title: typeof page.title === 'string' ? page.title : '' })
          : undefined
      const via = await sendToSession(session, said, files, { context })
      if (via === 'skipped') return { ok: false as const }
      return { ok: true as const, via }
    }
  )

  ipcMain.handle(CHANNELS.agentRelaySessionBtw, (_e, ref: string, question: string) => {
    const session = typeof ref === 'string' ? resolveSessionRef(ref) : undefined
    if (!session || typeof question !== 'string') return { ok: false, reason: 'This session is gone.' }
    return askSideQuestion(session, question)
  })
  ipcMain.handle(CHANNELS.repoGitState, (_e, ref: string) => repoGitState(ref))
  ipcMain.handle(CHANNELS.repoGitPush, (_e, ref: string) => repoGitPush(ref))
  ipcMain.handle(CHANNELS.repoGitChanges, (_e, ref: string, scope?: ChangeScope) => repoGitChanges(ref, scope))
  ipcMain.handle(CHANNELS.repoGitPull, (_e, ref: string) => repoGitPull(ref))
  ipcMain.handle(CHANNELS.repoGitOpenPull, (_e, ref: string) => repoGitOpenPull(ref))
  ipcMain.handle(CHANNELS.repoGitMerge, (_e, ref: string) => repoGitMerge(ref))
  ipcMain.handle(CHANNELS.repoTurnUndo, (_e, ref: string, turnAt: number) => {
    const session = typeof ref === 'string' ? resolveSessionRef(ref) ?? rememberedSession(ref) : undefined
    if (!session || !Number.isFinite(turnAt)) return { ok: false, error: 'This session is gone.' }
    return toggleTurnUndo(session, turnAt, Object.keys(readSessionTouched(session).edits))
  })

  ipcMain.handle(CHANNELS.agentRelaySessionSent, (_e, ref: string) => {
    if (typeof ref !== 'string' || ref === '') return []
    return sentTurnsFor(ref)
  })

  ipcMain.handle(CHANNELS.agentRelaySessionTranscript, (_e, ref: string) => {
    if (typeof ref !== 'string' || ref === '') return []
    const session = resolveSessionRef(ref) ?? codexThreadFor(ref) ?? rememberedSession(ref)
    return session ? withUndoStates(session, readSessionTranscript(session)) : []
  })

  ipcMain.handle(CHANNELS.agentRelaySessionScreen, (_e, ref: string, back?: number) => {
    if (typeof ref !== 'string' || ref === '') return null
    const session = resolveSessionRef(ref)
    const lines = Number.isFinite(back) ? Number(back) : 0
    return session && session.staleSince === undefined ? capturePaneScreen(session.origin, lines) : null
  })

  ipcMain.handle(CHANNELS.agentRelaySessionKeys, async (_e, ref: string, keys: PaneKey[]) => {
    if (typeof ref !== 'string' || !Array.isArray(keys) || keys.length > 200) return false
    const session = resolveSessionRef(ref)
    if (!session || session.staleSince !== undefined) return false
    const interrupt = keys.some((k) => 'key' in k && k.key === 'Escape')
    if (interrupt) endAgentDriving(session.sessionId, true)
    const sent = await sendPaneKeys(session.origin, keys)
    if (sent && interrupt) setAgentSessionBusy(session.sessionId, false)
    return sent
  })

  ipcMain.handle(CHANNELS.agentRelaySessionFit, (_e, ref: string, cols: number, rows: number) => {
    if (typeof ref !== 'string' || !Number.isFinite(cols) || !Number.isFinite(rows)) return false
    const session = resolveSessionRef(ref)
    return session && session.staleSince === undefined ? fitHiddenPane(session.origin, cols, rows) : false
  })

  const screenWatches = new Map<string, { count: number; end: () => void }>()

  ipcMain.handle(CHANNELS.agentRelaySessionWatch, (e, ref: string) => {
    if (typeof ref !== 'string' || ref === '') return false
    const key = `${e.sender.id}|${ref}`
    const existing = screenWatches.get(key)
    if (existing) {
      existing.count++
      return true
    }
    const session = resolveSessionRef(ref)
    if (!session || session.staleSince !== undefined || !session.origin?.tmuxPane) return false
    const sender = e.sender
    let timer: ReturnType<typeof setTimeout> | undefined
    let last = 0
    const push = (): void => {
      timer = undefined
      last = Date.now()
      if (!sender.isDestroyed()) sender.send(CHANNELS.agentRelaySessionScreenChanged, ref)
    }
    const stop = watchPane(session.origin, () => {
      if (timer) return
      const wait = last + CONFIG.AGENT_RELAY.PANE_SCREEN_STREAM_FRAME_MS - Date.now()
      if (wait <= 0) push()
      else timer = setTimeout(push, wait)
    })
    const end = (): void => {
      clearTimeout(timer)
      stop()
      screenWatches.delete(key)
    }
    screenWatches.set(key, { count: 1, end })
    sender.once('destroyed', end)
    return true
  })

  ipcMain.handle(CHANNELS.agentRelaySessionUnwatch, (e, ref: string) => {
    const watch = screenWatches.get(`${e.sender.id}|${ref}`)
    if (watch && --watch.count <= 0) watch.end()
  })

  ipcMain.handle(CHANNELS.agentRelaySessionChecklist, (_e, ref: string) => {
    if (typeof ref !== 'string' || ref === '') return undefined
    return readSessionChecklist(resolveSessionRef(ref)?.sessionId)
  })

  ipcMain.handle(CHANNELS.agentRelaySessionHelpers, (_e, ref: string) => {
    if (typeof ref !== 'string' || ref === '') return []
    const session = resolveSessionRef(ref)
    return session ? readRunningHelpers(session) : []
  })

  ipcMain.handle(CHANNELS.agentRelaySessionTools, (_e, ref: string) => {
    if (typeof ref !== 'string' || ref === '') return []
    const session = resolveSessionRef(ref) ?? codexThreadFor(ref) ?? rememberedSession(ref)
    return session ? readSessionTools(session) : []
  })

  ipcMain.handle(CHANNELS.agentRelaySessionUsage, async (_e, ref: string) => {
    if (typeof ref !== 'string' || ref === '') return null
    const session = resolveSessionRef(ref) ?? codexThreadFor(ref) ?? rememberedSession(ref)
    const usage = session ? readSessionUsage(session) : null
    const home = session && usage ? sessionAccountHome(session) : null
    const account = home ? await planAccountFor(home.backend, home.dir) : null
    return usage && account ? { ...usage, account: account.plan ? `${planTierLabel(account.plan)} · ${account.email}` : account.email } : usage
  })

  ipcMain.handle(CHANNELS.agentRelaySessionAffects, async (_e, ref: string): Promise<SessionAffects> => {
    if (typeof ref !== 'string' || ref === '') return NO_AFFECTS
    const session = resolveSessionRef(ref) ?? codexThreadFor(ref) ?? rememberedSession(ref)
    const found = session?.cwd ? await affectsRecordAbove(session.cwd) : null
    if (!session?.cwd || !found) return NO_AFFECTS
    const where = { root: found.root, cwd: session.cwd }
    return sessionAffects(readSessionTouched(session), where, found.record, session.affects)
  })

  // Ends the session. Same lookup-by-name discipline as the reply above -- the
  // renderer names a row, main resolves it -- and it answers as soon as the
  // wrap-up prompt is typed rather than awaiting the whole escalation, which
  // waits out the agent's turn and can run a minute.
  ipcMain.handle(CHANNELS.agentRelayWrapSession, async (_e, ref: string) => {
    if (typeof ref !== 'string' || !ref) return { ok: false as const, reason: 'unreachable' }
    const started = await startSessionWrap(ref, 'mac')
    if (!started.ok) return { ok: false as const, reason: started.reason }
    void started.done.then((outcome) => devLog.log('[agent-relay] wrap finished', { ref, outcome }))
    return { ok: true as const, via: started.via }
  })

  ipcMain.handle(CHANNELS.codeProjectIdeas, async (_e, input: unknown) => {
    const row = (input ?? {}) as { cwd?: unknown; name?: unknown; titles?: unknown; mode?: unknown }
    const cwd = typeof row.cwd === 'string' ? row.cwd : ''
    if (!isAbsolute(cwd) || !isDirectory(cwd)) return null
    const titles = Array.isArray(row.titles) ? row.titles.filter((t): t is string => typeof t === 'string') : []
    const mode: ProjectIdeasMode = row.mode === 'generate' || row.mode === 'refresh' ? row.mode : 'cached'
    return projectIdeas(cwd, typeof row.name === 'string' ? row.name : '', titles, mode)
  })

  ipcMain.handle(CHANNELS.codeProjectIdeaFeedback, (_e, input: unknown) => {
    const row = (input ?? {}) as { cwd?: unknown; label?: unknown; why?: unknown; verdict?: unknown }
    const cwd = typeof row.cwd === 'string' ? row.cwd : ''
    const label = typeof row.label === 'string' ? row.label.trim() : ''
    if (!isAbsolute(cwd) || !label) return { done: true }
    const verdict = row.verdict === 'done' || row.verdict === 'bad' ? row.verdict : null
    projectIdeaFeedback(cwd, label, typeof row.why === 'string' ? row.why : undefined, verdict)
    return verdict === 'done' ? checkIdeaDone(cwd, label) : { done: true }
  })

  ipcMain.handle(CHANNELS.codeStartAgent, (_e, input: unknown) => startCodeSession(input))
  ipcMain.handle(CHANNELS.codeRouteTask, (_e, task: unknown, sessions: unknown) =>
    typeof task === 'string' && Array.isArray(sessions) ? routeTask(task, sessions as TaskCandidate[]) : null
  )
  ipcMain.handle(CHANNELS.codeConductorWorkspaces, () => listConductorWorkspaces())
  ipcMain.handle(CHANNELS.codeContinueConductor, (_e, id: unknown) =>
    continueConductorWorkspace(typeof id === 'string' ? id : '', startCodeSession)
  )
  ipcMain.handle(CHANNELS.codeNoProjectFolder, () => noProjectFolder())

  ipcMain.handle(CHANNELS.codeStartupPeek, (_e, pane: unknown) =>
    peekStartup(typeof pane === 'string' ? pane : '')
  )

  ipcMain.handle(CHANNELS.codeStartupAnswer, (_e, pane: unknown, index: unknown) =>
    answerStartup(typeof pane === 'string' ? pane : '', typeof index === 'number' ? index : -1)
  )

  ipcMain.handle(CHANNELS.codeAgentModels, () => agentModelsState())

  ipcMain.handle(CHANNELS.codeSetUpAgentProvider, (event, harness: unknown) => {
    if (!isModelHarness(harness)) return { ok: false }
    return setUpAgentProvider(harness, (p) => event.sender.send(CHANNELS.codeAgentSetupProgress, p))
  })

  ipcMain.handle(CHANNELS.codeSetAgentModel, (_e, choice: unknown) => {
    const c = choice !== null && typeof choice === 'object' ? (choice as Record<string, unknown>) : {}
    if (!isModelHarness(c.harness) || typeof c.model !== 'string') return false
    return setAgentModel({ harness: c.harness, model: c.model })
  })

  ipcMain.handle(CHANNELS.chatModelPicks, () => ({
    opencode: PREFS.getChatModel('opencode'),
    openrouter: PREFS.getChatModel('openrouter'),
    claude: PREFS.getChatModel('claude'),
    codex: PREFS.getChatModel('codex')
  }))

  ipcMain.handle(CHANNELS.chatSetModelPick, (_e, backend: unknown, model: unknown) => {
    if ((backend === 'opencode' || backend === 'openrouter' || backend === 'claude' || backend === 'codex') && typeof model === 'string') {
      PREFS.setChatModel(backend, model)
    }
  })

  ipcMain.handle(CHANNELS.chatSourceModels, () => listChatSourceModels())

  ipcMain.handle(CHANNELS.agentRelayListClients, () => detectMcpClients())

  ipcMain.handle(CHANNELS.agentRelayConfigureClient, (_e, id: McpClientId) => {
    const result = configureMcpClient(id)
    if (result.ok) track(ANALYTICS_EVENT.setting_toggled, { key: 'agent_relay_client', value: id })
    return result
  })

  // the HUD is a live surface for EVERY pending ask/approve/show, not
  // just ones the MCP calls decided to push — raised/dismissed straight off
  // the store's own change feed, on every launch (relay works even with the
  // phone unpaired or push disabled; those only gate the REMOTE surfaces).
  // they answered a question and then went quiet, so the agent is blocked
  // on questions they may not know exist. Re-push the same card -- it re-opens
  // at the question the cursor is on, so the nudge IS the way back in.
  onRelayStalled((request) => {
    const left = (request.params.questions?.length ?? 0) - request.buffered.length
    if (left <= 0) return
    devLog.log(`[agent-relay] nudging a stalled interview — ${left} question(s) left`)
    void sendRelayPush(request).then(
      (sent) => {
        if (!sent.ok) devLog.warn('[agent-relay] stall nudge push failed', sent.detail)
      },
      (err) => devLog.error('[agent-relay] stall nudge failed', err)
    )
  })

  onRelayStoreChanged((request) => {
    if (request.status === 'pending') startRelayHud(request)
    else {
      dismissRelayHud(request.id)
      // The iPhone is the one surface that cannot clear itself: the HUD and the
      // deck both re-render off this same feed, but a delivered notification is
      // owned by iOS and outlives the request entirely. Fire-and-forget --
      // a resolution must not wait on, or fail because of, a push.
      //
      // A notify settles INSIDE mint() (store.ts:275-277), so it reaches this
      // feed already resolved, before its own alert has even been sent. Clearing
      // on that edge races the alert it is meant to retire -- the background
      // clear can land first and iOS then has nothing to remove, leaving the
      // card up forever. `resolvedVia` is what separates the two: null is the
      // settle-at-mint, and a real retirement (dismiss/timeout) always names one.
      if (request.verb !== 'notify' || request.resolvedVia !== null) {
        void sendRelayClearPush(request)
      }
      // The terminal picker is a SECOND blocker: resolving the request leaves
      // it on its own keyboard read. Type the answer back into its pane.
      void sendPickerAnswer(request).then(
        (via) => {
          if (via !== 'skipped') devLog.log(`[agent-relay] typed picker answer via ${via}`)
        },
        (err) => devLog.error('[agent-relay] picker answer failed', err)
      )
    }
    // Whole snapshot, not the changed request: a resolution moves a card
    // between two lists, and the lists are pending + a 5-card tail.
    broadcastRequests()
    // Per-session "waiting" is derived from the pending list, so the status
    // has to follow the store as well as the socket set -- without this a
    // session's dot stays amber until some OTHER agent connects or quits.
    broadcastStatus()
  })
}

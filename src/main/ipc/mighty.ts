/**
 * Mighty IPC — the standing personal agent's chat, sessions, scheduled jobs,
 * artifact registry, and settings. Extracted verbatim from the old monolithic
 * `ipc.ts`.
 */
import { ipcMain, shell, dialog } from 'electron'
import { rmSync, existsSync, realpathSync, readdirSync, writeFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import { dirname, join, basename } from 'path'
import { CHANNELS } from '../../shared/ipc'
import {
  getMightyWindow,
  hideMightyWindow,
  getMightyZoomLevel,
  setMightyZoomLevel
} from '../mighty/mighty-window'
import { showMightyViewWindow } from '../mighty/mighty-view-window'
import { route } from '../routing'
import { MIGHTY } from '../store/mighty'
import { copyProjectImage, removeProjectImageFiles } from '../store/project-image'
import { runMighty } from '../mighty/run-mighty'
import { exportSession } from '../mighty/export-session'
import { broadcastMightyTurnAppended } from '../mighty/broadcast'
import { abortRun, runTerminal } from '../backend/runner'
import { CONFIG } from '../../shared/config'
import { toBackendId } from '../backend/adapters'
import { runJobNow } from '../mighty/scheduler'
import { PATHS } from '../store/paths'
import { PREFS } from '../store/prefs'
import { resolveBinary } from '../platform'
import { getCoordinationService } from '../agent-relay/mcp/http-listener'
import { track } from '../analytics'
import { ANALYTICS_EVENT } from '../../shared/analytics-events'
import type {
  MightyChatPayload,
  MightyChatResult,
  MightyExportFormat,
  MightyPhasePayload,
  MightyEventPayload,
  MightyUpsertJobPayload,
  MightySettings,
  MightyProject,
  ProjectRepoLink,
  ProjectFolderScan,
  ChatWorkspaceTab
} from '../../shared/types'
import { isMightyMode } from '../../shared/types'

// Mirrors project() in bin/mm-coord byte for byte: a different root or hash and agents file under a project nobody linked.
function repoLinkFor(folder: string): ProjectRepoLink {
  let root = realpathSync(folder)
  try {
    const common = execFileSync(
      resolveBinary('git') ?? 'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: folder, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim()
    root = realpathSync(dirname(common))
  } catch {
    // Not a git repo: the folder itself is the project, same as mm-coord.
  }
  return { repoFolder: root, agentProjectId: createHash('sha256').update(root).digest('hex') }
}

const LIVE_AGENT_MS = 72 * 60 * 60 * 1000
const runIdByClient = new Map<string, string>()

function countDir(folder: string): number {
  try {
    return readdirSync(folder, { withFileTypes: true }).filter((e) => !e.name.startsWith('.')).length
  } catch {
    return 0
  }
}

function liveAgentsFor(agentProjectId: string): number {
  try {
    const cutoff = Date.now() - LIVE_AGENT_MS
    return getCoordinationService()
      .snapshot()
      .sessions.filter((s) => s.project === agentProjectId && s.lastSeen > cutoff).length
  } catch {
    return 0
  }
}

function scanFolder(folder: string): ProjectFolderScan {
  const link = repoLinkFor(folder)
  const claude = join(link.repoFolder, '.claude')
  return {
    ...link,
    name: basename(link.repoFolder),
    hasInstructions:
      existsSync(join(link.repoFolder, 'CLAUDE.md')) || existsSync(join(link.repoFolder, 'AGENTS.md')),
    skills: countDir(join(claude, 'skills')),
    agents: countDir(join(claude, 'agents')),
    liveAgents: liveAgentsFor(link.agentProjectId)
  }
}

function syncAgentProject(project: MightyProject): void {
  if (!project.agentProjectId) return
  const service = getCoordinationService()
  if (!service.snapshot().projects.some((p) => p.id === project.agentProjectId)) return
  service.renameProject(project.agentProjectId, project.name.slice(0, 120))
  service.archiveProject(project.agentProjectId, project.archived === true)
}

export function registerMightyHandlers(): void {
  // ── Mighty (standing personal agent) ────────────────────────────────────────
  // One chat turn. Awaits the full run (runMighty resolves on completion) so the
  // renderer gets the reply + the session it landed in + any files Mighty created.
  ipcMain.handle(CHANNELS.mightyChat, (e, payload: MightyChatPayload): Promise<MightyChatResult> => {
    const clientRunId = payload.clientRunId
    const live = (channel: string, body: MightyPhasePayload | MightyEventPayload): void => {
      const main = getMightyWindow()?.webContents
      main?.send(channel, body)
      if (e.sender !== main && !e.sender.isDestroyed()) e.sender.send(channel, body)
    }
    return runMighty({
      message: payload.message,
      sessionId: payload.sessionId,
      onRunId: (runId) => clientRunId && runIdByClient.set(clientRunId, runId),
      projectId: payload.projectId,
      backend: payload.backend,
      attachments: payload.attachments,
      source: 'chat',
      // Push each backend phase to the Mighty window so the pending bubble shows
      // live activity. Stamped with the RESOLVED session id runMighty hands back,
      // never `payload.sessionId` — a first send has no session yet, so echoing the
      // request stamped every fresh pane's stream with the same '' and each pane
      // (also still at '') accepted all of them.
      onPhase: (phase, detail, sessionId) => {
        live(CHANNELS.mightyPhase, { sessionId, clientRunId: payload.clientRunId, phase, detail })
      },
      // Rich per-event push (tool calls, thinking, text chunks) so the pending
      // bubble can stream the answer + inline steps live, same pattern as onPhase.
      // Only fires for backends whose adapter implements parseEvent (claude today).
      onEvent: (event, sessionId) => {
        live(CHANNELS.mightyEvent, { sessionId, clientRunId: payload.clientRunId, event })
      }
    }).finally(() => clientRunId && runIdByClient.delete(clientRunId))
  })

  ipcMain.handle(CHANNELS.mightyListSessions, () => MIGHTY.listSessions())
  ipcMain.handle(CHANNELS.mightyGetSession, (_, id: string) => MIGHTY.getSession(id))
  ipcMain.handle(CHANNELS.mightyRunTerminal, (_, sessionId: string) => {
    const runId = MIGHTY.getSession(sessionId)?.turns.findLast((t) => t.run_id)?.run_id
    if (!runId) return ''
    const dir = readdirSync(PATHS.MIGHTY_RUNS).find((name) => name.endsWith(`-${runId.slice(0, 8)}`))
    return runTerminal(runId, dir && join(PATHS.MIGHTY_RUNS, dir))
  })
  ipcMain.handle(CHANNELS.mightyNewSession, (_, projectId?: string) => MIGHTY.newSession('', projectId))
  ipcMain.handle(CHANNELS.mightyDeleteSession, (_, id: string) => MIGHTY.deleteSession(id))

  // Once, at startup: a project made before icons existed gets a guessed one, so
  // the sidebar reads as icons on first launch instead of after twelve manual picks.
  MIGHTY.backfillProjectIcons()
  MIGHTY.backfillProjectImages()

  ipcMain.handle(CHANNELS.mightyListProjects, () => MIGHTY.listProjects())
  // Create/rename/edit-defaults: caller sends a full MightyProject (id present for
  // an edit, freshly-generated for a create — the renderer owns id generation the
  // same way it doesn't for sessions, since a project must exist before its first
  // session can reference it). Returns null (and does NOT persist) on an empty name.
  ipcMain.handle(CHANNELS.mightyUpsertProject, (_, project: MightyProject) => {
    // Picture fields are owned by the pick/clear handlers; a stale renderer copy must not resurrect them.
    const stored = MIGHTY.getProject(project.id)
    const saved = MIGHTY.upsertProject(
      stored ? { ...project, imagePath: stored.imagePath, imageRemoved: stored.imageRemoved } : project
    )
    if (saved) syncAgentProject(saved)
    if (saved && !stored) {
      track(ANALYTICS_EVENT.code_project_added, {
        first: MIGHTY.listProjects().length === 1,
        has_folder: !!saved.repoFolder
      })
    }
    return saved
  })
  ipcMain.handle(
    CHANNELS.mightyPickProjectFolder,
    async (_, known?: string): Promise<ProjectRepoLink | null> => {
      let folder = known
      if (!folder) {
        const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
        folder = result.canceled ? undefined : result.filePaths[0]
      }
      return folder && existsSync(folder) ? repoLinkFor(folder) : null
    }
  )
  ipcMain.handle(
    CHANNELS.mightyScanProjectFolder,
    async (_, known?: string): Promise<ProjectFolderScan | null> => {
      let folder = known
      if (!folder) {
        const result = await dialog.showOpenDialog({
          properties: ['openDirectory', 'multiSelections']
        })
        folder = result.canceled ? undefined : result.filePaths[0]
      }
      return folder && existsSync(folder) ? scanFolder(folder) : null
    }
  )

  // Agent projects nobody has linked yet, so the import screen can offer them once.
  ipcMain.handle(CHANNELS.mightyFoundProjects, (): ProjectFolderScan[] => {
    let snapshot
    try {
      snapshot = getCoordinationService().snapshot()
    } catch {
      return []
    }
    const linked = new Set(MIGHTY.listProjects().map((p) => p.agentProjectId))
    const cutoff = Date.now() - LIVE_AGENT_MS
    return snapshot.projects
      .filter((p) => p.state === 'active' && !linked.has(p.id))
      .map((p) => {
        const sessions = snapshot.sessions.filter((s) => s.project === p.id)
        const root = sessions.find((s) => existsSync(s.cwd))?.cwd
        const scan = root ? scanFolder(root) : null
        return {
          repoFolder: scan?.repoFolder ?? '',
          // Without a folder on disk the coordination id is all we have to file agents under.
          agentProjectId: scan?.agentProjectId ?? p.id,
          name: p.name,
          hasInstructions: scan?.hasInstructions ?? false,
          skills: scan?.skills ?? 0,
          agents: scan?.agents ?? 0,
          liveAgents: sessions.filter((s) => s.lastSeen > cutoff).length
        }
      })
      .sort((a, b) => b.liveAgents - a.liveAgents)
  })

  ipcMain.handle(CHANNELS.mightyImportProjects, (_, scans: ProjectFolderScan[]): number => {
    const now = new Date().toISOString()
    let made = 0
    for (const scan of scans) {
      const saved = MIGHTY.upsertProject({
        id: crypto.randomUUID(),
        name: scan.name,
        created: now,
        updated: now,
        repoFolder: scan.repoFolder === '' ? undefined : scan.repoFolder,
        agentProjectId: scan.agentProjectId
      })
      if (saved) made += 1
    }
    return made
  })

  ipcMain.handle(CHANNELS.mightyDeleteProject, (_, id: string) => MIGHTY.deleteProject(id))
  ipcMain.handle(CHANNELS.mightyPickProjectImage, async (_, projectId: string) => {
    const project = MIGHTY.getProject(projectId)
    if (!project) return null
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'ico'] }]
    })
    const source = result.canceled ? undefined : result.filePaths[0]
    if (!source || !existsSync(source)) return null
    const imagePath = copyProjectImage(projectId, source)
    if (!imagePath) return null
    const saved = MIGHTY.upsertProject({
      ...project,
      imagePath,
      imageRemoved: undefined,
      updated: new Date().toISOString()
    })
    if (saved) syncAgentProject(saved)
    return saved
  })
  ipcMain.handle(CHANNELS.mightyDiscoverProjectImages, () => MIGHTY.backfillProjectImages())
  ipcMain.handle(CHANNELS.mightyClearProjectImage, (_, projectId: string) => {
    const project = MIGHTY.getProject(projectId)
    if (!project?.imagePath) return null
    removeProjectImageFiles(projectId)
    const saved = MIGHTY.upsertProject({
      ...project,
      imagePath: undefined,
      imageRemoved: true,
      updated: new Date().toISOString()
    })
    if (saved) syncAgentProject(saved)
    return saved
  })
  // projectId omitted/empty clears the session's assignment (moves it to Unassigned).
  ipcMain.handle(CHANNELS.mightyAssignSessionProject, (_, sessionId: string, projectId?: string) =>
    MIGHTY.assignSessionProject(sessionId, projectId)
  )
  // Deliberately does NOT broadcastBackendChanged: that blind app-wide push is what
  // made one chat's dropdown repoint every other chat.
  ipcMain.handle(CHANNELS.mightySetSessionBackend, (_, sessionId: string, backend: string) =>
    MIGHTY.setSessionBackend(sessionId, toBackendId(backend))
  )
  ipcMain.handle(CHANNELS.mightySetSessionPinned, (_, sessionId: string, pinned: boolean) =>
    MIGHTY.setSessionPinned(sessionId, pinned === true)
  )
  ipcMain.handle(CHANNELS.mightySetSessionTitle, (_, sessionId: string, title: unknown) =>
    typeof title === 'string' && MIGHTY.setSessionTitle(sessionId, title)
  )
  ipcMain.handle(CHANNELS.mightySetSessionArchived, (_, sessionId: string, archived: boolean) =>
    MIGHTY.setSessionArchived(sessionId, archived === true)
  )
  ipcMain.handle(CHANNELS.mightySetProjectPinned, (_, projectId: string, pinned: boolean) =>
    MIGHTY.setProjectPinned(projectId, pinned === true)
  )
  ipcMain.handle(CHANNELS.mightyTruncateLastTurn, (_, sessionId: string) =>
    MIGHTY.truncateLastTurn(sessionId)
  )
  ipcMain.handle(
    CHANNELS.mightyExportSession,
    async (_, sessionId: string, format: MightyExportFormat): Promise<boolean> => {
      const session = MIGHTY.getSession(sessionId)
      if (!session) return false
      const ext = format === 'json' ? 'json' : 'md'
      const base = (session.title.trim() || 'chat').replace(/[/\\:*?"<>|]/g, '-')
      const result = await dialog.showSaveDialog({
        defaultPath: join(PATHS.MIGHTY_WORKSPACE, `${base}.${ext}`),
        filters: [{ name: format === 'json' ? 'JSON' : 'Markdown', extensions: [ext] }]
      })
      if (result.canceled || !result.filePath) return false
      writeFileSync(result.filePath, exportSession(session, format), 'utf-8')
      return true
    }
  )

  ipcMain.handle(CHANNELS.mightyListJobs, () => MIGHTY.listJobs())
  ipcMain.handle(CHANNELS.mightyUpsertJob, (_, payload: MightyUpsertJobPayload) => {
    MIGHTY.upsertJob(payload.job)
  })
  ipcMain.handle(CHANNELS.mightyDeleteJob, (_, id: string) => MIGHTY.deleteJob(id))
  ipcMain.handle(CHANNELS.mightyRunJob, (_, id: string) => runJobNow(id))

  ipcMain.handle(CHANNELS.mightyListRegistry, () => MIGHTY.listArtifacts())
  // Remove an artifact: drop the registry row AND delete the file from the workspace
  // (the user expects "remove" to actually clean up, not just hide the entry).
  ipcMain.handle(CHANNELS.mightyDeleteArtifact, (_, path: string) => {
    // Registry membership IS the trust boundary here, not a workspace-root check —
    // artifacts can legitimately live outside PATHS.MIGHTY_WORKSPACE (see
    // isRegisteredArtifact's comment), so only a path the renderer actually read
    // back from listRegistry() may be deleted.
    if (!MIGHTY.isRegisteredArtifact(path)) {
      console.error('mightyDeleteArtifact rejected: not a registered artifact:', path)
      return false
    }
    const removed = MIGHTY.removeArtifact(path)
    if (removed) {
      try {
        rmSync(path, { force: true })
      } catch (err) {
        console.error('mightyDeleteArtifact: failed to delete file:', err)
      }
    }
    return removed
  })
  ipcMain.handle(CHANNELS.mightyReveal, async (_, path: string) => {
    if (!MIGHTY.isRegisteredArtifact(path)) {
      console.error('mightyReveal rejected: not a registered artifact:', path)
      return
    }
    try {
      shell.showItemInFolder(path)
    } catch (err) {
      console.error('mightyReveal failed:', err)
    }
  })
  // Smart open: an HTML report opens in the in-app viewer (the impressive hosted
  // dashboard experience); anything else reveals in Finder. Returns false when the
  // file is missing (e.g. a run that registered an artifact but never finished
  // writing it) so the renderer can surface that instead of the click looking dead.
  ipcMain.handle(CHANNELS.mightyOpenArtifact, (_, path: string): boolean => {
    if (!MIGHTY.isRegisteredArtifact(path)) {
      console.error('mightyOpenArtifact rejected: not a registered artifact:', path)
      return false
    }
    if (!existsSync(path)) {
      console.error('mightyOpenArtifact: file missing on disk:', path)
      return false
    }
    try {
      const p = path.toLowerCase()
      if (p.endsWith('.html') || p.endsWith('.htm') || p.endsWith('.md') || p.endsWith('.markdown')) {
        showMightyViewWindow(path)
      } else {
        shell.showItemInFolder(path)
      }
      return true
    } catch (err) {
      console.error('mightyOpenArtifact failed:', err)
      return false
    }
  })
  ipcMain.handle(CHANNELS.mightyGetSettings, () => PREFS.getMightySettings())
  ipcMain.handle(CHANNELS.mightySetSettings, (_, settings: MightySettings) => {
    PREFS.setMightySettings(settings)
  })
  ipcMain.handle(CHANNELS.mightyGetDetailMode, () => PREFS.getMightyDetailMode())
  ipcMain.handle(CHANNELS.mightySetDetailMode, (_, on: boolean) => {
    PREFS.setMightyDetailMode(on)
  })

  ipcMain.handle(CHANNELS.mightyGetSpeakReplies, () => PREFS.getSpeakReplies())
  ipcMain.handle(CHANNELS.mightySetSpeakReplies, (_, on: boolean) => {
    PREFS.setSpeakReplies(on === true)
    track(ANALYTICS_EVENT.setting_toggled, { key: 'speak_replies', value: String(on === true) })
  })

  ipcMain.handle(CHANNELS.mightyGetRenderMarkup, () => PREFS.getMightyRenderMarkup())
  ipcMain.handle(CHANNELS.mightySetRenderMarkup, (_, on: boolean) => {
    PREFS.setMightyRenderMarkup(on)
  })
  // Zoom: main owns the level (it clamps, persists, and broadcasts), so the
  // renderer only reads it and asks for changes — e.g. the indicator's
  // click-to-reset. Keyboard zoom never comes through here; it's intercepted in
  // mighty-window.ts.
  ipcMain.handle(CHANNELS.mightyGetZoomLevel, () => getMightyZoomLevel())
  ipcMain.handle(CHANNELS.mightySetZoomLevel, (_, level: number) => {
    setMightyZoomLevel(level)
  })
  ipcMain.handle(CHANNELS.mightyGetSidebarWidth, () => PREFS.getMightySidebarWidth())
  ipcMain.handle(CHANNELS.mightySetSidebarWidth, (_, width: number) => {
    PREFS.setMightySidebarWidth(width)
  })
  ipcMain.handle(CHANNELS.mightyGetSidebarShown, () => PREFS.getMightySidebarShown())
  ipcMain.handle(CHANNELS.mightySetSidebarShown, (_, on: boolean) => {
    PREFS.setMightySidebarShown(on)
  })
  ipcMain.handle(CHANNELS.mightySetLastMode, (_, mode: unknown) => {
    if (isMightyMode(mode)) PREFS.setMightyLastMode(mode)
  })
  ipcMain.handle(CHANNELS.mightySetLastCodeSession, (_, ref: unknown) => {
    if (typeof ref === 'string' && ref.length < 512) PREFS.setMightyLastCodeSession(ref)
  })
  ipcMain.handle(CHANNELS.mightyGetContextRailShown, () => PREFS.getMightyContextRailShown())
  ipcMain.handle(CHANNELS.mightySetContextRailShown, (_, on: boolean) => {
    PREFS.setMightyContextRailShown(on)
  })
  ipcMain.handle(CHANNELS.mightyGetWorkspaces, () => PREFS.getMightyWorkspaces())
  ipcMain.handle(CHANNELS.mightySetWorkspaces, (_, tabs: ChatWorkspaceTab[]) => {
    PREFS.setMightyWorkspaces(tabs)
  })
  // Reveal a source file the user attached to a turn. Unlike mightyReveal, the
  // trust boundary here is "the path exists on disk" — a source is the user's own
  // file, never a registry entry, so we can't gate on isRegisteredArtifact. We
  // still refuse a missing path so a stale row can't poke at arbitrary locations.
  ipcMain.handle(CHANNELS.mightyRevealSource, (_, path: string) => {
    if (!existsSync(path)) {
      console.error('mightyRevealSource rejected: no such file:', path)
      return
    }
    try {
      shell.showItemInFolder(path)
    } catch (err) {
      console.error('mightyRevealSource failed:', err)
    }
  })
  ipcMain.handle(CHANNELS.mightyOpenWorkspace, async () => {
    try {
      await shell.openPath(PATHS.MIGHTY_WORKSPACE)
    } catch (err) {
      console.error('mightyOpenWorkspace failed:', err)
    }
  })
  ipcMain.handle(CHANNELS.mightyShowPanel, () => {
    route('panel', { panelSource: 'mighty' })
    hideMightyWindow()
  })
  // Esc step 1. Kills only this pane's run; the child's `close` runs the normal
  // failure path, so the pane settles into its stopped state on its own.
  ipcMain.handle(CHANNELS.mightyStopRun, (_, id: string) => {
    const runId = runIdByClient.get(id) ?? id
    const killed = abortRun(runId)
    // Nothing alive to kill: the run died with a previous app lifetime, so no close
    // handler will ever settle it. The pane reads `running` off the persisted
    // session.runId, so without this Esc stays a no-op on that thread forever.
    if (!killed) {
      const sessionId = MIGHTY.findSessionIdByRunId(runId)
      if (sessionId !== null) {
        MIGHTY.resolveTurn(sessionId, runId, {
          a: CONFIG.MIGHTY.STOPPED_REPLY,
          ok: false,
          ts: new Date().toISOString()
        })
        broadcastMightyTurnAppended(sessionId)
      }
    }
    return killed
  })
  // Esc step 2, sent only once no pane reports a live run.
  ipcMain.handle(CHANNELS.mightyHide, () => {
    hideMightyWindow()
  })
}

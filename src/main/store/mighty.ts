import {
  existsSync,
  readFileSync,
  appendFileSync,
  writeFileSync,
  renameSync,
  statSync
} from 'fs'
import { randomUUID } from 'crypto'
import { PATHS } from './paths'
import {
  copyProjectImage,
  discoverProjectImage,
  removeProjectImageFiles,
  resolveProjectRepoFolder
} from './project-image'
import { PREFS } from './prefs'
import { historyTimestamp } from './history'
import { encryptLine, decryptLine } from './safe-storage'
import { CONFIG } from '../../shared/config'
import {
  MightySession,
  MightyTurn,
  MightyJob,
  MightyArtifact,
  MightyProject,
  BackendId
} from '../../shared/types'

// ── Mighty store ────────────────────────────────────────────────────────────────
// The persistence layer for the standing personal agent. Three append-only JSONL
// files under ~/MightyMouse/mighty/, each read through this module ONLY (never the
// raw file — encryption honors the history toggle, exactly like store/history.ts):
//   sessions.jsonl  — resumable conversations; latest line per session id wins.
//   jobs.jsonl      — scheduled jobs; latest line per job id wins.
//   registry.jsonl  — every artifact Mighty created (append-only, no dedup).
//
// Same upgrade seam as history: at ~20k rows swap the JSONL scan for sqlite; the
// MIGHTY interface stays put. Mirrors the warm-cache + incognito + encryption
// contract so behavior is consistent with the rest of the app.

const SCHEMA_VERSION = 1

// One generic line codec shared by all three files (matches history.decodeLine).
function decodeLine<T>(line: string): T | null {
  const plain = decryptLine(line) // legacy plaintext passes through; encrypted decrypts
  if (plain === null) return null // decrypt failed (wrong machine / corrupt) → skip
  const t = plain.trim()
  if (t === '') return null
  try {
    return JSON.parse(t) as T
  } catch {
    return null
  }
}

// Append one record, honoring incognito (skip) + the history encryption toggle.
function appendLine(path: string, record: unknown): void {
  if (PREFS.getIncognito()) return
  try {
    const json = JSON.stringify(record)
    const line = PREFS.getHistoryEncryption() ? encryptLine(json) : json
    const known = path === PATHS.MIGHTY_SESSIONS && sessionsCurrent() ? loadedSessions : null
    appendFileSync(path, line + '\n', 'utf-8')
    if (known) {
      const session = JSON.parse(json) as MightySession
      known.byId.set(session.id, session)
      Object.assign(known, sessionsStamp())
    }
    if (path === PATHS.MIGHTY_SESSIONS) sessionsWritten?.()
  } catch (err) {
    console.error(`Failed to append to ${path}:`, err)
  }
}

// Read + decode every line of a file (skips unreadable rows). Used for the
// latest-wins reducers below. No warm cache: these files are tiny (one row per
// session/job, not per turn) and read only when the Mighty window is open.
function readLines<T>(path: string): T[] {
  if (!existsSync(path)) return []
  const out: T[] = []
  try {
    for (const line of readFileSync(path, 'utf-8').split('\n')) {
      if (line.trim() === '') continue
      const rec = decodeLine<T>(line)
      if (rec) out.push(rec)
    }
  } catch (err) {
    console.error(`Failed to read ${path}:`, err)
  }
  return out
}

// Collapse an append-only log to the latest record per id (last line wins). Both
// sessions and jobs are edited by re-appending, so the newest line is authoritative.
function latestById<T extends { id: string }>(rows: T[]): Map<string, T> {
  const map = new Map<string, T>()
  for (const r of rows) map.set(r.id, r)
  return map
}

// Rewrite a whole file from a record list, honoring encryption. Used by deleteSession /
// deleteJob / deleteProject / removeArtifact. Deliberately does NOT consult incognito —
// removal isn't an append, see docs/gotchas.md. Returns whether it actually wrote.
function rewriteFile(path: string, records: unknown[]): boolean {
  try {
    const encrypt = PREFS.getHistoryEncryption()
    const lines = records.map((r) => {
      const json = JSON.stringify(r)
      return encrypt ? encryptLine(json) : json
    })
    const tmp = path + '.tmp'
    writeFileSync(tmp, lines.length ? lines.join('\n') + '\n' : '', 'utf-8')
    renameSync(tmp, path)
    return true
  } catch (err) {
    console.error(`Failed to rewrite ${path}:`, err)
    return false
  }
}

type FileStamp = { mtimeMs: number; size: number }
let loadedSessions: (FileStamp & { byId: Map<string, MightySession> }) | null = null

function sessionsStamp(): FileStamp | undefined {
  const at = statSync(PATHS.MIGHTY_SESSIONS, { throwIfNoEntry: false })
  return at && { mtimeMs: at.mtimeMs, size: at.size }
}

function sessionsCurrent(): boolean {
  const at = sessionsStamp()
  return !!at && loadedSessions?.mtimeMs === at.mtimeMs && loadedSessions.size === at.size
}

function sessionsLoaded(): Map<string, MightySession> {
  if (sessionsCurrent()) return loadedSessions!.byId
  const at = sessionsStamp()
  const byId = latestById(readLines<MightySession>(PATHS.MIGHTY_SESSIONS))
  loadedSessions = at ? { ...at, byId } : null
  return byId
}

function sessionsById(): Map<string, MightySession> {
  return structuredClone(sessionsLoaded())
}

let sessionsWritten: (() => void) | null = null
export function onSessionsWritten(listener: () => void): void {
  sessionsWritten = listener
}

let projectsWritten: (() => void) | null = null
export function onProjectsWritten(listener: () => void): void {
  projectsWritten = listener
}

export const MIGHTY = {
  // ── Sessions ────────────────────────────────────────────────────────────────

  /** Create a fresh empty session and persist it. Returns the new id. */
  newSession(title = '', projectId?: string): MightySession {
    const ts = historyTimestamp()
    const session: MightySession = {
      schema_version: SCHEMA_VERSION,
      id: randomUUID(),
      created: ts,
      updated: ts,
      title: title.trim().slice(0, 80),
      turns: [],
      projectId
    }
    appendLine(PATHS.MIGHTY_SESSIONS, session)
    return session
  },

  /**
   * All sessions, most-recently-updated first (latest line per id wins).
   *
   * Deliberately unfiltered: getSession() resolves any id, so anything hidden here
   * is still reachable by a pane binding — a blank-but-live session the sidebar
   * refused to list, which is what made the pane and the sidebar disagree. Nothing
   * mints turn-less sessions any more (newChatInActivePane binds null and lets the
   * first send create one), so there is nothing left to hide.
   */
  listSessions(): MightySession[] {
    const map = sessionsById()
    return [...map.values()].sort((a, b) => (a.updated < b.updated ? 1 : -1))
  },

  readSessions(): ReadonlyArray<Readonly<MightySession>> {
    return [...sessionsLoaded().values()]
  },

  putSession(session: MightySession): void {
    appendLine(PATHS.MIGHTY_SESSIONS, session)
  },

  /** One session by id, or null. */
  getSession(id: string): MightySession | null {
    return structuredClone(sessionsLoaded().get(id)) ?? null
  },

  /**
   * The session containing the run `runId`, or null if nothing owns it.
   *
   * History rows key off run ids, sessions key off session ids, and the session's own
   * `runId` only survives while the run is in flight (resolveTurn deletes it). So this
   * matches on the turn-level `run_id` stamped by startTurn, which is what lets a
   * FINISHED history row reopen its real conversation instead of a blank one.
   *
   * Returns null for turns recorded before `run_id` existed — callers fall back to
   * seeding a transient thread, which is the pre-existing behavior.
   */
  findSessionIdByRunId(runId: string): string | null {
    if (!runId) return null
    for (const session of this.listSessions()) {
      if (session.turns.some((t) => t.run_id === runId)) return session.id
    }
    return null
  },

  /**
   * Append a turn to a session (creating the session if id is unknown) and persist
   * the whole updated session as a new line. Sets the title from the first turn.
   * `newSessionProjectId` seeds the project only when a NEW session is created here
   * (an already-existing session keeps whatever project it's already assigned to).
   * Returns the session id the turn landed in.
   */
  appendTurn(sessionId: string | undefined, turn: MightyTurn, newSessionProjectId?: string): string {
    let session = sessionId ? this.getSession(sessionId) : null
    if (!session) session = this.newSession(turn.q, newSessionProjectId)
    session.turns.push(turn)
    session.updated = turn.ts
    if (session.title === '' && turn.q.trim() !== '') {
      session.title = turn.q.trim().slice(0, 80)
    }
    appendLine(PATHS.MIGHTY_SESSIONS, session)
    return session.id
  },

  /**
   * Append a turn that's still being answered, and mark the session as running.
   *
   * The counterpart to appendTurn for the ask path: the question becomes visible to
   * every window the moment the run STARTS, instead of materializing only once the
   * answer lands. Before this existed, a run in flight left the store holding a
   * session with a title and zero turns — so expanding the panel mid-answer opened
   * Mighty on what looked like an empty "New conversation" while the sidebar row
   * showed the real title. Pair every startTurn with a resolveTurn (including on
   * abort/error) or the session stays marked running.
   *
   * Returns the session id the turn landed in (minting one if the id is unknown,
   * matching appendTurn's contract).
   */
  startTurn(
    sessionId: string | undefined,
    turn: MightyTurn,
    runId: string,
    newSessionProjectId?: string
  ): string {
    let session = sessionId ? this.getSession(sessionId) : null
    if (!session) session = this.newSession(turn.q, newSessionProjectId)
    // A session can already END in this exact question with no answer — a listen
    // capture parks its transcript that way, and sending it is what starts this run.
    // Claim that turn instead of pushing a twin, or the chat shows the transcript
    // twice: once orphaned above, once with the reply.
    const last = session.turns[session.turns.length - 1]
    const claimsPending = last && last.a === '' && last.q === turn.q && !last.run_id
    // Stamp the run on the TURN as well as the session. session.runId is cleared by
    // resolveTurn, so it can't answer "which session owns this finished run?" — the
    // question History's Continue asks. See findSessionIdByRunId.
    if (claimsPending) session.turns[session.turns.length - 1] = { ...last, ...turn, run_id: runId }
    else session.turns.push({ ...turn, run_id: runId })
    session.updated = turn.ts
    session.runId = runId
    delete session.archived
    if (session.title === '' && turn.q.trim() !== '') {
      session.title = turn.q.trim().slice(0, 80)
    }
    appendLine(PATHS.MIGHTY_SESSIONS, session)
    return session.id
  },

  /**
   * Fill in the answer for the turn `runId` started, and clear the running mark.
   *
   * Patches the turn IN PLACE — it must not append, or a started+resolved turn would
   * show up twice. The target is found by matching the session's own `runId` rather
   * than assuming "the last turn": a turn appended from another surface between start
   * and resolve would otherwise get this answer stapled onto it.
   *
   * No-ops (returns false) when the session is gone or `runId` doesn't match the
   * session's live run — a late resolve from a superseded run must not clobber a
   * newer turn's answer.
   */
  resolveTurn(sessionId: string, runId: string, patch: Partial<MightyTurn>): boolean {
    const session = this.getSession(sessionId)
    if (!session || session.runId !== runId) return false
    // startTurn always pushed the turn it began, so the trailing row IS this run's —
    // guarded by the runId check above, which is what makes that safe to rely on.
    const turn = session.turns[session.turns.length - 1]
    if (!turn) return false
    session.turns[session.turns.length - 1] = { ...turn, ...patch }
    session.updated = patch.ts ?? historyTimestamp()
    delete session.runId
    appendLine(PATHS.MIGHTY_SESSIONS, session)
    return true
  },

  /**
   * Settle sessions the last app lifetime died holding — a persisted `runId` only
   * resolveTurn clears, so a killed run reads as thinking forever.
   *
   * BOOT ONLY, before anything reads sessions: mid-session this settles live runs.
   */
  reconcileInterruptedSessions(): number {
    let settled = 0
    for (const session of sessionsById().values()) {
      if (session.runId === undefined) continue
      delete session.runId
      // Only the trailing turn can be this run's (startTurn always pushes or claims
      // it). An answered one means the reply landed and only the mark was lost, so
      // the transcript stays untouched.
      const turn = session.turns[session.turns.length - 1]
      if (turn && turn.a === '') {
        session.turns[session.turns.length - 1] = {
          ...turn,
          a: CONFIG.MIGHTY.INTERRUPTED_REPLY,
          ok: false
        }
      }
      appendLine(PATHS.MIGHTY_SESSIONS, session)
      settled++
    }
    if (settled > 0) {
      console.warn(`mighty: settled ${settled} interrupted session(s) from a previous run`)
    }
    return settled
  },

  /**
   * Fill in the answer on a session's trailing turn when that turn is still
   * unanswered. The runId-free counterpart to resolveTurn, for a turn written by
   * appendTurn (which never stamps one): smart dictation's capture turn is created
   * by logCapture with `a: ''` and answered by a SEPARATE backend run, so there is
   * no runId linking the two.
   *
   * Refuses to overwrite a turn that already has an answer — a late result must not
   * clobber a reply the user has already read, and an already-answered trailing turn
   * means a follow-up landed first.
   */
  answerLastTurn(sessionId: string, patch: Partial<MightyTurn>): boolean {
    const session = this.getSession(sessionId)
    if (!session) return false
    const turn = session.turns[session.turns.length - 1]
    if (!turn || turn.a !== '') return false
    session.turns[session.turns.length - 1] = { ...turn, ...patch }
    session.updated = patch.ts ?? historyTimestamp()
    appendLine(PATHS.MIGHTY_SESSIONS, session)
    return true
  },

  /**
   * Physically drop a session (rewrites the file without it), then clear every
   * reference to it. Returns true if removed.
   *
   * The cascade is the point. A job holding a deleted session's id doesn't fail —
   * appendTurn's `if (!session)` branch silently mints a FRESH session per run, so
   * the job spawns a new orphan every fire and never accumulates history again.
   * Clearing the id makes the job adopt its next run's session for real.
   *
   * Artifact rows keep their file and prompt (the Made tab reads neither the
   * session nor its id) — only the dangling pointer is dropped, so deleting a
   * conversation can never delete something Mighty made.
   */
  deleteSession(id: string): boolean {
    const map = sessionsById()
    if (!map.has(id)) return false
    map.delete(id)
    if (!rewriteFile(PATHS.MIGHTY_SESSIONS, [...map.values()])) return false
    sessionsWritten?.()

    const jobs = latestById(readLines<MightyJob>(PATHS.MIGHTY_JOBS))
    const orphanedJobs = [...jobs.values()].filter((j) => j.sessionId === id)
    if (orphanedJobs.length > 0) {
      for (const job of orphanedJobs) jobs.set(job.id, { ...job, sessionId: '' })
      rewriteFile(PATHS.MIGHTY_JOBS, [...jobs.values()])
    }

    const artifacts = readLines<MightyArtifact>(PATHS.MIGHTY_REGISTRY)
    if (artifacts.some((a) => a && a.sessionId === id)) {
      rewriteFile(
        PATHS.MIGHTY_REGISTRY,
        artifacts.map((a) => (a && a.sessionId === id ? { ...a, sessionId: '' } : a))
      )
    }
    return true
  },

  /**
   * Move a session into a project (or clear its assignment when projectId is
   * empty/undefined). No-ops on an unknown session id instead of throwing — the
   * caller (IPC handler) already validated the id came from listSessions(), but a
   * concurrent delete from another window is possible, so this stays defensive.
   * Returns true if the session was found and updated.
   */
  assignSessionProject(sessionId: string, projectId: string | undefined): boolean {
    const session = this.getSession(sessionId)
    if (!session) return false
    session.projectId = projectId && projectId.trim() !== '' ? projectId : undefined
    session.renamed = new Date().toISOString()
    appendLine(PATHS.MIGHTY_SESSIONS, session)
    return true
  },

  /** Pin a provider to one conversation. Same defensive no-op as assignSessionProject. */
  setSessionBackend(sessionId: string, backend: BackendId): boolean {
    const session = this.getSession(sessionId)
    if (!session) return false
    session.backend = backend
    appendLine(PATHS.MIGHTY_SESSIONS, session)
    return true
  },

  setSessionTitle(sessionId: string, title: string): boolean {
    const session = this.getSession(sessionId)
    const trimmed = title.trim().slice(0, 80)
    if (!session || trimmed === '') return false
    session.title = trimmed
    session.renamed = new Date().toISOString()
    appendLine(PATHS.MIGHTY_SESSIONS, session)
    return true
  },

  setSessionPinned(sessionId: string, pinned: boolean): boolean {
    const session = this.getSession(sessionId)
    if (!session) return false
    session.pinned = pinned || undefined
    appendLine(PATHS.MIGHTY_SESSIONS, session)
    return true
  },

  setSessionArchived(sessionId: string, archived: boolean): boolean {
    const session = this.getSession(sessionId)
    if (!session) return false
    session.archived = archived || undefined
    appendLine(PATHS.MIGHTY_SESSIONS, session)
    return true
  },

  setProjectPinned(projectId: string, pinned: boolean): boolean {
    const project = this.listProjects().find((p) => p.id === projectId)
    if (!project) return false
    this.upsertProject({ ...project, pinned: pinned || undefined, updated: new Date().toISOString() })
    return true
  },

  // No-op while the last turn is still running — caller must stop it first.
  truncateLastTurn(sessionId: string): MightySession | null {
    const session = this.getSession(sessionId)
    if (!session || session.turns.length === 0 || session.runId !== undefined) return null
    const dropped = session.turns[session.turns.length - 1]
    session.turns = session.turns.slice(0, -1)
    if (session.turns.length === 0 && session.title === dropped.q.trim().slice(0, 80)) session.title = ''
    session.updated = historyTimestamp()
    appendLine(PATHS.MIGHTY_SESSIONS, session)
    return session
  },

  // ── Jobs ──────────────────────────────────────────────────────────────────────

  /** All jobs (latest line per id wins), oldest-created first for a stable list. */
  listJobs(): MightyJob[] {
    const map = latestById(readLines<MightyJob>(PATHS.MIGHTY_JOBS))
    return [...map.values()].sort((a, b) => (a.created < b.created ? -1 : 1))
  },

  getJob(id: string): MightyJob | null {
    return latestById(readLines<MightyJob>(PATHS.MIGHTY_JOBS)).get(id) ?? null
  },

  /** Create or update a job (append-only; latest line wins). */
  upsertJob(job: MightyJob): void {
    appendLine(PATHS.MIGHTY_JOBS, job)
  },

  /** Physically drop a job. Returns true if removed. */
  deleteJob(id: string): boolean {
    const map = latestById(readLines<MightyJob>(PATHS.MIGHTY_JOBS))
    if (!map.has(id)) return false
    map.delete(id)
    return rewriteFile(PATHS.MIGHTY_JOBS, [...map.values()])
  },

  // ── Registry (things Mighty made) ──────────────────────────────────────────────

  /**
   * Record an artifact Mighty created (append-only). `exists` isn't part of the
   * persisted row — it's computed fresh on every listArtifacts() read instead of
   * going stale in the ledger.
   */
  addArtifact(artifact: Omit<MightyArtifact, 'exists'>): void {
    appendLine(PATHS.MIGHTY_REGISTRY, artifact)
  },

  /** All registered artifacts, most-recent first, with a fresh on-disk existence check. */
  listArtifacts(): MightyArtifact[] {
    return readLines<MightyArtifact>(PATHS.MIGHTY_REGISTRY)
      .filter((a) => a && typeof a.path === 'string')
      .map((a) => ({ ...a, exists: existsSync(a.path) }))
      .sort((a, b) => (a.ts < b.ts ? 1 : -1))
  },

  /**
   * True if `path` is a currently-registered artifact. Artifacts are legitimately
   * created outside PATHS.MIGHTY_WORKSPACE (run-mighty.ts honors an LLM-named
   * outputPath anywhere), so containment can't be checked against a single root —
   * registry membership is the actual trust boundary: the renderer can only ever
   * pass back a path it read from listRegistry(), never an arbitrary string.
   */
  isRegisteredArtifact(path: string): boolean {
    return readLines<MightyArtifact>(PATHS.MIGHTY_REGISTRY).some((a) => a && a.path === path)
  },

  /**
   * Drop an artifact from the registry by path (rewrites the file). Does NOT delete
   * the file on disk — that's the caller's job (so the registry stays a pure ledger).
   * Returns true if a matching row was removed.
   */
  removeArtifact(path: string): boolean {
    const rows = readLines<MightyArtifact>(PATHS.MIGHTY_REGISTRY)
    const kept = rows.filter((a) => a.path !== path)
    if (kept.length === rows.length) return false
    return rewriteFile(PATHS.MIGHTY_REGISTRY, kept)
  },

  // ── Projects ──────────────────────────────────────────────────────────────────

  /** All projects, oldest-created first (stable list order, matches listJobs). */
  listProjects(): MightyProject[] {
    const map = latestById(readLines<MightyProject>(PATHS.MIGHTY_PROJECTS))
    return [...map.values()].sort((a, b) => (a.created < b.created ? -1 : 1))
  },

  getProject(id: string): MightyProject | null {
    return latestById(readLines<MightyProject>(PATHS.MIGHTY_PROJECTS)).get(id) ?? null
  },

  /**
   * Create or update a project (append-only; latest line wins). Trims the name and
   * rejects an empty one — the caller (IPC handler) surfaces the failure, this store
   * never persists an unnamed project. Returns the persisted project, or null if the
   * name was empty.
   */
  upsertProject(project: MightyProject): MightyProject | null {
    const name = project.name.trim()
    if (name === '') return null
    const record: MightyProject = { ...project, name }
    appendLine(PATHS.MIGHTY_PROJECTS, record)
    projectsWritten?.()
    return record
  },

  /**
   * Give every project that has never had an icon a guessed one, so a fresh
   * sidebar reads as icons rather than six identical folders. Runs once per
   * project: a stamped `icon` (including the explicit 'folder') is never
   * touched again, so a user's pick always outlives this.
   */
  backfillProjectIcons(): number {
    let stamped = 0
    for (const project of this.listProjects()) {
      if (project.icon !== undefined) continue
      this.upsertProject({
        ...project,
        icon: guessProjectIcon(project.name, project.repoFolder),
        updated: new Date().toISOString()
      })
      stamped += 1
    }
    return stamped
  },

  /** Copy the first logo/favicon found under each linked repo into project-images/. */
  backfillProjectImages(): number {
    let stamped = 0
    for (const project of this.listProjects()) {
      if (project.imageRemoved) continue
      if (project.imagePath && existsSync(project.imagePath)) continue
      const repo = resolveProjectRepoFolder(project)
      if (!repo) continue
      const found = discoverProjectImage(repo, project.name)
      if (!found) continue
      const imagePath = copyProjectImage(project.id, found)
      if (!imagePath) continue
      this.upsertProject({
        ...project,
        imagePath,
        updated: new Date().toISOString()
      })
      stamped += 1
    }
    return stamped
  },

  patchProjectByAgentId(agentProjectId: string, change: Pick<Partial<MightyProject>, 'name' | 'archived'>): void {
    const linked = this.listProjects().find((p) => p.agentProjectId === agentProjectId)
    if (linked) this.upsertProject({ ...linked, ...change, updated: new Date().toISOString() })
  },

  /**
   * Physically drop a project. Any sessions pointing at it are unassigned (never
   * deleted) so deleting a project can never lose a conversation. Returns true if a
   * project was removed.
   */
  deleteProject(id: string): boolean {
    const map = latestById(readLines<MightyProject>(PATHS.MIGHTY_PROJECTS))
    if (!map.has(id)) return false
    removeProjectImageFiles(id)
    map.delete(id)
    if (!rewriteFile(PATHS.MIGHTY_PROJECTS, [...map.values()])) return false
    projectsWritten?.()

    const sessions = sessionsById()
    for (const session of sessions.values()) {
      if (session.projectId === id) this.assignSessionProject(session.id, undefined)
    }
    return true
  }
}

/** Keyword → icon, first hit wins. Anything unmatched keeps the folder, which
 *  is the honest answer for a name we cannot read anything into. */
const ICON_HINTS: ReadonlyArray<[RegExp, string]> = [
  [/phone|ios|android|mobile|app\b/i, 'phone'],
  [/site|web|landing|www|\.com|portal|blog/i, 'globe'],
  [/shop|store|commerce|cart|pay|billing/i, 'cart'],
  [/video|film|clip|camera|reel|media|screen/i, 'camera'],
  [/music|audio|sound|voice|song|string/i, 'music'],
  [/data|label|db|sql|warehouse|analytics/i, 'database'],
  [/agent|bot|ai\b|llm|gpt|claude/i, 'bot'],
  [/design|brand|ui|ux|figma|creative|creator/i, 'palette'],
  [/cli|term|shell|script|tool|bin\b/i, 'terminal'],
  [/test|lab|experiment|demo|sandbox|scratch/i, 'beaker'],
  [/launch|growth|market|ads|campaign/i, 'rocket']
]

export function guessProjectIcon(name: string, repoFolder?: string): string {
  const hay = `${name} ${repoFolder ?? ''}`
  return ICON_HINTS.find(([re]) => re.test(hay))?.[1] ?? 'folder'
}

import { join } from 'path'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'fs'
import { randomUUID } from 'crypto'
import { CONFIG } from '../../shared/config'
import { PATHS } from '../store/paths'
import { PREFS } from '../store/prefs'
import { MIGHTY } from '../store/mighty'
import { historyTimestamp, HISTORY, failDetail } from '../store/history'
import { runBackend, abortRun, resolveRunModel, EXIT_TIMEOUT, EXIT_STOPPED } from '../backend/runner'
import { transcribeAttachments } from '../backend/audio-transcribe'
import { parseActResult } from '../backend/parse'
import { buildMemoryBlob } from '../backend/context-memory'
import { screenControlBlock } from '../backend/prompts'
import { fireScreenshot } from '../capture/screenshot'
import { resolveClaude, captureContext } from '../platform'
import { toBackendId, canRunUnattended, getCapabilities, BACKENDS, type PriorMessage } from '../backend/adapters'
import {
  MightyRunSource,
  MightyTurn,
  MightyChatResult,
  MightyProject,
  RUN_EVENT,
  type MediaAttachment,
  type RunEvent,
  type RunFailReason,
  type ToolCallSummary,
  type BackendId,
  type TurnUsage
} from '../../shared/types'
import { summarizeAttachments } from '../../shared/attachments'
import { runLabel } from '../../shared/model-label'
import { track } from '../analytics'
import { ANALYTICS_EVENT } from '../../shared/analytics-events'
import { broadcastMightyPhase, broadcastMightyTurnAppended } from './broadcast'
import { chatBrowserRun, chatBrowserTools } from '../agent-relay/mcp/browser-tools'
import { MODEL_SOURCES } from '../../shared/model-sources'

// ── Mighty runner ─────────────────────────────────────────────────────────────
// The ONE place a Mighty run is invoked. Wraps runBackend on the act path so Mighty
// inherits shell + file-write + skill invocation across EVERY backend (claude /
// codex / mightymouse) with no backend branch — the adapter registry decides
// transport. Each run:
//   1. builds Mighty's system prompt (persona + workspace + skills) and a user
//      prompt that includes the running conversation + the memory blob,
//   2. runs sandboxed to MIGHTY_WORKSPACE (the act agent's only --add-dir grant),
//   3. parses the ACT_RESULT line for the summary + any created file,
//   4. logs the turn to the session and registers new artifacts.
//
// Shared by chat turns (ipc) and scheduled jobs (scheduler) — same path, so a job
// result and a typed message are logged identically and both show in the registry.

// The local Claude Code skills Mighty should know about. Kept here (not a magic
// string in the prompt) so the list is one edit away. Mighty runs on the act loop,
// which already injects bypassPermissions skill access; this just tells it WHICH.
const MIGHTY_SKILLS: Array<{ cmd: string; what: string }> = [
  { cmd: '/yap', what: 'auto-caption a video file' },
  { cmd: '/draft-tweet', what: 'compose a tweet for the user (preview, does not post)' },
  { cmd: '/tweet', what: 'post a tweet' },
  { cmd: '/commit-fix', what: 'stage + commit a focused fix' },
  { cmd: '/skillify', what: 'turn a repeatable task into a reusable skill' },
  { cmd: '/deep-research', what: 'multi-source, fact-checked research report' },
  { cmd: '/create-image', what: 'generate an image' },
  { cmd: '/visual-doc', what: 'produce a visual document / infographic' }
]

/**
 * The ONE place a Mighty failure gets a name. Both stores (the local history row
 * and the caller's `error`) read from this, so a run can never be a `timeout` in
 * one and a bare `failed` in the other.
 *
 * Exit codes come from runner.ts; -2 is the paid backend's HTTP 402 sentinel.
 * Never returns undefined — an unclassifiable failure is `'error'`, recorded
 * explicitly so it's distinguishable from a row that predates this field.
 */
function classifyFailure(exitCode: number, answer: string, backend: string): RunFailReason {
  if (exitCode === EXIT_TIMEOUT) return 'timeout'
  if (exitCode === EXIT_STOPPED) return 'stopped'
  if (exitCode === -2) return 'out_of_credits'
  // The paid backend reports "sign in" through the answer body, not an exit code.
  if (backend === 'mightymouse' && answer.toLowerCase().includes('sign')) return 'signed_out'
  return 'error'
}

/**
 * The skills section of Mighty's prompt, or '' for a backend that can't use it.
 *
 * Empty for the local backends: `claude -p` is a separate paid CLI a local model has
 * no business shelling into, so those ~10 lines bought nothing — and they cost real
 * identity confusion. A 9B model reading "Claude Code skills are available to you"
 * ten times answers "I'm Claude Code" when asked what it is, which is exactly what
 * the {{MODEL_LABEL}} line above now contradicts. Don't reintroduce the tension.
 */
function skillsBlock(backend: BackendId, claudeBin: string): string {
  if (backend === 'local' || backend === 'mlx' || backend === 'openrouter') return ''
  const lines = MIGHTY_SKILLS.map(
    (s) => `  ${s.cmd} — ${s.what}  (run: ${claudeBin} -p "${s.cmd} <args>" --permission-mode bypassPermissions)`
  ).join('\n')
  return `- Claude Code skills are available to you. Invoke a skill via the shell exactly as documented. Available skills:
${lines}
- For anything that maps to a skill (captioning a video → /yap, drafting a tweet → /draft-tweet, committing a fix → /commit-fix, turning work into a skill → /skillify), prefer running the skill over hand-rolling it.
`
}

const MEMORY_PROMPT_CHARS = 4000

function memoryBlock(backend: BackendId): string {
  let saved = ''
  try {
    saved = readFileSync(PATHS.MIGHTY_MEMORY, 'utf-8').trim().slice(0, MEMORY_PROMPT_CHARS)
  } catch {
    // no memory file yet
  }
  const known = saved
    ? `\nWHAT YOU REMEMBER ABOUT THIS USER (from earlier conversations):\n${saved}\n`
    : ''
  if (backend === 'local' || backend === 'mlx' || backend === 'openrouter') return known
  return `${known}
YOUR MEMORY FILE: ${PATHS.MIGHTY_MEMORY}
- It is how you remember this person between conversations. Each conversation starts fresh except for this file.
- Update it when the user says "remember", corrects you, or shows a stable preference (tone, format, names, people, projects, tools they use). One short line per fact, starting with Always, Never or Prefer where it fits.
- Read it before editing. Rewrite a fact that changed instead of adding a contradicting one. Delete facts that are no longer true. Keep it under ${MEMORY_PROMPT_CHARS} characters.
- Never store passwords, keys, card numbers or health details. Do not mention the file unless the user asks what you remember.
`
}

/**
 * Build Mighty's system prompt with persona name, workspace, skills, and user
 * settings filled in. `projectPrompt` (a Project's optional extra context, when the
 * session belongs to one) is appended AFTER the user's global instructions — the
 * global block stays "who Mighty is", the project block adds "what this project is
 * about", so neither silently replaces the other.
 */
function buildMightySystemPrompt(
  backend: BackendId,
  runModel: string,
  projectPrompt?: string,
  source?: MightyRunSource,
  screenshotPath?: string
): string {
  const claudeBin = resolveClaude() ?? 'claude'
  const settings = PREFS.getMightySettings()
  const name = PREFS.getMightyName()
  const globalInstructions = PREFS.getGlobalInstructions()
  // Custom instructions become a clearly-labeled block, or an empty string if unset
  // (so the prompt stays clean and the {{INSTRUCTIONS}} token never leaks as a literal).
  // Sourced from the global instructions store (Settings → Instructions), gated by
  // its own appliesTo.mighty toggle — replaces the old MightySettings.instructions.
  let instructions =
    globalInstructions.text.trim() !== '' && globalInstructions.appliesTo.mighty
      ? `\nUSER'S INSTRUCTIONS FOR YOU (follow these; they override defaults where they conflict):\n${globalInstructions.text.trim()}\n`
      : ''
  if (projectPrompt && projectPrompt.trim() !== '') {
    instructions += `\nCONTEXT FOR THIS PROJECT (this conversation belongs to a project with its own context):\n${projectPrompt.trim()}\n`
  }
  const base = CONFIG.SYSTEM_PROMPT_MIGHTY.replace(/\{\{NAME\}\}/g, name)
    .replace(/\{\{WORKSPACE\}\}/g, PATHS.MIGHTY_WORKSPACE)
    // The SAME string the run footer shows, so what the model says it is can never
    // drift from what the UI reports ran.
    .replace(/\{\{MODEL_LABEL\}\}/g, runLabel(backend, runModel))
    .replace(/\{\{SKILLS\}\}/g, skillsBlock(backend, claudeBin))
    .replace(/\{\{INSTRUCTIONS\}\}/g, instructions)
    .replace(/\{\{MEMORY\}\}/g, memoryBlock(backend))
    .replace(/\{\{FORMAT\}\}/g, settings.outputFormat)
  // Screen control goes on before brevity: it is capability ("here are the verbs"),
  // and the voice rules below are shape ("keep it short"), so a spoken act turn ends
  // up able to click AND not narrate the whole click list back at the user.
  const withScreen = `${base}${screenControlBlock(screenshotPath)}`
  // Spoken turns get the ear-shaped brevity rules LAST, so they win over the
  // format/instruction blocks above — a "use markdown headers" custom
  // instruction must not survive into something being read aloud.
  return source === 'voice' ? `${withScreen}\n${CONFIG.SYSTEM_PROMPT_VOICE_BREVITY}` : withScreen
}

// Strip any ACT_RESULT contract line(s) from the model's output so chat shows the
// real, conversational reply — not the machine summary. The ACT_RESULT line is
// still parsed separately for the OUTPUT path; here we only remove it from what the
// user reads. Returns the cleaned, trimmed message body.
function stripResultLine(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.trim().startsWith('ACT_RESULT:'))
    .join('\n')
    .trim()
}

/** One-line preview of a tool's input for a persisted summary row (command, path, …).
 *  Deliberately a small local copy of the renderer's lib/run-events.ts helper of the
 *  same purpose — main never imports renderer code, and this is the one field worth
 *  duplicating rather than crossing that boundary for. */
function toolCallInputPreview(input: unknown): string {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>
    const pick = o.command ?? o.file_path ?? o.path ?? o.query ?? o.description ?? o.pattern ?? o.url
    if (typeof pick === 'string') return pick
    if (Object.keys(o).length === 0) return ''
  }
  if (input == null) return ''
  if (typeof input === 'string') return input.replace(/\s+/g, ' ').trim()
  try {
    return JSON.stringify(input).replace(/\s+/g, ' ').trim()
  } catch {
    return String(input)
  }
}

const CONVO_TOKEN_BUDGET = 4000

function recentTurnsByBudget(priorTurns: MightyTurn[], budgetTokens: number): MightyTurn[] {
  const budgetChars = budgetTokens * 4
  const kept: MightyTurn[] = []
  let used = 0
  for (let i = priorTurns.length - 1; i >= 0; i--) {
    const t = priorTurns[i]
    used += t.q.length + t.a.length
    if (used > budgetChars && kept.length > 0) break
    kept.push(t)
  }
  return kept.reverse()
}

// Shell-transport backends only; local/mlx http adapters use priorMessagesFor's messages[] instead.
function renderConversation(priorTurns: MightyTurn[], message: string): string {
  const name = PREFS.getMightyName()
  const lines: string[] = []
  const recent = recentTurnsByBudget(priorTurns, CONVO_TOKEN_BUDGET)
  if (recent.length > 0) {
    lines.push('CONVERSATION SO FAR:')
    for (const t of recent) {
      lines.push(`User: ${t.q}`)
      if (t.a.trim() !== '') lines.push(`${name}: ${t.a}`)
    }
    lines.push('')
  }
  lines.push(`User: ${message}`)
  lines.push('')
  // No "remember the ACT_RESULT line" nag here — the system prompt now decides
  // chat-vs-build mode, so forcing the contract line would turn a plain "hello"
  // into a terse summary. Let the model converse or build as the message warrants.
  lines.push('Reply now. If this needs an artifact, build it; otherwise just talk.')
  return lines.join('\n')
}

function priorMessagesFor(priorTurns: MightyTurn[]): PriorMessage[] {
  const recent = recentTurnsByBudget(priorTurns, CONVO_TOKEN_BUDGET)
  const out: PriorMessage[] = []
  for (const t of recent) {
    out.push({ role: 'user', content: t.q })
    if (t.a.trim() !== '') out.push({ role: 'assistant', content: t.a })
  }
  return out
}

// Snapshot the workspace file set so we can detect what a run NEWLY created — the
// agent may write files without naming them all on the ACT_RESULT line, and we want
// the registry to capture everything. Returns absolute paths (recursive, shallow-safe).
function snapshotWorkspace(): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (dir: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      const p = join(dir, name)
      if (p === PATHS.MIGHTY_MEMORY) continue
      try {
        const st = statSync(p)
        if (st.isDirectory()) walk(p)
        else out.set(p, `${st.mtimeMs}:${st.size}`)
      } catch {
        // skip unreadable
      }
    }
  }
  walk(PATHS.MIGHTY_WORKSPACE)
  return out
}

export interface RunMightyOpts {
  /** The user's message (chat) or the job's prompt (scheduled). */
  message: string
  /** Session to append to; undefined → a new session is created. */
  sessionId?: string
  /**
   * Project to seed a brand-new session's defaults from. Only consulted when
   * sessionId is absent (a session that already exists carries its own projectId,
   * read straight off the session record instead — see resolveProject below).
   */
  projectId?: string
  /**
   * Provider for this one run, ahead of the session's own field. Only for the pane's
   * FIRST send: the dropdown choice exists in renderer state before any session does,
   * so there is nothing on disk to read yet.
   */
  backend?: BackendId
  /** User-attached media (images / files / audio). Audio is transcribed to text
   *  before the run; images + files flow to the adapter for per-backend translation. */
  attachments?: MediaAttachment[]
  /** What triggered this run. */
  source: MightyRunSource
  /**
   * Live-activity callback fired on every backend phase change ("Reading…",
   * "Writing", "Running command"). Chat wires this to push phases to the window so
   * the pending bubble shows what Mighty is doing; the scheduler omits it.
   *
   * `detail` is the adapter's specific subject for the phase — the filename being
   * read, the command being run — and is `''` when the phase has no subject. It
   * used to be dropped here, which is what made a long run read as one repeated
   * word with no sense of progress. Surfaces are free to ignore it.
   */
  onPhase?: (phase: string, detail: string, sessionId: string) => void
  /**
   * Rich per-line transcript events (tool calls, thinking, assistant text chunks,
   * final usage) — same union the Run Transcript Inspector overlay consumes. Only
   * the `claude` adapter emits these (see adapters.ts parseEvent); other backends
   * simply never call it, so chat degrades to phase-only for those. Chat wires this
   * to stream the answer + steps live; the scheduler omits it.
   */
  onEvent?: (event: RunEvent, sessionId: string) => void
  /**
   * Let this turn DRIVE the Mac — click, type, scroll — instead of only answering.
   * Fires one screenshot before the run and appends the mm-input verb list to the
   * system prompt; the coordinates in those verbs are read off that image, which is
   * why the capability and the capture are one flag and not two.
   *
   * Off for chat and jobs. Live mode passes PREFS.getLiveActs().
   */
  screenControl?: boolean
  /**
   * The run's id, handed over the moment it exists — before the backend spawns.
   * A caller that wants to STOP this run needs the id while it is still in
   * flight, and the resolved result arrives far too late for that.
   */
  onRunId?: (runId: string) => void

  /**
   * Fires with the absolute path of the control screenshot, once, as soon as it
   * is captured. Separate from `onEvent` because the capture happens BEFORE the
   * run starts — there is no RunEvent to hang it off, and it is the one step in
   * an act turn the agent didn't ask for.
   */
  onScreenshot?: (screenshotPath: string) => void
}

/**
 * Resolve the project (if any) a run should inherit defaults from: an existing
 * session's own projectId takes priority (it's already assigned), falling back to
 * opts.projectId for a brand-new session being created inside a project. Returns
 * null when there's no project to apply — every caller then behaves exactly as
 * before Projects existed (global PREFS backend/model, no extra prompt context).
 */
function resolveProject(opts: RunMightyOpts): MightyProject | null {
  const existing = opts.sessionId ? MIGHTY.getSession(opts.sessionId) : null
  const projectId = existing?.projectId ?? opts.projectId
  if (!projectId) return null
  return MIGHTY.getProject(projectId)
}

/**
 * Run one Mighty turn end-to-end and return the result. Resolves only when the run
 * finishes (unlike fire-and-forget runBackend callers) so chat + scheduler can await
 * it. Never throws — a failure resolves with an `error` field and is logged as a
 * failed turn, mirroring how the rest of the app degrades a bad run to a logged miss.
 */
export function runMighty(opts: RunMightyOpts): Promise<MightyChatResult> {
  const session = opts.sessionId ? MIGHTY.getSession(opts.sessionId) : null
  const project = resolveProject(opts)
  const backend = toBackendId(
    opts.backend ?? session?.backend ?? project?.defaultBackend ?? PREFS.getBackend()
  )
  const runId = randomUUID()
  opts.onRunId?.(runId)
  const ts = historyTimestamp()

  // An unattended job on a backend that can't refuse a command has no guardrail:
  // no human watching, no short fuse (jobs get an hour), and no deny list. Refuse
  // the run instead of silently granting it unrestricted shell for an hour. Chat is
  // unaffected — a human is right there. This is the gate that makes the raised
  // ceiling safe; see canRunUnattended.
  if (opts.source === 'job' && !canRunUnattended(backend)) {
    const label = BACKENDS[backend].label
    return Promise.resolve({
      answer: `Scheduled jobs can't run on ${label} - it can't limit what a command does, and a job runs with nobody watching. Switch this job's backend to ${BACKENDS.claude.label} or ${BACKENDS.mightymouse.label} to run it on a schedule.`,
      sessionId: opts.sessionId ?? '',
      artifacts: [],
      // Refused by policy before anything spawned — same shape as a binary that
      // couldn't start, and distinguishable from a run that ran and failed.
      error: 'spawn_failed'
    })
  }

  // Per-run dump dir (prompt/output), swept like tmp. Distinct from the workspace
  // (the agent's file output) so transient prompt text never pollutes "things made".
  const stamp = ts.replace(/[:]/g, '-')
  const runDir = join(PATHS.MIGHTY_RUNS, `${opts.source}-${stamp}-${runId.slice(0, 8)}`)
  try {
    if (!existsSync(runDir)) mkdirSync(runDir, { recursive: true })
  } catch {
    // best-effort; runBackend will still write into it
  }

  // Resolve the prior conversation for context (empty for a brand-new session).
  const prior = opts.sessionId ? (MIGHTY.getSession(opts.sessionId)?.turns ?? []) : []
  const memoryBlob = buildMemoryBlob({ mode: 'act' })
  const convo = renderConversation(prior, opts.message)
  const baseUserPrompt = memoryBlob.trim() !== '' ? `${memoryBlob.trim()}\n\n---\n\n${convo}` : convo

  const attachments = opts.attachments || []
  // By-kind rollup recorded on each turn so a session's audit shows what was sent
  // (distinct from context). Omitted on the turn when nothing was attached.
  const attSummary = attachments.length > 0 ? summarizeAttachments(attachments) : undefined

  // Run timing, surfaced per-turn in detail mode. `startedAt` covers the whole turn
  // (transcription + prompt assembly + the backend run), which is what the user
  // actually waited through — the runner's own duration starts later, at spawn.
  const startedAt = Date.now()
  // Stamped by the first phase push: the backend's first sign of life. Stays null on
  // a run that dies before emitting one, which is why the turn field is optional.
  let firstPhaseAt: number | null = null

  // Tracked alongside the live onEvent stream (below) so the settled turn keeps a
  // trail of what Mighty did — otherwise it vanishes the moment the turn lands, since
  // the renderer's own liveTimeline is cleared once the persisted session replaces it.
  const toolCalls: ToolCallSummary[] = []
  const openToolCalls = new Map<string, ToolCallSummary>()
  let usage: TurnUsage | undefined

  const before = snapshotWorkspace()

  // The chat turn becomes visible — with an empty answer — the moment the run
  // STARTS, not once it finishes. Mirrors the ask path's hud-run.ts startTurn call:
  // before this, a brand-new chat's session had zero turns until the run landed, so
  // the sidebar showed nothing for the whole run and only appeared once it finished.
  // resolveTurn (paired below in onDone / the catch handler) patches this same turn
  // in place rather than appending a second one.
  const pendingTurn: MightyTurn = {
    source: opts.source,
    q: opts.message,
    a: '',
    ts,
    ok: true,
    backend
  }
  const sessionId = MIGHTY.startTurn(opts.sessionId, pendingTurn, runId, opts.projectId)
  // A pane's dropdown choice made before it had a session lives only in renderer
  // state; pin it now that a session exists, so later turns resolve it from disk.
  if (opts.backend && !session?.backend) MIGHTY.setSessionBackend(sessionId, opts.backend)
  broadcastMightyTurnAppended(sessionId)

  return new Promise<MightyChatResult>((resolve) => {
    // Guard against an adapter that never calls onDone (shouldn't happen) — resolve
    // as a failure on the same ceiling the run uses, so chat/scheduler never hang.
    let settled = false
    const finish = (result: MightyChatResult): void => {
      if (settled) return
      settled = true
      resolve(usage ? { ...result, usage } : result)
    }

    void (async (): Promise<void> => {
    // Attribution for the HISTORY rows below. Both were previously hardcoded ('' and
    // absent), which made Mighty runs — the bulk of all act runs — render as
    // "(unknown)" in Analytics' model + top-app cards.
    //   model: a project can pin its own model (selectedModelOverride above), so that
    //     wins; otherwise the backend's resolved model.
    //   frontApp: one cheap AppleScript, same call the suggestion path uses. Captured
    //     up front (before the run) so it names the app the user launched FROM, not
    //     whatever they alt-tabbed to while a long act ran.
    const runModel = project?.defaultModel || resolveRunModel(backend)
    let ranModel: string | undefined

    // Built HERE, not at the top of the run: the prompt names the model that's about
    // to answer ({{MODEL_LABEL}}) and drops the Claude-skills block for local ones,
    // so it can't be assembled before runModel is known.
    // Screen control needs a FRESH frame per turn: every coordinate the agent
    // emits is measured on this image, so a stale one aims at where things used
    // to be. Deliberately not behind the vision rate limiter — that guard exists
    // to cap the token cost of chatty "look at my screen" turns, and starving a
    // control turn of its frame doesn't save money, it just makes it click wrong.
    // A capture failure degrades to an answer-only turn rather than throwing.
    const controlShot = opts.screenControl
      ? (await fireScreenshot().catch(() => null))?.screenshotPath
      : undefined
    if (controlShot) opts.onScreenshot?.(controlShot)

    const systemPrompt = buildMightySystemPrompt(
      backend,
      runModel,
      project?.systemPrompt,
      opts.source,
      controlShot
    )

    // Mighty IS the act-agent loop: shell, file writes, skill invocation. A model
    // that can't call tools has nothing to run it with, so it streams prose about
    // what it WOULD have done and settles as a turn that looks successful and
    // changed nothing — the same silent-wrong-answer shape as serving an embedding
    // model. Refuse before anything spawns.
    //
    // Asked per-MODEL via getCapabilities, not the adapter's static flag (mlx defaults toolCalls:false).
    const caps =
      backend === 'local'
        ? { ...BACKENDS.local.capabilities, toolCalls: true }
        : await getCapabilities(backend, undefined, backend === 'mlx' ? runModel : undefined).catch(
            () => BACKENDS[backend].capabilities
          )
    const answerOnlyChat =
      opts.source === 'chat' && backend in MODEL_SOURCES && MODEL_SOURCES[backend as keyof typeof MODEL_SOURCES].runs === 'api'
    if (!caps.toolCalls && !answerOnlyChat) {
      const answer = `${BACKENDS[backend].label} can't run agent mode - this model has no way to run commands or edit files, so it could only describe what to do. Switch to ${BACKENDS.claude.label} or ${BACKENDS.mightymouse.label} in Settings, or use Ask and Rewrite, which work on every backend.`
      MIGHTY.resolveTurn(sessionId, runId, { a: answer, ts: historyTimestamp(), ok: false, model: runModel })
      broadcastMightyTurnAppended(sessionId)
      finish({
        answer,
        sessionId,
        artifacts: [],
        // Refused by policy before anything spawned — same shape as the unattended
        // gate above, and distinguishable from a run that ran and failed.
        error: 'spawn_failed'
      })
      return
    }

    const frontApp = (await captureContext().catch(() => null))?.frontApp ?? null

    // Audio → text pre-step (no backend ingests audio); pass on only non-audio media.
    const audioText = await transcribeAttachments(attachments)
    const userPrompt = audioText ? `${baseUserPrompt}${audioText}` : baseUserPrompt
    const backendAttachments = attachments.filter((a) => a.kind !== 'audio')

    // The run's evidence, written BEFORE it starts. An unattended job can now run for
    // an hour; if the app dies at minute 40, every completion-path append below never
    // fires and the work would vanish without a trace. This row is that trace — the
    // completion re-writes the same run_id and latest-wins hides it. See
    // HISTORY.appendPending / reconcilePendingRuns.
    HISTORY.appendPending({
      schema_version: 1,
      run_id: runId,
      ts,
      duration_s: 0,
      instruction: opts.message,
      mode: 'act',
      selection: '',
      selection_chars: 0,
      backend,
      model: runModel,
      ctx_attached: false,
      front_app: frontApp,
      source: 'mighty',
      run_dir: runDir
    })

    const browserTools = opts.source === 'chat' && process.platform === 'darwin' ? await chatBrowserTools() : null
    const endBrowserRun = browserTools ? chatBrowserRun(() => void abortRun(runId)) : undefined

    void runBackend({
      backend,
      runId,
      systemPrompt,
      userPrompt,
      priorMessages: priorMessagesFor(prior),
      runDir,
      // Unset, the run inherits the folder the app was started from and the model treats it as the user's files.
      workDir: project?.repoFolder && existsSync(project.repoFolder) ? project.repoFolder : PATHS.MIGHTY_WORKSPACE,
      // The sandbox: the ONLY filesystem grant is Mighty's workspace, so everything
      // it builds lands there and it can't wander the user's disk via the Read tool.
      addDirs: [PATHS.MIGHTY_WORKSPACE],
      attachments: backendAttachments.length > 0 ? backendAttachments : undefined,
      mode: 'act',
      // Attended chat keeps the short 5-min fuse; an unattended job gets the hour.
      // A screen-control turn overrides its source's ceiling — voice's 20s is sized
      // for one spoken sentence and would kill a multi-click run mid-way.
      timeoutMs: controlShot
        ? Math.max(CONFIG.MIGHTY.RUN_TIMEOUT_MS[opts.source], CONFIG.MIGHTY.VOICE_ACT_TIMEOUT_MS)
        : CONFIG.MIGHTY.RUN_TIMEOUT_MS[opts.source],
      // Silence-kill only for unattended runs — an attended one has a human who can
      // watch it hang and hit stop, and shouldn't be second-guessed by a watchdog.
      stallMs: opts.source === 'job' ? CONFIG.MIGHTY.RUN_STALL_MS : undefined,
      // Nobody's watching a job: add deletes to the deny-list on top of the systemic
      // verbs every run gets. This is what makes the 1h ceiling above safe to ship —
      // see SYSTEMIC_DENIED_TOOLS / UNATTENDED_ONLY_DENIED_TOOLS.
      unattended: opts.source === 'job',
      // Without this the CLI ships the user's MCP servers, skills and settings: ~150K prompt tokens vs ~38K.
      lean: true,
      mcpConfig: browserTools ?? undefined,
      selectedModelOverride: project?.defaultModel,
      onPhase: (phase, detail) => {
        // Forward the friendly headline ("Reading…", "Writing") AND the adapter's
        // specific subject (the filename, the command) to the caller so a surface
        // can show what's actually happening rather than one repeated word. Each
        // surface decides how much of `detail` it has room for. No-op for the
        // scheduler (no callback).
        if (phase.trim() === '') return
        firstPhaseAt ??= Date.now()
        opts.onPhase?.(phase, detail, sessionId)
        // The phone's thread LIST, which `opts.onPhase` can't reach: that
        // callback is per-caller, so a run started on the Mac has nobody
        // forwarding it and the phone's row sat on a static "Running…" for the
        // whole run. Goes through the same fan-out as turn boundaries, and
        // no-ops when no phone is connected.
        broadcastMightyPhase(sessionId, phase, detail)
      },
      onEvent: (event: RunEvent) => {
        // Mirror tool_start/tool_end into the persisted summary trail, keyed by the
        // adapter's own tool_use id so a slow/overlapping pair still matches correctly
        // (same id-pairing approach as the renderer's foldRunEvent).
        if (event.kind === RUN_EVENT.tool_start) {
          const row: ToolCallSummary = { name: event.name, inputPreview: toolCallInputPreview(event.input), ok: true }
          openToolCalls.set(event.id, row)
          toolCalls.push(row)
        } else if (event.kind === RUN_EVENT.tool_end) {
          const row = openToolCalls.get(event.id)
          if (row) {
            row.ok = !event.isError
            openToolCalls.delete(event.id)
          }
        } else if (event.kind === RUN_EVENT.usage) {
          if (event.model) ranModel = event.model
          const free = backend === 'local' || backend === 'mlx'
          const costUsd = free || event.costUsd === undefined ? usage?.costUsd : (usage?.costUsd ?? 0) + event.costUsd
          const genMs = event.durationMs === undefined ? usage?.genMs : (usage?.genMs ?? 0) + event.durationMs
          usage = {
            inputTokens: (usage?.inputTokens ?? 0) + event.inputTokens,
            outputTokens: (usage?.outputTokens ?? 0) + event.outputTokens,
            costUsd,
            free,
            genMs
          }
        }
        opts.onEvent?.(event, sessionId)
      },
      onDone: (result, exitCode, _stdOut, stdErr, _duration) => {
        endBrowserRun?.()
        const ok = exitCode === 0
        const parsed = result ? parseActResult(result) : null
        // Show the model's real, conversational reply — strip the ACT_RESULT contract
        // line so chat reads like a person, not a status code ("ready"). The summary
        // is only a fallback for the rare build that printed ONLY the contract line.
        const body = stripResultLine(result ?? '')
        // stdErr only carries a clean sentence when buildCommand threw before spawning
        // (missing CLI binary) — everything else is raw process chatter, unfit for chat.
        const missingCliMsg = stdErr.trim().endsWith(' in Settings.')
          ? stdErr.trim()
          : null
        const providerMsg = ok ? null : (BACKENDS[backend].explainFailure?.(_stdOut) ?? null)
        const answer = ok
          ? body !== ''
            ? body
            : parsed?.summary && parsed.summary.trim() !== ''
              ? parsed.summary
              : 'Done.'
          : exitCode === EXIT_TIMEOUT
            ? 'That took too long and timed out. Try again or narrow it down.'
            : exitCode === EXIT_STOPPED
              ? CONFIG.MIGHTY.STOPPED_REPLY
              : exitCode === -2
                ? CONFIG.UI_LABELS.RUN_FAIL_REASON.out_of_credits
                : (missingCliMsg ?? providerMsg ?? 'Something went wrong on that run.')

        // Classify ONCE, here, and feed both stores from it. The display string
        // above is copy for a human; this is the machine-readable record. They
        // used to be the same value, which is why 423 failed runs are unreadable.
        const reason: RunFailReason | undefined = ok
          ? undefined
          : missingCliMsg !== null
            ? 'spawn_failed'
            : classifyFailure(exitCode, answer, backend)

        // Detect newly-created files (named on ACT_RESULT or just appeared in workspace).
        // A path that already existed but whose mtime/size moved was OVERWRITTEN by this
        // run — it counts as this run's artifact too, and the older registry entry now
        // points at bytes that are gone, so it gets dropped rather than left as a row
        // that opens someone else's file.
        const after = snapshotWorkspace()
        const created: string[] = []
        const overwritten: string[] = []
        for (const [path, stamp] of after) {
          const prior = before.get(path)
          if (prior === undefined) created.push(path)
          else if (prior !== stamp) overwritten.push(path)
        }
        created.push(...overwritten)
        if (parsed?.outputPath && parsed.outputPath !== '' && !created.includes(parsed.outputPath)) {
          // Honor an explicitly-named output even if it's outside the workspace scan.
          created.push(parsed.outputPath)
        }

        // Fill in the answer on the turn startTurn already made visible, above.
        const turnTs = historyTimestamp()
        const patch: Partial<MightyTurn> = {
          a: answer,
          ts: turnTs,
          ok,
          model: ranModel ?? runModel,
          artifacts: created.length > 0 ? created : undefined,
          attachments: attSummary,
          sources: attachments.length > 0 ? attachments.map((a) => a.path) : undefined,
          durationMs: Date.now() - startedAt,
          firstPhaseMs: firstPhaseAt === null ? undefined : firstPhaseAt - startedAt,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          usage
        }
        MIGHTY.resolveTurn(sessionId, runId, patch)
        broadcastMightyTurnAppended(sessionId)
        const landedSession = sessionId

        // Register every created artifact so it shows in the "Made" tab. An overwritten
        // path drops its previous row first — otherwise the tab lists the same filename
        // twice under two different prompts, both opening the newer run's content.
        for (const path of overwritten) {
          MIGHTY.removeArtifact(path)
        }
        for (const path of created) {
          MIGHTY.addArtifact({ path, ts: turnTs, sessionId: landedSession, prompt: opts.message })
        }

        // Also log to the shared HISTORY store so panel recall ("what did I ask
        // yesterday") can surface Mighty conversations too — mode 'act' since Mighty
        // always runs the act-agent loop. Mirrors MightySession's turns shape into a
        // single-turn HistoryEntry per Mighty turn (Mighty owns its own multi-turn
        // session separately; this is just the recall-visible trace).
        HISTORY.append({
          schema_version: 1,
          run_id: runId,
          ts: turnTs,
          // Was hardcoded 0, which made every Mighty run look instant in Analytics.
          // Same measure the turn records, in the seconds this row expects.
          duration_s: Math.round((patch.durationMs ?? 0) / 1000),
          duration_ms: patch.durationMs ?? 0,
          instruction: opts.message,
          mode: 'act',
          selection: '',
          selection_chars: 0,
          result: answer,
          result_chars: answer.length,
          ok,
          reason,
          result_detail: ok ? undefined : failDetail(stdErr),
          backend,
          model: ranModel ?? runModel,
          ctx_attached: false,
          front_app: frontApp,
          source: 'mighty',
          run_dir: runDir
        })

        // Cloud run-outcome. Mighty calls runBackend directly rather than going
        // through hud-run, so without this every Mighty run was invisible to the
        // fleet dashboards — and its failures never reached admin-stats' fail-reason
        // rollup, which is why that panel rendered empty.
        track(ANALYTICS_EVENT.run_completed, {
          mode: 'act',
          backend,
          model: ranModel ?? runModel,
          ok,
          duration_ms: patch.durationMs ?? 0,
          chars_out: answer.length,
          turns: 0,
          ctx: false,
          source: opts.source,
          ...(ok ? {} : { reason, exit_code: exitCode })
        })

        finish({
          answer,
          sessionId: landedSession,
          artifacts: created,
          error: reason
        })
      }
    }).catch((err: unknown) => {
      endBrowserRun?.()
      // runBackend itself threw before spawning (e.g. binary not found). Fill in the
      // turn startTurn already made visible, and resolve. A pre-spawn throw is the
      // MOST diagnosable failure there is, so keep the thrown message — it names the
      // binary that couldn't be found.
      const failTs = historyTimestamp()
      const failMs = Date.now() - startedAt
      const answer = 'I could not start that run.'
      const detail = failDetail(err instanceof Error ? err.message : String(err))
      MIGHTY.resolveTurn(sessionId, runId, {
        a: answer,
        ts: failTs,
        ok: false,
        model: runModel,
        attachments: attSummary,
        sources: attachments.length > 0 ? attachments.map((a) => a.path) : undefined,
        // Recorded even though the run never spawned: a slow failure (a binary probe
        // that hung) is exactly the case detail mode exists to make visible. No
        // firstPhaseMs — nothing ever ran to emit a phase.
        durationMs: failMs
      })
      broadcastMightyTurnAppended(sessionId)
      const landedSession = sessionId
      HISTORY.append({
        schema_version: 1,
        run_id: runId,
        ts: failTs,
        // Was hardcoded 0, which hid exactly the slow pre-spawn failure this path exists to record.
        duration_s: Math.round(failMs / 1000),
        duration_ms: failMs,
        instruction: opts.message,
        mode: 'act',
        selection: '',
        selection_chars: 0,
        result: answer,
        result_chars: answer.length,
        ok: false,
        reason: 'spawn_failed',
        result_detail: detail,
        backend,
        model: runModel,
        ctx_attached: false,
        front_app: frontApp,
        source: 'mighty',
        run_dir: runDir
      })
      // exit_code -1 = the runner's spawn/IO failure sentinel; nothing ever ran to
      // produce a real one here.
      track(ANALYTICS_EVENT.run_completed, {
        mode: 'act',
        backend,
        model: runModel,
        ok: false,
        duration_ms: Date.now() - startedAt,
        chars_out: 0,
        turns: 0,
        ctx: false,
        source: opts.source,
        reason: 'spawn_failed',
        exit_code: -1
      })
      finish({ answer, sessionId: landedSession, artifacts: [], error: 'spawn_failed' })
    })
    })()
  })
}

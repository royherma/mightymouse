import { spawn } from 'child_process'
import { writeFileSync, appendFileSync, readFileSync, readdirSync, openSync, readSync, closeSync, fstatSync } from 'fs'
import { join } from 'path'
import { unlinkSync } from 'fs'
import { PATHS } from '../store/paths'
import { PREFS } from '../store/prefs'
import { CONFIG } from '../../shared/config'
import { shell } from '../platform'
import { cleanOutput } from './parse'
import { BACKENDS, BackendId, PriorMessage } from './adapters'
import type { AppMode, MediaAttachment, RunEvent } from '../../shared/types'
import { getSupabase } from '../supabase'
import { trackError } from '../analytics'
import { actControlSocketPath } from '../act-control-path'
import { ensureAgentModel } from './local-models'
import { fillSpares, hasSpares, keepSpareReady, stdinPromptLine, takeSpare, type SpareSpec } from './spare-pool'
import { pickPlanLogin, planLoginHasRoom, recordPlanRun } from './plan-logins'

/**
 * The model a run will ACTUALLY use, for the history/analytics label.
 *
 * Why this exists: `local`/`mlx` carry no model in config (`OLLAMA_MODEL` and
 * `RAPIDMLX_MODEL` are '' — the user picks one at runtime), so the adapter's
 * static `modelName` is empty for them. The run path already resolved the real
 * model from PREFS (see runHttp's ollamaModel/mlxModel below) while the logging
 * path read the static field — two sources of truth for one fact, and the log
 * side was the empty one. Every history row and analytics event MUST label the
 * model through here so the two can never disagree again.
 *
 * Returns '' only when a local backend has no model picked yet (a run that can't
 * happen anyway). An empty model on a completed run is always a bug.
 */
export function resolveRunModel(backend: BackendId): string {
  if (backend === 'local') return PREFS.getOllamaModel()
  if (backend === 'mlx') return PREFS.getMlxModel()
  if (backend === 'opencode') return PREFS.getChatModel('opencode') || BACKENDS.opencode.modelName
  if (backend === 'openrouter')
    return PREFS.getChatModel('openrouter') || PREFS.getSelectedModel() || BACKENDS.openrouter.modelName
  return BACKENDS[backend].modelName
}

/**
 * The ordered models to try for a run, newest first. Only the `claude` CLI path
 * has a chain today — it's the one whose model we bump the day a new flagship
 * lands, ahead of every user's CLI/account actually having it.
 *
 * Index 0 is what the adapter would have spawned anyway, so a backend with no
 * chain returns a 1-entry list and the retry logic below is a no-op for it.
 */
export function resolveModelChain(backend: BackendId, fast: boolean | undefined): string[] {
  if (backend !== 'claude' && backend !== 'mightymouse') return []
  const useFast = fast === true && CONFIG.CLAUDE_FAST_MODEL !== ''
  const head = useFast ? CONFIG.CLAUDE_FAST_MODEL : CONFIG.CLAUDE_MODEL
  const rest = useFast ? CONFIG.CLAUDE_FAST_MODEL_FALLBACKS : CONFIG.CLAUDE_MODEL_FALLBACKS
  // Dedupe so a fallback that duplicates the head can't spawn the same run twice.
  return [...new Set([head, ...rest])].filter((m) => m !== '')
}

const TERMINAL_LOG_TAIL_BYTES = 512 * 1024
const TERMINAL_LINE_MAX = 2000
const TERMINAL_OUTPUT_MAX = 256 * 1024

function runLogLines(runId: string): string[] {
  let tail = ''
  try {
    const fd = openSync(PATHS.LOG, 'r')
    try {
      const size = fstatSync(fd).size
      const buf = Buffer.alloc(Math.min(size, TERMINAL_LOG_TAIL_BYTES))
      readSync(fd, buf, 0, buf.length, size - buf.length)
      tail = buf.toString('utf-8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return []
  }
  const tag = `[${runId}]`
  const lines: string[] = []
  let mine = false
  for (const line of tail.split('\n')) {
    if (line.startsWith('=== RUN ')) {
      mine = false
      continue
    }
    const tagged = /\[[0-9a-f-]{36}\]/.exec(line)
    if (tagged) mine = tagged[0] === tag
    if (mine && line.trim() !== '') lines.push(line.replace(`${tag} `, ''))
  }
  return lines
}

export function runTerminal(runId: string, runDir: string | undefined): string {
  const log = runLogLines(runId)
  const spawned = log.findIndex((l) => l === 'cold spawn' || l === 'took a pre-started process')
  let output = ''
  if (runDir) {
    try {
      output = readdirSync(runDir)
        .filter((name) => name.startsWith('.out-'))
        .sort()
        .flatMap((name) => readFileSync(join(runDir, name), 'utf-8').split('\n'))
        .filter((line) => line.trim() !== '')
        .map((line) => (line.length > TERMINAL_LINE_MAX ? `${line.slice(0, TERMINAL_LINE_MAX)} … +${line.length - TERMINAL_LINE_MAX} more` : line))
        .join('\n')
    } catch {
      output = ''
    }
  }
  if (output.length > TERMINAL_OUTPUT_MAX) output = `… earlier output cut\n${output.slice(-TERMINAL_OUTPUT_MAX)}`
  return [...log.slice(0, spawned + 1), output, ...log.slice(spawned + 1)].filter((part) => part !== '').join('\n')
}

/**
 * Did this run die because the CLI refused the --model we asked for?
 *
 * The claude CLI reports an unknown/no-access model as plain prose on STDOUT
 * (NOT stderr) with exit 1 — verified 2026-07-27 against `--model claude-opus-99`:
 *   "There's an issue with the selected model (X). It may not exist or you may
 *    not have access to it."
 * Match on that shape rather than the exit code alone, so an ordinary failed run
 * never gets silently retried on a different model.
 */
export function isModelUnavailable(stdout: string, stderr: string): boolean {
  return /issue with the selected model|(?:model).{0,40}(?:does not exist|not found|no access|may not have access)/i.test(
    `${stdout}\n${stderr}`
  )
}

/**
 * Fire a throw-away invocation so the OS warms the binary + dylib in the file cache.
 * Subsequent real runs skip the cold-load cost (~200-600ms on first use).
 * Errors are swallowed — this is best-effort only.
 *
 * HTTP adapters have no binary to prewarm — skip them silently.
 */
export function prewarmLLM(backend: BackendId): void {
  const adapter = BACKENDS[backend]

  // Only warm adapters that are statically shell. HTTP adapters have no binary;
  // per-feature adapters (function transport, e.g. MightyMouse) only spawn for
  // `act` and their CLI is already warmed via the BYO `claude` adapter — skip.
  if (adapter.transport !== 'shell') return
  if (adapter.pooledSpawn && hasSpares()) return
  // opencode's warm-up prompt is a billed OpenRouter call (~288/day at the idle interval).
  if (backend === 'opencode') return

  const promptFile = join(PATHS.TMP, 'warmup-prompt.txt')
  try {
    writeFileSync(promptFile, 'respond with the single word ready', 'utf-8')
  } catch {
    return
  }

  let cmd: string
  try {
    cmd = adapter.buildCommand!({
      runDir: PATHS.TMP,
      promptFile,
      outFile: join(PATHS.TMP, 'warmup-out.txt'),
      addDirs: [],
      attachments: [],
      shellQuote: shell.quote,
      shellFileText: shell.fileText
    })
  } catch {
    // Binary not installed — nothing to prewarm. Best-effort, swallow.
    return
  }

  const child = spawn(shell.bin, shell.spawnArgs(cmd), { env: shell.env(), stdio: ['ignore', 'pipe', 'pipe'] })

  // Kill as soon as we get the first byte — binary is loaded, cache is warm
  const kill = (): void => {
    try { child.kill() } catch { /* Best-effort cleanup or diagnostics must not interrupt the run. */ }
  }
  child.stdout.once('data', kill)
  const timeout = setTimeout(kill, 10_000)
  child.on('close', () => clearTimeout(timeout))
  child.on('error', () => clearTimeout(timeout))
}

/**
 * Warm every shell-backed CLI (claude, codex), not just the current pref, so
 * switching backend mid-session still hits a warm binary. `prewarmLLM` skips
 * non-shell adapters internally, so passing all ids is safe + cheap.
 */
export function prewarmAllShellBackends(): void {
  fillSpares()
  for (const id of Object.keys(BACKENDS) as BackendId[]) prewarmLLM(id)
}

// Stamped at the start of every real run — lets the idle-reprewarm loop below
// tell "user is actively asking things" apart from "nothing has happened in
// N minutes, the OS may have evicted the CLI binary from cache."
let lastActivityAt = Date.now()

let idleReprewarmTimer: ReturnType<typeof setInterval> | null = null

/**
 * Keep the OS file-cache warm across long idle gaps, not just once at boot.
 * The one-shot prewarm in startAppTail only pays off for the FIRST ask after
 * launch — if the user then goes quiet for 20+ minutes, the OS can evict the
 * CLI binary/dylib pages and the next ask silently eats the cold-load cost
 * again. Polling on an interval (rather than a single idle-timeout) means a
 * user who keeps asking things every few minutes never re-triggers a warm —
 * `lastActivityAt` only advances on a real run, so we skip the redundant fire.
 */
export function startIdleReprewarmLoop(): void {
  if (idleReprewarmTimer) return
  idleReprewarmTimer = setInterval(() => {
    if (Date.now() - lastActivityAt >= CONFIG.PREWARM_IDLE_REFRESH_MS) prewarmAllShellBackends()
  }, CONFIG.PREWARM_IDLE_REFRESH_MS)
  // Don't keep the process alive just for this loop.
  idleReprewarmTimer.unref?.()
}

// Exit-code sentinels surfaced to onDone. 0 = success, >0 = real CLI exit code,
// -1 = spawn/IO failure, -2 = out-of-credits (HTTP 402, set by the http adapter),
// -3 = wall-clock timeout (this module killed a hung run),
// -4 = the USER stopped it (Stop button / stop hotkey) — not a failure.
export const EXIT_TIMEOUT = -3
export const EXIT_STOPPED = -4

// runIds the user deliberately stopped. A SIGKILLed child reports a generic
// nonzero exit, which is indistinguishable from a real crash — so callers used to
// render a user-initiated stop as "agent failed (exit -1)" in red. We tag the id
// at kill time and translate its exit code in the close handler, so every caller
// (HUD, panel, history, audit) sees EXIT_STOPPED and can say "Stopped" instead.
// Entries are consumed by the close handler; the stray-entry sweep below keeps
// this from leaking if a child somehow never closes.
const stoppedRuns = new Set<string>()

/** True if this run was killed by the user (consumes the flag). */
function takeStoppedFlag(runId: string): boolean {
  return stoppedRuns.delete(runId)
}

// ── Live-run registry (for the kill-switch) ─────────────────────────────────
// Every spawned shell child registers here under its runId for its lifetime, so
// the global stop hotkey (Cmd+Opt+Shift+K) can SIGKILL an in-flight agent from
// outside runBackend. Killing the child fires its `close` handler with a nonzero
// code → the normal onDone failure path reports it; no special-cased result
// routing here. HTTP runs aren't registered (no OS process to kill); they finish
// on their own short ceiling. Cleared on close/error/timeout so it never leaks.
const liveRuns = new Map<string, import('child_process').ChildProcess>()

/**
 * Kill a whole process group, not just the shell wrapper. The CLI is spawned
 * detached (see runBackend) so its pid is also its process-group id; killing
 * -pid signals every descendant (grandchildren the CLI forks, common in `act`
 * mode, previously survived as orphans). Falls back to a plain child.kill() if
 * the group-kill fails (e.g. ESRCH — the group already exited in a race).
 */
function killProcessGroup(child: import('child_process').ChildProcess): void {
  if (!child.pid) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    try { child.kill('SIGKILL') } catch { /* Best-effort cleanup or diagnostics must not interrupt the run. */ }
  }
}

/**
 * SIGKILL every in-flight shell run. Returns the count killed. Each killed child's
 * `close` event runs the standard failure path (exitCode = the kill signal's code),
 * so the HUD/panel surfaces a failed run with no extra wiring. Safe to call when
 * nothing is running (returns 0).
 */
export function abortAllRuns(): number {
  let killed = 0
  for (const [id, child] of liveRuns) {
    stoppedRuns.add(id)
    killProcessGroup(child)
    killed++
  }
  liveRuns.clear()
  return killed
}

/**
 * SIGKILL one in-flight shell run by id. Returns true if a matching live run was
 * found and killed. Like abortAllRuns, the child's `close` event runs the standard
 * failure path, so the panel/HUD surfaces the stop with no extra wiring. Used by the
 * per-run Stop button so stopping one run never touches another in flight.
 */
export function abortRun(runId: string): boolean {
  const child = liveRuns.get(runId)
  if (!child) return false
  stoppedRuns.add(runId)
  killProcessGroup(child)
  liveRuns.delete(runId)
  return true
}

/** Whether any shell run is currently in flight — drives the "press K to stop" hint. */
export function hasLiveRun(): boolean {
  return liveRuns.size > 0
}

/** One finished tool call's timing, written to steps.jsonl and summarized in run.json. */
export interface StepTiming {
  i: number
  kind: string
  cmd: string
  exit?: number
  startMs: number
  durMs: number
}

/**
 * Read <runDir>/steps.jsonl and return a compact timing summary for run.json: the
 * total step count and the slowest few, so the audit row alone shows the bottleneck
 * without opening the raw stream. Returns null when no steps were logged (e.g. an
 * http run, or a backend without parseStep).
 */
export function summarizeSteps(
  runDir: string,
  topN = 5
): { stepCount: number; slowest: StepTiming[] } | null {
  let raw: string
  try {
    raw = readFileSync(join(runDir, 'steps.jsonl'), 'utf-8')
  } catch {
    return null
  }
  const rows: StepTiming[] = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    try {
      rows.push(JSON.parse(line))
    } catch { /* Best-effort cleanup or diagnostics must not interrupt the run. */ }
  }
  if (rows.length === 0) return null
  const slowest = [...rows].sort((a, b) => b.durMs - a.durMs).slice(0, topN)
  return { stepCount: rows.length, slowest }
}

/**
 * Per-run tool-call timer. Fed each StreamStep the adapter parses; on a 'start' it
 * records the offset, on the matching 'end' it appends a row to <runDir>/steps.jsonl
 * so a slow run's bottleneck (which command ate the time) is always recoverable.
 * Returns the finished step on an 'end' so the runner can drive a live HUD counter.
 */
function makeStepTracker(runDir: string, startedAt: number): {
  feed: (s: import('./adapters').StreamStep) => StepTiming | null
  count: number
} {
  const open = new Map<string, { i: number; kind: string; cmd: string; startMs: number }>()
  const stepsFile = join(runDir, 'steps.jsonl')
  let seq = 0
  const tracker = {
    count: 0,
    feed(s: import('./adapters').StreamStep): StepTiming | null {
      const nowMs = Date.now() - startedAt
      if (s.edge === 'start') {
        // Some streams emit only completes (no id pairing) — synthesize an id so we
        // still log a row with a best-effort 0 duration rather than dropping it.
        const id = s.id || `seq-${seq}`
        open.set(id, { i: seq++, kind: s.kind, cmd: s.cmd, startMs: nowMs })
        tracker.count++
        return null
      }
      // edge === 'end'
      const started = (s.id && open.get(s.id)) || undefined
      const row: StepTiming = started
        ? {
            i: started.i,
            kind: started.kind,
            cmd: started.cmd || s.cmd,
            exit: s.exit,
            startMs: started.startMs,
            durMs: nowMs - started.startMs
          }
        : { i: seq++, kind: s.kind, cmd: s.cmd, exit: s.exit, startMs: nowMs, durMs: 0 }
      if (s.id) open.delete(s.id)
      if (!PREFS.getIncognito()) {
        try {
          appendFileSync(stepsFile, JSON.stringify(row) + '\n', 'utf-8')
        } catch { /* Best-effort cleanup or diagnostics must not interrupt the run. */ }
      }
      return row
    }
  }
  return tracker
}

export interface RunOptions {
  backend: BackendId
  runId: string
  systemPrompt: string
  userPrompt: string
  priorMessages?: PriorMessage[]
  runDir: string
  workDir?: string
  addDirs?: string[]
  disableTools?: boolean
  model?: string
  /** Wall-clock ceiling in ms. On expiry the run is killed → exitCode -3. */
  timeoutMs?: number
  /**
   * Silence ceiling in ms: kill the run if the CLI streams NOTHING for this long
   * (→ exitCode -3, same as a wall-clock timeout — a wedged run is a timed-out run
   * from the user's side). Reset on every parsed event, so a slow-but-alive run
   * never trips it.
   *
   * This is the right instrument for long unattended work, where a flat wall-clock
   * ceiling can't tell a productive 40-minute run from one wedged at minute 4. Left
   * undefined for attended runs — there's a human watching who can hit stop.
   */
  stallMs?: number
  /** Nobody is watching this run (a scheduled job). Adapters clamp irreversible
   *  commands when set — see BuildCommandCtx.unattended. Kept separate from stallMs
   *  so "what may it do" and "when do we kill it" stay independent decisions. */
  unattended?: boolean
  /** App feature behind this run (rewrite | ask | act). HTTP path records it on
   *  the usage row for per-feature billing; the shell path ignores it. */
  mode?: AppMode
  /** Prefer the adapter's lighter/faster model when it has one — set for quick
   *  predictions (suggestions) where latency beats depth. Adapters without a fast
   *  tier ignore it (no hard dependency on a fast model existing). */
  fast?: boolean
  lean?: boolean
  mcpConfig?: string
  /** Normalized user media (images + files). ONE list — each adapter translates it
   *  to its own native form (codex `-i`/inline, claude --add-dir, mightymouse http
   *  data-URLs/document blocks). Audio is transcribed to text upstream (hud-run) and
   *  never appears here. Replaces the old pre-baked images/imageFiles split. */
  attachments?: MediaAttachment[]
  /** Force structured JSON output on the http path (response_format json_object).
   *  Set ONLY by JSON-parsed callers (suggestions); shell adapters ignore it (the
   *  prompt clamp does the work there). Per-call, never inferred from feature/mode. */
  json?: boolean
  /** Per-call override for the mightymouse backend's model slug, taking priority
   *  over PREFS.getSelectedModel() (e.g. a Project's default model). Absent → fall
   *  back to the global pref, same as before this field existed. Ignored by every
   *  other adapter. */
  selectedModelOverride?: string
  /** Called with the model the run ACTUALLY used, when only the server knows it
   *  (the paid backend routes server-side). Fires mid-run, before onDone, so a
   *  caller can label its history row with the real slug instead of a guess.
   *  Never fires for backends whose model resolveRunModel() already knows. */
  onModelResolved?: (model: string) => void
  /** Called with whether the run actually reasoned before answering. Only the
   *  `local` adapter fires it; every other backend leaves the caller's default. */
  onThinkingResolved?: (thinking: boolean) => void
  /** Index into the backend's model chain (see resolveModelChain). Set ONLY by the
   *  runner when retrying after the CLI rejected a model — callers always start at
   *  0 (undefined). Guarantees the retry walks forward and terminates. */
  modelAttempt?: number
  onPhase: (phase: string, detail: string) => void
  /** Rich transcript events (tool calls w/ full input/output, thinking, text,
   *  usage) for the Run Transcript Inspector — one call per event the adapter's
   *  parseEvent yields. Optional: only wired by HUD runs when the run-details
   *  setting is on, and only rich-stream adapters (claude) actually emit any.
   *  Fired live as the stream arrives, in stream order. */
  onEvent?: (event: RunEvent) => void
  onDone: (
    result: string | null,
    exitCode: number,
    stdOut: string,
    stdErr: string,
    durationSec: number,
    promptFile: string,
    outFile: string
  ) => void
  permissionMode?: 'plan' | 'bypassPermissions'
  onSpawn?: (pid: number) => void
}

// async only so the buildEnv path can `await getJwt()`; callers fire-and-forget
// (never await the returned promise), so the spawn stays effectively synchronous.
export async function runBackend(opts: RunOptions): Promise<void> {
  lastActivityAt = Date.now()
  const { backend, runId, systemPrompt, userPrompt, runDir, addDirs = [], timeoutMs, stallMs, onPhase, onEvent, onDone } = opts

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const epoch = Date.now()
  // Dot-prefixed so Finder hides them: prompt-*.txt contains the full assembled
  // prompt INCLUDING the system prompt, and out-*.txt the raw model output — the
  // secret sauce we don't want a curious customer reading by opening the run folder.
  // Still on disk (History reveal + replay + debug reference them by absolute path,
  // never by a *.txt glob), just not casually visible. Not encryption — anyone who
  // reveals hidden files can still read them; that's the intended level of "hidden".
  const promptFile = join(runDir, `.prompt-${stamp}-${epoch}.txt`)
  const outFile = join(runDir, `.out-${stamp}-${epoch}.txt`)

  // Incognito: suppress every persisted log/debug write for this run. The prompt
  // file is still written (the CLI reads it as input) but unlinked once the run
  // ends — see scrubTmp(). logRun()/outFile/the prompt-text dump all no-op.
  const incognito = PREFS.getIncognito()
  const logRun = (s: string): void => {
    if (incognito) return
    try { appendFileSync(PATHS.LOG, s, 'utf-8') } catch (err) { console.error('Failed to append run log:', err) }
  }
  // Best-effort removal of the per-run tmp files when incognito is on, so no
  // prompt/response text lingers on disk even for the 24h cleanupTmp window.
  const scrubTmp = (): void => {
    if (!incognito) return
    for (const f of [promptFile, outFile]) {
      try { unlinkSync(f) } catch { /* Best-effort cleanup or diagnostics must not interrupt the run. */ }
    }
  }

  const fullPrompt = systemPrompt !== '' ? `${systemPrompt}\n\n${userPrompt}` : userPrompt

  try {
    writeFileSync(promptFile, fullPrompt, 'utf-8')
  } catch (err) {
    console.error('Failed to write prompt file:', err)
    onDone(null, -1, '', 'Failed to write prompt file', 0, promptFile, outFile)
    return
  }

  const adapter = BACKENDS[backend]

  // Resolve the current Supabase JWT once — shared by both transports. Empty
  // string = signed out; each path propagates the appropriate error.
  const getJwt = async (): Promise<string> => {
    const { data } = await getSupabase().auth.getSession()
    return data.session?.access_token ?? ''
  }

  // Resolve this run's transport. Usually static, but an adapter may vary it by
  // feature (MightyMouse: act → shell CLI agent, rewrite/ask → http chat). This is
  // the ONLY place transport is decided — still never a branch on backend id.
  const transport =
    typeof adapter.transport === 'function' ? adapter.transport(opts.mode) : adapter.transport

  // ── Transport branch (ONE place in the entire codebase) ─────────────────────
  // HTTP adapters own their entire request lifecycle (fetch + stream + error handling).
  // Shell adapters fall through to the spawn path below. Never branch on adapter id.
  if (transport === 'http' && adapter.runHttp) {
    void adapter.runHttp({
      runId,
      systemPrompt,
      userPrompt,
      priorMessages: opts.priorMessages ?? [],
      addDirs,
      timeoutMs,
      feature: opts.mode,
      attachments: opts.attachments ?? [],
      json: opts.json,
      // Only the `local` adapter reads this — resolved here (not in adapters.ts)
      // because prefs.ts imports BackendId from adapters.ts, so adapters.ts can't
      // import prefs.ts back without a cycle. runner.ts already imports both.
      ollamaModel: PREFS.getOllamaModel(),
      // Only the `mlx` adapter reads this — bridged here for the same no-import-cycle
      // reason as ollamaModel above (adapters.ts can't import prefs.ts back).
      mlxModel: PREFS.getMlxModel(),
      // Same no-import-cycle bridge. The adapter still gates this on the model's
      // declared capability AND on feature === 'ask' — the pref alone never turns
      // thinking on, because `think: true` is a hard error on an incapable model.
      thinkingEnabled: PREFS.getThinkingEnabled(),
      // Per-conversation model pick for the paid `mightymouse` backend (empty = the
      // server's feature-routed default). Bridged from PREFS here for the same
      // no-import-cycle reason as ollamaModel above. Only the mightymouse adapter
      // sends it upstream; other http adapters ignore it. A caller-supplied override
      // (e.g. a Project's default model) wins over the global pref.
      selectedModel:
        opts.selectedModelOverride ??
        ((backend === 'openrouter' && PREFS.getChatModel('openrouter')) || PREFS.getSelectedModel()),
      getJwt,
      onPhase,
      onEvent,
      onModelResolved: opts.onModelResolved,
      onThinkingResolved: opts.onThinkingResolved,
      onDone
    })
    return
  }

  // Walk the model chain: index 0 is the adapter's own default (no override), so
  // an untouched first attempt behaves exactly as before this existed.
  const modelChain = resolveModelChain(backend, opts.fast)
  const modelAttempt = opts.modelAttempt ?? 0
  // local has no static modelName/fallback chain, so it always needs an explicit override.
  const chatPick =
    backend === 'opencode' || ((backend === 'claude' || backend === 'codex') && !opts.fast && modelAttempt === 0)
      ? PREFS.getChatModel(backend)
      : ''
  const modelOverride =
    backend === 'local'
      ? resolveRunModel(backend)
      : opts.model && modelAttempt === 0
        ? opts.model
        : chatPick !== ''
        ? chatPick
        : modelAttempt > 0
          ? modelChain[modelAttempt]
          : undefined
  // Tell the caller which model actually ran, so the history row and the analytics
  // "models used" chart record the fallback rather than the model we asked for.
  if (modelOverride !== undefined) opts.onModelResolved?.(modelOverride)
  let spawnModel = modelOverride
  if (backend === 'local' && modelOverride) {
    const agent = await ensureAgentModel(modelOverride)
    if ('error' in agent) {
      onDone(null, -1, '', agent.error, 0, promptFile, outFile)
      return
    }
    spawnModel = agent.model
  }

  const pooled = adapter.pooledSpawn === true && !adapter.buildEnv
  let cmd: string
  try {
    cmd = adapter.buildCommand!({
      runDir,
      workDir: opts.workDir,
      promptFile,
      outFile,
      addDirs,
      attachments: opts.attachments ?? [],
      shellQuote: shell.quote,
      shellFileText: shell.fileText,
      fast: opts.fast,
      lean: opts.lean,
      noTools: opts.disableTools,
      mcpConfig: opts.mcpConfig,
      stdinPrompt: pooled,
      unattended: opts.unattended,
      modelOverride: spawnModel
    })
  } catch (err) {
    // e.g. BinaryNotFoundError when the CLI isn't installed / not on PATH.
    const msg = err instanceof Error ? err.message : 'Failed to build backend command'
    console.error('buildCommand failed:', err)
    onDone(null, -1, '', msg, 0, promptFile, outFile)
    return
  }

  // Claude plan mode is the read-only switch. It has to replace the bypass flag buildClaudeCommand emits.
  if (opts.disableTools && !opts.lean && backend === 'claude') cmd += " --tools ''"
  if (opts.permissionMode === 'plan') {
    cmd = cmd.replace('--permission-mode bypassPermissions', '--permission-mode plan')
  }

  // Build the spawn env. Most adapters use the default shell env; an adapter with
  // buildEnv (MightyMouse act) merges extras that re-point the CLI at our metered
  // Edge proxy + authenticate with the user's JWT (provider key stays server-side).
  let spawnEnv = shell.env()

  // These children are the app talking to itself (suggestions, act, panel runs) —
  // never a session Roy is watching. Claude Code hooks are inherited, so without a
  // marker the Stop hook pushes each one's raw output to his phone as a card.
  spawnEnv = { ...spawnEnv, MM_INTERNAL_RUN: runId }

  // Act runs get the control-socket path so the `mm-ui` shim can reach APP-side
  // capabilities (the highlight overlay) that mm-input can't provide — mm-input
  // posts CGEvents and needs no app state, the overlay is an Electron window only
  // main can drive. Passed via env rather than baked into the shim so the app
  // name / tmp layout stays owned by CONFIG.APP_NAME. See act-control.ts.
  if (opts.mode === 'act') {
    spawnEnv = { ...spawnEnv, MM_ACT_SOCKET: actControlSocketPath() }
  }

  if (adapter.buildEnv) {
    // local needs no account; skip the JWT fetch so offline local Act can't fail on it.
    if (backend === 'local') {
      spawnEnv = { ...spawnEnv, ...adapter.buildEnv({ jwt: '', edgeBaseUrl: '' }) }
    } else {
      // getJwt() → supabase.auth.getSession() can THROW on a transient network blip
      // (GoTrue's background token refresh does a fetch). This is above the killTimer
      // wiring below, so an unguarded throw here would reject runBackend's promise with
      // no timeout net — the paid `act` HUD hangs on "Calling MightyMouse" forever, and
      // crash.ts classifies the Supabase-network rejection as "transient" and never
      // tracks it. Fail the run cleanly + visibly instead. (Money-path safety.)
      let jwt: string
      try {
        jwt = await getJwt()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('getJwt failed before spawn:', err)
        trackError({ kind: 'backend', message: `JWT fetch failed before act run: ${msg}`, source: 'main' })
        onDone(null, -1, '', 'Could not reach MightyMouse to authorize this run. Check your connection and try again.', 0, promptFile, outFile)
        return
      }
      spawnEnv = { ...spawnEnv, ...adapter.buildEnv({ jwt, edgeBaseUrl: CONFIG.BILLING.EDGE_FUNCTION_URL }) }
    }
  }

  const planLogin = pickPlanLogin(backend)
  if (planLogin) spawnEnv = { ...spawnEnv, ...planLogin.env }

  // Log execution
  const logMsg = `[${new Date().toLocaleString()}] [${runId}] ${backend} spawn: ${cmd}\n`
  logRun(`=== RUN ${runId} ===\n${logMsg}`)

  onPhase(`Calling ${adapter.label}`, 'warming up')

  const startedAt = Date.now()
  let firstByteMs: number | null = null

  const spareSpec: SpareSpec | null = pooled
    ? {
        cmd,
        cwd: opts.workDir,
        env: { ...(opts.mode === 'act' ? { MM_ACT_SOCKET: actControlSocketPath() } : {}), ...planLogin?.env }
      }
    : null
  const spare = spareSpec ? takeSpare(spareSpec) : undefined
  logRun(`[${runId}] ${spare ? 'took a pre-started process' : 'cold spawn'}\n`)

  // stdin: 'ignore' is load-bearing for a file prompt: an open pipe makes claude wait 3s for stdin data.
  // detached: true makes child.pid its own process-group leader, so killProcessGroup
  // can SIGKILL the whole tree (child + any grandchildren it forks) instead of just
  // the shell wrapper. We deliberately do NOT unref() — we still await 'close'/'error'.
  const child =
    spare?.child ??
    spawn(shell.bin, shell.spawnArgs(cmd), {
      env: spawnEnv,
      cwd: opts.workDir,
      stdio: [pooled ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      detached: true
    })
  if (pooled) {
    child.stdin?.on('error', () => {})
    child.stdin?.end(stdinPromptLine(fullPrompt))
  }

  // Register for the lifetime of the run so the kill-switch (abortAllRuns) can reach
  // it. Deregistered in close/error below — and on timeout, where we kill it anyway.
  liveRuns.set(runId, child)
  if (child.pid) opts.onSpawn?.(child.pid)

  // Two independent fuses, one kill path. A hung CLI otherwise streams nothing and
  // never closes, freezing the panel/HUD forever.
  //   • wall-clock (timeoutMs) — the backstop: this run has taken too long, period.
  //   • stall (stallMs)        — the sharp one: this run has gone SILENT too long.
  // Wall-clock alone can't tell a productive 40-minute job from one wedged at minute
  // 4; silence can. Both report exitCode -3 — from the user's side a wedged run and
  // a timed-out run are the same event. `timedOut` guards the close handler so we
  // don't double-report when the kill itself triggers a close event.
  let timedOut = false
  const expire = (why: string): void => {
    if (timedOut) return
    timedOut = true
    liveRuns.delete(runId)
    logRun(`[${runId}] ${why} — killing\n`)
    killProcessGroup(child)
    const duration = (Date.now() - startedAt) / 1000
    scrubTmp()
    onDone(null, EXIT_TIMEOUT, stdout, accumulatedStdErr, duration, promptFile, outFile)
  }

  const killTimer =
    timeoutMs && timeoutMs > 0
      ? setTimeout(() => expire(`timed out after ${timeoutMs}ms`), timeoutMs)
      : null

  // Reset on every parsed event (see handleLine), so only true silence trips it.
  let stallTimer: ReturnType<typeof setTimeout> | null = null
  const armStall = (): void => {
    if (!stallMs || stallMs <= 0 || timedOut) return
    if (stallTimer) clearTimeout(stallTimer)
    stallTimer = setTimeout(() => expire(`stalled — no output for ${stallMs}ms`), stallMs)
  }
  armStall()

  const clearKillTimer = (): void => {
    if (killTimer) clearTimeout(killTimer)
    if (stallTimer) clearTimeout(stallTimer)
  }

  // The CLI streams JSONL events to stdout. We capture the whole thing (for the
  // final answer + debugging) AND parse it line-by-line for live progress + timing.
  let stdout = ''
  let lineBuf = ''
  const steps = makeStepTracker(runDir, startedAt)
  const handleLine = (line: string): void => {
    const trimmed = line.trim()
    if (trimmed === '') return
    // Proof of life: ANY line resets the stall fuse. Deliberately counts every line,
    // not just phase changes — a run grinding through output we don't label is still
    // working, and killing it would be the false positive that makes the watchdog
    // worse than the flat ceiling it replaces.
    armStall()
    // Per-step timing → steps.jsonl (silent, for diagnostics). This does NOT drive
    // the HUD copy — the user never sees "step 4 · /bin/zsh -lc …"; that's internal.
    if (adapter.parseStep) {
      const st = adapter.parseStep(trimmed)
      if (st) steps.feed(st)
      // fall through: parsePhase produces the human-facing label for this same line.
    }
    // User-facing progress: the adapter's own friendly phase ("Reading X",
    // "Running command", "Writing"). One source of truth for what the user reads.
    const ph = adapter.parsePhase(trimmed)
    if (ph) onPhase(ph.phase, ph.detail)
    // Rich transcript events for the inspector — only when a caller wired onEvent
    // (HUD runs with the run-details setting on) AND the adapter emits them (claude).
    // Fully separate from the phase/step slivers above: this carries full tool
    // inputs/outputs, thinking, and usage.
    if (onEvent && adapter.parseEvent) {
      for (const ev of adapter.parseEvent(trimmed)) onEvent(ev)
    }
  }

  const onStdout = (str: string): void => {
    if (firstByteMs === null) firstByteMs = Date.now() - startedAt
    stdout += str
    if (!incognito) {
      try { appendFileSync(outFile, str, 'utf-8') } catch { /* Best-effort cleanup or diagnostics must not interrupt the run. */ }
    }
    lineBuf += str
    let nl: number
    while ((nl = lineBuf.indexOf('\n')) !== -1) {
      handleLine(lineBuf.slice(0, nl))
      lineBuf = lineBuf.slice(nl + 1)
    }
  }
  child.stdout!.on('data', (data: Buffer) => onStdout(data.toString()))

  let accumulatedStdErr = ''
  const onStderr = (str: string): void => {
    accumulatedStdErr += str
    logRun(`[${runId}] [STDERR] ${str}`)
  }
  child.stderr!.on('data', (data: Buffer) => onStderr(data.toString()))
  if (spare?.stdout) onStdout(spare.stdout)
  if (spare?.stderr) onStderr(spare.stderr)

  child.on('close', (code) => {
    clearKillTimer()
    liveRuns.delete(runId)
    if (timedOut) return // already reported via the timeout path
    if (lineBuf.trim() !== '') handleLine(lineBuf) // flush any trailing partial line
    const duration = (Date.now() - startedAt) / 1000

    const startupMs = firstByteMs !== null ? `startup: ${firstByteMs}ms, ` : ''
    logRun(`[${runId}] ${backend} exit code: ${code} (${startupMs}total: ${duration.toFixed(2)}s)\n`)
    const hitPlanLimit = planLogin ? recordPlanRun(planLogin.id, code, stdout, accumulatedStdErr) : false

    if (code !== 0) {
      // The user stopped this run. Report it as EXIT_STOPPED so callers render
      // "Stopped" rather than "agent failed (exit -1)" — a deliberate stop is not
      // an error. Checked BEFORE the resume-fallback below: a killed run must
      // never silently respawn as a cold spawn (that would restart the very run
      // the user just stopped). Partial stdout is passed through unchanged, so
      // whatever the agent produced before the kill is kept.
      if (takeStoppedFlag(runId)) {
        scrubTmp()
        onDone(null, EXIT_STOPPED, stdout, accumulatedStdErr, duration, promptFile, outFile)
        return
      }
      // The CLI refused our --model (unknown slug, or this account has no access).
      // Retry down the chain so naming a brand-new model never breaks a user whose
      // CLI/account hasn't got it yet. Bounded by the chain length, so it always
      // terminates and the LAST model's failure surfaces normally.
      if (hitPlanLimit && planLoginHasRoom(backend)) {
        scrubTmp()
        logRun(`[${runId}] login ${planLogin?.id} hit its plan limit — retrying on another login\n`)
        void runBackend(opts)
        return
      }
      if (isModelUnavailable(stdout, accumulatedStdErr) && modelAttempt + 1 < modelChain.length) {
        const next = modelChain[modelAttempt + 1]
        scrubTmp()
        logRun(`[${runId}] model ${modelChain[modelAttempt]} unavailable — retrying with ${next}\n`)
        void runBackend({ ...opts, modelAttempt: modelAttempt + 1 })
        return
      }
      scrubTmp()
      onDone(null, code ?? -1, stdout, accumulatedStdErr, duration, promptFile, outFile)
      return
    }

    if (spareSpec) keepSpareReady(spareSpec)

    // Adapter pulls the final answer out of the JSONL stream.
    const processedResult = cleanOutput(adapter.parseOutput(stdout))

    scrubTmp()
    onDone(processedResult, 0, stdout, accumulatedStdErr, duration, promptFile, outFile)
  })

  child.on('error', (err) => {
    clearKillTimer()
    liveRuns.delete(runId)
    if (timedOut) return
    const duration = (Date.now() - startedAt) / 1000
    // A stop that raced an error still reports as stopped — the user's intent
    // outranks the incidental failure, and it clears the flag either way so it
    // can never leak into a later run.
    const stopped = takeStoppedFlag(runId)
    onDone(null, stopped ? EXIT_STOPPED : -1, '', stopped ? '' : err.message, duration, promptFile, outFile)
  })
}

// hud-run.ts — the single home for running one ask / act / rewrite turn against
// a backend and rendering it to a top-right HUD card (or blind-pasting, for
// rewrite). Both the panel submit handler (ipc.ts) and the listen Ask/Act
// buttons (capture-actions.ts) call THIS — there is no second copy of the
// prompts → runBackend → History/audit → HUD pipeline anywhere.
//
// It also owns the per-runId conversation thread, so a HUD card can ask a
// FOLLOW-UP question inline: the thread is the source of truth for an ask
// conversation; the panel's panelState.history is a non-authoritative mirror
// kept in sync via the onAskTurn callback (the service never imports panel UI
// for chat — only the cross-cutting billing/error/paste bridges below).
import { writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { CONFIG } from '../../shared/config'
import { CHANNELS } from '../../shared/ipc'
import type {
  AppMode,
  ContextData,
  HistoryEntry,
  MediaAttachment,
  MightyTurn
} from '../../shared/types'
import { RUN_EVENT } from '../../shared/types'
import { summarizeAttachments } from '../../shared/attachments'
import { runBackend, summarizeSteps, resolveRunModel, EXIT_TIMEOUT, EXIT_STOPPED } from './runner'
import { isImagePath } from './image-vision'
import { redact } from '../capture/redact'
import { transcribeAttachments } from './audio-transcribe'
import { buildRewritePrompts, buildActPrompts } from './prompts'
import { parseActResult } from './parse'
import { BACKENDS, BackendId } from './adapters'
import { isPhoneRun, sendToPhone } from '../phone-remote/server'
import { estimateDuration } from '../estimator/duration-estimator'
import { track, trackError } from '../analytics'
import { ANALYTICS_EVENT, type RunFailReason } from '../../shared/analytics-events'
import { HISTORY, historyTimestamp, failDetail } from '../store/history'
import { createRunFolder } from '../store/run-folder'
import { UNREAD } from '../store/unread'
import { EVENTS } from '../store/events'
import { PATHS } from '../store/paths'
import { MIGHTY } from '../store/mighty'
import { broadcastMightyTurnAppended } from '../mighty/broadcast'
import {
  startHud as rawStartHud,
  updateHud,
  doneHud as rawDoneHud,
  failHud as rawFailHud,
  runningHud as rawRunningHud
} from '../hud-window'
import { setActivity } from '../activity'
import { pushTranscriptEvent } from '../transcript-window'
import { closePanelWindow, sendToPanelRenderer, isPanelVisible } from '../panel-window'
// Mirror every HUD lifecycle call to the Dynamic Island. The island is a separate,
// opt-in surface; wrapping the four HUD functions here (rather than dotting setActivity
// across the ~8 done/fail sites in this file) means no run path can forget to signal it.
// pushIslandActivity is a no-op when the island is off, so this is free when unused.
const startHud: typeof rawStartHud = (...a) => {
  setActivity('thinking', a[1])
  rawStartHud(...a)
}
const runningHud: typeof rawRunningHud = (...a) => {
  setActivity('thinking', a[1])
  rawRunningHud(...a)
}
const doneHud: typeof rawDoneHud = (...a) => {
  const [, ok, summary] = a
  setActivity(ok ? 'done' : 'error', summary)
  rawDoneHud(...a)
}
const failHud: typeof rawFailHud = (...a) => {
  setActivity('error', a[1])
  rawFailHud(...a)
}

// The onEvent callback a HUD run passes to runBackend — forwards each rich
// transcript event to the inspector, ONLY when the run-details setting is on.
// Returns undefined when off, so runBackend never wires the (claude-only) rich
// parse path and there's zero overhead for the default case. Read live per run,
// not captured, so toggling the setting takes effect on the next run.
function makeTranscriptSink(runId: string): ((event: import('../../shared/types').RunEvent) => void) | undefined {
  if (!PREFS.getRunTranscript()) return undefined
  return (event) => pushTranscriptEvent(runId, event)
}
import { captureContext, pasteText, pasteTextToApp, input } from '../platform'
import { screen } from 'electron'
import { parsePointTag, parseTypeTag } from '../../shared/point-tag'
import { flyCursorTo } from '../cursor-window'
import { findOnScreen } from '../capture/find-on-screen'
import { PREFS } from '../store/prefs'
import { trackChecklistStep } from '../activation-checklist'
import { flashHighlightBox } from '../highlight-window'
import { parseActHighlightTarget, isActInputCommand } from './act-highlight'
import { noteAppGeneratedInput } from '../phone-remote/local-input-watch'

// Activation: emit first_run_succeeded exactly once per machine. run_completed
// fires on every run and so can't answer "did this user ever succeed once" —
// the only question that separates an activated user from a bounced install.
function markFirstRunSucceeded(mode: AppMode, backend: string): void {
  if (PREFS.getFirstRunSucceeded()) return
  PREFS.setFirstRunSucceeded()
  track(ANALYTICS_EVENT.first_run_succeeded, { mode, backend })
  trackChecklistStep('first_run')
}

/**
 * Prefer the real failure reason (e.g. BinaryNotFoundError's "claude CLI not
 * found. Install it or set its path in Settings.") over a generic exit-code
 * string. runner.ts forwards a message via stdErr whenever buildCommand threw
 * BEFORE spawning anything (missing binary) — that's the one case where stdErr
 * is a clean, user-readable sentence rather than raw CLI chatter. A nonzero
 * exit from an actual spawned process fills stdErr with unstructured output,
 * so only trust it when it reads like the one known-clean shape.
 */
function friendlyExitMessage(stdErr: string, fallback: string): string {
  const trimmed = stdErr.trim()
  return trimmed.endsWith(' in Settings.') ? trimmed : fallback
}

const RATE_LIMIT_RE = /\b429\b|rate.?limit|too many requests|quota exceeded/i

/**
 * A friendly reason + message for a nonzero exit, checked BEFORE the generic
 * `${backend} failed (exit N)` fallback. Reuses each adapter's own `parseAuth`
 * (already regex-matches "not logged in" shapes off CLI text — see
 * adapters.ts) against the run's raw stderr. `ok` is hardcoded `true`: that
 * param means "the dedicated auth-probe command exited 0" in its original
 * caller (settings.ts), a signal we don't have here, and several adapters
 * (codex, gemini) fold it straight into `loggedIn` — passing our real `false`
 * would make `loggedIn` default to false and misclassify ANY failure (network
 * blip, crash) as signed-out. `true` restores each adapter's tolerant default:
 * only an explicit logged-out marker in the text flips it. Order: auth before
 * rate-limit — an expired-token error can itself mention "quota".
 */
function classifyRunFailure(
  backend: BackendId,
  stdErr: string
): { reason: RunFailReason; message: string } | null {
  const trimmed = stdErr.trim()
  if (trimmed === '') return null
  const adapter = BACKENDS[backend]
  if (adapter.parseAuth && !adapter.parseAuth(trimmed, true).loggedIn) {
    return { reason: 'signed_out', message: adapter.loginAdvice ?? 'Not signed in.' }
  }
  if (RATE_LIMIT_RE.test(trimmed)) {
    return { reason: 'rate_limited', message: 'Rate limited. Wait a bit and try again.' }
  }
  return null
}

// Cap on the stderr tail attached to the CLOUD run_completed/backend_error events
// (public.events, broader-read than the local history row). Small on purpose —
// this is a diagnostic hint for "why did this fail", not a debug dump.
const CLOUD_STDERR_TAIL_CHARS = 300

/** Truncated, secret-scrubbed stderr tail safe to attach to a tracked analytics
 *  event. Distinct from failDetail() (history.ts), which is local-file-only —
 *  this is the one that actually reaches prod, so it MUST be redacted. '' when
 *  there's nothing to say. */
function scrubbedStdErrTail(stdErr: string): string {
  const trimmed = stdErr.trim()
  if (trimmed === '') return ''
  return redact(trimmed.slice(-CLOUD_STDERR_TAIL_CHARS))
}

/** Extra resolved from a QuickAction before the service is called (ipc.ts reads
 *  the skill body off disk; the service just forwards it to the prompt). */
export interface ResolvedActionExtra {
  key: string
  system_extra?: string
  /** Already read from disk by the caller; '' = none. */
  skill_body: string
}

/**
 * Plain options bag — NO panelState reference, NO store reads for inputs. The
 * caller derives every field from its own state, so this service stays
 * panel-agnostic and reusable from the listen path.
 */
export interface HudRunOptions {
  /** HUD card id. Ask mode uses a fresh `r:<hex4>` per question; act/rewrite/
   *  listen pass their own. */
  runId: string
  /** Stable session id for the HISTORY row. In ask mode this is the panel's
   *  session runId (NOT the per-question card runId), so a multi-turn ask keeps
   *  rewriting ONE row. For act/rewrite/listen it equals runId. */
  historyRunId: string
  mode: AppMode

  instruction: string
  selection: string
  /** Path to the pre-written selection tmp file; '' for act/listen. */
  selFile: string

  ctxData: ContextData | null
  /** Act only; [] otherwise. */
  finderFiles: string[]

  /** User-attached media from the panel/cheese input (images / files / audio).
   *  Audio is transcribed to text here (a pre-step) before the backend runs; images
   *  and files flow through to the adapter, which translates them per-backend. */
  attachments?: MediaAttachment[]

  /** Seed turns for the FIRST call only; follow-ups read the stored thread. */
  conversationHistory: Array<{ q: string; a: string }>
  /** First question (History title) once known; '' lets the service capture it. */
  sessionTitle: string

  actionExtra: ResolvedActionExtra | null
  /** Pre-assembled FIRST-PARTY memory blob (buildMemoryBlob); '' = no-op. */
  memoryBlob: string
  /** Retrieved THIRD-PARTY content (connector items, recall slices); '' = no-op.
   *  Routed to the user turn, not the system prompt — see prompts.ts. */
  retrievedBlob?: string

  backend: BackendId
  source: 'panel' | 'listen' | 'followup' | 'suggestion' | 'phone'
  /** frontApp at trigger time, for rewrite's focus-intact paste guard; '' otherwise. */
  triggerApp: string

  /** Called after a successful ASK turn so the caller can mirror it into its own
   *  state (e.g. panelState.history + panel chat UI). Undefined = no mirror. */
  onAskTurn?: (q: string, a: string) => void

  /** Where an ASK or ACT turn's progress/answer/error surface. 'hud' (default)
   *  drives a top-right HUD card (updateHud/doneHud/failHud). 'panel' routes
   *  through the panel renderer (busyPhase / showAnswer|showActResult / showError)
   *  so the run lives inline in the open panel instead of a card. Set 'panel' only
   *  when the panel is open at submit time. Ignored for rewrite. Act falls back to
   *  a HUD card if the panel is closed by the time the run finishes. */
  target?: 'panel' | 'hud'

  /** The Mighty session this ask is a follow-up on (caller's already-bound session
   *  id, e.g. panel's sessionIdRef). When present, the run APPENDS to it instead of
   *  minting a new one via MIGHTY.newSession — this is what keeps a multi-turn ask
   *  as ONE conversation instead of a fresh session per follow-up. Undefined = first
   *  turn (or rewrite, which never binds a session). */
  sessionId?: string

  /** What this turn shows AS THE QUESTION in the Mighty conversation, when that
   *  differs from `instruction`. A capture follow-up sets it: the spoken transcript
   *  is already turn one, so the follow-up displays "Do this" rather than repeating
   *  the same sentence, while the backend still receives the full `instruction`.
   *  Undefined (the normal case) = the instruction IS the question. */
  turnQ?: string


  /** Set when this run was auto-chained from another run (e.g. smart dictation's
   *  classify step handing off to act) — carried onto the HISTORY row and the
   *  run_completed analytics event so the two can be grouped as one flow.
   *  Undefined for a standalone run. */
  pipelineId?: string
}

interface ThreadEntry {
  turns: Array<{ q: string; a: string }>
  /** First question — History row title across all turns. */
  sessionTitle: string
  backend: BackendId
  /** Session runId for HISTORY writes (see HudRunOptions.historyRunId). */
  historyRunId: string
}

// Per-runId ask conversation threads. Keyed by the HUD card runId so N concurrent
// ask cards (each its own `r:<hex4>`) never collide. Act/rewrite create no entry.
const threads = new Map<string, ThreadEntry>()

/**
 * A run that's CURRENTLY in flight and routed to the open panel (its progress +
 * result land inline). Registered for the lifetime of the backend call. If the
 * user closes/leaves the panel mid-run, detachActiveRunsToHud() flips `routed` to
 * 'hud' and raises a live "working…" card NOW — so the run stays visible top-right
 * (dismissable) instead of vanishing until it finishes. One entry per in-flight
 * panel run; ask/act/rewrite all register the same shape.
 */
interface ActiveRun {
  /** Live routing target. Starts 'panel'; flipped to 'hud' on panel close. The
   *  run's onPhase/onDone read THIS (not a captured flag), so the switch is live. */
  routed: 'panel' | 'hud'
  /** Card title + subtitle to show when detached to the HUD mid-run. */
  hudTitle: string
  hudSubtitle: string
  /** Predicted duration (ms) for this run, so a panel→HUD detach raises the card
   *  WITH its ETA bar. 0 = no estimate (cold start / estimator unavailable). */
  etaMs: number
  /** Wall-clock ms when the run started. On a panel→HUD detach the card continues
   *  the timer + bar from HERE instead of resetting to 0 (the run never restarted —
   *  only its display moved), so the elapsed time + fill stay continuous. */
  startedAt: number
  /** Set for every ask run (never rewrite) the moment it starts — see runAskOrRewriteTurn.
   *  On completion, the answer is appended to this session and a mightyTurnAppended
   *  push fires, so the panel and/or an open Mighty window resolve it live instead of
   *  it hanging without an answer. */
  mightySessionId?: string
}
const activeRuns = new Map<string, ActiveRun>()

/**
 * Move every in-flight panel-routed run to a HUD card immediately. Called when the
 * panel is closed/blurred while a run is still going: the spawned CLI keeps running
 * (closing the panel never kills it), so we just re-point its output to a live card
 * the user can watch (and dismiss) top-right. No-op if nothing is in flight.
 */
export function detachActiveRunsToHud(): void {
  for (const [runId, run] of activeRuns) {
    if (run.routed !== 'panel') continue
    run.routed = 'hud'
    // Pass the run's original start so the card CONTINUES the timer + bar from there
    // instead of resetting to 0 — the run moved surface, it didn't restart.
    startHud(runId, run.hudTitle, run.hudSubtitle, 'act', undefined, run.etaMs, run.startedAt)
  }
}

/** Current turns for a runId, or [] — lets a caller seed conversationHistory. */
export function getHudThread(runId: string): Array<{ q: string; a: string }> {
  return threads.get(runId)?.turns ?? []
}

/** Drop a run's thread — called on card dismiss so threads don't leak. */
export function clearHudThread(runId: string): void {
  threads.delete(runId)
}

/**
 * Follow-up question on an existing ask card: reuse the stored thread, run a new
 * ask turn on the SAME card. The answer flows back through the normal hudDone
 * path. No-ops with a failHud if the thread expired (card dismissed).
 */
export function runHudFollowUp(runId: string, question: string): void {
  const q = question.trim()
  if (q === '') return
  const thread = threads.get(runId)
  if (!thread) {
    failHud(runId, 'session expired - start a new question')
    return
  }

  // A follow-up is always an ask; estimate from (ask, this thread's backend) so the
  // card's bar fills for the new turn too, not just the first question.
  const followUpEtaMs = estimateDuration('ask', thread.backend)?.etaMs ?? 0
  runningHud(runId, 'Working on it', q.length > 40 ? q.slice(0, 40) + '…' : q, followUpEtaMs)
  EVENTS.append({
    run_id: runId,
    event: 'follow_up_start',
    chars: q.length,
    turn_index: thread.turns.length
  })

  runHudRun({
    runId,
    historyRunId: thread.historyRunId,
    mode: 'ask',
    instruction: q,
    selection: '',
    selFile: '',
    ctxData: null,
    finderFiles: [],
    conversationHistory: thread.turns,
    sessionTitle: thread.sessionTitle,
    actionExtra: null,
    memoryBlob: '',
    backend: thread.backend,
    source: 'followup',
    triggerApp: ''
  })
}

/**
 * Run one ask / act / rewrite turn end-to-end. Fire-and-forget: returns once the
 * backend is spawned; all rendering happens in the onDone callback. The caller
 * must have already called startHud() for ask/act (rewrite has no card up front).
 */
export function runHudRun(opts: HudRunOptions): void {
  // Run START — emitted here (the single chokepoint every path funnels through)
  // so panel, listen, suggestion AND follow-up runs all count, with `source` to
  // split them. Pairs with run_completed (end) for completion %/success rate.
  const attSummary = summarizeAttachments(opts.attachments)
  track(ANALYTICS_EVENT.mode_submit, {
    mode: opts.mode,
    backend: opts.backend,
    ctx: opts.ctxData !== null,
    source: opts.source,
    attachments: attSummary.count,
    attachment_images: attSummary.images,
    attachment_audio: attSummary.audio,
    attachment_files: attSummary.files
  })
  if (opts.mode === 'act') {
    runActTurn(opts)
  } else {
    runAskOrRewriteTurn(opts)
  }
}

// ── Act ──────────────────────────────────────────────────────────────────────

function runActTurn(opts: HudRunOptions): void {
  const { runId, instruction, selection, finderFiles, ctxData, backend } = opts
  const backendModel = resolveRunModel(backend)

  // Act routed to the open panel: progress goes through the panel's busy overlay
  // (busyPhase) and the result lands inline (showActResult), mirroring how ask is
  // kept inline. Register it as an in-flight panel run so closing the panel mid-run
  // detaches it to a live HUD card (detachActiveRunsToHud flips run.routed → 'hud').
  // For a hotkey act (target 'hud') the card was already raised by ipc.ts.
  const run: ActiveRun = {
    routed: opts.target === 'panel' ? 'panel' : 'hud',
    hudTitle: instruction.length > 36 ? instruction.substring(0, 36) + '…' : instruction,
    hudSubtitle: 'working…',
    etaMs: estimateDuration('act', backend)?.etaMs ?? 0,
    startedAt: Date.now()
  }
  activeRuns.set(runId, run)

  // An act CONTINUING a conversation (today: the Ask/Act buttons on a capture card,
  // which pass the session logCapture opened) binds to that session the same way ask
  // does — question visible at kickoff, answer patched in on completion. Without this
  // an act wrote nothing to MIGHTY at all, so a voice note you acted on left no
  // conversation to open. Only a run that ALREADY has a session joins one: a bare
  // hotkey act stays session-less, exactly as before, rather than spraying one-turn
  // conversations into the sidebar for every filesystem action.
  // The session this run bound to, kept for the history row. run.mightySessionId is
  // cleared the moment the run settles (so a late resolve can't double-fire), and the
  // row is written after that — so without a copy here the row records no session and
  // History's Continue has nothing to reopen.
  let boundMightySessionId: string | undefined
  if (opts.sessionId) {
    const pending: MightyTurn = {
      source: 'chat',
      q: opts.turnQ ?? instruction,
      a: '',
      ts: historyTimestamp(),
      ok: true,
      backend
    }
    run.mightySessionId = MIGHTY.startTurn(opts.sessionId, pending, runId)
    boundMightySessionId = run.mightySessionId
    broadcastMightyTurnAppended(run.mightySessionId)
  }

  // Fill in the answer for the turn started above and clear the session's running
  // mark. Mirrors runAskOrRewriteTurn's resolveLinkedMighty: PATCHES (never appends,
  // or the question would show twice), fires on EVERY terminal path so a session can
  // never hang mid-think, and clears the link so it can't double-resolve. No-op when
  // this act never bound a session.
  const resolveLinkedMighty = (a: string, ok: boolean): void => {
    const sessionId = run.mightySessionId
    if (!sessionId) return
    run.mightySessionId = undefined
    MIGHTY.resolveTurn(sessionId, runId, { a, ok, ts: historyTimestamp(), backend })
    broadcastMightyTurnAppended(sessionId)
  }

  // Render an act result, reading the LIVE routing: inline if still panel-routed
  // (panel open), else a HUD card (hotkey act, or detached when the panel closed).
  // Every terminal path funnels through here — success, nonzero exit, timeout, stop,
  // and the unparseable-result case — which is what makes it the one safe place to
  // settle the bound conversation.
  const reportActResult = (
    ok: boolean,
    summary: string,
    revealPath: string | null,
    revealIsDir = false,
    stopped = false
  ): void => {
    resolveLinkedMighty(summary, ok)
    activeRuns.delete(runId)
    if (run.routed === 'panel' && isPanelVisible()) {
      sendToPanelRenderer(CHANNELS.showActResult, { summary, revealPath, revealIsDir, ok })
    } else if (ok) {
      doneHud(runId, true, summary, revealPath)
    } else {
      failHud(runId, summary, stopped)
    }
  }

  const { systemPrompt, userPrompt } = buildActPrompts({
    instruction,
    finderFiles,
    selection,
    ctxData,
    memoryBlob: opts.memoryBlob
  })

  // Per-run work dir + flat audit row, named from the first finder file (or a
  // slug of the instruction). Mirrors the run-folder convention.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  let basename = 'run'
  if (finderFiles.length > 0) {
    const lastSlash = finderFiles[0].lastIndexOf('/')
    const f = lastSlash !== -1 ? finderFiles[0].substring(lastSlash + 1) : finderFiles[0]
    basename = f.replace(/\.[^.]+$/, '')
  } else {
    basename = instruction
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .substring(0, 40)
  }
  const runDir = join(PATHS.ACTS, `${basename}-${stamp}`)
  try {
    mkdirSync(runDir, { recursive: true })
    writeFileSync(PATHS.LATEST_ACT, runDir, 'utf-8')
  } catch {}

  const auditPath = join(PATHS.ACTS_AUDITS, `${stamp}-${basename}.json`)
  const runJsonPath = join(runDir, 'run.json')
  const resultFile = join(runDir, 'result.txt')

  const writeAudit = (row: Record<string, unknown>): void => {
    try {
      // Attach per-step timing so the audit row alone shows the bottleneck (which
      // tool call ate the time) without opening the raw stream.
      const steps = summarizeSteps(runDir)
      const enriched = steps ? { ...row, steps_summary: steps } : row
      const enc = JSON.stringify(enriched, null, 2)
      writeFileSync(runJsonPath, enc, 'utf-8')
      writeFileSync(auditPath, enc, 'utf-8')
    } catch {}
  }

  // Act runs get one History row, result = the agent's summary.
  const appendActHistory = (
    ok: boolean,
    summary: string,
    duration: number,
    reason?: RunFailReason,
    detail?: string
  ): void => {
    // A CONTINUED act (resumed from history) re-writes this same run_id, and the
    // latest row wins the dedupe — so it must carry the conversation forward or the
    // earlier turns vanish from the row. Fresh acts have no prior turns, so this
    // stays undefined and the row looks exactly as it did before.
    const actTurns =
      opts.conversationHistory.length > 0
        ? [...opts.conversationHistory, { q: instruction, a: summary }]
        : undefined
    const entry: HistoryEntry = {
      schema_version: CONFIG.HISTORY_SCHEMA_VERSION,
      run_id: opts.historyRunId,
      ts: historyTimestamp(),
      duration_s: duration,
      duration_ms: Math.round(duration * 1000),
      instruction,
      mode: 'act',
      selection,
      selection_chars: selection.length,
      result: summary || undefined,
      result_chars: summary?.length ?? 0,
      turns: actTurns,
      turn_count: actTurns?.length,
      ok,
      reason: ok ? undefined : (reason ?? 'error'),
      result_detail: ok ? undefined : detail,
      backend,
      model: backendModel,
      ctx_attached: ctxData !== null,
      attachments: opts.attachments?.length ? summarizeAttachments(opts.attachments) : undefined,
      front_app: ctxData?.frontApp,
      window_title: ctxData?.windowTitle,
      browser_url: ctxData?.browserURL,
      // Record the act working dir so the history panel can reveal it. Incognito
      // skips the pointer (the folder is the user's to scrub), matching ask/rewrite.
      run_dir: PREFS.getIncognito() ? undefined : runDir,
      source: opts.source,
      pipeline_id: opts.pipelineId,
      // See the ask row: lets History's Continue reopen the real conversation. Only
      // an act that joined a session has one — a bare hotkey act stays session-less.
      session_id: boundMightySessionId
    }
    HISTORY.append(entry)
    // Bump the menu-bar badge for a finished run the user hasn't checked — UNLESS
    // it's landing inline in the open panel they're already looking at. Detached /
    // HUD-card results DO count. Deduped by session runId.
    if (!(run.routed === 'panel' && isPanelVisible())) UNREAD.mark(opts.historyRunId)
  }

  // Grant the agent the run dir plus each finder file's parent (deduped).
  const addDirs = [runDir]
  const seen = new Set<string>([runDir])
  for (const p of finderFiles) {
    const lastSlash = p.lastIndexOf('/')
    const parent = lastSlash !== -1 ? p.substring(0, lastSlash) : p
    if (parent !== '' && !seen.has(parent)) {
      seen.add(parent)
      addDirs.push(parent)
    }
  }

  // ONE normalized attachment list — finder images plus any user attachments. Each
  // adapter translates it per-backend; no pre-baked imageFiles here.
  const mediaAttachments: MediaAttachment[] = [
    ...finderFiles.filter(isImagePath).map((p) => ({ path: p, kind: 'image' as const })),
    ...(opts.attachments || [])
  ]

  // Audio → text pre-step, then pass only non-audio attachments to the backend.
  // The common case (no audio) calls runBackend SYNCHRONOUSLY — only an actual
  // audio attachment defers into the transcription microtask. Keeps the hot path
  // (and the timeout-wiring tests) free of a needless async hop.
  const backendAttachments = mediaAttachments.filter((a) => a.kind !== 'audio')
  // Act runs get a second, always-on onEvent listener (independent of the
  // debug-gated transcript sink) that flashes a highlight box at each real
  // mm-input click/type/drag target — see PREFS.getActHighlight().
  const transcriptSink = makeTranscriptSink(runId)
  // tool_use ids of in-flight mm-input Bash calls: tool_end carries only the id,
  // never the command, so the start edge is where it has to be remembered.
  const actInputCallIds = new Set<string>()
  const onActEvent = (event: import('../../shared/types').RunEvent): void => {
    transcriptSink?.(event)
    // Before the highlight pref: attribution is a security property, not a
    // cosmetic one. Stamped on BOTH edges — a per-char `type` outlives the
    // window opened at tool_start, exactly like runInput's own long-type case.
    if (event.kind === RUN_EVENT.tool_start && isActInputCommand(event)) {
      actInputCallIds.add(event.id)
      noteAppGeneratedInput()
    } else if (event.kind === RUN_EVENT.tool_end && actInputCallIds.delete(event.id)) {
      noteAppGeneratedInput()
    }
    if (!PREFS.getActHighlight()) return
    const target = parseActHighlightTarget(event)
    if (target) flashHighlightBox(target.x, target.y)
  }
  const fire = (promptWithAudio: string): void => {
    runBackend({
      backend,
      runId,
      systemPrompt,
      userPrompt: promptWithAudio,
      runDir,
      addDirs,
      attachments: backendAttachments.length > 0 ? backendAttachments : undefined,
      mode: 'act',
      timeoutMs: CONFIG.RUN_TIMEOUT_MS.act,
      stallMs: CONFIG.ACT_STALL_MS,
      onEvent: onActEvent,
      onPhase: (phase, detail) => {
      // Read the LIVE route: panel overlay while the panel owns it, else the HUD
      // card it was detached to (or raised on from a hotkey).
      if (run.routed === 'panel' && isPanelVisible()) {
        sendToPanelRenderer(CHANNELS.busyPhase, {
          phase,
          detail: detail ?? '',
          source: 'node',
          etaMs: run.etaMs
        })
      } else {
        updateHud(runId, detail ? `${phase}: ${detail}` : phase)
      }
      // A phone-triggered act-dictation replay has no panel/HUD to watch, so it
      // gets its own push -- gated client-side to whichever runId the phone has
      // opened the progress sheet for, same as chatChunk vs an open thread.
      if (isPhoneRun(runId)) sendToPhone({ type: 'actProgress', runId, phase, detail })
    },
    onDone: (result, exitCode, _stdOut, stdErr, duration) => {
      EVENTS.append({
        run_id: runId,
        event: 'act_completed',
        chars: result?.length ?? 0,
        duration_s: duration,
        exit_code: exitCode
      })
      // Listen-initiated runs also log a done event for the speech funnel — fire
      // it for BOTH success and failure (before any early-return) to match the
      // pre-refactor behavior.
      if (opts.source === 'listen') {
        EVENTS.append({
          run_id: runId,
          event: 'listen_action_done',
          action: 'act',
          chars: result?.length ?? 0,
          duration_s: duration,
          exit_code: exitCode
        })
      }

      // Cloud run-outcome for the act path — same contract as the ask/rewrite
      // onDone above (act has no conversation thread, so turns is always 0).
      const trackActCompleted = (ok: boolean, reason?: RunFailReason, reasonDetail?: string): void => {
        track(ANALYTICS_EVENT.run_completed, {
          mode: 'act',
          backend,
          model: backendModel,
          ok,
          duration_ms: Math.round(duration * 1000),
          chars_out: result?.length ?? 0,
          turns: 0,
          ctx: ctxData !== null,
          source: opts.source,
          pipeline_id: opts.pipelineId,
          ...(ok ? {} : { reason, exit_code: exitCode, ...(reasonDetail ? { reason_detail: reasonDetail } : {}) })
        })
        if (ok) markFirstRunSucceeded('act', backend)
      }

      if (exitCode !== 0) {
        const isTimeout = exitCode === EXIT_TIMEOUT
        // The user pressed Stop. Not a failure: no trackError, no "failed" copy,
        // and whatever the agent already did to the filesystem stands (we can't
        // and shouldn't undo it). Reported neutrally so a deliberate stop never
        // looks like a crash.
        const isStopped = exitCode === EXIT_STOPPED
        if (isTimeout) {
          trackError({
            kind: 'timeout',
            message: `act timed out after ${CONFIG.RUN_TIMEOUT_MS.act}ms`,
            source: 'runner',
            props: { mode: 'act', backend, run_id: runId }
          })
        }
        writeAudit({
          ts: new Date().toISOString(),
          run_id: runId,
          ok: false,
          instruction,
          files: finderFiles,
          run_dir: runDir,
          timing: { totalMs: Math.floor(duration * 1000) },
          exit_code: exitCode,
          error: isStopped ? 'stopped by user' : isTimeout ? 'timed out' : 'claude exit nonzero'
        })
        const classified = isStopped || isTimeout ? null : classifyRunFailure(backend, stdErr)
        const actReason: RunFailReason = isStopped
          ? 'stopped'
          : isTimeout
            ? 'timeout'
            : (classified?.reason ?? 'error')
        trackActCompleted(false, actReason, scrubbedStdErrTail(stdErr))
        appendActHistory(
          false,
          isStopped ? 'stopped' : isTimeout ? 'failed: timed out' : `failed: agent exit ${exitCode}`,
          duration,
          actReason,
          failDetail(stdErr)
        )
        reportActResult(
          false,
          isStopped
            ? 'Stopped. Anything it already did was kept.'
            : isTimeout
              ? 'Timed out. Try again, or check Settings > Test.'
              : (classified?.message ?? friendlyExitMessage(stdErr, `agent failed (exit ${exitCode})`)),
          // A stopped act may well have created files — offer the run folder so
          // the user can see what landed before the kill.
          isStopped ? runDir : null,
          isStopped, // runDir is a directory
          isStopped
        )
        return
      }

      if (result) {
        try {
          writeFileSync(resultFile, result, 'utf-8')
        } catch {}
      }

      const act = parseActResult(result || '')
      if (!act) {
        writeAudit({
          ts: new Date().toISOString(),
          run_id: runId,
          ok: false,
          instruction,
          files: finderFiles,
          run_dir: runDir,
          timing: { totalMs: Math.floor(duration * 1000) },
          exit_code: exitCode,
          error: 'no ACT_RESULT line',
          result_chars: result?.length ?? 0
        })
        trackActCompleted(false, 'error')
        appendActHistory(false, 'failed: no ACT_RESULT line', duration, 'error', failDetail(stdErr))
        // The agent ran but didn't report a clean result. Don't dead-end on a
        // cryptic line — say so plainly and let the user open the run folder to
        // see what it actually left behind.
        reportActResult(false, "Couldn't read the result. Open the run folder to check.", runDir, true)
        return
      }

      let revealPath = act.outputPath
      if (revealPath && revealPath !== '' && !existsSync(revealPath)) {
        revealPath = null
      }

      const baseSummary = act.summary || 'done'
      const isFailure = baseSummary.toLowerCase().includes('failed')
      // Fall back to the run dir so "click to reveal" always works. revealIsDir
      // tells the renderer to label the button "Open run folder" vs "Show in Finder",
      // and makes the no-output case obvious instead of a mystery file path.
      const reveal = revealPath ?? runDir
      const revealIsDir = !revealPath
      // Make the result legible: when the agent produced a file, name it in the
      // summary (the bare ACT_RESULT line is often too terse to tell what happened).
      const outName = revealPath ? revealPath.slice(revealPath.lastIndexOf('/') + 1) : ''
      const summary =
        outName && !baseSummary.includes(outName) ? `${baseSummary} → ${outName}` : baseSummary

      // Listen-initiated act keeps the Ask/Act buttons on a HUD card so the user
      // can chain another voice command on the same card (the ⚡ prefix marks it
      // an act result). Listen never routes to the panel, so it stays on its own
      // doneHud path; panel/hotkey act goes through reportActResult (inline in the
      // open panel, or a one-shot reveal card otherwise). This branch skips
      // reportActResult, so it must settle the bound conversation itself — this is
      // THE path a capture Act takes, and leaving it out would hang the very session
      // this binding exists to fill.
      if (opts.source === 'listen') {
        resolveLinkedMighty(summary, !isFailure)
        activeRuns.delete(runId)
        if (isFailure) {
          failHud(runId, summary)
        } else {
          doneHud(runId, true, `⚡ ${summary}`, reveal, undefined, { actions: ['ask', 'act'] })
        }
      } else {
        reportActResult(!isFailure, summary, reveal, revealIsDir)
      }

      // No detail: the agent reported this failure itself, so `summary` already
      // carries the reason in its own words — stderr would only add process noise.
      appendActHistory(!isFailure, summary, duration, isFailure ? 'error' : undefined)
      trackActCompleted(!isFailure, isFailure ? 'error' : undefined)

      EVENTS.append({
        run_id: runId,
        event: 'act_result',
        summary,
        output_path: revealPath || '',
        failed: isFailure
      })

      writeAudit({
        ts: new Date().toISOString(),
        run_id: runId,
        ok: !isFailure,
        instruction,
        files: finderFiles,
        run_dir: runDir,
        timing: { totalMs: Math.floor(duration * 1000) },
        exit_code: exitCode,
        summary,
        output_path: revealPath || '',
        result_chars: result?.length ?? 0,
        raw_chars: result?.length ?? 0
      })
    }
    })
  }
  const hasAudio = mediaAttachments.some((a) => a.kind === 'audio')
  if (!hasAudio) {
    fire(userPrompt)
  } else {
    void (async (): Promise<void> => {
      const audioText = await transcribeAttachments(mediaAttachments)
      fire(audioText ? `${userPrompt}${audioText}` : userPrompt)
    })()
  }
}

// ── Point + (optional) click ──────────────────────────────────────────────────

// Resolve a [POINT:…] tag in an ask answer to a logical screen point, fly the
// cursor glyph there, and — only when the click pref is ON — actually move +
// click the OS cursor. Returns the answer with the tag stripped (or the original
// when there's no tag / it can't be resolved). Never throws; any failure just
// leaves the visible answer intact and skips the gesture.
//
// Coordinate spaces: the screenshot is a full-screen capture of the MAIN display
// at native (Retina) resolution, so the model's [POINT:x,y] are IMAGE PIXELS in
// that display's space. We convert px → logical points (÷ scaleFactor) and add the
// display origin. find-on-screen already returns logical points, so a label tag
// needs no conversion.
async function resolvePointAndAct(answer: string, screenshotPath: string | null): Promise<string> {
  // An answer can carry a POINT (where to point/click) and/or a TYPE (what to
  // type after). Parse both; strip both from the visible text regardless of
  // whether we end up acting on them.
  const pointParsed = parsePointTag(answer)
  const typeParsed = parseTypeTag(pointParsed ? pointParsed.stripped : answer)
  if (!pointParsed && !typeParsed) return answer

  // Visible text = the answer with BOTH tags removed.
  const visible = typeParsed ? typeParsed.stripped : pointParsed ? pointParsed.stripped : answer

  let point: { x: number; y: number } | null = null

  if (pointParsed) {
    if (pointParsed.tag.kind === 'label' && screenshotPath) {
      // Pixel-accurate, free: resolve the label against on-screen OCR text.
      point = await findOnScreen(pointParsed.tag.label, screenshotPath)
    }
    // No label match (or coords given) → use the model's pixel coords off the
    // main display screenshot, converted to logical screen points.
    if (!point && pointParsed.tag.kind === 'coords') {
      const display = screen.getPrimaryDisplay()
      const scale = display.scaleFactor || 1
      point = {
        x: Math.round(display.bounds.x + pointParsed.tag.x / scale),
        y: Math.round(display.bounds.y + pointParsed.tag.y / scale)
      }
    }

    if (point) {
      // Clamp into the display so a hallucinated coord can't park it offscreen.
      const display = screen.getDisplayNearestPoint(point)
      const b = display.bounds
      point = {
        x: Math.min(Math.max(point.x, b.x), b.x + b.width - 1),
        y: Math.min(Math.max(point.y, b.y), b.y + b.height - 1)
      }
      flyCursorTo(point.x, point.y)
    }
  }

  // Acting (click + type) is opt-in AND gated on the live Accessibility
  // permission (clickAt/typeText return false rather than throwing if missing).
  // Sequence after the glyph lands: click the target, then type into it. The
  // type waits an extra beat after the click so focus settles in the field.
  if (PREFS.getClickEnabled()) {
    const pt = point
    setTimeout(() => {
      if (pt) void input.clickAt(pt.x, pt.y)
      if (typeParsed) {
        const t = typeParsed.tag
        setTimeout(() => {
          void input.typeText(t.kind === 'key' ? t.combo : t.text, t.kind === 'key' ? 'key' : 'text')
        }, CONFIG.POINT_CLICK_DELAY_MS)
      }
    }, CONFIG.POINT_CLICK_DELAY_MS)
  }

  return visible
}

// ── Ask + Rewrite ─────────────────────────────────────────────────────────────

function runAskOrRewriteTurn(opts: HudRunOptions): void {
  const { runId, mode, instruction, selection, selFile, ctxData, backend } = opts
  const isAsk = mode === 'ask'
  // `let`, because the paid backend routes server-side: we start with our best
  // local guess and the proxy's mm_result line corrects it mid-run (see
  // onModelResolved below). Read at onDone time, by which point it's the truth.
  let backendModel = resolveRunModel(backend)
  // Only the local adapter ever sets this — false is the honest value everywhere else.
  let thinking = false

  // Ask/rewrite routed to the open panel: progress/answer/error go through the
  // panel renderer instead of a HUD card. A panel rewrite owns the panel until it
  // blind-pastes; a SUGGESTION rewrite (target 'hud', no panel behind it) drives a
  // HUD card instead — so its progress shows and `detached` resolves the card on
  // done. Ask is panel-routed only when the panel was open at submit. Register as
  // an in-flight panel run so closing the panel mid-run detaches it to a live HUD
  // card (detachActiveRunsToHud flips run.routed → 'hud').
  const startsOnPanel = opts.target === 'panel' || (!isAsk && opts.target !== 'hud')
  const run: ActiveRun = {
    routed: startsOnPanel ? 'panel' : 'hud',
    hudTitle: isAsk ? 'Working on it' : 'Rewriting',
    hudSubtitle: instruction.length > 36 ? instruction.substring(0, 36) + '…' : instruction || '…',
    etaMs: estimateDuration(mode, backend)?.etaMs ?? 0,
    startedAt: Date.now()
  }
  activeRuns.set(runId, run)
  // Ask (never rewrite) binds to a Mighty session from the moment it starts, so the
  // panel can hand off into Mighty mid-answer without a separate seed step — the
  // conversation already lives in MIGHTY, the panel just points at it. The pending
  // turn lands via resolveLinkedMighty below on whichever terminal path fires.
  // A follow-up passes its already-bound sessionId (opts.sessionId) so this turn
  // APPENDS to the same session instead of splitting into a new one — only the
  // true first turn of a conversation mints inside startTurn.
  //
  // The QUESTION is written now, not on completion: a run in flight used to leave the
  // store holding a title with zero turns, so expanding mid-answer opened Mighty on an
  // empty "New conversation" beside a sidebar row showing the real title. startTurn
  // also stamps runId, which is how any window renders a thinking bubble for a run it
  // doesn't own. Broadcast so an already-open Mighty binds live rather than at expand.
  // See boundMightySessionId in runActTurn: run.mightySessionId is blanked on the
  // terminal path, which fires BEFORE the history row is written.
  let boundMightySessionId: string | undefined
  if (isAsk) {
    const pending: MightyTurn = {
      source: 'chat',
      q: opts.turnQ ?? instruction,
      a: '',
      ts: historyTimestamp(),
      ok: true,
      backend
    }
    run.mightySessionId = MIGHTY.startTurn(opts.sessionId, pending, runId)
    boundMightySessionId = run.mightySessionId
    broadcastMightyTurnAppended(run.mightySessionId)
  }
  // Live check used by every render path below: are we still inline in the panel?
  const onPanel = (): boolean => run.routed === 'panel' && isPanelVisible()

  EVENTS.append({ run_id: runId, event: 'backend_chosen', backend, model: backendModel })

  // Ensure a thread exists for ask, capturing the session title on the first turn.
  let thread = isAsk ? threads.get(runId) : undefined
  if (isAsk && !thread) {
    thread = {
      turns: opts.conversationHistory.slice(),
      sessionTitle: opts.sessionTitle || instruction,
      backend,
      historyRunId: opts.historyRunId
    }
    threads.set(runId, thread)
  }

  // Ambient activity access: on an ask, when the context-log toggle is on AND this
  // backend can tool-call (the CLI agents can; `local`/http-only can't), tell the
  // agent the local keystroke/history files exist and grant it read access below.
  // This is what lets "what did I type/work on today" get READ instead of refused,
  // for ANY phrasing — no keyword gate to maintain.
  const activityAccess =
    isAsk && BACKENDS[backend]?.capabilities?.toolCalls === true && PREFS.getContextLog()

  const { systemPrompt, userPrompt } = buildRewritePrompts({
    mode,
    selection,
    instruction,
    selFile,
    conversationHistory: isAsk && thread ? thread.turns : opts.conversationHistory,
    ctxData,
    actionExtra: opts.actionExtra,
    memoryBlob: opts.memoryBlob,
    retrievedBlob: opts.retrievedBlob,
    // Capture asks (screenshot/recording/listen) pass the capture folder + image
    // as context files so the agent reads them before answering.
    contextFiles: opts.finderFiles,
    activityAccess
  })

  // One folder per run, keyed on the history run id so multi-turn ask reuses the
  // same dir as its single history row. Skipped in incognito (nothing persists, so
  // the row carries no run_dir and the panel shows no "open folder" button). Falls
  // back to PATHS.TMP for the backend's prompt/out dump if folder creation failed.
  const runFolder = PREFS.getIncognito()
    ? null
    : createRunFolder({
        runId: opts.historyRunId,
        ts: historyTimestamp(),
        kind: mode,
        instruction: isAsk && thread ? thread.sessionTitle : instruction,
        backend,
        // Persist where the user was + what they selected, so the run folder is a
        // self-contained record (no reliance on the swept tmp/ selection file).
        selection,
        context: {
          front_app: ctxData?.frontApp || undefined,
          window_title: ctxData?.windowTitle || undefined,
          browser_url: ctxData?.browserURL || undefined,
          screenshot_path: ctxData?.screenshotPath || undefined,
          selection_chars: selection.length
        }
      })

  // Append (or rewrite) the HISTORY row. Ask is multi-turn: every turn rewrites
  // ONE row under historyRunId, with the whole conversation in `turns`.
  const appendHistoryRow = (
    ok: boolean,
    result: string,
    duration: number,
    // Why it failed, and the raw stderr behind that verdict. Both omitted when ok.
    // The cloud event has carried a reason for a while; the local row did not, so
    // "why did this fail on MY machine" was unanswerable offline.
    reason?: RunFailReason,
    detail?: string
  ): void => {
    const turns = isAsk && thread && thread.turns.length > 0 ? thread.turns.slice() : undefined
    const title = isAsk && thread ? thread.sessionTitle : instruction
    const entry: HistoryEntry = {
      schema_version: CONFIG.HISTORY_SCHEMA_VERSION,
      run_id: opts.historyRunId,
      ts: historyTimestamp(),
      duration_s: duration,
      duration_ms: Math.round(duration * 1000),
      instruction: title,
      mode,
      selection,
      selection_chars: selection.length,
      result: result || undefined,
      result_chars: result?.length ?? 0,
      turns,
      turn_count: turns?.length,
      ok,
      reason: ok ? undefined : (reason ?? 'error'),
      result_detail: ok ? undefined : detail,
      backend,
      model: backendModel,
      ctx_attached: ctxData !== null,
      attachments: opts.attachments?.length ? summarizeAttachments(opts.attachments) : undefined,
      front_app: ctxData?.frontApp,
      window_title: ctxData?.windowTitle,
      browser_url: ctxData?.browserURL,
      screenshot_path: ctxData?.screenshotPath || undefined,
      run_dir: runFolder ?? undefined,
      source: opts.source,
      // The conversation this run belongs to, so History's Continue can reopen the
      // real thread. Capture rows have always recorded this; ask/act rows did not,
      // which is why continuing a chat row opened a blank "New conversation".
      session_id: boundMightySessionId
    }
    HISTORY.append(entry)
    // Bump the menu-bar badge for a finished run the user hasn't checked — UNLESS
    // it's landing inline in the open panel they're already looking at (that's
    // "read" the moment it renders). Detached/HUD results DO count. Deduped by
    // session runId, so multi-turn ask follow-ups count once.
    if (!onPanel()) UNREAD.mark(opts.historyRunId)
  }

  // Every ask run is bound to a Mighty session from the start (see run.mightySessionId
  // above) — this fills the answer into the turn startTurn already wrote and clears the
  // session's runId, so whichever window (Panel and/or Mighty) is showing that session
  // swaps its thinking bubble for the reply. Fires on EVERY terminal path (success,
  // error, timeout, out-of-credits, abort) — the session must never hang mid-think.
  // PATCHES, never appends: an append here would leave the question on screen twice.
  // Clears the link after firing so it can't double-resolve. No-op for rewrite (never
  // bound to a session). Returns the session id (before it's cleared) so a caller that
  // still needs it — e.g. to hand the HUD card a "click to open conversation" target —
  // doesn't have to read run.mightySessionId after this has already blanked it.
  const resolveLinkedMighty = (a: string, ok: boolean): string | undefined => {
    const sessionId = run.mightySessionId
    if (!sessionId) return undefined
    run.mightySessionId = undefined
    MIGHTY.resolveTurn(sessionId, runId, { a, ok, ts: historyTimestamp(), backend })
    broadcastMightyTurnAppended(sessionId)
    return sessionId
  }

  // How a failure surfaces follows the LIVE route: inline in the open panel
  // (showError), or on the HUD card if the run was detached / started there.
  const reportError = (msg: string, stopped = false): void => {
    // Resolve the bound Mighty session BEFORE the delete drops run.mightySessionId, so
    // its conversation shows the failure instead of hanging on a pending bubble.
    resolveLinkedMighty(stopped ? msg : `Error: ${msg}`, false)
    activeRuns.delete(runId)
    if (onPanel()) {
      sendToPanelRenderer(CHANNELS.showError, { msg, runId })
    } else {
      failHud(runId, msg, stopped)
    }
  }

  // Grant read access to any capture context files (folder + screenshot) so the
  // agent can actually open them. A folder path is granted as-is; a file path
  // grants its parent dir.
  const addDirs = (opts.finderFiles || [])
    .map((p) => (/\.[^/.]+$/.test(p) ? p.substring(0, p.lastIndexOf('/')) : p))
    .filter((p) => p !== '')

  // Activity access: grant the agent read access to ~/MightyMouse so it can open
  // the context-log/ day files + rewrite-history.jsonl the system prompt points at.
  // One dir grant covers both (they live under the app root).
  if (activityAccess) addDirs.push(PATHS.ROOT)

  // Build ONE normalized attachment list. Each adapter translates it per-backend
  // (codex `-i`/inline, claude --add-dir, mightymouse data-URLs/document blocks) —
  // no per-backend pre-bake here anymore. Auto sources: capture screenshots
  // (finderFiles) + the "see my screen" context image (ctxData.screenshotPath), all
  // images. User sources: opts.attachments (images + files + audio).
  const autoImagePaths: string[] = [...(opts.finderFiles || [])]
  if (ctxData?.screenshotPath) autoImagePaths.push(ctxData.screenshotPath)
  const mediaAttachments: MediaAttachment[] = [
    ...autoImagePaths.filter(isImagePath).map((p) => ({ path: p, kind: 'image' as const })),
    ...(opts.attachments || [])
  ]

  // Audio can't reach a backend (no provider/CLI ingests it) — transcribe to text
  // first, fold into the prompt, then pass ONLY the non-audio attachments downstream.
  // No-audio runs (the common case) call runBackend synchronously; only an actual
  // audio attachment defers into the transcription microtask.
  const backendAttachments = mediaAttachments.filter((a) => a.kind !== 'audio')
  const fire = (promptWithAudio: string): void => {
    runBackend({
      backend,
      runId,
      systemPrompt,
      userPrompt: promptWithAudio,
      runDir: runFolder ?? PATHS.TMP,
      addDirs: addDirs.length > 0 ? addDirs : undefined,
      attachments: backendAttachments.length > 0 ? backendAttachments : undefined,
      mode,
      lean: mode === 'rewrite',
      timeoutMs: CONFIG.RUN_TIMEOUT_MS[mode],
      onEvent: makeTranscriptSink(runId),
      // The paid backend picks the model server-side; this is the only way we learn
      // which one ran. Fires before onDone, so the history row + run_completed event
      // below both record the real slug rather than our compile-time default.
      onModelResolved: (m) => {
        backendModel = m
      },
      onThinkingResolved: (t) => {
        thinking = t
        EVENTS.append({ run_id: runId, event: 'thinking_resolved', thinking: t })
      },
      onPhase: (phase, detail) => {
      // Live route: panel overlay while it owns the run, else the HUD card it was
      // detached to (or started on for a hotkey ask).
      if (onPanel()) {
        // sessionId lets the panel bind to the same Mighty session this ask is
        // already writing to, so expand mid-answer opens Mighty on it directly.
        sendToPanelRenderer(CHANNELS.busyPhase, {
          phase,
          detail,
          source: 'node',
          etaMs: run.etaMs,
          runId,
          sessionId: run.mightySessionId
        })
      } else {
        updateHud(runId, detail ? `${phase}: ${detail}` : phase)
      }
      // A phone-triggered act-dictation replay has no panel/HUD to watch, so it
      // gets its own push -- gated client-side to whichever runId the phone has
      // opened the progress sheet for, same as chatChunk vs an open thread.
      if (isPhoneRun(runId)) sendToPhone({ type: 'actProgress', runId, phase, detail })
    },
    onDone: async (result, exitCode, _stdOut, stdErr, duration, _promptFile, _outFile) => {
      EVENTS.append({
        run_id: opts.historyRunId,
        event: 'cli_completed',
        backend,
        chars: result?.length ?? 0,
        duration_s: duration,
        exit_code: exitCode
      })

      // run_completed = the cloud source of truth for success rate + latency.
      // Fire it from EVERY exit path below (success, failure/timeout, out-of-credits)
      // so count(ok)/count(*) is a clean ratio. duration is in seconds here; the
      // event carries ms so latency is queryable at finer resolution.
      const trackRunCompleted = (ok: boolean, reason?: RunFailReason, reasonDetail?: string): void => {
        track(ANALYTICS_EVENT.run_completed, {
          mode,
          backend,
          model: backendModel,
          ok,
          duration_ms: Math.round(duration * 1000),
          chars_out: result?.length ?? 0,
          turns: thread ? thread.turns.length : 0,
          ctx: ctxData !== null,
          source: opts.source,
          thinking,
          ...(ok ? {} : { reason, exit_code: exitCode, ...(reasonDetail ? { reason_detail: reasonDetail } : {}) })
        })
        if (ok) markFirstRunSucceeded(mode, backend)
      }
      if (opts.source === 'listen') {
        EVENTS.append({
          run_id: runId,
          event: 'listen_action_done',
          action: 'ask',
          chars: result?.length ?? 0,
          duration_s: duration,
          exit_code: exitCode
        })
      }

      // -2 = out-of-credits sentinel from the mightymouse HTTP adapter (HTTP 402).
      if (exitCode === -2) {
        EVENTS.append({ run_id: runId, event: 'out_of_credits', backend })
        track(ANALYTICS_EVENT.out_of_credits, { backend })
        trackRunCompleted(false, 'out_of_credits')
        appendHistoryRow(false, result || '', duration, 'out_of_credits')
        resolveLinkedMighty('Error: out of credits', false)
        activeRuns.delete(runId)
        if (onPanel()) {
          sendToPanelRenderer(CHANNELS.showError, { msg: 'out_of_credits', runId })
        } else {
          failHud(runId, 'out of credits')
        }
        // Zero the local balance display immediately (don't wait for the poll).
        sendToPanelRenderer(CHANNELS.billingBalanceChanged, 0)
        return
      }

      if (exitCode !== 0 || !result || result === '') {
        const isTimeout = exitCode === EXIT_TIMEOUT
        // User-initiated stop: neutral copy, and NOT logged as a backend error —
        // otherwise every deliberate stop pollutes the error dashboard.
        const isStopped = exitCode === EXIT_STOPPED
        const classified = isStopped || isTimeout ? null : classifyRunFailure(backend, stdErr)
        const errorMsg = isStopped
          ? 'Stopped.'
          : isTimeout
            ? 'Timed out. Try again, or check Settings > Test.'
            : (classified?.message ?? friendlyExitMessage(stdErr, `${backend} failed (exit ${exitCode})`))
        if (!isStopped) {
          track(ANALYTICS_EVENT.backend_error, { which: backend, mode, exit_code: exitCode })
        }
        if (isTimeout) {
          trackError({
            kind: 'timeout',
            message: `${mode} timed out after ${CONFIG.RUN_TIMEOUT_MS[mode]}ms`,
            source: 'runner',
            props: { mode, backend, run_id: runId }
          })
        }
        const askReason: RunFailReason = isStopped
          ? 'stopped'
          : isTimeout
            ? 'timeout'
            : (classified?.reason ?? 'error')
        trackRunCompleted(false, askReason, scrubbedStdErrTail(stdErr))
        EVENTS.append({
          run_id: runId,
          event: isStopped ? 'run_stopped' : 'error',
          where: 'cli_completed',
          message: errorMsg
        })
        appendHistoryRow(false, result || '', duration, askReason, failDetail(stdErr))
        reportError(errorMsg, isStopped)
        return
      }

      EVENTS.append({
        run_id: opts.historyRunId,
        event: 'result_extracted',
        chars: result.length,
        parsed_envelope: BACKENDS[backend].hasEnvelope
      })

      // Point-at / click: if the ask answer carries a [POINT:…] tag, fly the cursor
      // glyph to it (and click when the pref is on), then strip the tag so the
      // thread/history/visible answer never show the raw directive. Done BEFORE the
      // thread commit below so every downstream surface uses the clean text.
      if (isAsk) {
        result = await resolvePointAndAct(result, ctxData?.screenshotPath ?? null)
      }

      // Commit this ask turn to the thread BEFORE writing the row, so the row's
      // `turns` includes the answer we just got. Then mirror to the caller.
      if (isAsk && thread) {
        thread.turns.push({ q: instruction, a: result })
        opts.onAskTurn?.(instruction, result)
      }

      appendHistoryRow(true, result, duration)
      trackRunCompleted(true)
      // Fill in the handed-off Mighty session with the real answer (live-handoff).
      // Capture the id here — resolveLinkedMighty clears run.mightySessionId, but the
      // HUD card (below) still needs it so clicking the finished card can open Mighty
      // on this exact conversation.
      const resolvedSessionId = resolveLinkedMighty(result, true)

      // Whether the run was detached to a HUD card mid-flight (panel closed while
      // it ran). If so, a "working…" card is already up and must be resolved here.
      const detached = run.routed === 'hud'
      activeRuns.delete(runId)

      if (mode === 'rewrite') {
        // Blind-paste only if the SAME app is still frontmost as at trigger time.
        // If focus moved, pasting would dump text into the wrong place — skip it
        // and point the user at History (the result is already saved).
        const current = await captureContext()
        const focusIntact =
          opts.triggerApp !== '' &&
          current.frontApp === opts.triggerApp &&
          current.frontApp !== CONFIG.APP_NAME

        closePanelWindow()

        if (focusIntact) {
          // Resolve the detached working card (if any) — the result is going to the
          // cursor, so the card just confirms and auto-dismisses.
          if (detached) doneHud(runId, true, 'Pasted into your document')
          setTimeout(async () => {
            EVENTS.append({ run_id: runId, event: 'rewrite_pasted', chars: result.length })
            track(ANALYTICS_EVENT.rewrite_pasted, { chars: result.length })
            // A suggestion rewrite was triggered by a MOUSE CLICK on a cursor chip,
            // which blurs the text field even though the app stayed frontmost — a
            // bare Cmd+V would land nowhere. Re-activate the app first (same fix the
            // write-suggestion paste uses). A panel rewrite kept focus in the field,
            // so the plain paste is correct there.
            if (opts.source === 'suggestion') {
              await pasteTextToApp(result, opts.triggerApp)
            } else {
              await pasteText(result)
            }
          }, 180)
        } else {
          EVENTS.append({
            run_id: runId,
            event: 'rewrite_paste_skipped_focus_lost',
            trigger_app: opts.triggerApp,
            current_app: current.frontApp || ''
          })
          track(ANALYTICS_EVENT.rewrite_paste_skipped, { reason: 'focus_lost' })
          // Reuse the detached card if it's up; otherwise raise the "saved" card.
          if (!detached) startHud(runId, 'Rewrite ready', 'Focus changed - saved to History', 'act')
          doneHud(runId, true, 'Saved to History · open it from the menu bar')
        }
      } else if (onPanel()) {
        // Ask still inline in the open panel: render the answer in the panel chat
        // (its onShowAnswer handler appends Q+A and stays in ask mode for
        // follow-ups). No HUD card — Esc on the panel dismisses, same as always.
        // sessionId rides along: busyPhase is the panel's only other source for it, and
        // a run that never emitted a bound phase would leave expand opening a blank chat.
        sendToPanelRenderer(CHANNELS.showAnswer, {
          q: instruction,
          a: result,
          runId,
          sessionId: resolvedSessionId
        })
        EVENTS.append({
          run_id: runId,
          event: 'ask_answered',
          chars: result.length,
          turn_index: thread ? thread.turns.length : 0
        })
      } else {
        // Ask: drop the answer into its HUD card (body + Copy + follow-up input).
        // 'ask' is always offered (drives the follow-up input). Listen cards also
        // keep 'act' so a spoken question's answer can be acted on in place.
        const askActions: Array<'ask' | 'act'> =
          opts.source === 'listen' ? ['ask', 'act'] : ['ask']
        let askSummary = result.split('\n').find((l) => l.trim() !== '') || 'done'
        askSummary = askSummary.trim()
        if (askSummary.length > 64) askSummary = askSummary.substring(0, 64) + '…'
        doneHud(runId, true, askSummary, null, undefined, {
          body: result,
          actions: askActions,
          sessionId: resolvedSessionId
        })
        EVENTS.append({
          run_id: runId,
          event: 'ask_answered',
          chars: result.length,
          turn_index: thread ? thread.turns.length : 0
        })
      }
    }
    })
  }
  const hasAudio = mediaAttachments.some((a) => a.kind === 'audio')
  if (!hasAudio) {
    fire(userPrompt)
  } else {
    void (async (): Promise<void> => {
      const audioText = await transcribeAttachments(mediaAttachments)
      fire(audioText ? `${userPrompt}${audioText}` : userPrompt)
    })()
  }
}

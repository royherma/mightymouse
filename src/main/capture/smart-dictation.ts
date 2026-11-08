// Smart dictation (double-tap the listen hotkey): screen-aware dictation.
//
// Plain dictation transcribes speech and pastes it verbatim. Smart dictation
// takes the SAME transcript, attaches a screenshot of what's on screen, and asks
// the user's chosen backend to do the right thing — write a Gmail reply, refine
// slide copy, draft ad copy, or ANSWER a question about the screen. The model
// returns ONE {action,text} object; we paste on "paste" and show the body on
// "answer".
//
// Safety net mirrors recall-classifier.ts exactly: grab the first {...} block,
// coerce to a safe shape, and on ANY failure (no screenshot, bad JSON, timeout,
// empty text) FALL BACK to pasting the verbatim transcript — so smart dictation
// can never do WORSE than plain dictation, and never crashes.
import { captureContext, captureScreenshot, pasteText, pasteTextToApp } from '../platform'
import { runBackend, resolveRunModel } from '../backend/runner'
import type { BackendId } from '../backend/adapters'
import { runHudRun } from '../backend/hud-run'
import { buildSmartDictationPrompts } from '../backend/prompts'
import { doneHud, updateHud, failHud, runningHud, widenHud, isHudVisible, dismissHud } from '../hud-window'
import { estimateDuration } from '../estimator/duration-estimator'
import { buildMemoryBlob } from '../backend/context-memory'
import { PREFS } from '../store/prefs'
import { PATHS } from '../store/paths'
import { MIGHTY } from '../store/mighty'
import { getCaptureSessionId } from './capture-actions'
import { broadcastMightyTurnAppended } from '../mighty/broadcast'
import { HISTORY, historyTimestamp } from '../store/history'
import { UNREAD } from '../store/unread'
import { CONFIG } from '../../shared/config'
import { track, trackError } from '../analytics'
import { ANALYTICS_EVENT } from '../../shared/analytics-events'
import type { ContextData, HistoryEntry, HudConfirmKind } from '../../shared/types'

/** What the model is asked to return. Kept tiny on purpose (see the prompt). */
export type SmartAction = 'paste' | 'answer' | 'act'
interface SmartResult {
  action: SmartAction
  text: string
  /** Only meaningful when action === 'act'. True = ask the user to confirm
   *  before the act pipeline fires (delete/overwrite/send/pay/irreversible). */
  destructive: boolean
}

/** Coerce arbitrary parsed JSON into a safe SmartResult, or null if unusable.
 *  A missing/malformed "destructive" on an "act" defaults to true — the model
 *  skipping the field is itself ambiguous, and the whole point is safety. */
function coerce(raw: unknown): SmartResult | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const action: SmartAction = o.action === 'answer' ? 'answer' : o.action === 'act' ? 'act' : 'paste'
  const text = typeof o.text === 'string' ? o.text.trim() : ''
  if (text === '') return null
  const destructive = typeof o.destructive === 'boolean' ? o.destructive : true
  return { action, text, destructive }
}

/** Parse the backend's raw output into a SmartResult. Tolerates stray prose
 *  around the JSON (same {...}-grab as recall-classifier). Null on any failure. */
function parseSmartResult(result: string | null): SmartResult | null {
  if (!result || result.trim() === '') return null
  try {
    const match = result.match(/\{[\s\S]*\}/)
    if (!match) return null
    return coerce(JSON.parse(match[0]))
  } catch {
    return null
  }
}

/**
 * Settle the conversation logCapture opened for this voice note. That turn is the
 * ONLY record of a listen run in MIGHTY and is written with an empty answer, so
 * without this every reader of the session — the Mighty window, and a phone with
 * the thread open — showed the question and no reply, however the run actually
 * went. The HUD card and the history row were the only places the answer existed.
 */
function settleCaptureTurn(runId: string, text: string, ok: boolean, backend: BackendId): void {
  const sessionId = getCaptureSessionId(runId)
  if (!sessionId) return
  if (MIGHTY.answerLastTurn(sessionId, { a: text, ok, ts: historyTimestamp(), backend })) {
    broadcastMightyTurnAppended(sessionId)
  }
}

/** Short first-line title for the HUD card from a longer body. */
function summarize(text: string): string {
  const first = text.split('\n').find((l) => l.trim() !== '')?.trim() || 'done'
  return first.length > 64 ? first.slice(0, 64) + '…' : first
}

/** Everything fireActRun needs, stashed while a destructive act waits on the
 *  user's confirm card. Keyed by the classify runId (the card showing Confirm/
 *  Cancel), same id the act run's own card takes over once fired. */
interface PendingAct {
  transcript: string
  text: string
  wordCount: number
  backend: BackendId
  ctx: ContextData
  shot: string
  triggerApp: string
}
const pendingActs = new Map<string, PendingAct>()

/** Fire the actual act run + its history/analytics bookkeeping. Shared by the
 *  non-destructive (immediate) and destructive (post-confirm) paths. */
function fireActRun(runId: string, p: PendingAct): void {
  // Hand off to a genuinely separate act run, linked back to this classify run
  // via pipelineId — NOT the same history row (the two stay independently
  // visible/queryable, per the pipeline design).
  appendSmartResultHistory(runId, p.transcript, true, p.text, p.backend, false, p.ctx, runId)
  // Settle the capture turn with the PLAN before the act appends its own turn, so
  // the thread reads question -> plan -> outcome instead of leaving the question
  // unanswered above a result that answers it.
  settleCaptureTurn(runId, p.text, true, p.backend)
  track(ANALYTICS_EVENT.smart_dictation_completed, {
    action: 'act',
    words: p.wordCount,
    backend: p.backend,
    pipeline_id: runId
  })
  const actRunId = `r:${(Date.now() % 0xffff).toString(16).padStart(4, '0')}`
  const etaMs = estimateDuration('act', p.backend)?.etaMs ?? 0
  runningHud(runId, 'Working on it', summarize(p.text), etaMs)
  runHudRun({
    runId,
    historyRunId: actRunId,
    mode: 'act',
    instruction: p.text,
    selection: '',
    selFile: '',
    ctxData: p.ctx,
    // NOT finderFiles — that list renders as "SELECTED FILES (from Finder)", under a
    // system-prompt rule saying "operate on those files". Passing the ambient context
    // screenshot there told the agent the PNG was the subject, so "highlight the button"
    // became "annotate this image" (PIL + open in Preview) instead of ringing the real
    // screen. The shot already reaches the model via ctx.screenshotPath (set at capture,
    // attached in hud-run's autoImagePaths) — this was duplication with a side effect.
    finderFiles: [],
    conversationHistory: [],
    sessionTitle: '',
    actionExtra: null,
    memoryBlob: buildMemoryBlob({ mode: 'act' }),
    // Bind the act to the capture's conversation so its outcome lands there, the
    // same way an Ask/Act from a capture card does (hud-run's startTurn/resolveTurn).
    // Without it the act ran session-less and the voice note's thread ended on the
    // plan, never saying whether the act actually worked.
    sessionId: getCaptureSessionId(runId),
    turnQ: p.text,
    backend: p.backend,
    source: 'listen',
    triggerApp: p.triggerApp,
    pipelineId: runId
  })
}

/** Renderer answered a destructive-act confirm card (Confirm/Cancel). No-op if
 *  the runId isn't pending (already resolved, or the card was reloaded). */
export function resolvePendingAct(runId: string, answer: HudConfirmKind): void {
  const p = pendingActs.get(runId)
  if (!p) return
  pendingActs.delete(runId)
  if (answer === 'confirm') {
    fireActRun(runId, p)
  } else {
    // A cancelled act settles too: an unanswered turn reads as a run that vanished,
    // when what actually happened is a decision the user made and should see.
    settleCaptureTurn(runId, `Cancelled: ${p.text}`, false, p.backend)
    track(ANALYTICS_EVENT.smart_dictation_completed, {
      action: 'act_cancelled',
      words: p.wordCount,
      backend: p.backend,
      pipeline_id: runId
    })
    dismissHud(runId)
  }
}

/**
 * logCapture already wrote one history row for this run_id with `result` = the raw
 * transcript (written before the AI step even started). Once the AI result is known,
 * append a SECOND row with the SAME run_id carrying the real output — every reader
 * (panel, recall, search) dedups by run_id keeping the latest, so this transparently
 * supersedes the transcript-only row. Same pattern as ask-mode multi-turn (HistoryEntry
 * .turns doc) and act's appendActHistory in hud-run.ts.
 */
function appendSmartResultHistory(
  runId: string,
  transcript: string,
  ok: boolean,
  result: string,
  backend: BackendId,
  badge: boolean,
  ctx: ContextData,
  pipelineId?: string
): void {
  const entry: HistoryEntry = {
    schema_version: CONFIG.HISTORY_SCHEMA_VERSION,
    run_id: runId,
    ts: historyTimestamp(),
    duration_s: 0,
    instruction: transcript,
    mode: 'ask',
    selection: '',
    selection_chars: 0,
    result: result || undefined,
    result_chars: result?.length ?? 0,
    ok,
    backend,
    model: resolveRunModel(backend),
    ctx_attached: true,
    // Attribution for Analytics' Top Apps card. Omitting these made every Listen
    // run — the bulk of all runs — bucket as "(unknown)" there, even though the
    // context was captured up front for the paste/prompt. Same fields the ask/act
    // rows carry in hud-run.ts's appendHistoryRow.
    front_app: ctx.frontApp,
    window_title: ctx.windowTitle,
    browser_url: ctx.browserURL,
    source: 'capture',
    pipeline_id: pipelineId
  }
  HISTORY.append(entry)
  // 'paste' already landed the result visibly in the app the user was looking
  // at (pasteTextToApp re-activates triggerApp) — that's always "seen", never
  // badge. 'answer' shows in the HUD card itself — badge only if that card
  // isn't actually on screen (mirrors hud-run.ts's isPanelVisible() guard).
  if (badge) UNREAD.mark(runId)
}

/** Turn an internal fallback reason into a short, user-facing phrase for the HUD. */
function humanizeFallbackReason(reason: string): string {
  if (reason.includes('exit -2')) return 'out of credits'
  if (reason.includes('exit -3')) return 'timed out'
  if (reason.includes('exit -1')) return 'connection failed'
  if (reason.startsWith('backend exit')) return 'backend error'
  if (reason === 'unparseable model output') return 'bad response'
  if (reason.startsWith('backend threw')) return 'backend error'
  return reason
}

/**
 * Run screen-aware dictation for an already-transcribed utterance. Fire-and-forget
 * from the caller's perspective (it awaits internally but the caller need not).
 * Never throws — every failure path pastes the verbatim transcript.
 *
 * @param transcript the spoken instruction (already transcribed)
 * @param runId      the HUD card id started by the listen flow
 * @param wordCount  spoken word count, for analytics parity with listen_completed
 */
export async function runSmartDictation(
  transcript: string,
  runId: string,
  wordCount: number
): Promise<void> {
  const backend = PREFS.getBackend()

  // Nothing was said → nothing to do. Close the card quietly.
  if (transcript.trim() === '') {
    doneHud(runId, true, 'nothing heard')
    return
  }

  // Verbatim paste is the guaranteed floor: any failure below still lands the
  // transcript so the user's speech is never lost. But the HUD must be honest
  // about WHETHER the AI step actually ran — pasting silently under a green
  // "done" card hides real failures (out of credits, network down, backend
  // crash) as if smart dictation worked, when it just degraded to plain dictation.
  //
  // `expected` degrades (no screenshot access) still show success — there's
  // nothing actionable for the user to fix. `unexpected` failures (backend
  // errored) show a failed card with the reason, so out-of-credits/network/model
  // errors are visible instead of silently eating the user's instruction.
  const pasteVerbatim = (reason: string, severity: 'expected' | 'unexpected' = 'unexpected'): void => {
    pasteText(transcript).catch((err) => console.error('smart-dictation fallback paste failed:', err))
    if (severity === 'expected') {
      doneHud(runId, true, summarize(transcript), null, undefined, { actions: ['ask', 'act'] })
    } else {
      failHud(runId, `AI unavailable (${humanizeFallbackReason(reason)}) - pasted your words as-is`)
    }
    track(ANALYTICS_EVENT.smart_dictation_completed, { action: 'fallback', words: wordCount, backend })
    trackError({
      kind: 'smart_dictation_fallback',
      message: reason,
      source: 'smart-dictation',
      props: { backend }
    })
    // Fallback still pasted the transcript verbatim — that IS the real result, so
    // the history row already matches. No follow-up append needed here. The
    // conversation still gets settled: an unanswered turn reads as a run that
    // vanished, which is worse than one saying it pasted your words as-is.
    settleCaptureTurn(runId, transcript, true, backend)
  }

  // Capture screen context (front app for focus-safe paste + screenshot for the
  // model to read). captureContext resolves frontApp/window/URL; captureScreenshot
  // returns the PNG path or null. A null screenshot → no screen awareness → fall
  // back to verbatim (the whole point is the screen).
  //
  // recording:false flips the card out of the waveform branch (mic is done, we're
  // processing now) — without this the phase text below sets React state but has
  // no DOM slot to render into, since the waveform branch renders no subtitle.
  // widenHud grows it past the narrow RECORDING_W the card opened at — otherwise
  // the "✨ Smart Listen" title + phase text clip in the 200px recording width.
  updateHud(runId, 'Reading your screen…', true, false)
  widenHud(runId)
  let ctx: ContextData
  try {
    ctx = await captureContext()
  } catch {
    ctx = {}
  }
  const shot = await captureScreenshot().catch(() => null)
  if (!shot) {
    pasteVerbatim('screenshot capture returned null', 'expected')
    return
  }
  ctx.screenshotPath = shot
  const triggerApp = ctx.frontApp || ''

  const { systemPrompt, userPrompt } = buildSmartDictationPrompts({ transcript, ctxData: ctx })

  updateHud(runId, 'Thinking…', true, false)

  // Run through the user's chosen backend (S6: no forced model, BYO stays free).
  // json:true forces structured output on the http path; shell adapters obey the
  // prompt clamp. Wrap the fire-and-forget onDone in a Promise so we can await it.
  await new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      resolve()
    }
    void runBackend({
      backend,
      runId,
      systemPrompt,
      userPrompt,
      runDir: PATHS.TMP,
      // Grant the screenshot's dir so a CLI backend can Read the image off disk.
      addDirs: [shot.substring(0, shot.lastIndexOf('/'))],
      attachments: [{ path: shot, kind: 'image' }],
      mode: 'rewrite',
      json: true,
      timeoutMs: CONFIG.RUN_TIMEOUT_MS.rewrite,
      lean: true,
      onPhase: (phase, detail) => updateHud(runId, detail || phase, true),
      onDone: (result, exitCode) => {
        try {
          if (exitCode !== 0) {
            pasteVerbatim(`backend exit ${exitCode}`)
            return
          }
          const parsed = parseSmartResult(result)
          if (!parsed) {
            pasteVerbatim('unparseable model output')
            return
          }
          if (parsed.action === 'act') {
            const pending: PendingAct = { transcript, text: parsed.text, wordCount, backend, ctx, shot, triggerApp }
            if (parsed.destructive) {
              // Don't fire yet — show a Confirm/Cancel card and stash everything
              // fireActRun needs. resolvePendingAct (via hudConfirmAct IPC) either
              // fires it or drops it; nothing else can pick this runId back up.
              pendingActs.set(runId, pending)
              doneHud(runId, true, summarize(parsed.text), null, undefined, {
                body: `This will: ${parsed.text}`,
                confirmAct: true
              })
              track(ANALYTICS_EVENT.smart_dictation_completed, {
                action: 'act',
                words: wordCount,
                backend,
                pipeline_id: runId
              })
              appendSmartResultHistory(runId, transcript, true, parsed.text, backend, !isHudVisible(runId), ctx, runId)
            } else {
              // Hand off to a genuinely separate act run, linked back to this
              // classify run via pipelineId — NOT the same history row (the two
              // stay independently visible/queryable, per the pipeline design).
              appendSmartResultHistory(runId, transcript, true, parsed.text, backend, false, ctx, runId)
              track(ANALYTICS_EVENT.smart_dictation_completed, {
                action: 'act',
                words: wordCount,
                backend,
                pipeline_id: runId
              })
              fireActRun(runId, pending)
            }
          } else if (parsed.action === 'answer') {
            // Show the answer in the HUD body — do NOT paste it into the app.
            doneHud(runId, true, summarize(parsed.text), null, undefined, {
              body: parsed.text,
              actions: ['ask']
            })
            track(ANALYTICS_EVENT.smart_dictation_completed, {
              action: 'answer',
              words: wordCount,
              backend
            })
            appendSmartResultHistory(runId, transcript, true, parsed.text, backend, !isHudVisible(runId), ctx)
            settleCaptureTurn(runId, parsed.text, true, backend)
          } else {
            // Paste the adapted text into the app the user was in. pasteTextToApp
            // re-activates triggerApp first so focus is correct even though the HUD
            // is non-activating.
            pasteTextToApp(parsed.text, triggerApp).catch((err) =>
              console.error('smart-dictation paste failed:', err)
            )
            doneHud(runId, true, summarize(parsed.text), null, undefined, { actions: ['ask', 'act'] })
            track(ANALYTICS_EVENT.smart_dictation_completed, {
              action: 'paste',
              words: wordCount,
              backend
            })
            appendSmartResultHistory(runId, transcript, true, parsed.text, backend, false, ctx)
            settleCaptureTurn(runId, parsed.text, true, backend)
          }
        } finally {
          finish()
        }
      }
    }).catch((err) => {
      pasteVerbatim(`backend threw: ${String(err)}`)
      finish()
    })
  })
}

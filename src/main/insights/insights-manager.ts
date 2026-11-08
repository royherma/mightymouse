import { clipboard } from 'electron'
import { randomUUID } from 'crypto'
import { appendFileSync, existsSync, readFileSync, writeFileSync, watch, type FSWatcher } from 'fs'
import { join } from 'path'
import { CONFIG } from '../../shared/config'
import { IS_DEV, devLog } from '../../shared/env'
import type { HistoryEntry, Suggestion, SuggestState } from '../../shared/types'
import { HISTORY, historyTimestamp } from '../store/history'
import { classifyEdit } from './edit-distance'
import { buildMemoryBlob } from '../backend/context-memory'
import { runHudRun } from '../backend/hud-run'
import { captureContext, pasteTextToApp } from '../platform'
import { setCursorFocusable } from '../cursor-window'
import { startHud } from '../hud-window'
import { track } from '../analytics'
import type { AnalyticsEventName, AnalyticsEventProps } from '../../shared/analytics-events'
import { EVENTS } from '../store/events'
import { PATHS } from '../store/paths'
import { PREFS } from '../store/prefs'
import { collect, bucketFromSignals, signalFingerprint } from './signal-collector'
import type {
  InsightSignals,
  InsightBucket,
  SuggestSource,
  CollectStepTiming
} from './signal-collector'
import { OutcomeStore, outcomeTimestamp, type SuggestionDecision } from './outcome-store'
import { estimateDuration, estimateSuggestionDuration } from '../estimator/duration-estimator'
import { instructionStem, Ranker } from './ranker'
import { predict } from './predictor'
import { parseSuggestionJson, type ParseFailure } from './suggestion-json'
import type { AppMode } from '../../shared/types'

// The mode to LOG for a suggestion. A 'write'-kind suggestion (generate fresh
// text into an empty cursor, no selection) is its own interaction, so it logs as
// the 'write' mode regardless of the rewrite/ask mode the predictor tagged it
// with. 'run'-kind suggestions keep their real mode. One home so every outcome /
// event / history row agrees on what a write is.
function effectiveMode(suggestion: Suggestion): AppMode {
  return suggestion.kind === 'write' ? 'write' : suggestion.mode
}

// One-line human-readable cause for the dev log — turns a ParseFailure tag into a
// debuggable reason so an empty manual trigger explains itself instead of going dark.
function describeParseFailure(failure: ParseFailure): string {
  switch (failure.kind) {
    case 'no-array':
      return 'model output had no JSON array'
    case 'not-array':
      return 'parsed JSON was not an array'
    case 'parse-error':
      return `JSON parse failed: ${failure.error}`
    case 'empty-array':
      return 'model returned an empty array (nothing to suggest)'
    case 'all-dropped':
      return `all ${failure.total} item(s) filtered out: ${failure.reasons.join(', ')}`
    case 'declined':
      return `model declined: ${failure.reason}`
  }
}

// Per-run timing breakdown: the two top-level phases (context-gathering vs the LLM
// call) plus the sub-step split inside collect. Written to the failure log and
// dev-logged on every run so "why is a suggestion slow" is answerable per run.
interface RunTiming {
  collectMs: number
  predictMs: number
  stepMs: CollectStepTiming
}

// Defensive: timing is best-effort diagnostics, never load-bearing. A signals
// object without it (a test mock, a future collect variant) must not crash a run.
const NO_STEP_TIMING: CollectStepTiming = { capture: 0, recall: 0 }

function formatStepTiming(s: CollectStepTiming | undefined): string {
  const t = s ?? NO_STEP_TIMING
  return `capture=${t.capture}ms recall=${t.recall}ms`
}

type FailureOutcome = AnalyticsEventProps<'suggestion_failed'>['outcome']

// One trace row per predict — the "replay why we got THIS suggestion" record.
// Written on EVERY run (shown / empty / failed), unlike suggestion-failures.jsonl
// which only covers the empty paths. Holds the EXACT prompt sent, which deep blobs
// were populated (the idle-vs-manual context gap is visible here), per-step timing,
// and the resulting chips. Best-effort — a failed trace write never breaks a run.
function recordPredictTrace(args: {
  source: SuggestSource
  outcome: 'shown' | FailureOutcome
  signals: InsightSignals
  bucket: InsightBucket
  timing: RunTiming
  backend: string
  model: string
  prompts: { systemPrompt: string; userPrompt: string; hasRecall: boolean }
  suggestions?: Suggestion[]
  rawOutput?: string
  reason?: string
}): void {
  const { source, outcome, signals, bucket, timing, backend, model, prompts, suggestions, rawOutput, reason } = args
  if (PREFS.getIncognito()) return
  try {
    const row = {
      ts: new Date().toISOString(),
      source,
      outcome,
      reason: reason ?? '',
      backend,
      model,
      // Context the model actually saw — the front app, the empty-vs-not selection,
      // and whether the deep blobs were populated (idle leaves both false; that gap
      // is the single most common "why was it dumb here" cause).
      front_app: bucket.front_app,
      window_title: signals.ctxData.windowTitle || '',
      browser_url: signals.ctxData.browserURL || '',
      had_selection: signals.selection.trim() !== '',
      had_screenshot: !!signals.ctxData.screenshotPath,
      has_recall: prompts.hasRecall,
      collect_ms: timing.collectMs,
      predict_ms: timing.predictMs,
      step_ms: timing.stepMs,
      // The EXACT prompt pair — replay the run by re-sending these verbatim.
      system_prompt: prompts.systemPrompt,
      user_prompt: prompts.userPrompt,
      // What came out: the chips on a shown run, the raw model text on an empty one.
      suggestions: (suggestions ?? []).map((s) => ({
        label: s.label,
        instruction: s.instruction,
        mode: s.mode,
        kind: s.kind
      })),
      raw_output: (rawOutput ?? '').slice(0, CONFIG.SUGGESTIONS.MAX_INSTRUCTION_CHARS)
    }
    appendFileSync(PATHS.SUGGESTION_TRACE, JSON.stringify(row) + '\n', 'utf-8')
  } catch (err) {
    devLog.warn(`[insights] failed to write suggestion-trace row: ${String(err)}`)
  }
}

/**
 * Record a predict that surfaced nothing — to disk (full row, queryable) AND the
 * analytics pipeline (counts + grouping). This is the ONLY durable trace of a
 * "why didn't the suggestion help" event: devLog is dev-only and the cloud event
 * carries the bucket, not the on-screen context. Best-effort — a failed write of
 * the failure log must never itself crash the predict path.
 */
function recordPredictFailure(args: {
  source: SuggestSource
  outcome: FailureOutcome
  reason: string
  signals: InsightSignals
  bucket: InsightBucket
  timing: RunTiming
  backend: string
  model: string
  rawOutput?: string
}): void {
  const { source, outcome, reason, signals, bucket, timing, backend, model, rawOutput } = args
  if (PREFS.getIncognito()) return
  logSuggestionEvent('suggestion_failed', { front_app: bucket.front_app, source, outcome, reason })
  try {
    const row = {
      ts: new Date().toISOString(),
      source,
      outcome,
      reason,
      // Which provider + model produced this — the audit field. A slow Codex run
      // and a billed mightymouse-cloud run look identical without it.
      backend,
      model,
      // Full timing breakdown so a timeout/slow run shows WHERE the time went —
      // the LLM call (predict_ms) vs context gathering (collect_ms + its sub-steps).
      collect_ms: timing.collectMs,
      predict_ms: timing.predictMs,
      step_ms: timing.stepMs,
      front_app: bucket.front_app,
      window_title: signals.ctxData.windowTitle || '',
      browser_url: signals.ctxData.browserURL || '',
      had_selection: signals.selection.trim() !== '',
      // The raw model text when there WAS output to parse — the single most useful
      // field for diagnosing a bad/empty suggestion. Empty on the no-output paths
      // (timeout / backend error), capped so a runaway answer can't bloat the log.
      raw_output: (rawOutput ?? '').slice(0, CONFIG.SUGGESTIONS.MAX_INSTRUCTION_CHARS)
    }
    appendFileSync(PATHS.SUGGESTION_FAILURES, JSON.stringify(row) + '\n', 'utf-8')
  } catch (err) {
    devLog.warn(`[insights] failed to write suggestion-failures row: ${String(err)}`)
  }
}

type SuggestionSender = (state: SuggestState) => void
type CancelArmSender = () => void

interface CursorSample {
  x: number
  y: number
}

interface IdlePoint extends CursorSample {
  ts: number
}

interface ActiveBubble {
  suggestions: Suggestion[]
  signals: InsightSignals
  bucket: InsightBucket
  // Wall-clock ms predict() took to generate this batch. Stamped onto every
  // outcome row (accept + dismiss) so analytics can chart generation latency.
  genMs: number
  // Provider + model that generated this batch, stamped onto every outcome row so
  // accept-rate can be sliced per model — which model produces suggestions the user
  // keeps vs dismisses. Audit + quality signal in one.
  backend: string
  model: string
}

const HUD_TITLE_MAX = 36
const HIDDEN: SuggestState = { phase: 'hidden' }

let running = false
let sender: SuggestionSender | null = null
let cancelArmSender: CancelArmSender | null = null
let lastPoint: IdlePoint | null = null
let predicting = false
// Set when the user has soft-cancelled an in-flight prediction (Esc → Enter):
// the predict keeps running but its result is dropped instead of shown.
let cancelled = false
let lastFingerprint = ''
let activeBubble: ActiveBubble | null = null

export function setSuggestionSender(next: SuggestionSender | null): void {
  sender = next
}

export function setCancelArmSender(next: CancelArmSender | null): void {
  cancelArmSender = next
}

// Remember the last state we sent so a freshly-loaded overlay can be re-synced
// (the window/renderer come up async, AFTER the shortcut already broadcast its
// 'loading' — without a replay that first frame is lost and no bubble appears).
let lastBroadcast: SuggestState = HIDDEN

function broadcast(state: SuggestState): void {
  lastBroadcast = state
  sender?.(state)
}

/** Re-emit the current bubble state — called once the overlay renderer is ready. */
export function replayBubbleState(): void {
  if (lastBroadcast.phase !== 'hidden') sender?.(lastBroadcast)
}

// Suggestion events are the only ones this module emits. Constrain to that
// subset so props are typechecked against the taxonomy, while the local
// EVENTS.append mirror stays loose (on-device debug stream).
type SuggestionEvent = Extract<AnalyticsEventName, `suggestion_${string}`>

function logSuggestionEvent<K extends SuggestionEvent>(
  event: K,
  props: AnalyticsEventProps<K>
): void {
  EVENTS.append({ event, ...props })
  track(event, props)
}

// `decision` records WHY the bubble ended (rejected/superseded/ignored) — see
// SuggestionDecision. Defaults to 'rejected' (the explicit-dismiss common case).
function recordDismissed(active: ActiveBubble, decision: SuggestionDecision = 'rejected'): void {
  active.suggestions.forEach((suggestion, index) => {
    OutcomeStore.record({
      ts: outcomeTimestamp(),
      front_app: active.bucket.front_app,
      mode: effectiveMode(suggestion),
      instruction_stem: instructionStem(suggestion.instruction),
      shown_index: index,
      accepted: false,
      gen_ms: active.genMs,
      backend: active.backend,
      model: active.model,
      decision
    })
  })
  logSuggestionEvent('suggestion_dismissed', {
    front_app: active.bucket.front_app,
    count: active.suggestions.length
  })
}

function hideBubble(recordDismissal: boolean, decision: SuggestionDecision = 'rejected'): void {
  if (activeBubble && recordDismissal) recordDismissed(activeBubble, decision)
  activeBubble = null
  broadcast(HIDDEN)
}

async function predictForIdle(force = false, source: SuggestSource = 'idle'): Promise<void> {
  // `force` (dev/manual trigger) bypasses the active-bubble + fingerprint guards so
  // it always runs a fresh prediction, even on unchanged context. `source` decides
  // how deep the context search goes (manual → relevance search over all history).
  if (predicting) return
  if (!force && activeBubble) return
  predicting = true
  cancelled = false // fresh run; any prior cancel doesn't carry over
  // Manual trigger only: show the spinner ("preliminary step") in the bubble the
  // instant the shortcut fires, so the user gets feedback before the LLM answers.
  // Idle stays silent — no spinner flashing next to the cursor every few seconds.
  const showFeedback = source === 'manual'
  try {
    if (force) {
      // A forced re-predict replaces whatever's on screen — the old bubble was
      // never chosen, so record it as superseded (not an explicit reject).
      if (activeBubble) recordDismissed(activeBubble, 'superseded')
      activeBubble = null
      lastFingerprint = ''
    }
    if (showFeedback) broadcast({ phase: 'loading', etaMs: estimateSuggestionDuration()?.etaMs ?? 0 })
    const collectStart = Date.now()
    const signals = await collect(source)
    const collectMs = Date.now() - collectStart
    const fingerprint = signalFingerprint(signals)
    if (!force && fingerprint === lastFingerprint) return
    const bucket = bucketFromSignals(signals)
    const predictStart = Date.now()
    const result = await predict(signals, Ranker.topAcceptedStems(bucket))
    const predictMs = Date.now() - predictStart
    // genMs = the LLM call only (back-compat name used by OutcomeStore + the shown
    // event). collectMs is the context-gathering phase before it. Together they're
    // the breakdown of "where did the time go" for this run.
    const genMs = predictMs
    const timing: RunTiming = {
      collectMs,
      predictMs,
      stepMs: signals.collectStepMs ?? NO_STEP_TIMING
    }
    devLog.log(
      `[insights] timing (${source}, ${result.backend}/${result.model}): ` +
        `collect=${collectMs}ms predict=${predictMs}ms [${formatStepTiming(signals.collectStepMs)}]`
    )
    lastFingerprint = fingerprint

    // User cancelled while this was in flight (Esc → Enter): the bubble is already
    // hidden, so drop the result silently instead of popping chips after a cancel.
    if (cancelled) return

    // Failure / timeout: tell the user (manual only). Idle just goes quiet.
    if (!result.ok) {
      // Internal debug: WHY a manual trigger came back empty (no output / backend
      // threw / timed out) — never shown to the user, just for the dev console.
      devLog.warn(`[insights] predict failed (${source}): ${result.reason}${result.detail ? ` — ${result.detail}` : ''}`)
      recordPredictFailure({
        source,
        outcome: result.reason, // 'timeout' | 'error'
        reason: result.detail || result.reason,
        signals,
        bucket,
        timing,
        backend: result.backend,
        model: result.model
      })
      recordPredictTrace({
        source,
        outcome: result.reason,
        reason: result.detail || result.reason,
        signals,
        bucket,
        timing,
        backend: result.backend,
        model: result.model,
        prompts: result.prompts
      })
      if (showFeedback) broadcast({ phase: 'error' })
      else hideBubble(false)
      return
    }

    const suggestions = Ranker.rerank(result.suggestions, bucket)
    if (suggestions.length === 0) {
      // Ran fine but had nothing useful. Manual = say so; idle = stay quiet.
      // Log the cause: the model's parse failure if it produced nothing, otherwise
      // the rerank dropped everything the model DID return (filtered post-parse).
      const why = result.failure
        ? describeParseFailure(result.failure)
        : `rerank dropped all ${result.suggestions.length} parsed suggestion(s)`
      devLog.warn(`[insights] predict empty (${source}): ${why}`)
      recordPredictFailure({
        // A 'declined' failure is the model saying "nothing useful here"; anything
        // else (bad JSON, empty array, all items filtered, rerank-dropped) is a
        // run that produced output we couldn't turn into a suggestion.
        source,
        outcome: result.failure?.kind === 'declined' ? 'declined' : 'no-suggestions',
        reason: why,
        signals,
        bucket,
        timing,
        backend: result.backend,
        model: result.model,
        rawOutput: result.rawOutput
      })
      recordPredictTrace({
        source,
        outcome: result.failure?.kind === 'declined' ? 'declined' : 'no-suggestions',
        reason: why,
        signals,
        bucket,
        timing,
        backend: result.backend,
        model: result.model,
        prompts: result.prompts,
        rawOutput: result.rawOutput
      })
      if (showFeedback) broadcast({ phase: 'empty' })
      else hideBubble(false)
      return
    }

    activeBubble = { suggestions, signals, bucket, genMs, backend: result.backend, model: result.model }
    broadcast({ phase: 'ready', suggestions })
    recordPredictTrace({
      source,
      outcome: 'shown',
      signals,
      bucket,
      timing,
      backend: result.backend,
      model: result.model,
      prompts: result.prompts,
      suggestions,
      rawOutput: result.rawOutput
    })
    logSuggestionEvent('suggestion_shown', {
      front_app: bucket.front_app,
      count: suggestions.length,
      modes: suggestions.map((s) => s.mode),
      source
    })
  } finally {
    predicting = false
  }
}

function writeSelectionFile(selection: string): string {
  const epoch = Date.now()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const selFile = join(PATHS.TMP, `rewrite-${stamp}-${epoch}-sel.txt`)
  try {
    writeFileSync(selFile, selection, 'utf-8')
    return selFile
  } catch {
    return ''
  }
}

/**
 * Accept a 'write' suggestion: its body is already generated, so skip the LLM and
 * paste it straight at the cursor (+ clipboard). Mirrors rewrite's focus-intact
 * guard — if the user clicked away from the trigger app, pasting would land in the
 * wrong window, so we only paste when the same app is still frontmost.
 *
 * Why the settle delay: picking the chip (click OR ⌘-chord) momentarily routes the
 * interaction through our overlay, so the trigger app isn't ready to receive Cmd+V
 * the same tick. We hide the bubble (caller already broadcast HIDDEN), wait one
 * settle beat for focus to return, THEN read context + paste — otherwise the Cmd+V
 * lands nowhere and pasteText's clipboard-restore wipes the draft (the exact bug we
 * saw: log said "pasted" but nothing landed and the clipboard was untouched). This
 * is the same yield-then-paste the rewrite path uses (hud-run.ts).
 */
async function pasteSuggestionNow(
  suggestion: Suggestion,
  signals: InsightSignals,
  finalText?: string
): Promise<void> {
  const text = finalText ?? suggestion.text ?? ''
  if (text === '') return
  const triggerApp = signals.ctxData.frontApp || ''

  // Hard-release our overlay's keyboard focus FIRST. The write preview claimed it
  // (setFocusable(true) + window.focus()) so its textarea could receive keystrokes —
  // which BLURRED the trigger app's field (a web contenteditable in Chrome). Until we
  // give that OS keyboard focus back, re-activating Chrome can't restore the field's
  // caret, so Cmd+V lands nowhere (the bug: log said "pasted", nothing appeared).
  // Blur our window, THEN let the window server settle before activating the target.
  setCursorFocusable(false)
  await new Promise((resolve) => setTimeout(resolve, CONFIG.SUGGESTIONS.PASTE_SETTLE_MS))

  // We KNOW the intended target: the app frontmost when the bubble was shown
  // (triggerApp). pasteTextToApp re-activates it BY NAME before Cmd+V, so the paste
  // can't land in the wrong window even if a popover/overlay currently holds focus.
  // The old guard re-read the front app and bailed to clipboard-only whenever it
  // wasn't "intact" — but confirming a write in our own popover makes US frontmost,
  // so the guard ALWAYS failed and nothing ever pasted (the bug: previewed, hit
  // Confirm, the draft only reached the clipboard). Trust triggerApp + re-activate.
  if (triggerApp !== '' && triggerApp !== CONFIG.APP_NAME) {
    logSuggestionEvent('suggestion_write_pasted', { front_app: triggerApp, chars: text.length })
    await pasteTextToApp(text, triggerApp)
    return
  }

  // No usable target app name (rare) — drop the draft on the clipboard so the user
  // can ⌘V it where they meant, rather than blind-pasting into an unknown window.
  clipboard.writeText(text)
  logSuggestionEvent('suggestion_write_focus_lost', {
    trigger_app: triggerApp,
    current_app: ''
  })
}

async function startSuggestionRun(suggestion: Suggestion, signals: InsightSignals): Promise<void> {
  const runId = `s:${randomUUID()}`
  const selection = signals.selection || ''
  const selFile = suggestion.mode === 'act' ? '' : writeSelectionFile(selection)
  const title =
    suggestion.instruction.length > HUD_TITLE_MAX
      ? suggestion.instruction.slice(0, HUD_TITLE_MAX) + '...'
      : suggestion.instruction

  // Every suggestion run gets a visible "working…" HUD card up front — a click on
  // a cursor-bubble chip has NO panel behind it, so without a card the run is
  // invisible until it finishes (the old act/ask-only branch silently dropped
  // rewrite's progress onto a card that never existed). One card for all modes.
  // etaMs drives the card's progress bar from the (suggestion mode, backend) shape.
  const suggestEtaMs = estimateDuration(suggestion.mode, PREFS.getBackend())?.etaMs ?? 0
  startHud(
    runId,
    suggestion.mode === 'ask' ? 'Working on it' : title,
    'working...',
    undefined,
    undefined,
    suggestEtaMs
  )

  // Re-capture the frontmost app NOW, at click time — NOT the predict-time app on
  // signals.ctxData (captured seconds ago during idle, almost always stale by the
  // time the user clicks). This is the app a rewrite must paste back into. The
  // cursor overlay is click-through, so the user's document is still frontmost.
  const live = await captureContext()
  const triggerApp = live.frontApp || signals.ctxData.frontApp || ''

  runHudRun({
    runId,
    historyRunId: runId,
    mode: suggestion.mode,
    instruction: suggestion.instruction,
    selection,
    selFile,
    ctxData: signals.ctxData,
    finderFiles: [],
    conversationHistory: [],
    sessionTitle: '',
    actionExtra: null,
    memoryBlob: buildMemoryBlob({ mode: suggestion.mode }),
    backend: PREFS.getBackend(),
    source: 'suggestion',
    triggerApp,
    target: 'hud'
  })
}

// ── Dev triggers (testing) ───────────────────────────────────────────────────
// Let us fire the pipeline on demand instead of waiting out the idle timer, and
// inject a deterministic suggestion set so the bubble + Cmd+1/2/3 path can be
// tested with different inputs each run, no rebuild. All gated on IS_DEV.

let triggerWatcher: FSWatcher | null = null

/** Force a real prediction now, skipping the idle wait + dedupe. */
export function triggerInsightsNow(): void {
  if (!running) return
  void predictForIdle(true)
}

/**
 * Manual ⌘⌥⇧S trigger: force a fresh prediction that runs the deeper, relevance-
 * searched memory lookup for the current context. Same bubble UI as idle, richer
 * context behind it. Caller ensures the manager + overlay are started first.
 */
export function triggerSuggestNow(): void {
  if (!running) return
  void predictForIdle(true, 'manual')
}

/** Show an exact suggestion set now (skips the LLM) — deterministic UI test. */
export function showSuggestionsForDev(suggestions: Suggestion[]): void {
  if (!running || suggestions.length === 0) return
  // Synthesize a bubble around an empty signal context so Cmd+1/2/3 still runs.
  const signals: InsightSignals = {
    ctxData: { frontApp: null, windowTitle: null, browserURL: null, screenshotPath: null },
    selection: '',
    ambientContext: '',
    recentHistory: [],
    recallBlob: '',
    source: 'idle',
    collectStepMs: { capture: 0, recall: 0 }
  }
  activeBubble = {
    suggestions,
    signals,
    bucket: bucketFromSignals(signals),
    genMs: 0,
    backend: '',
    model: ''
  }
  broadcast({ phase: 'ready', suggestions })
}

// Touch ~/MightyMouse/insights-trigger.txt to fire: empty body → real predict,
// a Suggestion[] JSON body → that exact set. Debounced (fs.watch double-fires).
function watchTriggerFile(): void {
  if (!IS_DEV || triggerWatcher) return
  let last = 0
  try {
    if (!existsSync(PATHS.INSIGHTS_TRIGGER)) writeFileSync(PATHS.INSIGHTS_TRIGGER, '', 'utf-8')
    triggerWatcher = watch(PATHS.INSIGHTS_TRIGGER, () => {
      const now = Date.now()
      if (now - last < 150) return
      last = now
      let body = ''
      try {
        body = readFileSync(PATHS.INSIGHTS_TRIGGER, 'utf-8').trim()
      } catch {
        /* file briefly gone during write — treat as a plain trigger */
      }
      // Dev keywords (no JSON): "manual" runs the full ⌘⌥⇧S flow (spinner → real
      // predict), "loading"/"empty"/"error" just park that feedback phase so you
      // can eyeball the bubble UI in the live app without the shortcut or the LLM.
      if (body === 'manual') {
        devLog.log('[insights] dev trigger: manual flow (spinner → predict)')
        triggerSuggestNow()
        return
      }
      if (body === 'loading' || body === 'empty' || body === 'error') {
        devLog.log('[insights] dev trigger: park phase', body)
        broadcast({ phase: body })
        return
      }
      const injected = body ? parseSuggestionJson(body) : []
      if (injected.length > 0) {
        devLog.log('[insights] dev trigger: showing injected suggestions', injected.length)
        showSuggestionsForDev(injected)
      } else {
        devLog.log('[insights] dev trigger: forcing real prediction')
        triggerInsightsNow()
      }
    })
  } catch (err) {
    devLog.warn('[insights] failed to watch trigger file:', err)
  }
}

function stopWatchTriggerFile(): void {
  triggerWatcher?.close()
  triggerWatcher = null
}

export function startInsightsManager(): boolean {
  if (running) return false
  lastPoint = null
  predicting = false
  lastFingerprint = ''
  activeBubble = null
  running = true
  watchTriggerFile()
  return true
}

export function stopInsightsManager(): void {
  if (!running) return
  stopWatchTriggerFile()
  // A live bubble at teardown was shown but never decided — record it as ignored
  // so the funnel accounts for it (instead of silently dropping the shown row).
  hideBubble(activeBubble !== null, 'ignored')
  lastPoint = null
  predicting = false
  running = false
}

export function isInsightsManagerRunning(): boolean {
  return running
}

export function hasActiveBubble(): boolean {
  return activeBubble !== null
}

/** Is ANY bubble on screen — the loading spinner OR the ready chips? */
export function isBubbleVisible(): boolean {
  return activeBubble !== null || predicting
}

/**
 * Bare Esc on a live bubble: arm the HUD-style "⏎ to cancel" hint (overlay shows
 * it). Returns whether it consumed the key (a bubble was up). Enter then confirms
 * via dismissActiveBubble.
 */
export function armBubbleCancel(): boolean {
  if (!isBubbleVisible()) return false
  cancelArmSender?.()
  return true
}

/**
 * Dismiss the live bubble (Enter after Esc armed it, or the ✕). Records a ready
 * set as dismissed; for a loading bubble it soft-cancels — the predict finishes
 * but its result is dropped (no hard LLM abort; the wasted call is invisible).
 */
export function dismissActiveBubble(): boolean {
  if (!isBubbleVisible()) return false
  if (predicting) cancelled = true // drop the in-flight result when it lands
  hideBubble(activeBubble !== null)
  return true
}

export function handleCursorSample(point: CursorSample): void {
  if (!running) return
  const now = Date.now()
  if (!lastPoint) {
    lastPoint = { ...point, ts: now }
    return
  }

  // Movement resets the idle timer but no longer dismisses a live bubble — the
  // user dismisses explicitly with Esc, so the bubble stays put while they move
  // toward it (or the ⌘⌥⇧1/2/3 keys). Only show a NEW bubble after a fresh idle.
  const moved = Math.hypot(point.x - lastPoint.x, point.y - lastPoint.y)
  if (moved > CONFIG.SUGGESTIONS.MOVE_PX) {
    lastPoint = { ...point, ts: now }
    return
  }

  // Idle auto-fire is gated on the pref. The manager may still be alive purely to
  // serve the manual ⌘⌥⇧S shortcut (which lazy-starts it) — in that case idle
  // bubbles must stay off, so the shortcut works without turning idle on.
  if (!PREFS.getExperimentalSuggestions()) return

  if (now - lastPoint.ts >= CONFIG.SUGGESTIONS.IDLE_MS) {
    void predictForIdle()
  }
}

export function acceptActiveSuggestion(index: number, finalText?: string): boolean {
  const active = activeBubble
  if (!active) return false
  const suggestion = active.suggestions[index]
  if (!suggestion) return false

  OutcomeStore.record({
    ts: outcomeTimestamp(),
    front_app: active.bucket.front_app,
    mode: effectiveMode(suggestion),
    instruction_stem: instructionStem(suggestion.instruction),
    shown_index: index,
    accepted: true,
    gen_ms: active.genMs,
    backend: active.backend,
    model: active.model,
    decision: 'accepted'
  })
  active.suggestions.forEach((other, otherIndex) => {
    if (otherIndex === index) return
    // Siblings the user didn't pick: actively passed over for another chip.
    OutcomeStore.record({
      ts: outcomeTimestamp(),
      front_app: active.bucket.front_app,
      mode: effectiveMode(other),
      instruction_stem: instructionStem(other.instruction),
      shown_index: otherIndex,
      accepted: false,
      gen_ms: active.genMs,
      backend: active.backend,
      model: active.model,
      decision: 'rejected'
    })
  })
  logSuggestionEvent('suggestion_accepted', {
    front_app: active.bucket.front_app,
    mode: effectiveMode(suggestion),
    shown_index: index,
    instruction_stem: instructionStem(suggestion.instruction)
  })

  activeBubble = null
  broadcast(HIDDEN)
  // 'write' = already-generated draft → instant paste, no LLM. Everything else
  // re-runs the backend as before. `finalText` (set when the user previewed +
  // edited the draft) only applies to a write — it's the body we paste AND log.
  if (suggestion.kind === 'write') {
    const draft = suggestion.text || ''
    const final = finalText ?? draft
    logSuggestionFeedback(active, suggestion, draft, final)
    void pasteSuggestionNow(suggestion, active.signals, final)
  } else {
    void startSuggestionRun(suggestion, active.signals)
  }
  return true
}

/**
 * Capture the (suggested → final) pair for an accepted 'write' suggestion as a
 * History row. This is the clean training signal: same context, the model's draft
 * (`suggested_text`), and the body the user actually shipped (`final_text`), with
 * `edit_type` summarizing how far they moved it. No LLM ran, so there's no model
 * string and the result IS the final text. Read later via HISTORY.* like any row.
 */
function logSuggestionFeedback(
  active: ActiveBubble,
  suggestion: Suggestion,
  suggested: string,
  final: string
): void {
  const entry: HistoryEntry = {
    schema_version: CONFIG.HISTORY_SCHEMA_VERSION,
    run_id: `sf:${randomUUID()}`,
    ts: historyTimestamp(),
    duration_s: 0,
    instruction: suggestion.instruction,
    mode: effectiveMode(suggestion),
    selection: active.signals.selection || '',
    selection_chars: (active.signals.selection || '').length,
    result: final || undefined,
    result_chars: final.length,
    ok: true,
    backend: PREFS.getBackend(),
    model: '',
    ctx_attached: false,
    front_app: active.bucket.front_app,
    source: 'suggestion',
    suggested_text: suggested,
    final_text: final,
    edit_type: classifyEdit(suggested, final)
  }
  HISTORY.append(entry)
}

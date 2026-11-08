import { randomUUID } from 'crypto'
import { CONFIG } from '../../shared/config'
import type { Suggestion, MediaAttachment } from '../../shared/types'
import { buildSuggestionPrompts } from '../backend/prompts'
import { isImagePath } from '../backend/image-vision'
import { runBackend, EXIT_TIMEOUT } from '../backend/runner'
import { BACKENDS, type BackendId } from '../backend/adapters'
import { PREFS } from '../store/prefs'
import { PATHS } from '../store/paths'
import type { InsightSignals } from './signal-collector'
import { parseSuggestionResult, type ParseFailure } from './suggestion-json'

// Tagged so callers can tell "ran fine but nothing to say" (ok + empty list) apart
// from "the backend failed or never answered" (error/timeout) — the manual bubble
// shows a different message for each. The idle path only cares about ok.suggestions.
//
// `detail` (and `failure` on the ok path) is internal-only diagnostics: the manual
// trigger devLogs it so an empty/failed run explains WHY (declined / bad JSON / all
// items filtered / no output). Never shown to the user — debug signal only.
// `backend` + `model` ride on EVERY result (ok or not) so the audit log can
// attribute a slow/failed run to the exact provider + model that produced it —
// telling a Codex run apart from a billed mightymouse-cloud run after the fact.
// `prompts` rides on EVERY result so the trace log can record the EXACT system +
// user prompt that produced (or failed to produce) this batch — the single field
// that makes a run replayable. Both the prompt and the per-blob populated flags
// are derived once in predict() and handed back, not re-assembled by the caller.
export interface PredictPrompts {
  systemPrompt: string
  userPrompt: string
  hasRecall: boolean
}

export type PredictResult =
  | { ok: true; suggestions: Suggestion[]; failure?: ParseFailure; rawOutput?: string; backend: BackendId; model: string; prompts: PredictPrompts }
  | { ok: false; reason: 'timeout' | 'error'; detail?: string; backend: BackendId; model: string; prompts: PredictPrompts }

export async function predict(
  signals: InsightSignals,
  topAcceptedStems: string[] = []
): Promise<PredictResult> {
  const { systemPrompt, userPrompt } = buildSuggestionPrompts({
    ctxData: signals.ctxData,
    selection: signals.selection,
    ambientContext: signals.ambientContext,
    recentHistory: signals.recentHistory,
    recallBlob: signals.recallBlob,
    source: signals.source,
    topAcceptedStems
  })

  // The exact prompt + which deep-context blobs were populated, handed back on every
  // result so the trace log can replay "why this suggestion" without re-deriving it.
  const prompts: PredictPrompts = {
    systemPrompt,
    userPrompt,
    hasRecall: signals.recallBlob.trim() !== ''
  }

  // Hand the predictor the screen, same vision path ask/act use. One normalized
  // attachment list; the adapter translates it per-backend (http data-URLs, codex
  // -i, claude --add-dir). Optional — no screenshot just degrades to text-only.
  const screenshotPath = signals.ctxData.screenshotPath
  const screenAttachments: MediaAttachment[] =
    screenshotPath && isImagePath(screenshotPath)
      ? [{ path: screenshotPath, kind: 'image' }]
      : []

  // Resolve once up front so it's stamped on every result path (success, error,
  // timeout) and matches EXACTLY what runs below. Suggestions request the fast
  // model (fast: true), so the audit must record the fast model when the adapter
  // has one — falling back to the flagship when it doesn't, same as buildCommand.
  const backend: BackendId = PREFS.getBackend()
  const adapter = BACKENDS[backend]
  const model = adapter.fastModelName ?? adapter.modelName

  return new Promise((resolve) => {
    let settled = false
    const finish = (result: PredictResult): void => {
      if (settled) return
      settled = true
      resolve(result)
    }

    void runBackend({
      backend,
      runId: `suggest:${randomUUID()}`,
      systemPrompt,
      userPrompt,
      runDir: PATHS.TMP,
      attachments: screenAttachments.length > 0 ? screenAttachments : undefined,
      timeoutMs: CONFIG.SUGGESTIONS.PREDICT_TIMEOUT_MS,
      mode: 'ask',
      // The output is parsed as a JSON array — ask the http (mightymouse) backend's
      // proxy to force response_format json_object so it can't wrap it in prose.
      // Belt-and-suspenders with the JSON_ONLY_RULE prompt clamp + the tolerant
      // parser, which also cover the claude/codex CLI backends (they skip the proxy).
      json: true,
      // A suggestion is a quick prediction, not a deep answer — route it to the
      // adapter's fast model (claude → Haiku) so the bubble feels instant. Adapters
      // without a fast tier (codex) ignore this and run their normal model.
      fast: true,
      lean: true,
      onPhase: () => {},
      // A result string (even one that parses to []) means the model ran; no string
      // at all means the run produced nothing. runBackend hands us the exit code +
      // stderr, so distinguish WHY it was empty instead of one flat 'no-output':
      // a wall-clock timeout, a CLI/HTTP error (stderr carries the reason), or a
      // genuinely empty answer (exit 0, no text). When it ran but parsed to zero
      // suggestions, the parse failure rides along on `failure` for the manual log.
      onDone: (result, exitCode, _stdOut, stdErr) => {
        if (!result) {
          if (exitCode === EXIT_TIMEOUT) {
            finish({ ok: false, reason: 'timeout', detail: 'backend killed at wall-clock limit', backend, model, prompts })
          } else if (exitCode !== 0) {
            const why = stdErr.trim().split('\n').pop()?.slice(0, 200) || 'no stderr'
            finish({ ok: false, reason: 'error', detail: `exit ${exitCode}: ${why}`, backend, model, prompts })
          } else {
            finish({ ok: false, reason: 'error', detail: 'backend returned empty output (exit 0)', backend, model, prompts })
          }
          return
        }
        const { suggestions, failure } = parseSuggestionResult(result)
        // Keep the raw model text on the ok-but-empty path so the failure log can
        // show exactly what the model said when nothing usable came out of it.
        finish({ ok: true, suggestions, failure, rawOutput: result, backend, model, prompts })
      }
    }).catch((err) => finish({ ok: false, reason: 'error', detail: String(err), backend, model, prompts }))

    // Outer safety net: if runBackend never calls onDone at all (it owns its own
    // timeout, so this should be rare), bail after the budget so predict() can't hang.
    setTimeout(
      () => finish({ ok: false, reason: 'timeout', detail: 'predict() outer timeout — onDone never fired', backend, model, prompts }),
      CONFIG.SUGGESTIONS.PREDICT_TIMEOUT_MS
    )
  })
}

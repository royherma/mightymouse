import { assembleAmbientContext, assembleContextRecall } from '../backend/context-memory'
import { HISTORY } from '../store/history'
import { captureContext, captureScreenshot, captureSelection } from '../platform'
import { CONFIG } from '../../shared/config'
import type { ContextData, HistoryItem } from '../../shared/types'

// How the suggestion run was triggered. 'idle' = the cursor-still timer (cheap,
// recency-only context). 'manual' = the ⌘⌥⇧S hotkey (deliberate, so it earns a
// relevance search over ALL history for the current contact/subject/topic).
export type SuggestSource = 'idle' | 'manual'

export interface InsightSignals {
  ctxData: ContextData
  selection: string
  ambientContext: string
  recentHistory: HistoryItem[]
  // Relevance-searched history for the current context. Populated ONLY on the
  // manual path; '' for idle (which stays cheap on the recency view alone).
  recallBlob: string
  source: SuggestSource
  // Wall-clock ms for each sub-step of collect(), so a slow run can be blamed on
  // the right thing (screen capture vs history search)
  // instead of one opaque "collect took N ms".
  collectStepMs: CollectStepTiming
}

export interface CollectStepTiming {
  capture: number // context + selection + screenshot (parallel — slowest of the 3)
  recall: number // history relevance search + ambient assembly (manual only)
}

export interface InsightBucket {
  front_app: string
}

export async function collect(source: SuggestSource = 'idle'): Promise<InsightSignals> {
  // Grab a screenshot alongside the text context so the predictor can SEE the screen
  // (the actual tweet box, the thread, which account is signed in) and draft smarter
  // suggestions — same vision path ask/act use. Best-effort: a null path just means
  // the model falls back to text-only, never a failed suggestion run.
  const captureStart = Date.now()
  const [ctxData, selection, screenshotPath] = await Promise.all([
    captureContext(),
    captureSelection().catch(() => ''),
    captureScreenshot().catch(() => null)
  ])
  if (screenshotPath) ctxData.screenshotPath = screenshotPath
  const captureMs = Date.now() - captureStart

  // History relevance search + ambient assembly are synchronous but scan the JSONL,
  // so time them too — they grow with history size and are the next thing to blame.
  const recallStart = Date.now()
  const ambientContext = assembleAmbientContext()
  const recentHistory = HISTORY.readRecent(CONFIG.SUGGESTIONS.RECENT_HISTORY)
  const recallBlob = source === 'manual' ? assembleContextRecall(ctxData, selection) : ''
  const recallMs = Date.now() - recallStart

  return {
    ctxData,
    selection,
    ambientContext,
    recentHistory,
    recallBlob,
    source,
    collectStepMs: { capture: captureMs, recall: recallMs }
  }
}

export function bucketFromSignals(signals: InsightSignals): InsightBucket {
  return {
    front_app: signals.ctxData.frontApp || ''
  }
}

export function signalFingerprint(signals: InsightSignals): string {
  return [
    signals.ctxData.frontApp || '',
    signals.ctxData.windowTitle || '',
    signals.ctxData.browserURL || '',
    signals.selection.trim().slice(0, CONFIG.SUGGESTIONS.MAX_INSTRUCTION_CHARS)
  ].join('\n')
}

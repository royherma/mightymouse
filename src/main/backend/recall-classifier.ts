/**
 * recall-classifier.ts — decide whether a query is the user asking about their OWN
 * past activity ("what did I ask yesterday?", "what was I working on Tuesday?") and,
 * if so, extract the date window + search phrase to retrieve.
 *
 * Two-stage by design, so we don't pay a model call on every keystroke:
 *   1. mightBeRecall()  — synchronous keyword gate. ~free, runs on every submit.
 *                         Filters out the ~98% of queries that are plainly not recall.
 *   2. classifyRecallIntent() — fires a single fast (Haiku) call through the metered
 *                         llm-proxy ONLY when the gate passes. Returns structured JSON.
 *
 * Architectural fork (intended): the model classifier needs the proxy (JWT + Haiku),
 * which only the paid `mightymouse` backend has. Free `claude`/`codex` users never
 * reach classifyRecallIntent — the caller falls back to parseDateRange() + the gate.
 * Any failure (network, non-JSON, timeout, signed out) degrades to intent:'other',
 * so a recall miss is just a normal ask, never a crash.
 *
 * RecallIntent starts as 'recall' | 'other'. To add more memory tools later
 * (search screenshots, summarize period), extend the union + the classifier prompt —
 * the dispatch in ipc.ts grows one branch each. No tool-call protocol needed yet.
 */

import { CONFIG } from '../../shared/config'

// 'recall'    = the user's OWN MightyMouse history (what did I ask/do here).
// 'timeline'  = a chronological recap of a PERIOD ("what did I do this week"):
//               merges MightyMouse history + ambient app/site activity into one
//               day-by-day story, rather than answering a single pointed question.
// 'connector' = the user's CONNECTED accounts (Gmail/Slack/Zoom) — their real
//               email/chat/meeting content, the personal knowledge base.
// 'other'     = a normal request, no memory lookup.
export type RecallIntent = 'recall' | 'timeline' | 'connector' | 'other'

export interface RecallClassification {
  intent: RecallIntent
  /** ISO date strings (YYYY-MM-DD) bounding the lookup, or null if not date-scoped. */
  dateWindow: { start: string; end: string } | null
  /** Distilled 3-8 word search phrase for content matching, or '' if purely date-based. */
  semanticQuery: string
  /** Model's self-rated confidence 0..1. */
  confidence: number
  /**
   * Synonym / related terms that should widen the retrieval set. Used by the media
   * recall path to expand the token set before scoring (query expansion). A query
   * about "screen recording of the demo" might expand to ["presentation","demo","record"].
   * Empty array when no expansion is relevant or when the call fails.
   */
  expandedTerms: string[]
}

// Cheap pre-filter. First-person + recall verbs + time words. Broad on purpose:
// a false positive costs one Haiku call; a false negative silently loses the feature.
const RECALL_SIGNALS = [
  'what did i',
  'what have i',
  'what was i',
  'did i work on',
  'did i ask',
  'have i done',
  'when did i',
  'how many times',
  'show me my',
  'show me what',
  'find my',
  'look up my',
  'remind me what',
  'my history',
  'yesterday',
  'last week',
  'last month',
  'last night',
  'earlier today',
  'this morning',
  'this week',
  'this month'
]

// "last 7 days" / "last seven days" / "past 3 days" — not a fixed phrase, needs a pattern.
const LAST_N_DAYS = /\b(?:last|past)\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen)\s+days?\b/

/** True if the query plausibly asks about the user's own past activity. */
export function mightBeRecall(instr: string): boolean {
  const lower = instr.toLowerCase()
  return RECALL_SIGNALS.some((sig) => lower.includes(sig)) || LAST_N_DAYS.test(lower)
}

// A timeline query wants a chronological RECAP of a period, not one fact. The tell
// is a "recap/summary/timeline/overview/what-did-I-do" phrasing paired with a period.
// Narrow on purpose: mightBeRecall already catches the broad recall net; this only
// needs to flag the subset that reads as "walk me through my week", so the free-backend
// path can route to the timeline assembler instead of the pointed-question one.
const TIMELINE_SIGNALS = [
  'timeline',
  'recap',
  'summarize my',
  'summary of my',
  'overview of my',
  'walk me through my',
  'what have i been up to',
  'what did i do',
  'what have i done',
  'what was i doing',
  'catch me up',
  'my day',
  'my week',
  'my month'
]

/** True if the query reads as "give me a chronological recap of a period". */
export function mightBeTimelineRecall(instr: string): boolean {
  const lower = instr.toLowerCase()
  return TIMELINE_SIGNALS.some((sig) => lower.includes(sig))
}

const CLASSIFY_SYSTEM =
  'You classify a user question. Respond with ONLY valid JSON, no prose, matching exactly: ' +
  '{"intent":"recall"|"timeline"|"connector"|"other","dateWindow":{"start":"YYYY-MM-DD","end":"YYYY-MM-DD"}|null,' +
  '"semanticQuery":"<3-8 word search phrase, or empty>","confidence":0.0-1.0,' +
  '"expandedTerms":["synonym1","synonym2"]}. ' +
  '"recall" = asking a POINTED question about their OWN past activity inside THIS app ' +
  '(e.g. "what did I ask yesterday", "what was I working on Tuesday"). ' +
  '"timeline" = asking for a CHRONOLOGICAL RECAP of a whole period, not one fact ' +
  '(e.g. "what did I do this week", "recap my day", "summarize my last 3 days", ' +
  '"walk me through what I worked on"). For "timeline" always fill dateWindow with the ' +
  'period (default to today if none is named) and leave semanticQuery empty. ' +
  '"connector" = asking about content in their CONNECTED accounts — their email, Slack, or meeting ' +
  'transcripts (e.g. "what did legal want changed in the contract", "summarize what the team decided ' +
  'about hiring", "what did Sarah email me about pricing", "what\'s the latest on the Acme deal"). ' +
  '"other" = anything else. For "connector", always fill semanticQuery with the topic to search for. ' +
  '"expandedTerms" = 2-5 synonyms or related terms that would help retrieve relevant documents for the ' +
  'semanticQuery (e.g. "screen recording" → ["recording","capture","demo","video"]). Use [] when none apply. ' +
  'Resolve relative dates against today. Use null for dateWindow when no date is implied.'

const FALLBACK: RecallClassification = {
  intent: 'other',
  dateWindow: null,
  semanticQuery: '',
  confidence: 0,
  expandedTerms: []
}

/** Pull the terminal mm_result text out of the proxy's NDJSON stream. */
export async function readProxyResult(resp: Response): Promise<string> {
  if (!resp.ok || !resp.body) return ''
  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let result = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? '' // keep the partial last line
    for (const line of lines) {
      const t = line.trim()
      if (t === '') continue
      try {
        const e = JSON.parse(t)
        if (e && e.type === 'mm_result' && typeof e.result === 'string') result = e.result
      } catch {
        // ignore non-JSON / phase lines
      }
    }
  }
  return result
}

/** Coerce arbitrary parsed JSON into a safe RecallClassification. */
function coerce(raw: unknown): RecallClassification {
  if (!raw || typeof raw !== 'object') return FALLBACK
  const o = raw as Record<string, unknown>
  const intent: RecallIntent =
    o.intent === 'recall'
      ? 'recall'
      : o.intent === 'timeline'
        ? 'timeline'
        : o.intent === 'connector'
          ? 'connector'
          : 'other'
  let dateWindow: RecallClassification['dateWindow'] = null
  if (o.dateWindow && typeof o.dateWindow === 'object') {
    const dw = o.dateWindow as Record<string, unknown>
    if (typeof dw.start === 'string' && typeof dw.end === 'string') {
      dateWindow = { start: dw.start, end: dw.end }
    }
  }
  // expandedTerms: safe-coerce to a string[] (filter non-strings in case the model
  // returns a mix). Empty array if absent — callers treat it as optional widening.
  let expandedTerms: string[] = []
  if (Array.isArray(o.expandedTerms)) {
    expandedTerms = (o.expandedTerms as unknown[]).filter((t): t is string => typeof t === 'string')
  }
  return {
    intent,
    dateWindow,
    semanticQuery: typeof o.semanticQuery === 'string' ? o.semanticQuery : '',
    confidence: typeof o.confidence === 'number' ? o.confidence : 0,
    expandedTerms
  }
}

/**
 * Classify a query via the fast model behind the proxy. Caller must ONLY invoke this
 * when mightBeRecall() is true AND the backend is the metered one. Never throws —
 * returns FALLBACK (intent:'other') on any failure.
 */
export async function classifyRecallIntent(
  instr: string,
  getJwt: () => Promise<string>
): Promise<RecallClassification> {
  let jwt: string
  try {
    jwt = await getJwt()
  } catch {
    return FALLBACK
  }
  if (jwt === '') return FALLBACK

  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), CONFIG.RUN_TIMEOUT_MS.recall_classify)
  try {
    const resp = await fetch(`${CONFIG.BILLING.EDGE_FUNCTION_URL}/llm-proxy`, {
      method: 'POST',
      signal: abort.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt}`
      },
      body: JSON.stringify({
        system: CLASSIFY_SYSTEM,
        userPrompt: instr,
        // Routes to the fast model server-side and meters under its own feature tag.
        feature: 'recall_classify',
        // Output is a single {intent,dateWindow,semanticQuery} object — force the
        // proxy's response_format json_object so it can't wrap it in prose. The
        // {...} regex grab below stays as the safety net.
        json: true
      })
    })
    const text = await readProxyResult(resp)
    if (text.trim() === '') return FALLBACK
    // Model may wrap JSON in stray text; grab the first {...} block.
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return FALLBACK
    return coerce(JSON.parse(match[0]))
  } catch {
    return FALLBACK
  } finally {
    clearTimeout(timer)
  }
}

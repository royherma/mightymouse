/**
 * activity-recall.ts — Rank + assemble the user's ambient ACTIVITY (apps/sites they
 * used) as a recall source for media-chat, alongside their explicit captures.
 *
 * Source: the on-device ambient context-log (~/MightyMouse/context-log/*.jsonl),
 * a rolling per-day record of `focus` events (app/window/url) + redacted `text`
 * events. It already exists and powers the always-on memory blob; here we read a
 * deliberate DATE WINDOW for an explicit recall query like "did I visit X yesterday".
 *
 * Why this module (vs reusing context-memory's 20-min blob):
 *   - That blob is a fixed last-20-minutes summary for ambient prompt context.
 *   - This is a query-driven, date-windowed, RANKED lookup — different shape.
 *
 * Pipeline:
 *   1. Collapse consecutive focus events into visit SEGMENTS (one per app+host run),
 *      so a 30-second stretch on one site is one row, not 15 noisy lines.
 *   2. Score each segment against the question tokens (+ expansion terms) with the
 *      shared scorer: url/host weight 3, title 2, app 1, typed-text 1.
 *   3. Drop zero-score segments (unless the query has no tokens → recency view),
 *      sort by score then recency, cap at topN.
 *   4. Pack into a budget-bounded, model-readable block.
 *
 * Privacy: the text events are ALREADY redacted at write time (redact.ts). We only
 * surface site/app/title + a short typed-text snippet — never raw verbatim keystrokes
 * beyond what the always-on summary already shows. The whole source is gated behind
 * PREFS.getContextLog() by the caller.
 */

import type { ContextLogEvent } from '../../shared/types'
import { tokenize, scoreText, packBlocks, type ScoredField } from './recall-core'
import { CONFIG } from '../../shared/config'

/** How long a typed-text snippet may be in the blob (privacy + budget). */
const SNIPPET_LEN = 60

/** Max typed-text snippets attached to one segment. */
const MAX_SNIPPETS = 2

/** A collapsed run of focus on a single app (and host, for browsers). */
export interface ActivitySegment {
  app: string
  host: string | null
  /** Distinct full URLs seen during the segment (deduped, junk-filtered). */
  urls: string[]
  /** Distinct window titles seen during the segment. */
  titles: string[]
  /** Short redacted typed-text snippets, if any text events landed here. */
  snippets: string[]
  startMs: number
  endMs: number
}

/**
 * chrome://, about:, data:, file:, extensions, empty — never useful as evidence.
 * Also drops localhost / loopback / *.local dev servers: when the user asks "which
 * site did I check", their own running dev ports (127.0.0.1:7878, localhost:5173) are
 * noise that would crowd out the real sites they visited.
 */
function isJunkURL(url: string): boolean {
  if (/^(about:|chrome:|chrome-extension:|data:|view-source:|file:)/.test(url) || url.trim() === '') return true
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[^/]+\.local)([:/]|$)/.test(url)
}

/** Hostname of a real (non-junk) http(s) URL, else null. Junk/localhost → null so those
 *  segments collapse by app only and surface no "site" evidence. */
function hostOf(url: string | null | undefined): string | null {
  if (!url || isJunkURL(url)) return null
  const m = url.match(/^https?:\/\/([^/]+)/)
  return m ? m[1].replace(/^www\./, '') : null
}

/**
 * Collapse a time-ordered event stream into visit segments. A new segment starts
 * whenever the (app, host) pair changes — so "Chrome on twitter.com" is one row even
 * across many focus pings, but switching to a different site or app breaks it.
 */
export function segmentEvents(events: ContextLogEvent[]): ActivitySegment[] {
  const segs: ActivitySegment[] = []
  let cur: ActivitySegment | null = null

  for (const ev of events) {
    const ts = new Date(ev.ts).getTime()
    if (isNaN(ts)) continue
    const app = ev.app || '(unknown app)'
    const host = hostOf(ev.url)

    // Text events attach to the current segment without breaking it (the user kept
    // typing in the same place). A focus event with a new (app, host) opens a segment.
    const isNewSegment = !cur || cur.app !== app || cur.host !== host

    if (ev.type === 'focus' && isNewSegment) {
      cur = { app, host, urls: [], titles: [], snippets: [], startMs: ts, endMs: ts }
      segs.push(cur)
    } else if (!cur) {
      // First event is a text event (no focus seen yet): open a bare segment for it.
      cur = { app, host, urls: [], titles: [], snippets: [], startMs: ts, endMs: ts }
      segs.push(cur)
    }

    cur.endMs = Math.max(cur.endMs, ts)
    if (ev.url && !isJunkURL(ev.url) && !cur.urls.includes(ev.url)) cur.urls.push(ev.url)
    if (ev.title && ev.title.trim()) {
      const t = ev.title.length > 80 ? ev.title.slice(0, 80) + '…' : ev.title
      if (!cur.titles.includes(t)) cur.titles.push(t)
    }
    if (ev.type === 'text' && ev.text && ev.text.trim().length >= 3 && cur.snippets.length < MAX_SNIPPETS) {
      cur.snippets.push(ev.text.slice(0, SNIPPET_LEN).trim())
    }
  }
  return segs
}

/** Score one segment against the query tokens. Host/URL is the strongest signal for
 *  "did I visit X"; title next; app weakest (every Chrome segment shares "Chrome"). */
function scoreSegment(seg: ActivitySegment, tokens: string[]): number {
  if (tokens.length === 0) return 0
  const fields: ScoredField[] = [
    { text: seg.host ?? '', weight: 3 },
    { text: seg.urls.join(' '), weight: 3 },
    { text: seg.titles.join(' '), weight: 2 },
    { text: seg.app, weight: 1 },
    { text: seg.snippets.join(' '), weight: 1 }
  ]
  return scoreText(tokens, fields)
}

/**
 * Rank activity segments for a question.
 *
 * @param events      Context-log events already filtered to the date window (oldest-first).
 * @param question    The user's query text.
 * @param extraTerms  Optional expansion terms (from classifyRecallIntent on mightymouse).
 * @param topN        Max segments to return.
 * @param dateScoped  True when the caller already narrowed `events` to a date window the
 *                    user named ("this morning", "yesterday"). Changes the zero-match
 *                    behaviour: a question like "which site did I check this morning"
 *                    has NO content token that matches a host, so relevance scoring drops
 *                    everything to zero. When the window itself IS the user's intent, that
 *                    empty result is wrong — they want to SEE the window's activity. So on
 *                    a date-scoped zero-match we fall back to the recency view of the
 *                    window instead of returning nothing. Undated queries keep strict
 *                    relevance (an empty result there honestly means "no match anywhere").
 */
export function rankActivityForQuery(
  events: ContextLogEvent[],
  question: string,
  extraTerms: string[] = [],
  topN = CONFIG.MEDIA_RECALL.ACTIVITY_TOP_N,
  dateScoped = false
): ActivitySegment[] {
  const segments = segmentEvents(events)
  if (segments.length === 0) return []

  const questionTokens = tokenize(question)
  const expansionTokens = extraTerms.flatMap((t) => tokenize(t)).filter((t) => !questionTokens.includes(t))
  const tokens = [...questionTokens, ...expansionTokens]

  // Recency view of the window: most-recent segments first. Used when there's nothing
  // to rank ON (no tokens) or when a date-scoped query matched nothing by relevance.
  // Prefer segments that carry a real host — a "which site did I check" question wants
  // actual sites, not app-only focus rows — but fall back to all segments if none have
  // a host (e.g. a pure-app day) so the window is never silently empty.
  const recencyView = (): ActivitySegment[] => {
    const withHost = segments.filter((s) => s.host)
    const pool = withHost.length > 0 ? withHost : segments
    return pool.slice(-topN).reverse()
  }

  if (tokens.length === 0) return recencyView()

  const matched = segments
    .map((seg) => ({ seg, score: scoreSegment(seg, tokens) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : b.seg.endMs - a.seg.endMs))
    .slice(0, topN)
    .map(({ seg }) => seg)

  // Date-scoped "what did I do then" question that matched no host/title → show the
  // window's actual activity instead of a misleading empty result.
  if (matched.length === 0 && dateScoped) return recencyView()
  return matched
}

/** Local `Mon D, h:mm`–`h:mm` range label for one segment. */
function whenLabel(seg: ActivitySegment): string {
  const fmt = (ms: number): string =>
    new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  const start = fmt(seg.startMs)
  // Only show an end time if the segment spans >1 minute.
  if (seg.endMs - seg.startMs < 60_000) return start
  const endTime = new Date(seg.endMs).toLocaleString(undefined, { hour: 'numeric', minute: '2-digit' })
  return `${start}–${endTime}`
}

/** One segment → a compact evidence block. */
function formatSegment(seg: ActivitySegment): string {
  const lines: string[] = [`### ${seg.app}${seg.host ? ` · ${seg.host}` : ''} · ${whenLabel(seg)}`]
  if (seg.titles.length > 0) lines.push(`Windows: ${seg.titles.slice(0, 2).join('; ')}`)
  if (seg.urls.length > 0) lines.push(`URLs: ${seg.urls.slice(0, 3).map((u) => u.slice(0, 100)).join(', ')}`)
  if (seg.snippets.length > 0) lines.push(`Typed: "${seg.snippets[0]}"${seg.snippets.length > 1 ? ' …' : ''}`)
  return lines.join('\n')
}

/**
 * Serialise ranked activity segments into a model-readable block. Greedily packed to
 * `budget`. Returns '' when there are no segments — the caller then omits the section
 * entirely (so an empty activity log never injects a misleading "nothing found" line
 * that the model might over-weight; the captures section owns the honest empty state).
 */
export function assembleActivityRecall(
  segments: ActivitySegment[],
  budget = CONFIG.MEDIA_RECALL.ACTIVITY_CHAR_BUDGET
): string {
  if (segments.length === 0) return ''
  const header = '## Your recent activity (apps & sites you used — from your on-device activity log)\n\n'
  const blocks = segments.map(formatSegment)
  return packBlocks(header, '', blocks, budget)
}

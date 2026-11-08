/**
 * Suggested actions for an idle card: the prompt that asks for them, and the
 * parsing that turns a model's reply back into chips.
 *
 * Pure, and separate from `swipe-triage.ts`, because the two fail differently.
 * Triage is always right -- the canned three exist whatever happens. This is
 * best-effort: a slow model, a refusal, or three lines of prose all have to end
 * as "no suggestions", never as a chip that types garbage into someone's agent.
 */

import type { AgentRelaySessionInfo } from './types'

/** Suggestions replace the canned three, so more than this is a wall of chips
 *  on a card meant to be decided in a second. */
export const MAX_SUGGESTIONS = 3

/** A chip has to fit on one line next to two others. Longer replies are the
 *  model writing a sentence, which is the wrong shape, so they are dropped
 *  rather than truncated into something the user did not choose. */
export const MAX_SUGGESTION_CHARS = 64
export const SUGGESTION_TARGET_CHARS = 40

/** Cache key: the same session with the same TLDR gets the same suggestions, so
 *  skip-cycling a deck does not re-spawn a CLI per card. Changing the TLDR is
 *  the agent saying it is doing something else, which is exactly when the old
 *  suggestions stop applying. */
export function suggestKey(session: Pick<AgentRelaySessionInfo, 'sessionId' | 'label' | 'tldr'>): string {
  return `${session.sessionId ?? session.label} ${session.tldr ?? ''}`
}

/** The phone's key for the same answer. It cannot use `suggestKey` -- the wire
 *  carries no `sessionId`, by design, since the label is already the join every
 *  other relay message uses. Same shape so the two cannot drift apart. */
export function suggestWireKey(label: string, tldr: string): string {
  return `${label} ${tldr}`
}

/** The wire key for a card, derived the ONE way -- components call this, never
 *  `suggestWireKey`. Reader and requester each built the context themselves,
 *  one forgot the subject fallback, and every card read a key nobody wrote. */
export function cardSuggestKey(card: {
  label: string
  session: Pick<AgentRelaySessionInfo, 'tldr'>
  subject?: string
}): string | undefined {
  const context = suggestContext(card.session, card.subject)
  return context ? suggestWireKey(card.label, context) : undefined
}

/** Everything the Mac can observe about one session, for the prompt. Every field
 *  optional: a shim too old to send facts, a pane not under tmux and a session
 *  that only ever notified each drop a different one, and the prompt has to hold
 *  up on whatever is left. */
export interface SuggestContext {
  /** What it is doing -- declared TLDR, else the subject derived from its cards. */
  subject: string
  repo?: string
  branch?: string
  agent?: string
  model?: string
  /** How long it has been open ("4m"), as the row already words it. */
  age?: string
  /** What it told its user recently, oldest first. */
  recent?: readonly string[]
  /** The last lines on its screen. Trimmed by the caller -- a full pane is
   *  mostly input-box chrome, which crowds out the half that carries meaning. */
  paneTail?: string
}

/** MCP is agent→Mac only: we cannot ask the agent what it needs, so every field
 *  here is observed. Handed over as JSON rather than prose because the fields
 *  are heterogeneous and half are usually missing -- a sentence template has to
 *  invent connective tissue for whatever is absent, where a dropped key reads
 *  as "not known" on its own. */
export function suggestPrompt(context: SuggestContext): string {
  // Undefined keys are dropped by JSON.stringify, so absence needs no wording.
  const json = JSON.stringify(
    {
      doing: context.subject,
      repo: context.repo,
      branch: context.branch,
      agent: context.agent,
      model: context.model,
      running_for: context.age,
      recently_told_user: context.recent?.length ? context.recent : undefined,
      last_on_screen: context.paneTail?.trim() || undefined
    },
    null,
    2
  )

  return [
    'A coding agent is running. Here is all we know about it:',
    '',
    json,
    '',
    `Write up to ${MAX_SUGGESTIONS} replies its user could send next, each a DIFFERENT direction:`,
    '1. Yes - starts with "Yes," and tells the agent to do exactly what it last proposed itself ("Yes, deploy it").',
    '2. No - decline or hold that, and say what to do instead.',
    '3. Something else - a useful step the agent did not propose.',
    'Never three versions of the same step. If it proposed nothing, give three different next steps.',
    'Each is what the USER says. If the agent told the user to run a command, the yes hands it back ("Yes, push it").',
    'Only a step the agent cannot do itself (a tap on a device, a permission grant) gets "Done" as the yes.',
    'Rules:',
    '- Reply with a JSON array and nothing else. No prose, no code fence.',
    '- Each item is {"emoji": "<one emoji>", "text": "<the instruction>"}.',
    '- The emoji stands for the instruction at a glance. Exactly one, never two.',
    '- Any emoji you like. Pick whatever fits best, these are only examples:',
    '  🧪 run the tests · 🔍 look at something · 🚀 ship it · 🐛 a bug · ✅ approve',
    '  📝 write something · ↩️ undo · ⏸️ stop · 📖 explain · 🧹 clean up',
    `- Each "text" under ${SUGGESTION_TARGET_CHARS} characters, ideally 2 to 6 words.`,
    '- Write them as instructions to the agent, in plain words.',
    '- Only suggest something this context actually supports. Fewer is fine.',
    '- If you cannot tell what it is doing, reply with [].'
  ].join('\n')
}

/** One chip: what gets typed, plus a glyph to recognise it by. The emoji is
 *  decoration ONLY -- it never joins `text`, which is what lands in someone's
 *  terminal. Optional because a model that skips it still wrote a usable
 *  instruction, and a chip without a glyph beats no chip. */
export interface Suggestion {
  text: string
  emoji?: string
}

/** One emoji, and only one: a pictographic with optional skin tone/VS16, ZWJ
 *  sequences, or a two-letter flag. Approximates `/^\p{RGI_Emoji}$/v` without
 *  the `/v` flag (es2024+); too strict only drops the glyph, never the chip. */
const EMOJI_UNIT = '\\p{Extended_Pictographic}[\\u{1F3FB}-\\u{1F3FF}]?\\uFE0F?'
export const ONE_EMOJI_RE = new RegExp(
  `^(?:\\p{Regional_Indicator}{2}|(?:${EMOJI_UNIT})(?:\\u200D(?:${EMOJI_UNIT}))*)$`,
  'u'
)

function cleanEmoji(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return ONE_EMOJI_RE.test(trimmed) ? trimmed : undefined
}

/** The shared bar every chip clears, whichever parser produced it. */
function cleanText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (!text || text.length > MAX_SUGGESTION_CHARS) return undefined
  // A line that ends in a colon is a heading for the lines under it, not a
  // thing anyone would say to their agent.
  if (text.endsWith(':')) return undefined
  return text
}

/** JSON is what the prompt asks for; the line parser stays as fallback because a
 *  model that answered in bare lines wrote good instructions and only missed the
 *  format -- dropping those trades three usable chips for none over a glyph. */
export function parseSuggestions(text: string): Suggestion[] {
  return parseSuggestionsJson(text) ?? parseSuggestionsLines(text)
}

/** `null` -- no parsable array at all, so the caller falls back to lines. An
 *  empty array is a real answer ("nothing to suggest") and returns `[]`. */
function parseSuggestionsJson(raw: string): Suggestion[] | null {
  const parsed = extractJsonArray(raw)
  if (!parsed) return null

  const out: Suggestion[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const text = cleanText((item as { text?: unknown }).text)
    if (!text) continue
    if (out.some((s) => s.text === text)) continue
    const emoji = cleanEmoji((item as { emoji?: unknown }).emoji)
    out.push(emoji ? { text, emoji } : { text })
    if (out.length === MAX_SUGGESTIONS) break
  }
  return out
}

/** Pre-JSON shape: bare lines, no glyph. Kept verbatim in behaviour so a model
 *  that ignores the format degrades exactly the way it used to. */
function parseSuggestionsLines(raw: string): Suggestion[] {
  const out: Suggestion[] = []
  for (const line of raw.split('\n')) {
    // Numbering and bullets are the one deviation worth stripping: the model
    // was asked for bare lines and formatting is not a content mistake.
    const text = cleanText(line.trim().replace(/^(?:[-*•]|\d+[.)])\s*/, ''))
    if (!text) continue
    if (out.some((s) => s.text === text)) continue
    out.push({ text })
    if (out.length === MAX_SUGGESTIONS) break
  }
  return out
}

/**
 * The real JSON array out of output that may carry a reasoning preamble.
 * Scanning every `[`→balanced `]` rather than matching first-to-last: a
 * preamble quoting history ("...[ask] write a tweet...") puts a `[` before the
 * real array, and the greedy match crashed on exactly that in prod
 * (`insights/suggestion-json.ts`, same fix).
 */
function extractJsonArray(raw: string): unknown[] | null {
  // An empty [] is a real answer, but a later non-empty array beats it -- so it
  // is remembered and only returned once the scan finds nothing better.
  let emptyFallback: unknown[] | null = null
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '[') continue
    let depth = 0
    let inStr = false
    let esc = false
    for (let j = i; j < raw.length; j++) {
      const ch = raw[j]
      if (inStr) {
        if (esc) esc = false
        else if (ch === '\\') esc = true
        else if (ch === '"') inStr = false
        continue
      }
      if (ch === '"') inStr = true
      else if (ch === '[') depth++
      else if (ch === ']') {
        depth--
        if (depth > 0) continue
        try {
          const parsed: unknown = JSON.parse(raw.slice(i, j + 1))
          if (Array.isArray(parsed)) {
            if (parsed.length > 0) return parsed
            emptyFallback ??= parsed
          }
        } catch {
          /* not valid JSON -- keep scanning from the next '[' */
        }
        break
      }
    }
  }
  return emptyFallback
}

/** Whether this card is even worth spending a model call on. A declared TLDR is
 *  the best context but not the only one: 4 sessions in 1264 ever call `recap`,
 *  so gating on it alone left every real card on the canned three. `buildDeck`
 *  already drops sessions that have said nothing, so a subject derived from the
 *  cards a session DID send is real content, not a guess about an empty one. */
export function worthSuggesting(
  session: Pick<AgentRelaySessionInfo, 'tldr' | 'stale'>,
  hasPending: boolean,
  derivedSubject?: string
): boolean {
  if (session.stale || hasPending) return false
  return Boolean(session.tldr?.trim() || derivedSubject?.trim())
}

/** The context a suggestion runs on: the agent's own words when it declared
 *  them, else what its cards say it is doing. */
export function suggestContext(
  session: Pick<AgentRelaySessionInfo, 'tldr'>,
  derivedSubject?: string
): string {
  return session.tldr?.trim() || derivedSubject?.trim() || ''
}

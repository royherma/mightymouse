import { CONFIG } from '../../shared/config'
import type { AppMode, Suggestion } from '../../shared/types'

const VALID_MODES: AppMode[] = ['rewrite', 'ask', 'act']
const JSON_ARRAY_RE = /\[[\s\S]*\]/

/**
 * Pull the real JSON array out of model output that may have a reasoning preamble.
 * The old greedy /\[[\s\S]*\]/ matched from the FIRST '[' to the LAST ']' — and a
 * reasoning preamble quoting history ("...[ask] write a tweet...") put a '[' BEFORE
 * the real array, so the match was garbage that failed JSON.parse (the exact prod
 * crash). Instead, scan for every '['→ balanced ']' span and return the first that
 * parses to a non-empty array. Resilient to prose before/after the JSON, ```json
 * fences, and stray brackets in quoted history.
 */
function extractJsonArray(raw: string): unknown[] | null {
  // A non-empty array wins outright. An empty [] is remembered as a fallback so a
  // genuine "[]" (model ran fine, nothing to suggest) still reports as empty-array
  // rather than no-array — but we keep scanning in case a real array follows it.
  let emptyFallback: unknown[] | null = null
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '[') continue
    // Walk forward tracking string state + bracket depth to find this '['s match.
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
        if (depth === 0) {
          try {
            const parsed = JSON.parse(raw.slice(i, j + 1))
            if (Array.isArray(parsed)) {
              if (parsed.length > 0) return parsed
              if (!emptyFallback) emptyFallback = parsed
            }
          } catch {
            /* not valid JSON — keep scanning from the next '[' */
          }
          break // this '[' didn't yield a non-empty array; try the next one
        }
      }
    }
  }
  return emptyFallback
}

function isMode(value: unknown): value is AppMode {
  return typeof value === 'string' && VALID_MODES.includes(value as AppMode)
}

// A write suggestion's body can be longer than an instruction (a full tweet,
// reply, or short email) but is still cursor-pastable — cap it so a runaway draft
// can't bloat the bubble payload.
function cleanBody(value: unknown, max: number): string {
  // Unlike cleanText, preserve newlines (a drafted reply/email has line breaks).
  if (typeof value !== 'string') return ''
  return value.replace(/[ \t]+/g, ' ').trim().slice(0, max)
}

function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, max)
}

// Why a parse produced no usable suggestions — surfaced for internal debugging so
// a manual trigger that returns nothing can explain itself (no array in the output,
// the array was empty, the model explicitly declined, or every item failed a filter).
export type ParseFailure =
  | { kind: 'no-array' } // no JSON array found in the raw output at all
  | { kind: 'not-array' } // matched brackets but JSON.parse gave a non-array
  | { kind: 'parse-error'; error: string } // the array failed JSON.parse
  | { kind: 'empty-array' } // valid array, zero items
  | { kind: 'all-dropped'; total: number; reasons: string[] } // items present, all filtered out
  | { kind: 'declined'; reason: string } // model returned {"decline":"..."} instead of suggestions

export interface ParseResult {
  suggestions: Suggestion[]
  failure?: ParseFailure
}

const DECLINE_OBJECT_RE = /\{[^[\]]*?"decline"\s*:\s*"([^"]*)"[^[\]]*?\}/

// A per-item drop reason for the diagnostic path — kept terse so a stitched list
// reads cleanly in the dev log (e.g. "label-too-short, bad-mode, instruction-too-short").
function itemDropReason(record: Record<string, unknown>): string | null {
  const label = cleanText(record.label, CONFIG.SUGGESTIONS.MAX_LABEL_CHARS)
  if (label.length < CONFIG.SUGGESTIONS.MIN_LABEL_CHARS) return 'label-too-short'
  if (!isMode(record.mode)) return 'bad-mode'
  const isWrite = record.kind === 'write'
  if (isWrite) {
    const text = cleanBody(record.text, CONFIG.SUGGESTIONS.MAX_WRITE_CHARS)
    if (text.length < CONFIG.SUGGESTIONS.MIN_LABEL_CHARS) return 'write-body-too-short'
  } else {
    const instruction = cleanText(record.instruction, CONFIG.SUGGESTIONS.MAX_INSTRUCTION_CHARS)
    if (instruction.length < CONFIG.SUGGESTIONS.MIN_LABEL_CHARS) return 'instruction-too-short'
  }
  return null
}

/**
 * Parse with diagnostics. Returns the same suggestions parseSuggestionJson does, plus
 * a `failure` tag when the list is empty so callers can log WHY (declined / no JSON /
 * all items filtered). parseSuggestionJson is the thin wrapper for callers that only
 * want the list.
 */
export function parseSuggestionResult(raw: string): ParseResult {
  // The model can opt out with a {"decline":"reason"} object instead of suggestions.
  // It arrives two ways: bare ({"decline":...}) OR wrapped as the sole item of an
  // array ([{"decline":...}]) — models do both, and the prompt's "return ONLY an
  // array" instruction nudges toward the wrapped form. Match either, so a deliberate
  // decline reads as 'declined' and never falls through to be parsed as a malformed
  // suggestion (the bug: a wrapped decline was dropped as "label-too-short").
  const declineMatch = raw.match(DECLINE_OBJECT_RE)
  if (declineMatch) {
    return { suggestions: [], failure: { kind: 'declined', reason: declineMatch[1].trim() } }
  }

  // Tolerant extraction: skips a reasoning preamble, ```json fences, and stray
  // brackets in quoted history to find the first span that parses to a real array.
  const parsed = extractJsonArray(raw)
  if (!parsed) {
    // Nothing parseable at all — distinguish "had a bracket but it was junk" from
    // "no array shape present" so the failure log points at the right cause.
    return JSON_ARRAY_RE.test(raw)
      ? { suggestions: [], failure: { kind: 'parse-error', error: 'no bracket span parsed to a JSON array' } }
      : { suggestions: [], failure: { kind: 'no-array' } }
  }
  if (parsed.length === 0) return { suggestions: [], failure: { kind: 'empty-array' } }

  const out: Suggestion[] = []
  const dropped: string[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') {
      dropped.push('not-object')
      continue
    }
    const record = item as Record<string, unknown>
    const reason = itemDropReason(record)
    if (reason) {
      dropped.push(reason)
      continue
    }
    if (!isMode(record.mode)) continue // already covered by itemDropReason; re-narrows for TS
    const mode = record.mode
    const label = cleanText(record.label, CONFIG.SUGGESTIONS.MAX_LABEL_CHARS)
    const instruction = cleanText(record.instruction, CONFIG.SUGGESTIONS.MAX_INSTRUCTION_CHARS)
    const isWrite = record.kind === 'write'
    const text = isWrite ? cleanBody(record.text, CONFIG.SUGGESTIONS.MAX_WRITE_CHARS) : ''

    const advice = cleanText(record.advice, CONFIG.SUGGESTIONS.MAX_INSTRUCTION_CHARS)
    const base: Suggestion = isWrite
      ? { label, instruction, mode, kind: 'write', text }
      : { label, instruction, mode }
    out.push(advice ? { ...base, advice } : base)
    if (out.length >= CONFIG.SUGGESTIONS.MAX) break
  }

  if (out.length === 0) {
    return { suggestions: [], failure: { kind: 'all-dropped', total: parsed.length, reasons: dropped } }
  }
  return { suggestions: out }
}

export function parseSuggestionJson(raw: string): Suggestion[] {
  return parseSuggestionResult(raw).suggestions
}

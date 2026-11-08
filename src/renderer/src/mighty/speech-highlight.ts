import type { SpokenWord } from '../../../shared/types'

/**
 * Maps Kokoro's spoken-word timings back onto the reply text so the word being
 * heard can be highlighted.
 *
 * The two sides do NOT line up 1:1: Kokoro speaks a phonemized version of the
 * text, so markdown syntax, code fences and punctuation exist in the source but
 * never in the spoken list. Matching therefore walks both sequences forward and
 * skips source tokens the voice didn't say, rather than assuming index N of one
 * is index N of the other.
 */

/** One slice of the source text, with when it's spoken (if it ever is). */
export interface HighlightToken {
  text: string
  /** Seconds into the clip, or null for a token the voice never speaks. */
  start: number | null
  end: number | null
}

/** Split on whitespace but KEEP it, so re-joining reproduces the source exactly —
 *  the rendered highlight must not silently reflow the reply. */
export function tokenizeForHighlight(text: string): string[] {
  return text.split(/(\s+)/).filter((t) => t !== '')
}

/** Lowercased alphanumerics only. Kokoro reports "config" for a source token of
 *  "`config`." or "**config**", so the comparison has to ignore everything the
 *  phonemizer already dropped. */
function comparable(token: string): string {
  return token.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Align `words` (what was spoken, in order) against the source text.
 *
 * Both sequences advance together; a source token with no alphanumerics (pure
 * punctuation, whitespace) is never spoken and gets null timings. A spoken word
 * that doesn't match the next source token is skipped after a bounded lookahead
 * — that keeps one bad match from cascading into a whole reply of wrong
 * highlights, since a stuck cursor is worse than a missing highlight.
 */
export function alignWords(text: string, words: SpokenWord[]): HighlightToken[] {
  const tokens = tokenizeForHighlight(text)
  const out: HighlightToken[] = []
  let w = 0

  for (const token of tokens) {
    const key = comparable(token)
    if (key === '') {
      out.push({ text: token, start: null, end: null })
      continue
    }
    // Bounded lookahead: a source word may have been skipped by the voice (a URL,
    // a code identifier). Scanning a few ahead re-syncs; scanning the whole list
    // would let a late coincidental match jump the cursor backwards in time.
    let hit = -1
    for (let k = w; k < Math.min(w + LOOKAHEAD, words.length); k++) {
      if (comparable(words[k].w) === key) {
        hit = k
        break
      }
    }
    if (hit === -1) {
      out.push({ text: token, start: null, end: null })
      continue
    }
    out.push({ text: token, start: words[hit].s, end: words[hit].e })
    w = hit + 1
  }
  return out
}

/** How far ahead to hunt for a match before giving up on a source token. */
const LOOKAHEAD = 4

/**
 * Index of the token being spoken at `time` (seconds), or -1 for none.
 *
 * Holds the last spoken token through the gaps BETWEEN words, so the highlight
 * doesn't strobe off during every pause. Past the final word it returns -1 so the
 * highlight clears rather than freezing on the last word forever.
 */
export function tokenIndexAt(tokens: HighlightToken[], time: number): number {
  let current = -1
  for (let i = 0; i < tokens.length; i++) {
    const { start, end } = tokens[i]
    if (start === null || end === null) continue
    if (time >= start && time < end) return i
    // Already past this one: remember it, so a pause keeps the previous word lit.
    if (time >= end) current = i
  }
  return current
}

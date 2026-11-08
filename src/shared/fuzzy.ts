/**
 * Word-anchored fuzzy text matching for the conversation search.
 *
 * The bar: typing `gsit` must find `gist`, but must NOT find `go sit down`.
 * That rules out subsequence matching (fzf-style) — on message bodies a short
 * query would match nearly everything. So a candidate matches only if some
 * WORD in the haystack is within a small edit distance of the query, or the
 * query appears verbatim. Whole-word anchoring is what keeps the noise out.
 *
 * Distance is capped (see MAX_DISTANCE) and computed with an early exit, so
 * this stays cheap enough to run over every turn's text on each keystroke.
 */

/** Per-word edit-distance ceiling, before the proportional cap below. */
const MAX_DISTANCE = 2
/** Under this length a word gets one edit of slack, not two. */
const MIN_LEN_FOR_FULL_FUZZ = 6
/** Under this length only an exact match counts. Two 2-char words are nearly
 *  always 1 edit apart, which is pure noise; 3 is safe because the shared-
 *  initial rule and the proportional cap still have to agree. */
const MIN_LEN_FOR_ANY_FUZZ = 3
/** At least this share of the longer string must survive unedited. Without
 *  it, "is" matches "gist" (2 edits on a 4-char word) and every short filler
 *  word in a message body becomes a hit. */
const MIN_SIMILARITY = 0.6

/** Scores: an exact hit must always outrank a typo hit, whatever the field. */
export const MATCH_SCORE = {
  exactPrefix: 3,
  exactSubstring: 2,
  fuzzyWord: 1,
  none: 0
} as const

export interface FuzzyMatch {
  /** Higher is better. 0 means no match. */
  score: number
  /** Index into the haystack where the match starts, for snippet centring. */
  index: number
  /** Length of the matched span, for highlighting. */
  length: number
}

const NO_MATCH: FuzzyMatch = { score: MATCH_SCORE.none, index: -1, length: 0 }

/**
 * Damerau-Levenshtein distance (adjacent transpositions cost 1, not 2),
 * abandoned as soon as it provably exceeds `max`.
 *
 * Transposition support is load-bearing, not a nicety: swapping two letters is
 * the most common typo there is, and plain Levenshtein charges `gsit`→`gist`
 * two edits — the same as two unrelated substitutions. That forces a budget so
 * loose it starts matching real words ("is" → "gist"). Charging 1 lets the
 * budget stay tight while still catching the typo people actually make.
 *
 * Three rolling rows instead of a full matrix — this runs per word, per turn,
 * per keystroke, so allocation matters more than elegance here.
 */
function boundedDistance(a: string, b: string, max: number): number {
  // A length gap alone can exceed the budget; skip the DP entirely.
  if (Math.abs(a.length - b.length) > max) return max + 1
  if (a === b) return 0

  // prev2 is needed for the transposition term (it looks back two rows).
  let prev2 = new Array<number>(b.length + 1).fill(0)
  let prev = new Array<number>(b.length + 1)
  let curr = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    let rowMin = curr[0]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let best = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost // substitution
      )
      // Adjacent transposition: "ab" -> "ba" costs 1.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, prev2[j - 2] + 1)
      }
      curr[j] = best
      if (best < rowMin) rowMin = best
    }
    // Every future row is >= this row's minimum, so we can bail early.
    if (rowMin > max) return max + 1
    const spare = prev2
    prev2 = prev
    prev = curr
    curr = spare
  }
  return prev[b.length]
}

/**
 * Edit budget for comparing two strings. Driven by the SHORTER of the two: a
 * 2-char word must not earn a 2-edit budget just because the query is long.
 * The proportional cap then stops edits from rewriting most of a short word.
 */
function budgetFor(queryLen: number, wordLen: number): number {
  const shorter = Math.min(queryLen, wordLen)
  const longer = Math.max(queryLen, wordLen)
  if (shorter < MIN_LEN_FOR_ANY_FUZZ) return 0
  const base = shorter < MIN_LEN_FOR_FULL_FUZZ ? 1 : MAX_DISTANCE
  const proportional = Math.floor(longer * (1 - MIN_SIMILARITY))
  return Math.min(base, proportional)
}

/**
 * A typo rarely lands on a word's first letter, and requiring it to match is
 * what separates "gsit"→"gist" (keep) from "gsit"→"sit" (drop). Cheap enough
 * to run before the distance DP.
 */
function sharesInitial(a: string, b: string): boolean {
  return a.length > 0 && b.length > 0 && a[0] === b[0]
}

/**
 * Match `query` against `haystack`. Returns the best match found, or a zero
 * score when nothing matches. `query` is expected pre-trimmed and non-empty;
 * callers treat an empty query as "show everything" before reaching here.
 */
export function fuzzyMatch(haystack: string, query: string): FuzzyMatch {
  if (query === '' || haystack === '') return NO_MATCH
  const hay = haystack.toLowerCase()
  const q = query.toLowerCase()

  // Fast path: a verbatim hit is the common case and the strongest signal.
  const at = hay.indexOf(q)
  if (at !== -1) {
    const isPrefix = at === 0 || /\s/.test(hay[at - 1])
    return {
      score: isPrefix ? MATCH_SCORE.exactPrefix : MATCH_SCORE.exactSubstring,
      index: at,
      length: q.length
    }
  }

  // Typo path: compare the query against each whole word. A multi-word query
  // can't be word-anchored this way, so it only ever takes the fast path.
  if (/\s/.test(q)) return NO_MATCH

  const wordRe = /\S+/g
  let m: RegExpExecArray | null
  while ((m = wordRe.exec(hay)) !== null) {
    const word = m[0]
    // Punctuation would inflate the distance ("gist," vs "gist"), so strip it.
    const bare = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    if (bare === '') continue
    if (!sharesInitial(bare, q)) continue
    const budget = budgetFor(q.length, bare.length)
    if (budget === 0) continue
    if (boundedDistance(bare, q, budget) <= budget) {
      const offset = m.index + word.indexOf(bare)
      // First hit wins; they all score the same, so an earlier one reads better
      // in a snippet.
      return { score: MATCH_SCORE.fuzzyWord, index: offset, length: bare.length }
    }
  }
  return NO_MATCH
}

/** True when `query` matches `haystack` at all. Convenience over fuzzyMatch. */
export function fuzzyMatches(haystack: string, query: string): boolean {
  return fuzzyMatch(haystack, query).score > MATCH_SCORE.none
}

/** How much text to keep around a match when building a snippet. */
const SNIPPET_LEAD = 30
const SNIPPET_TOTAL = 90
const ELLIPSIS = '…'

export interface Snippet {
  text: string
  /** Match position within `text` (not the original), for highlighting. */
  index: number
  length: number
}

/**
 * Cut a one-line excerpt around a match, padded with context and ellipsed at
 * both ends. Collapses whitespace so a multi-line reply still renders as one
 * tidy row in the sidebar.
 */
export function buildSnippet(source: string, match: FuzzyMatch): Snippet {
  const flat = source.replace(/\s+/g, ' ').trim()
  if (match.index < 0) return { text: flat.slice(0, SNIPPET_TOTAL), index: -1, length: 0 }

  // Re-locate the match: collapsing whitespace shifts every index after it.
  const flatIndex = flat.toLowerCase().indexOf(source.slice(match.index, match.index + match.length).toLowerCase())
  const at = flatIndex === -1 ? 0 : flatIndex

  const start = Math.max(0, at - SNIPPET_LEAD)
  const end = Math.min(flat.length, start + SNIPPET_TOTAL)
  const head = start > 0 ? ELLIPSIS : ''
  const tail = end < flat.length ? ELLIPSIS : ''
  return {
    text: `${head}${flat.slice(start, end)}${tail}`,
    index: at - start + head.length,
    length: match.length
  }
}

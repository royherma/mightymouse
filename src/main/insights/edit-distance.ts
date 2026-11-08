// Classify how far a user moved the model's pre-drafted 'write' suggestion before
// accepting it. The (suggested → final) gap is the training signal we capture on
// HistoryEntry; this collapses it to one label + the raw ratio for cheap querying.
//
// Why Levenshtein and not a token diff: the draft and the final are short bodies
// (capped at CONFIG.SUGGESTIONS.MAX_WRITE_CHARS), so an O(n·m) edit distance is
// trivially fast and char-level distance is the honest measure of "how much did
// they change" without tokenizer assumptions.

import { CONFIG } from '../../shared/config'
import type { EditType } from '../../shared/types'

/** Levenshtein edit distance between two strings. O(a·b) time, O(b) space. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length

  // Single rolling row — we only ever need the previous row.
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  const curr = new Array<number>(b.length + 1)

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost // substitution
      )
    }
    prev = curr.slice()
  }
  return prev[b.length]
}

/**
 * Normalized distance: changed chars ÷ longer length. 0 = identical, 1 = fully
 * different. Stable regardless of which side is longer.
 */
export function editRatio(suggested: string, final: string): number {
  const longest = Math.max(suggested.length, final.length)
  if (longest === 0) return 0
  return levenshtein(suggested, final) / longest
}

/**
 * Bucket the edit into the EditType the History row records. `unchanged` is exact
 * equality (the draft shipped as-is); past CONFIG.SUGGESTIONS.REWRITE_RATIO it's a
 * `rewritten`, otherwise an `edited` tweak.
 */
export function classifyEdit(suggested: string, final: string): EditType {
  if (suggested === final) return 'unchanged'
  return editRatio(suggested, final) >= CONFIG.SUGGESTIONS.REWRITE_RATIO
    ? 'rewritten'
    : 'edited'
}

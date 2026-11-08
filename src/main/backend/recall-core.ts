/**
 * recall-core.ts — Shared primitives for all three recall assemblers.
 *
 * History recall, connector recall, and media recall used to each carry their own
 * private copy of stopwords, a tokeniser, and a greedy budget packer. That's three
 * places to maintain the same logic, three sources of quiet drift. This module is the
 * single home for all three so the behaviour is identical and testable in isolation.
 *
 * Exports are intentionally narrow (just the primitives, not the domain assemblers)
 * so callers stay decoupled from each other.
 */

// ── Stopwords ────────────────────────────────────────────────────────────────

/**
 * Union of the history-recall stopwords (context-memory.ts) and the media-recall
 * stopwords (media-recall.ts). Words so common they would narrow ANDed search to
 * nothing, or carry no discriminative signal in a weighted score. All lowercase.
 */
export const STOPWORDS = new Set([
  // History/connector recall stopwords (original set from context-memory.ts)
  're', 'fwd', 'the', 'and', 'for', 'with', 'from', 'your', 'you',
  'inbox', 'mail', 'gmail', 'message', 'draft', 'reply', 'email', 'untitled',
  // Media recall stopwords (original set from media-recall.ts)
  'a', 'an', 'in', 'on', 'at', 'to', 'of', 'is', 'it', 'that', 'this',
  'was', 'are', 'be', 'or', 'but', 'not', 'me', 'my', 'do', 'did', 'can',
  'see', 'all', 'any', 'has', 'had', 'its', 'by', 'up'
])

// ── Tokeniser ────────────────────────────────────────────────────────────────

export interface TokenizeOpts {
  /**
   * Minimum token length to keep (default 3).
   * 2 is fine for short acronyms but too noisy in general; 3 is the practical floor.
   */
  minLen?: number
  /**
   * Maximum number of unique tokens to return (default unlimited).
   * Callers that feed tokens into an AND search (searchText) should cap to avoid
   * over-narrowing; callers doing OR scoring can afford a wider set.
   */
  max?: number
}

/**
 * Lowercase, Unicode-aware tokenizer. Splits on non-letter/non-digit runs, removes
 * stopwords, deduplicates, and respects minLen / max caps. Deterministic for the same
 * input — safe for both search-needle extraction and scoring input.
 */
export function tokenize(text: string, opts: TokenizeOpts = {}): string[] {
  const minLen = opts.minLen ?? 3
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of text.split(/[^\p{L}\p{N}]+/u)) {
    const w = raw.toLowerCase()
    if (w.length < minLen || STOPWORDS.has(w) || seen.has(w)) continue
    seen.add(w)
    out.push(w)
    if (opts.max !== undefined && out.length >= opts.max) break
  }
  return out
}

// ── Budget packer ────────────────────────────────────────────────────────────

/**
 * Greedy character-budget packer shared by all recall assemblers. Packs `blocks`
 * one-by-one into a `header` until the `budget` is reached, then appends a
 * "…and N more not shown" overflow line. When `blocks` is empty the `emptyMsg`
 * is appended to the header instead.
 *
 * All three assemblers (history, connector, media) previously carried identical
 * versions of this loop — this is the single source.
 */
export function packBlocks(
  header: string,
  emptyMsg: string,
  blocks: string[],
  budget: number
): string {
  if (blocks.length === 0) return `${header}${emptyMsg}`

  const lines: string[] = []
  let used = header.length
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    if (used + block.length + 1 > budget) {
      lines.push(`…and ${blocks.length - i} more not shown.`)
      break
    }
    lines.push(block)
    used += block.length + 1
  }
  return header + lines.join('\n')
}

// ── Field-weighted scorer ─────────────────────────────────────────────────────

export interface ScoredField {
  /** The text to search in. May be undefined/empty — treated as no contribution. */
  text: string | undefined
  /**
   * Multiplier for each matching token (capped frequency still multiplied).
   * Higher = more influence on the final score. Typical: tags=3, title=2, body=1.
   */
  weight: number
}

/**
 * Score a document against a set of query tokens using field weights + frequency.
 *
 * For each token:
 *   - count occurrences across all fields (frequency, capped at CONFIG_FREQ_CAP per field)
 *   - add frequency × field.weight to the score
 *
 * Why frequency-capped (not raw count): raw frequency inflates long transcripts.
 * A cap of 3 means "mentioned several times" = same credit as "mentioned many times",
 * so a keyword-stuffed body doesn't outrank a tagged item where the word appears once.
 *
 * Returns 0 when no token matches any field.
 */
const FREQ_CAP = 3

export function scoreText(tokens: string[], fields: ScoredField[]): number {
  if (tokens.length === 0 || fields.length === 0) return 0
  let total = 0
  for (const token of tokens) {
    for (const field of fields) {
      if (!field.text) continue
      const hay = field.text.toLowerCase()
      // Count occurrences of the token in this field (whole-word-ish: just substring
      // count is fine — the alternative is a regex per token which is slower and the
      // difference is negligible on the short texts we have).
      let count = 0
      let pos = 0
      while (count < FREQ_CAP && (pos = hay.indexOf(token, pos)) !== -1) {
        count++
        pos += token.length
      }
      total += count * field.weight
    }
  }
  return total
}

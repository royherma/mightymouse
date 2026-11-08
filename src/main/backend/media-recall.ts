/**
 * media-recall.ts — Rank + assemble a media-library recall blob for LLM injection.
 *
 * Given a user question and the full media index, this module:
 *   1. Tokenises the question (+ any query-expansion terms from the caller).
 *   2. Scores each MediaItem against the tokens using field weights (tags=3,
 *      title/app=2, transcript/ocr=1) so a tagged item consistently outranks a
 *      transcript-only hit for the same keyword.
 *   3. Drops zero-scoring items, sorts by score (recency as tiebreak), caps at topN.
 *   4. Serialises the ranked slice into a budget-packed block the LLM can reason over.
 *
 * The scorer and packer are shared with history recall and connector recall via
 * recall-core.ts — no private duplicates here.
 */

import type { MediaItem } from '../../shared/types'
import { tokenize, scoreText, packBlocks, type ScoredField } from './recall-core'
import { CONFIG } from '../../shared/config'

/** How many chars to trim a transcript preview to in the recall blob. */
const TRANSCRIPT_PREVIEW = 300

/** How many chars to trim OCR text to. */
const OCR_PREVIEW = 200

// ── Scoring ───────────────────────────────────────────────────────────────────

/**
 * Score a single MediaItem against the query tokens.
 *
 * Field weights:
 *   - tags (RAKE keywords computed by enrichment): weight 3. High-signal: these are
 *     the engine's own distilled nouns for the content, so a match here is very likely
 *     relevant.
 *   - windowTitle + frontApp: weight 2. The app/window context was the user's focus —
 *     if they ask "what did I do in VS Code" this should surface immediately.
 *   - transcript / ocrText: weight 1. Lots of words, so matches are noisier. Capped
 *     frequency (see scoreText) prevents a long transcript from dominating.
 *
 * Returns 0 for items that match no token in any field.
 */
function scoreItem(item: MediaItem, tokens: string[]): number {
  if (tokens.length === 0) return 0
  const fields: ScoredField[] = [
    // Tags: highest signal — distilled nouns from enrichment
    { text: (item.insights?.tags ?? []).join(' '), weight: 3 },
    // App/window context: strong intent signal
    { text: item.windowTitle, weight: 2 },
    { text: item.frontApp, weight: 2 },
    // Body text: lower weight but wide coverage
    { text: item.transcript, weight: 1 },
    { text: item.insights?.ocrText, weight: 1 },
    // Browser URL words (e.g. "github", "notion") are useful but noisier than title
    { text: item.browserUrl, weight: 1 }
  ]
  return scoreText(tokens, fields)
}

// ── Ranking ───────────────────────────────────────────────────────────────────

/**
 * Rank the media index for a user question.
 *
 * @param question  The user's query text.
 * @param items     Full media index (from listMedia() — already newest-first).
 * @param topN      Maximum items to return (default CONFIG.MEDIA_RECALL.TOP_N).
 * @param extraTerms Optional expanded/synonym terms to widen the token set (from
 *                  classifyRecallIntent's expandedTerms on the mightymouse backend).
 *                  Appended to the question's tokens before scoring.
 */
export function rankMediaForQuery(
  question: string,
  items: MediaItem[],
  topN = CONFIG.MEDIA_RECALL.TOP_N,
  extraTerms: string[] = []
): MediaItem[] {
  // Build the token set: question tokens + caller-provided expansion terms.
  // Both go through the same tokenizer so stopwords + min-len are applied uniformly.
  const questionTokens = tokenize(question)
  const expansionTokens = extraTerms
    .flatMap((t) => tokenize(t))
    .filter((t) => !questionTokens.includes(t)) // de-dup against question tokens
  const tokens = [...questionTokens, ...expansionTokens]

  if (tokens.length === 0) {
    // No useful tokens — return the most-recent items up to topN.
    return items.slice(0, topN)
  }

  // Score each item; drop zero-matches (not relevant), then sort by score desc,
  // then by recency desc as a stable tiebreak (newest first among equals).
  const scored = items
    .map((item) => ({ item, score: scoreItem(item, tokens) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      // Tiebreak: recency (ISO strings sort lexicographically)
      return a.item.ts < b.item.ts ? 1 : a.item.ts > b.item.ts ? -1 : 0
    })

  return scored.slice(0, topN).map(({ item }) => item)
}

// ── Serialisation ─────────────────────────────────────────────────────────────

/**
 * Format one MediaItem into a compact, self-contained block for the LLM.
 * Keeps the format intentionally terse — the model only needs enough to anchor
 * its answer and cite which capture the information came from.
 */
function formatItem(item: MediaItem): string {
  const d = new Date(item.ts)
  const when = d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
  const kindLabel = item.kind === 'recording' ? 'Screen recording' : item.kind === 'listen' ? 'Dictation' : 'Screenshot'
  const lines: string[] = [`### ${kindLabel} · ${when}`]

  if (item.frontApp) lines.push(`App: ${item.frontApp}${item.windowTitle ? ` — ${item.windowTitle.slice(0, 80)}` : ''}`)
  if (item.browserUrl) lines.push(`URL: ${item.browserUrl.slice(0, 100)}`)

  if (item.insights?.tags && item.insights.tags.length > 0) {
    lines.push(`Tags: ${item.insights.tags.slice(0, 8).join(', ')}`)
  }

  if (item.transcript) {
    const preview = item.transcript.length > TRANSCRIPT_PREVIEW
      ? item.transcript.slice(0, TRANSCRIPT_PREVIEW) + '…'
      : item.transcript
    lines.push(`Transcript: ${preview}`)
  }

  if (item.insights?.ocrText) {
    const preview = item.insights.ocrText.length > OCR_PREVIEW
      ? item.insights.ocrText.slice(0, OCR_PREVIEW) + '…'
      : item.insights.ocrText
    lines.push(`On-screen text: ${preview}`)
  }

  // The folder path is the stable id the UI uses; include the last component as a
  // citation anchor so the model can say "from the screenshot at 10:32".
  lines.push(`[id: ${item.folder.split('/').pop() ?? item.folder}]`)

  return lines.join('\n')
}

/**
 * Serialise ranked media items into a model-readable block.
 *
 * Packed greedily to RECALL_CHAR_BUDGET (shared constant). Returns the header +
 * empty message when the ranked list is empty so the model says "nothing found"
 * rather than hallucinating. The header includes the question so the model has
 * context without receiving it again in the user prompt.
 */
export function assembleMediaRecall(
  items: MediaItem[],
  question: string,
  budget = CONFIG.MEDIA_RECALL.RECALL_CHAR_BUDGET
): string {
  const header = `## Your captures (answer using ONLY these)\nQuestion: "${question}"\n\n`
  const emptyMsg = 'No matching captures found.'
  const blocks = items.map(formatItem)
  return packBlocks(header, emptyMsg, blocks, budget)
}

/**
 * Collect image paths from the top-ranked items for the vision pass.
 * Screenshots contribute their imagePath directly. Recordings have no still
 * image by default (we don't extract frames here — that's heavy). Dictations
 * have no image. Returns at most `limit` paths.
 *
 * Called by chatWithMedia() (ipc.ts) to populate RunOptions.imageFiles (shell
 * adapters) or RunOptions.images (http adapter, after base64 encoding in ipc.ts).
 */
export function collectImagePaths(items: MediaItem[], limit = CONFIG.MEDIA_RECALL.VISION_IMAGE_LIMIT): string[] {
  const paths: string[] = []
  for (const item of items) {
    if (paths.length >= limit) break
    // Only screenshots have a still image on disk. Recordings: no still unless
    // enrichment extracted frames, but MediaItem has no frame path field today.
    if (item.kind === 'screenshot' && item.imagePath) {
      paths.push(item.imagePath)
    }
  }
  return paths
}

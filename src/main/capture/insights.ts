/**
 * insights.ts — free, local, no-LLM enrichment for a capture folder.
 *
 * Per kind:
 *   - screenshot → OCR the PNG (accurate) → keywords from the OCR text.
 *   - recording  → OCR sampled video frames (fast) + use the audio transcript;
 *                  keywords from both. The heavy one — gated behind an explicit
 *                  request so opening a recording stays instant.
 *   - listen     → no image; keywords straight from the transcript.
 *
 * Result is cached to `insights.json` in the capture folder. First call computes
 * + writes; later calls read the cache. No network, no LLM, no cost.
 *
 * Everything degrades gracefully: a missing OCR binary, a decode failure, or an
 * empty transcript yields an insights row with whatever it could get (often just
 * tags, or nothing) — it never throws into the library flow.
 */
import { existsSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { ocrImage } from './ocr'
import { sampleFrames } from './frame-sample'
import { extractKeywords } from './keywords'
import type { MediaInsights, MediaKind } from '../../shared/types'

const INSIGHTS_FILE = 'insights.json'
// Bump when the enrichment shape/quality changes so stale caches recompute.
const INSIGHTS_VERSION = 3
// ISO timestamp is injected by the caller (Date.now() is unavailable in some
// contexts/tests); here we stamp with a real clock since this is main-process.

/** Read a cached insights.json, or null if absent / unreadable / stale version. */
export function readCachedInsights(folder: string, transcript?: string): MediaInsights | null {
  const p = join(folder, INSIGHTS_FILE)
  if (!existsSync(p)) return null
  try {
    const data = JSON.parse(readFileSync(p, 'utf-8')) as MediaInsights
    if (data.v === INSIGHTS_VERSION) return data
    return write(folder, { ...data, v: INSIGHTS_VERSION, tags: tagsFor(transcript, data.ocrText) })
  } catch {
    return null
  }
}

function tagsFor(transcript?: string, ocrText?: string): string[] {
  return extractKeywords([transcript, ocrText].filter(Boolean).join('\n'))
}

function write(folder: string, insights: MediaInsights): MediaInsights {
  try {
    writeFileSync(join(folder, INSIGHTS_FILE), JSON.stringify(insights), 'utf-8')
  } catch {
    // A read-only/full disk shouldn't break enrichment — return uncached.
  }
  return insights
}

/** Dedupe consecutive frame OCR output: adjacent frames usually repeat text. */
function dedupeFrameText(texts: string[]): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of texts) {
    const norm = t.replace(/\s+/g, ' ').trim()
    if (!norm || seen.has(norm)) continue
    seen.add(norm)
    out.push(norm)
  }
  return out.join('\n\n')
}

/**
 * Compute (or read cached) insights for a capture. `transcript` is passed in by
 * the caller (it already read it while scanning). `videoPath`/`imagePath` are
 * absolute paths or undefined. Set `force` to recompute even if cached.
 */
export async function enrichCapture(opts: {
  folder: string
  kind: MediaKind
  imagePath?: string
  videoPath?: string
  transcript?: string
  force?: boolean
}): Promise<MediaInsights> {
  const { folder, kind, imagePath, videoPath, transcript, force } = opts
  if (!force) {
    const cached = readCachedInsights(folder, transcript)
    if (cached) return cached
  }

  let ocrText = ''
  let framesOcr: number | undefined

  if (kind === 'screenshot' && imagePath) {
    ocrText = await ocrImage(imagePath, false) // accurate — one image, high value
  } else if (kind === 'recording' && videoPath) {
    const { dir, frames } = await sampleFrames(videoPath)
    try {
      const texts = await Promise.all(frames.map((f) => ocrImage(f, true))) // fast
      ocrText = dedupeFrameText(texts)
      framesOcr = frames.length
    } finally {
      rmSync(dir, { recursive: true, force: true }) // never leave temp frames behind
    }
  }

  return write(folder, {
    v: INSIGHTS_VERSION,
    ts: new Date().toISOString(),
    ocrText: ocrText || undefined,
    tags: tagsFor(transcript, ocrText),
    framesOcr
  })
}

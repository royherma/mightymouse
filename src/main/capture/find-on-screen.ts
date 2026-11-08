/**
 * find-on-screen.ts — turn a text label ("Export", "the settings gear") into a
 * screen coordinate by OCRing a screenshot and fuzzy-matching the target against
 * the recognized text boxes.
 *
 * This is the cheap, accurate path for the "point at / click on screen" feature:
 * when the target is on-screen TEXT, we resolve it locally with zero LLM cost and
 * pixel-accurate boxes (Apple Vision via ocrRects). The model only has to name
 * the target; it does NOT have to guess a coordinate. When the target isn't text
 * (a bare icon), this returns null and the caller falls back to the model's own
 * [POINT:x,y] from the screenshot.
 *
 * Coordinates returned are LOGICAL SCREEN POINTS (origin top-left), already
 * divided by the display scale factor — i.e. what `screen.getCursorScreenPoint()`
 * and the cursor overlay use. ocrRects hands back image PIXELS (Retina 2x), so we
 * convert here, in one place.
 */
import { screen } from 'electron'
import { ocrRects, type OcrRect } from './ocr'

export interface ScreenPoint {
  x: number
  y: number
}

// A match must clear this score to count — below it, "found" is more likely noise
// than the real control, so we return null and let the model's coordinate win.
const MIN_SCORE = 0.4

/** Normalize for comparison: lowercase, collapse whitespace, strip punctuation. */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Score how well an OCR line matches the target (0..1). Higher = better.
 *   1.0  exact (normalized) equality
 *   0.85 the line IS the target plus extra words ("Export" in "Export as PNG")
 *   0.6  target appears as a substring somewhere
 *   word-overlap fraction otherwise
 */
function score(target: string, line: string): number {
  const t = norm(target)
  const l = norm(line)
  if (!t || !l) return 0
  if (t === l) return 1
  const tWords = t.split(' ')
  const lWords = l.split(' ')
  // Target is a leading run of the line's words → strong (button label + suffix).
  if (lWords.slice(0, tWords.length).join(' ') === t) return 0.85
  if (l.includes(t)) return 0.6
  // Fraction of target words present anywhere in the line.
  const present = tWords.filter((w) => lWords.includes(w)).length
  return present / tWords.length
}

/**
 * Resolve a target label to a screen point using OCR on the given screenshot.
 * Returns the CENTER of the best-matching text box (logical points), or null if
 * nothing clears MIN_SCORE. Never throws — OCR failure → null.
 */
export async function findOnScreen(
  target: string,
  screenshotPath: string
): Promise<ScreenPoint | null> {
  const trimmed = target.trim()
  if (!trimmed) return null

  let rects: OcrRect[]
  try {
    rects = await ocrRects(screenshotPath)
  } catch {
    return null
  }
  if (rects.length === 0) return null

  let best: OcrRect | null = null
  let bestScore = 0
  for (const r of rects) {
    const s = score(trimmed, r.text)
    // Tie-break toward the higher-confidence OCR line.
    if (s > bestScore || (s === bestScore && best && r.conf > best.conf)) {
      best = r
      bestScore = s
    }
  }

  if (!best || bestScore < MIN_SCORE) return null

  // Center of the box, image pixels → logical screen points.
  const scale = screen.getPrimaryDisplay().scaleFactor || 1
  return {
    x: Math.round((best.x + best.w / 2) / scale),
    y: Math.round((best.y + best.h / 2) / scale)
  }
}

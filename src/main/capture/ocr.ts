/**
 * ocr.ts — extract on-screen text from an image via the native Vision helper
 * (native/ocr/Ocr.swift). Free, local, offline. No model, no network, no cost.
 *
 * The binary is resolved the same way as native-mic.ts / notch-info.ts: the
 * repo path in dev, the app Resources dir when packaged. A missing binary or a
 * failed run degrades to '' — OCR is an enrichment, never load-bearing, so it
 * must never throw into the capture or library flow.
 *
 * Measured on a 2.1MB full-screen shot (macOS 26, M-series): ~2.4s accurate,
 * ~0.4s fast. Screenshots use accurate (searchable fidelity); video keyframes
 * use fast (many frames, lower per-frame value).
 */
import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { helpers } from '../platform'
import { CONFIG } from '../../shared/config'

const OCR_BIN = 'ocr'

/** Repo path in dev; app Resources when packaged (mirrors native-mic.ts). */
function resolveOcrBin(): string {
  // null only where the OS ships no helper; '' then fails the existsSync guard like a missing binary.
  return helpers.resolve(OCR_BIN) ?? ''
}

/** One recognized text line with its box, in IMAGE PIXELS (origin top-left). */
export interface OcrRect {
  text: string
  x: number
  y: number
  w: number
  h: number
  conf: number
}

/**
 * Run the ocr binary with the given extra args, returning trimmed stdout (or ''
 * on any failure). Shared by ocrImage (plain text) and ocrRects (JSON).
 */
function runOcr(imagePath: string, extraArgs: string[]): Promise<string> {
  return new Promise((resolve) => {
    const bin = resolveOcrBin()
    if (!existsSync(bin) || !existsSync(imagePath)) {
      resolve('')
      return
    }
    const proc = spawn(bin, [imagePath, ...extraArgs])
    let out = ''
    let settled = false
    const done = (text: string): void => {
      if (settled) return
      settled = true
      resolve(text)
    }

    // Per-image ceiling — accurate OCR on a dense 4K shot can run long; cap it
    // so one slow frame can't stall a whole video enrichment pass.
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      done('')
    }, CONFIG.OCR_TIMEOUT_MS)

    proc.stdout.on('data', (d) => {
      out += d.toString()
    })
    proc.on('error', () => {
      clearTimeout(timer)
      done('')
    })
    proc.on('close', () => {
      clearTimeout(timer)
      done(out.trim())
    })
  })
}

/**
 * OCR one image to text. Returns '' on any failure (missing binary, unreadable
 * image, timeout). `fast` trades accuracy for ~5x speed — used for video frames.
 */
export function ocrImage(imagePath: string, fast = false): Promise<string> {
  return runOcr(imagePath, fast ? ['--fast'] : [])
}

/**
 * OCR one image to per-line boxes (image pixels, top-left origin). Returns [] on
 * any failure — callers treat "no rects" as "couldn't find it", never an error.
 * Used by find-on-screen to resolve a label into a coordinate. Always accurate
 * level (we want correct boxes, not the fast/blurry pass).
 */
export async function ocrRects(imagePath: string): Promise<OcrRect[]> {
  const out = await runOcr(imagePath, ['--json'])
  if (!out) return []
  try {
    const parsed = JSON.parse(out)
    return Array.isArray(parsed) ? (parsed as OcrRect[]) : []
  } catch {
    return []
  }
}

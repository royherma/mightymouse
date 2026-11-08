// image-vision.ts — turn a screenshot path into an inline vision payload for the
// http (paid) backend. The shell backends (claude/codex CLI) read images off disk
// with their Read tool, so they never call this; only the chat-completions path
// needs the bytes inlined, because a text endpoint can't open a local path.
//
// We downscale to a sane ceiling and JPEG-compress first: a retina capture is
// multi-MB, which inflates the request, the image-token bill, and can exceed
// request limits. OpenRouter (our only http provider) accepts the OpenAI
// `image_url` data-URL form for EVERY vision model behind it, so one format here
// covers all underlying providers — no per-provider branching.
import { nativeImage } from 'electron'
import { existsSync } from 'fs'
import { CONFIG } from '../../shared/config'

// Extensions we treat as inline-able images. A capture's run FOLDER (no ext) and
// a transcript .txt are NOT images — they fall through to the shell Read path.
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])

/** True if a path looks like an image we can inline (by extension). */
export function isImagePath(p: string): boolean {
  const dot = p.lastIndexOf('.')
  if (dot === -1) return false
  return IMAGE_EXTS.has(p.slice(dot).toLowerCase())
}

/**
 * Load an image path → a downscaled JPEG data URL ready to drop into an OpenAI
 * `image_url` content part. Returns null for a missing file, a non-image path, or
 * an undecodable image — callers filter nulls, so a bad path silently degrades to
 * "no image" rather than failing the whole run.
 */
export function loadImageAsDataUrl(path: string): string | null {
  if (!isImagePath(path) || !existsSync(path)) return null
  try {
    let img = nativeImage.createFromPath(path)
    if (img.isEmpty()) return null

    // Only shrink — never upscale a small image. resize with one dimension keeps
    // aspect ratio; pick whichever axis is over its ceiling by the larger ratio.
    const { width, height } = img.getSize()
    const overW = width / CONFIG.VISION_MAX_W
    const overH = height / CONFIG.VISION_MAX_H
    const over = Math.max(overW, overH)
    if (over > 1) {
      img =
        overW >= overH
          ? img.resize({ width: CONFIG.VISION_MAX_W })
          : img.resize({ height: CONFIG.VISION_MAX_H })
    }

    const jpeg = img.toJPEG(CONFIG.VISION_JPEG_QUALITY)
    if (jpeg.length === 0) return null
    return `data:image/jpeg;base64,${jpeg.toString('base64')}`
  } catch {
    return null
  }
}

/** Map a list of file/folder paths to inline image data URLs, dropping non-images. */
export function loadImagesForVision(paths: string[]): string[] {
  const out: string[] = []
  for (const p of paths) {
    const url = loadImageAsDataUrl(p)
    if (url) out.push(url)
  }
  return out
}

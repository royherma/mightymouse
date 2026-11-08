// screenshot-attach.ts — "look at my last screenshot and…" as a routing parameter.
//
// Jev answers a `wants_screenshot` noul in the SAME ranking call, and when it
// says yes the newest macOS screenshot rides along with the transcript to
// whichever destination was picked. Two delivery shapes, because the two
// destinations that can see an image take it differently:
//   skill — a real MediaAttachment on the run, the path runHudRun already has.
//   agent — the absolute path appended to the text, because sendPaneText writes
//           a line into a pane and the CLI on the other end opens the file
//           itself. There is no attachment transport into a tmux pane.
// Apps get nothing: a paste is text, and swapping the clipboard to an image
// would lose the transcript that is the whole point of the recording.
import { nativeImage } from 'electron'
import { readdirSync, statSync, existsSync } from 'fs'
import { join, extname } from 'path'
import { screenshotDir } from '../capture/os-screenshots'

/** A screenshot older than this is almost certainly not the one being talked
 *  about. "My last screenshot" means the one just taken; without a window the
 *  feature would attach a picture from last Tuesday to an unrelated note. */
const MAX_AGE_MS = 5 * 60_000

/** Same extension + timestamp-token test os-screenshots.ts uses, for the same
 *  reason: match real macOS captures, not every png saved to the Desktop. The
 *  prefix is localized ("Bildschirmfoto …") but the digits never are. */
const SHOT_EXTS = new Set(['.png', '.jpg', '.jpeg'])
const STAMP_RE = /\d{4}[-.]\d{2}[-.]\d{2}/

const THUMB_W = 560
const THUMB_QUALITY = 72

export interface LastScreenshot {
  path: string
  /** Epoch ms, for the caller to report how old the attached shot was. */
  mtimeMs: number
}

/**
 * The newest macOS screenshot, or null when there is none recent enough.
 *
 * Deliberately NOT listOsScreenshots(): that stats every capture in the folder
 * and sorts up to 200 of them to build a Media Library page. This runs on the
 * routing path, which is budgeted at 4s end to end, and needs exactly one file
 * — so it keeps a running max instead of building and sorting a list.
 *
 * Never throws: an unreadable folder means no attachment, which degrades to the
 * transcript alone rather than failing the whole route.
 */
export function findLastScreenshot(): LastScreenshot | null {
  const dir = screenshotDir()
  if (!existsSync(dir)) return null

  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return null
  }

  const cutoff = Date.now() - MAX_AGE_MS
  let best: LastScreenshot | null = null
  for (const name of names) {
    if (!SHOT_EXTS.has(extname(name).toLowerCase())) continue
    if (!STAMP_RE.test(name)) continue

    const path = join(dir, name)
    try {
      const stat = statSync(path)
      if (!stat.isFile()) continue
      const mtimeMs = stat.mtime.getTime()
      if (mtimeMs < cutoff) continue
      if (!best || mtimeMs > best.mtimeMs) best = { path, mtimeMs }
    } catch {
      continue
    }
  }
  return best
}

// A data URL, not media://: that scheme only serves the screenshot folder when
// the OS-screenshots pref is on, and this attachment does not depend on it.
export function screenshotThumb(path: string): string {
  if (path === '') return ''
  try {
    const image = nativeImage.createFromPath(path)
    if (image.isEmpty()) return ''
    const jpeg = image.resize({ width: THUMB_W }).toJPEG(THUMB_QUALITY)
    return `data:image/jpeg;base64,${jpeg.toString('base64')}`
  } catch {
    return ''
  }
}

/**
 * os-screenshots.ts — surface the user's OWN macOS screenshots & screen
 * recordings (the ones `Cmd+Shift+4/5` drops on the Desktop) in the Media
 * Library, alongside MightyMouse's own captures.
 *
 * These are NOT MightyMouse captures: they live in the user's screencapture
 * folder (default ~/Desktop, but the user can move it — we read the real one
 * from `defaults read com.apple.screencapture location`), they have no run.json,
 * no context file, and no insights sidecar. So every OS item is tagged
 * `source: 'os'`, which the rest of the app uses to:
 *   - delete via the Trash (shell.trashItem), never rmSync — it's the user's
 *     real file, deleting from the Library must be recoverable.
 *   - write its enrich cache to PATHS.OS_CACHE (keyed by a path hash), never a
 *     sidecar next to the file — we don't pollute the user's Desktop.
 *
 * Bounded + cheap: we glob ONLY the macOS capture filename patterns (localized
 * "Screenshot …"/"Screen Recording …" plus the .png/.mov/.jpg extension), stat
 * each, take the most-recent OS_SCAN_LIMIT, and never read file bodies. A user
 * Desktop with hundreds of files stays fast.
 *
 * Opt-in: nothing here runs unless PREFS.getOsScreenshots() is true. The first
 * read of the Desktop/Documents folder may trigger a one-time macOS TCC prompt;
 * the toggle being user-initiated is what makes that acceptable.
 */
import { execFileSync } from 'child_process'
import { readdirSync, statSync, existsSync } from 'fs'
import { join, extname, basename } from 'path'
import { homedir } from 'os'
import { createHash } from 'crypto'
import { PATHS } from '../store/paths'
import { readCachedInsights } from './insights'
import type { MediaItem } from '../../shared/types'

// Most-recent N OS captures to surface. The Library is for recent work, not an
// archive of the user's entire Desktop history — a cap keeps the scan O(dir) and
// the list legible. Sorted by mtime before slicing so we keep the newest.
const OS_SCAN_LIMIT = 200

// macOS names every screenshot/recording with a localized prefix + a timestamp.
// We can't rely on the prefix (it's localized: "Bildschirmfoto …" in German), so
// we match on extension + the presence of a date-like token instead. Recordings
// are .mov, screenshots .png (or .jpg if the user changed the format default).
const SHOT_EXTS = new Set(['.png', '.jpg', '.jpeg'])
const REC_EXTS = new Set(['.mov'])
// A screenshot filename always carries a "YYYY-MM-DD at HH.MM.SS"-shaped stamp
// (the separators are localized but the digits aren't). This filters out random
// pngs the user saved to the Desktop — only true OS captures have the stamp.
const STAMP_RE = /\d{4}[-.]\d{2}[-.]\d{2}/

const SCREENSHOT_DIR_TTL_MS = 60_000
let screenshotDirCache: { dir: string; at: number } | null = null

/**
 * The folder macOS writes screenshots/recordings to. Honors the user's override
 * (`defaults write com.apple.screencapture location ~/x`); falls back to ~/Desktop
 * (the macOS default) when the key is unset or the read fails. The returned path
 * is the real on-disk dir — `~` is expanded by `defaults` already for an absolute
 * value, but a value stored as a relative/`~` path is normalized against $HOME.
 */
export function screenshotDir(): string {
  const now = Date.now()
  if (screenshotDirCache && now - screenshotDirCache.at < SCREENSHOT_DIR_TTL_MS) return screenshotDirCache.dir
  const dir = readScreenshotDir()
  screenshotDirCache = { dir, at: now }
  return dir
}

function readScreenshotDir(): string {
  const fallback = join(homedir(), 'Desktop')
  try {
    const raw = execFileSync('defaults', ['read', 'com.apple.screencapture', 'location'], {
      encoding: 'utf-8',
      timeout: 2000
    }).trim()
    if (!raw) return fallback
    // `defaults` may return a literal `~` or a relative path — expand against HOME.
    const expanded = raw.startsWith('~') ? join(homedir(), raw.slice(1)) : raw
    return existsSync(expanded) ? expanded : fallback
  } catch {
    // Key unset (`defaults` exits non-zero) or binary missing → the macOS default.
    return fallback
  }
}

/** mtime as ISO-8601, the OS capture's timestamp (no run.json to read it from). */
function fileTs(p: string): string {
  try {
    return statSync(p).mtime.toISOString()
  } catch {
    return new Date(0).toISOString()
  }
}

function fileSize(p: string): number {
  try {
    return statSync(p).size
  } catch {
    return 0
  }
}

/**
 * Stable cache key for an OS item's enrichment. The file lives in a user dir we
 * won't write into, so insights are cached under PATHS.OS_CACHE keyed by a hash
 * of the absolute path — survives across scans as long as the file isn't moved.
 */
export function osCacheFolder(absPath: string): string {
  const hash = createHash('sha1').update(absPath).digest('hex').slice(0, 16)
  return join(PATHS.OS_CACHE, hash)
}

/**
 * Scan the macOS screenshot folder into MediaItems, newest first, capped at
 * OS_SCAN_LIMIT. Read-only and best-effort: an unreadable dir/file is skipped,
 * never throws. Returns [] when the dir is absent or holds no OS captures.
 *
 * `folder` is set to the absolute FILE path (not a dir) — for OS items the file
 * itself is the stable id, since there's no enclosing capture folder. The
 * media:// protocol serves it directly once the screenshot dir is allowlisted.
 */
export function listOsScreenshots(): MediaItem[] {
  const dir = screenshotDir()
  if (!existsSync(dir)) return []

  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }

  const items: MediaItem[] = []
  for (const name of names) {
    const ext = extname(name).toLowerCase()
    const isShot = SHOT_EXTS.has(ext)
    const isRec = REC_EXTS.has(ext)
    if (!isShot && !isRec) continue
    // Require the timestamp token so we surface real OS captures, not every png
    // the user happens to keep on the Desktop. Recordings (.mov) always qualify.
    if (isShot && !STAMP_RE.test(name)) continue

    const path = join(dir, name)
    let isFile = false
    try {
      isFile = statSync(path).isFile()
    } catch {
      continue
    }
    if (!isFile) continue

    const cacheFolder = osCacheFolder(path)
    items.push({
      folder: path, // the file path IS the id for OS items
      source: 'os',
      kind: isRec ? 'recording' : 'screenshot',
      ts: fileTs(path),
      imagePath: isShot ? path : undefined,
      videoPath: isRec ? path : undefined,
      sizeBytes: fileSize(path),
      frontApp: undefined,
      // Surface enrichment only if we've cached it under OS_CACHE — never compute
      // here (scanning stays cheap; the renderer triggers compute via mediaEnrich).
      insights: readOsCachedInsights(cacheFolder)
    })
  }

  items.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
  return items.slice(0, OS_SCAN_LIMIT)
}

/** True if `path` is a file under the live macOS screenshot dir (no escape). */
export function isOsScreenshot(path: string): boolean {
  const dir = screenshotDir()
  const root = dir.endsWith('/') ? dir : dir + '/'
  return path.startsWith(root) && !path.includes('..') && basename(path) !== ''
}

// OS items cache their insights under OS_CACHE (keyed by path hash), so reads go
// through osCacheFolder — never a sidecar next to the user's file. The JSON format
// itself lives in insights.ts (the single home for the insights.json shape).
function readOsCachedInsights(cacheFolder: string): MediaItem['insights'] {
  return readCachedInsights(cacheFolder) ?? undefined
}

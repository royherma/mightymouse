/**
 * Media Library index — scans ~/MightyMouse/runs/ (and legacy ~/MightyMouse/
 * captures/) into a sorted list of MediaItems for the Media Library window.
 *
 * The library shows anything with actual MEDIA on disk — an image, audio, or
 * video file — regardless of which action produced it. A screenshot, a voice
 * note, a screen recording, OR an ask/act run that captured a screenshot all
 * qualify. A text-only LLM run (a plain rewrite/ask with no media file) does NOT.
 * So the rule is "does this folder contain a media file?", and the KIND is read
 * off that media (video → recording, audio-only → listen, image-only → screenshot)
 * — NOT off the run's mode — so the 3 existing UI kinds cover every media folder.
 *
 * Two on-disk layouts, both supported:
 *   - NEW: ~/MightyMouse/runs/<ts>-<kind>-<slug>-<id>/  (+ run.json with `ts`)
 *   - LEGACY: ~/MightyMouse/captures/{rec,shot,listen}-<stamp>/  (ts in the name)
 * There is NO manifest beyond run.json's timestamp: the folder's media files ARE
 * the schema. This module is the single place that knows both layouts.
 *
 * On-demand only (called from the IPC handler). The scan is bounded by the
 * folder count, not the file sizes — we stat media files but never read them.
 * Duration is recovered from the 16kHz/mono WAV header since it's not persisted
 * anywhere else. Upgrade seam: if the count outgrows a per-open scan, cache the
 * result and invalidate on an fs.watch of both roots.
 */
import { readdirSync, statSync, existsSync, readFileSync, rmSync } from 'fs'
import { join, basename } from 'path'
import { shell } from 'electron'
import { PATHS } from '../store/paths'
import { PREFS } from '../store/prefs'
import { FEEDBACK } from '../store/feedback'
import { readCachedInsights, enrichCapture } from './insights'
import { readCachedWaveform } from './waveform'
import { listOsScreenshots, isOsScreenshot, osCacheFolder } from './os-screenshots'
import { transcribe } from './whisper'
import type { MediaItem, MediaKind, RetranscribeResult } from '../../shared/types'

const WAV_SAMPLE_RATE = 16000
const WAV_BYTES_PER_SAMPLE = 2 // 16-bit mono

// The two roots a media folder can live under — the unified runs/ home (current)
// and the legacy captures/ tree (pre-migration folders that never moved). Read
// lazily (a function, not a const) so PATHS is resolved at call time, not module
// load. Order is cosmetic; results are sorted by timestamp at the end.
function mediaRoots(): readonly string[] {
  return [PATHS.RUNS, PATHS.CAPTURES]
}

// Media filenames a capture/run writes. Presence of ANY of these = a library row;
// which one is present also picks the kind (see kindForMedia).
const MEDIA_FILES = { png: 'screenshot.png', mp4: 'screen.mp4', wav: 'audio.wav' } as const

/**
 * Legacy folder stamp → ISO-8601. Legacy capture folders are named with a stamp
 * built from `toISOString().replace(/[:.]/g, '-')`, e.g. `shot-2026-05-29T08-20-41-566Z`.
 * Reverse it: the date part keeps its dashes, the time part's dashes become `:`
 * then `.` for the millis. New runs/ folders carry their ts in run.json instead
 * (see folderTimestamp). Returns null if the name doesn't match the legacy shape.
 */
function stampToIso(name: string): string | null {
  const m = name.match(/^(?:rec|shot|listen)-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/)
  if (!m) return null
  const [, date, hh, mm, ss, ms] = m
  return `${date}T${hh}:${mm}:${ss}.${ms}Z`
}

/**
 * Capture timestamp for a folder, ISO-8601. New runs/ folders store it in
 * run.json (`ts`); legacy captures/ folders encode it in the name. Falls back to
 * the folder's mtime so a folder is never dropped just for a missing/odd stamp.
 */
function folderTimestamp(folder: string, name: string): string {
  const fromName = stampToIso(name)
  if (fromName) return fromName
  try {
    const meta = JSON.parse(readFileSync(join(folder, 'run.json'), 'utf-8'))
    if (typeof meta.ts === 'string' && meta.ts) return meta.ts
  } catch {
    // no/unreadable run.json — fall through to mtime
  }
  try {
    return statSync(folder).mtime.toISOString()
  } catch {
    return new Date(0).toISOString()
  }
}

/**
 * The run_id that produced a folder, from run.json. Only new runs/ folders have it;
 * legacy captures/ folders return undefined (no run.json). Used to join a capture to
 * its feedback note.
 */
function folderRunId(folder: string): string | undefined {
  try {
    const meta = JSON.parse(readFileSync(join(folder, 'run.json'), 'utf-8'))
    return typeof meta.run_id === 'string' && meta.run_id ? meta.run_id : undefined
  } catch {
    return undefined
  }
}

/**
 * Kind from the media a folder actually contains — NOT from the run's mode. Video
 * → recording, audio-only → listen (a voice note), image-only → screenshot. Returns
 * null when the folder has no media file at all (a text-only run → not a library row).
 */
function kindForMedia(folder: string): MediaKind | null {
  if (existsSync(join(folder, MEDIA_FILES.mp4))) return 'recording'
  if (existsSync(join(folder, MEDIA_FILES.wav))) return 'listen'
  if (existsSync(join(folder, MEDIA_FILES.png))) return 'screenshot'
  return null
}

/** WAV duration in seconds from the data-chunk size. Cheap: reads 44 header bytes. */
function wavDurationS(wavPath: string): number | undefined {
  try {
    const size = statSync(wavPath).size
    if (size <= 44) return undefined
    return Math.round(((size - 44) / (WAV_SAMPLE_RATE * WAV_BYTES_PER_SAMPLE)) * 10) / 10
  } catch {
    return undefined
  }
}

/** Parse a context-*.txt file into its front_app / window_title / browser_url. */
function readContext(folder: string, fileName: string): Pick<MediaItem, 'frontApp' | 'windowTitle' | 'browserUrl'> {
  const out: Pick<MediaItem, 'frontApp' | 'windowTitle' | 'browserUrl'> = {}
  const p = join(folder, fileName)
  if (!existsSync(p)) return out
  try {
    for (const line of readFileSync(p, 'utf-8').split('\n')) {
      const [key, ...rest] = line.split(':')
      const val = rest.join(':').trim()
      if (!val) continue
      if (key === 'front_app') out.frontApp = val
      else if (key === 'window_title') out.windowTitle = val
      else if (key === 'browser_url') out.browserUrl = val
    }
  } catch {
    // ignore unreadable context — the row is still useful without it
  }
  return out
}

/** First context-*.txt present, preferring the start file for rec/listen. */
function firstContextFile(folder: string, kind: MediaKind): string | undefined {
  const candidates =
    kind === 'screenshot'
      ? ['context.txt']
      : kind === 'recording'
        ? ['context-recording-start.txt', 'context-recording-end.txt']
        : ['context-listen-start.txt']
  return candidates.find((f) => existsSync(join(folder, f)))
}

function transcriptText(folder: string): string | undefined {
  const p = join(folder, 'transcript.txt')
  if (!existsSync(p)) return undefined
  try {
    const t = readFileSync(p, 'utf-8').trim()
    return t || undefined
  } catch {
    return undefined
  }
}

function sizeOf(...paths: (string | undefined)[]): number {
  let total = 0
  for (const p of paths) {
    if (!p) continue
    try {
      total += statSync(p).size
    } catch {
      // missing file contributes nothing
    }
  }
  return total
}

/**
 * Build one MediaItem from an absolute folder path, or null if the folder holds
 * no media file (a text-only run → not a library row). Works for both the new
 * runs/ layout and the legacy captures/ layout — kind comes from the media on
 * disk, timestamp from run.json or the legacy name.
 */
function scanFolder(folder: string): MediaItem | null {
  const kind = kindForMedia(folder)
  if (!kind) return null
  const ts = folderTimestamp(folder, basename(folder))

  const png = join(folder, MEDIA_FILES.png)
  const mp4 = join(folder, MEDIA_FILES.mp4)
  const wav = join(folder, MEDIA_FILES.wav)

  const imagePath = existsSync(png) ? png : undefined
  const videoPath = existsSync(mp4) ? mp4 : undefined
  const audioPath = existsSync(wav) ? wav : undefined
  const transcript = transcriptText(folder)

  const ctxFile = firstContextFile(folder, kind)
  const ctx = ctxFile ? readContext(folder, ctxFile) : {}

  return {
    folder,
    kind,
    ts,
    run_id: folderRunId(folder),
    imagePath,
    videoPath,
    audioPath,
    transcript,
    durationS: audioPath ? wavDurationS(audioPath) : undefined,
    wordCount: transcript ? transcript.split(/\s+/).filter(Boolean).length : undefined,
    sizeBytes: sizeOf(imagePath, videoPath, audioPath),
    // Surface enrichment if it's already been computed — never compute here
    // (scanning must stay cheap). The renderer triggers compute via mediaEnrich.
    insights: readCachedInsights(folder, transcript) ?? undefined,
    waveform: readCachedWaveform(folder) ?? undefined,
    ...ctx
  }
}

const SCAN_CACHE_SETTLE_MS = 120_000
// Keyed on folder mtime: anything overwriting a file in place inside a folder must drop its entry.
let scanCache = new Map<string, { mtimeMs: number; item: MediaItem | null }>()

function scanFolderCached(
  folder: string,
  now: number,
  next: Map<string, { mtimeMs: number; item: MediaItem | null }>
): MediaItem | null {
  const mtimeMs = statSync(folder).mtimeMs
  const hit = scanCache.get(folder)
  if (hit && hit.mtimeMs === mtimeMs) {
    next.set(folder, hit)
    return hit.item && { ...hit.item }
  }
  const item = scanFolder(folder)
  if (now - mtimeMs > SCAN_CACHE_SETTLE_MS) next.set(folder, { mtimeMs, item })
  return item && { ...item }
}

const WARM_BATCH = 100

export function warmMediaScanCache(): void {
  const now = Date.now()
  const folders = mediaRoots().flatMap((root) => {
    try {
      return readdirSync(root).map((name) => join(root, name))
    } catch {
      return []
    }
  })
  const step = (start: number): void => {
    const end = Math.min(start + WARM_BATCH, folders.length)
    for (let i = start; i < end; i++) {
      try {
        scanFolderCached(folders[i], now, scanCache)
      } catch {
        // same skip as listMedia
      }
    }
    if (end < folders.length) setImmediate(() => step(end))
  }
  step(0)
}

/**
 * Scan both media roots (runs/ + legacy captures/) into one list, newest first.
 * Read-only and best-effort: an unreadable folder is skipped, never throws. Folders
 * without a media file (text-only runs) are filtered out by scanFolder.
 */
export function listMedia(): MediaItem[] {
  const items: MediaItem[] = []
  const now = Date.now()
  const nextCache: typeof scanCache = new Map()
  for (const root of mediaRoots()) {
    if (!existsSync(root)) continue
    let names: string[]
    try {
      names = readdirSync(root)
    } catch {
      continue
    }
    for (const name of names) {
      try {
        const item = scanFolderCached(join(root, name), now, nextCache)
        if (item) items.push(item)
      } catch {
        // skip any folder that fails to scan — keep the rest of the library usable
      }
    }
  }
  scanCache = nextCache
  // Opt-in: blend in the user's own macOS screenshots/recordings. Best-effort —
  // a TCC-blocked or missing screencapture dir just yields no rows (never throws).
  if (PREFS.getOsScreenshots()) {
    try {
      items.push(...listOsScreenshots())
    } catch {
      // ignore — the rest of the library stays usable
    }
  }
  // Join each app capture to its feedback note (by run_id) so "why I grabbed this"
  // shows on the row. Note-only entries (rating=null) and thumbed entries with a
  // note both surface here; os/legacy items have no run_id and stay noteless.
  for (const item of items) {
    if (item.run_id) {
      const note = FEEDBACK.get(item.run_id)?.note
      if (note) item.note = note
    }
  }
  // Newest first (ISO timestamps sort lexicographically).
  items.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
  return items
}

/** True if `folder` is a real path directly under a media root (no escape). */
export function isMediaFolder(folder: string): boolean {
  return mediaRoots().some((r) => {
    const root = r + (r.endsWith('/') ? '' : '/')
    return folder.startsWith(root) && !folder.includes('..')
  })
}

/**
 * Delete one library item by its id (a folder for app items, a file for OS items).
 *
 * App items live under our own roots — rm the folder outright (it's our data).
 * OS items are the USER'S real screenshot/recording files; deleting one from the
 * Library must be RECOVERABLE, so they go to the Trash (shell.trashItem), never
 * rm. A malformed id that matches neither guard is rejected — it can never touch
 * an unrelated path. Returns true on success.
 */
export async function deleteMedia(folder: string): Promise<boolean> {
  if (isOsScreenshot(folder)) {
    try {
      await shell.trashItem(folder)
      // The off-disk enrich cache for this file is now orphaned — clean it up too.
      rmSync(osCacheFolder(folder), { recursive: true, force: true })
      return true
    } catch {
      return false
    }
  }
  if (!isMediaFolder(folder)) return false
  try {
    rmSync(folder, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/**
 * Re-run whisper on one capture's audio and overwrite its transcript.txt,
 * returning the refreshed row. For the captures whisper got wrong the first
 * time — a garbled 16s clip that came back as a single word.
 *
 * App captures only: an OS screenshot/recording is the USER'S file and we never
 * write a sidecar next to it (same rule enrichMedia follows), so it's rejected
 * rather than silently no-op'd. Cached insights are left alone — they're keyed
 * off the old transcript, and mediaEnrich(force) is the way to refresh those.
 */
export async function retranscribeMedia(folder: string): Promise<RetranscribeResult> {
  if (isOsScreenshot(folder)) {
    return { ok: false, error: "Can't re-transcribe a macOS screen recording." }
  }
  if (!isMediaFolder(folder)) return { ok: false, error: 'Not a capture folder.' }
  const item = scanFolder(folder)
  if (!item) return { ok: false, error: 'Capture not found.' }
  if (!item.audioPath) return { ok: false, error: 'This capture has no audio.' }

  const res = await transcribe(item.audioPath, join(folder, 'transcript'))
  scanCache.delete(folder)
  if (!res.ok) return { ok: false, error: res.error ?? 'Transcription failed.' }
  // Re-scan rather than patching the item: transcript.txt on disk is the source
  // of truth for both `transcript` and `wordCount`, and scanFolder already agrees
  // with what a later listMedia() will report.
  const fresh = scanFolder(folder)
  return fresh ? { ok: true, item: fresh } : { ok: false, error: 'Capture not found.' }
}

/**
 * Compute (or read cached) enrichment for one capture, returning the updated
 * MediaItem. Guarded to the media roots. `force` recomputes even if cached.
 * Returns null if the folder isn't a valid media folder.
 */
export async function enrichMedia(folder: string, force = false): Promise<MediaItem | null> {
  // OS screenshots/recordings: the id is the file path. Build the item from the
  // OS scan (it carries source:'os' + the right paths) and cache enrichment to
  // PATHS.OS_CACHE — NEVER a sidecar next to the user's file.
  if (isOsScreenshot(folder)) {
    const item = listOsScreenshots().find((it) => it.folder === folder)
    if (!item) return null
    const insights = await enrichCapture({
      folder: osCacheFolder(folder),
      kind: item.kind,
      imagePath: item.imagePath,
      videoPath: item.videoPath,
      force
    })
    return { ...item, insights }
  }
  if (!isMediaFolder(folder)) return null
  const item = scanFolder(folder)
  if (!item) return null
  const insights = await enrichCapture({
    folder: item.folder,
    kind: item.kind,
    imagePath: item.imagePath,
    videoPath: item.videoPath,
    transcript: item.transcript,
    force
  })
  scanCache.delete(folder)
  return { ...item, insights }
}

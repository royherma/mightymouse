import { existsSync } from 'fs'
import { SETTINGS } from '../store/settings'
import { resolveBinary, clearBinaryCache } from '../platform'

/**
 * Resolve ffmpeg AT RECORD TIME, re-checking the filesystem instead of trusting
 * the path cached when settings were first loaded.
 *
 * Why this exists: `withResolvedBinaries()` (store/settings.ts) resolves ffmpeg
 * exactly ONCE, when the settings cache is first populated. Both record entry
 * points then did a bare `existsSync(s.ffmpegPath)` against that frozen string.
 * So a user who installed ffmpeg *while the app was running* kept getting
 * "Can't find ffmpeg" until they quit and relaunched — reported by the first
 * external tester (2026-07-23), alongside "I had to restart the app a couple of
 * times after changes". Same root shape: state read at load, never re-read.
 *
 * The hit path stays a single `existsSync`. Only a miss pays for re-resolution,
 * and a miss previously threw outright, so this strictly replaces a dead end.
 * `clearBinaryCache()` first because resolve-binary.ts memoizes per name — a
 * "not-found" recorded at startup would otherwise be returned forever.
 *
 * On success the fresh path is written back to SETTINGS so the Settings window
 * shows the truth and the next call takes the fast path.
 *
 * @returns absolute ffmpeg path, or null if it genuinely isn't installed.
 */
export function ensureFfmpeg(): string | null {
  const current = SETTINGS.get().ffmpegPath
  if (current && existsSync(current)) return current

  clearBinaryCache()
  const resolved = resolveBinary('ffmpeg')
  if (!resolved) return null

  // Persist so the Settings binaries row and the next record both see it.
  SETTINGS.set({ ffmpegPath: resolved })
  return resolved
}

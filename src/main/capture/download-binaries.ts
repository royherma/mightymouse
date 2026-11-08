import { createHash } from 'crypto'
import { execFile } from 'child_process'
import {
  createWriteStream,
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  unlinkSync
} from 'fs'
import { join } from 'path'
import { get } from 'https'
import { PATHS } from '../store/paths'
import { CONFIG } from '../../shared/config'
import { clearBinaryCache } from '../platform'

/**
 * Download one binary we built ourselves into ~/MightyMouse/bin.
 *
 * WHY THIS EXISTS
 * Recording and voice transcription both used to install via `brew install` —
 * which silently no-ops on a Mac with no Homebrew, i.e. every normal user's
 * Mac. Telemetry over 90 days: `setup_fix_ran {check:"recording"}` was
 * 0 ok / 2 fail. Asking a non-technical user to install a command-line package
 * manager first is not a fallback, it's a dead end, so we fetch a binary we
 * built ourselves over plain HTTPS instead.
 *
 * Mirrors downloadWhisperModel() (binaries.ts) — .part file plus an atomic
 * rename, so an interrupted download can never leave a truncated binary that
 * looks installed — and adds the checksum that one lacks.
 *
 * `name` doubles as the filename and the "no managed X for <arch>" error text,
 * which downloadFailureReason() buckets as unsupported-arch.
 */
function downloadManagedBinary(
  name: string,
  specs: Record<string, { url: string; sha256: string; bytes: number }>,
  onProgress?: (pct: number) => void
): Promise<{ ok: boolean; path: string; error?: string }> {
  const dest = join(PATHS.BIN, name)
  const partPath = `${dest}.part`
  const spec = specs[process.arch]

  return new Promise((resolve) => {
    if (!spec) {
      return resolve({ ok: false, path: dest, error: `no managed ${name} for ${process.arch}` })
    }
    try {
      mkdirSync(PATHS.BIN, { recursive: true })
    } catch {
      // Already there, or unwritable — createWriteStream below reports either.
    }

    const failed = (error: string): void => {
      try {
        unlinkSync(partPath)
      } catch {
        // Nothing written yet, or already gone. The download failed either way.
      }
      resolve({ ok: false, path: dest, error })
    }

    const file = createWriteStream(partPath)
    // Hashed as it streams — a second read of a 20MB file just to verify it
    // would double the disk cost for no extra safety.
    const hash = createHash('sha256')

    const req = (target: string): void => {
      get(target, (res) => {
        // Release assets always redirect to the CDN.
        if (res.statusCode === 301 || res.statusCode === 302) {
          const loc = res.headers.location
          if (loc) {
            res.resume()
            return req(loc)
          }
        }
        if (res.statusCode !== 200) {
          file.close()
          return failed(`HTTP ${res.statusCode}`)
        }
        const total = parseInt(res.headers['content-length'] || '0', 10) || spec.bytes
        let received = 0
        res.on('data', (chunk) => {
          received += chunk.length
          hash.update(chunk)
          if (total && onProgress) onProgress(Math.round((received / total) * 100))
        })
        res.pipe(file)
        file.on('finish', () =>
          file.close(() => {
            // A truncated body ends the stream cleanly, so only the byte count
            // catches it — same trap downloadWhisperModel() documents.
            if (total && received !== total) {
              return failed(`incomplete download (${received} of ${total} bytes)`)
            }
            const got = hash.digest('hex')
            if (got !== spec.sha256) {
              return failed(`checksum mismatch (expected ${spec.sha256.slice(0, 12)}…)`)
            }
            try {
              chmodSync(partPath, 0o755)
              renameSync(partPath, dest)
            } catch (err) {
              return failed(`could not save: ${(err as Error).message}`)
            }
            // resolveBinary() memoizes per name, so the "not found" recorded at
            // startup would be returned forever without this — the binary would
            // be on disk and the app would still say it was missing.
            clearBinaryCache()
            resolve({ ok: true, path: dest })
          })
        )
      }).on('error', (err) => {
        file.close()
        failed(err.message)
      })
    }
    req(spec.url)
  })
}

/**
 * ffmpeg: LGPL v2.1+ built from source and notarized under our Developer ID
 * (prds/active/2026-07-23-1784775485-managed-ffmpeg-download.md). The record
 * path needs no GPL component — recorder.ts encodes with Apple's hardware
 * h264_videotoolbox, and listen-recorder.ts writes plain PCM.
 */
export function downloadManagedFfmpeg(
  onProgress?: (pct: number) => void
): Promise<{ ok: boolean; path: string; error?: string }> {
  return downloadManagedBinary('ffmpeg', CONFIG.FFMPEG_DOWNLOAD, onProgress)
}

/**
 * whisper-cli: the transcription engine, whisper.cpp v1.8.2 (MIT).
 *
 * The MODEL is a separate download (downloadWhisperModel, binaries.ts) and
 * always worked without brew — this is the engine that reads it, the last piece
 * that was package-manager-gated.
 */
export function downloadManagedWhisper(
  onProgress?: (pct: number) => void
): Promise<{ ok: boolean; path: string; error?: string }> {
  return downloadManagedBinary('whisper-cli', CONFIG.WHISPER_DOWNLOAD, onProgress)
}

/**
 * Parakeet's engine: NVIDIA's own NeMo-Speech build, an archive of 12 files
 * rather than one binary, so it cannot go through downloadManagedBinary().
 *
 * Two things here are load-bearing:
 *   1. bin/ and lib/ must land as SIBLINGS — the binary finds its 11 dylibs via
 *      @loader_path/../lib, so a flattened unpack dies in dyld on every run.
 *   2. The archive must be fetched by the app, never by a browser: a file
 *      carrying com.apple.quarantine exits 137 because NVIDIA's build is
 *      ad-hoc signed, not notarized (PRD 2026-09-21).
 */
export function downloadManagedParakeet(
  onProgress?: (pct: number) => void
): Promise<{ ok: boolean; path: string; error?: string }> {
  const spec = CONFIG.PARAKEET_DOWNLOAD[`${process.platform}-${process.arch}`]
  const binPath = join(PATHS.BIN, CONFIG.PARAKEET_BIN_SUBPATH)
  const archivePath = join(PATHS.BIN, `${CONFIG.PARAKEET_DIR_NAME}-archive.part`)

  return new Promise((resolve) => {
    if (!spec) {
      return resolve({
        ok: false,
        path: binPath,
        error: `no managed parakeet for ${process.platform}-${process.arch}`
      })
    }
    try {
      mkdirSync(PATHS.BIN, { recursive: true })
    } catch {
      // Already there, or unwritable — createWriteStream below reports either.
    }

    const failed = (error: string): void => {
      try {
        unlinkSync(archivePath)
      } catch {
        // Nothing written yet, or already gone. The download failed either way.
      }
      resolve({ ok: false, path: binPath, error })
    }

    const file = createWriteStream(archivePath)
    const hash = createHash('sha256')

    const req = (target: string): void => {
      get(target, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          const loc = res.headers.location
          if (loc) {
            res.resume()
            return req(loc)
          }
        }
        if (res.statusCode !== 200) {
          file.close()
          return failed(`HTTP ${res.statusCode}`)
        }
        const total = parseInt(res.headers['content-length'] || '0', 10) || spec.bytes
        let received = 0
        res.on('data', (chunk) => {
          received += chunk.length
          hash.update(chunk)
          if (total && onProgress) onProgress(Math.round((received / total) * 100))
        })
        res.pipe(file)
        file.on('finish', () =>
          file.close(() => {
            if (total && received !== total) {
              return failed(`incomplete download (${received} of ${total} bytes)`)
            }
            const got = hash.digest('hex')
            if (got !== spec.sha256) {
              return failed(`checksum mismatch (expected ${spec.sha256.slice(0, 12)}…)`)
            }
            // A half-unpacked previous attempt would make tar skip files it
            // thinks exist, leaving a tree that passes the checksum and fails
            // at runtime.
            try {
              rmSync(join(PATHS.BIN, CONFIG.PARAKEET_DIR_NAME), { recursive: true, force: true })
            } catch {
              // force:true already swallows a missing dir; nothing left to report.
            }
            const unpack =
              process.platform === 'win32'
                ? { cmd: 'tar.exe', args: ['-xf', archivePath, '-C', PATHS.BIN] }
                : { cmd: '/usr/bin/tar', args: ['-xzf', archivePath, '-C', PATHS.BIN] }
            execFile(unpack.cmd, unpack.args, { timeout: 120_000 }, (unpackErr) => {
              try {
                unlinkSync(archivePath)
              } catch {
                // The archive already did its job; a leftover .part costs disk, not correctness.
              }
              if (unpackErr) return failed(`could not unpack: ${unpackErr.message}`)
              if (!existsSync(binPath)) return failed('could not unpack: no engine in archive')
              try {
                chmodSync(binPath, 0o755)
              } catch (err) {
                console.error('[parakeet] chmod +x on the unpacked engine failed:', err)
              }
              // The checksum proves the BYTES, not that the thing runs: a
              // missing dylib or a quarantine flag both pass the hash and then
              // exit non-zero here, which is the failure worth catching before
              // we tell setup it succeeded.
              execFile(binPath, ['--version'], { timeout: 10_000 }, (verErr) => {
                if (verErr) {
                  return failed(`engine will not run: ${verErr.message}`)
                }
                clearBinaryCache()
                resolve({ ok: true, path: binPath })
              })
            })
          })
        )
      }).on('error', (err) => {
        file.close()
        failed(err.message)
      })
    }
    req(spec.url)
  })
}

/** True when the Parakeet engine is unpacked and present. */
export function hasManagedParakeet(): boolean {
  return existsSync(join(PATHS.BIN, CONFIG.PARAKEET_BIN_SUBPATH))
}

/**
 * Bucket a download error for analytics.
 *
 * The raw message is never the event prop: it embeds the .part path, which
 * contains $HOME, which is usually a real name. These five buckets are what
 * the decision actually needs — `checksum` means a bad release and every user
 * is broken, `network` means one user should retry.
 */
export function downloadFailureReason(error?: string): string {
  if (!error) return 'none'
  if (error.startsWith('checksum mismatch')) return 'checksum'
  if (error.startsWith('incomplete download')) return 'truncated'
  if (error.startsWith('HTTP ')) return 'http'
  if (error.startsWith('could not save')) return 'disk'
  if (error.startsWith('no managed ')) return 'unsupported-arch'
  return 'network'
}

/** True when a managed ffmpeg is already on disk — lets setup skip the download. */
export function hasManagedFfmpeg(): boolean {
  return existsSync(join(PATHS.BIN, 'ffmpeg'))
}

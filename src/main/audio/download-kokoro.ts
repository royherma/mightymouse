import {
  existsSync,
  createReadStream,
  createWriteStream,
  mkdirSync,
  rmSync,
  renameSync,
  statSync
} from 'fs'
import { createHash } from 'crypto'
import { spawnSync } from 'child_process'
import { get } from 'https'
import { dirname, join } from 'path'
import { CONFIG } from '../../shared/config'
import { PATHS } from '../store/paths'
import { kokoroRoot, isKokoroSupportedPlatform } from './ensure-kokoro'

// Lazy download + install of the Kokoro voice payload. Same shape as
// gaze-model.ts (redirect handling, temp file, atomic rename, size guard) with
// three differences that payload's size forces:
//
//   1. RESUMABLE. This is ~550MB, not 8MB. A dropped connection at 90% must not
//      restart from zero, so the .partial is kept and re-requested with a Range
//      header. gaze-model deletes its temp on failure; that is fine at 8MB and
//      hostile here.
//   2. SHA-256 VERIFIED. A truncated tarball fails loudly at extraction, but a
//      silently corrupted one produces a payload that dies later with a confusing
//      Python traceback. The hash is pinned in CONFIG alongside the URL, so a
//      mismatch is caught before anything is unpacked.
//   3. BYTE-LEVEL PROGRESS, not a percentage. At this size the user needs MB and
//      a speed/ETA to tell "working" from "stuck", so onProgress reports raw
//      counters and the renderer formats them.
//
// The payload is a signed, self-contained venv (scripts/build-managed-kokoro.sh).
// It extracts to ~/MightyMouse/models/kokoro — a SHORT path on purpose: espeak-ng
// truncates a long data path and then falls back to the path baked in at its own
// build time, aborting the process with no Python traceback.

/** Progress counters for a payload download. Formatting belongs to the renderer. */
export interface KokoroProgress {
  receivedBytes: number
  totalBytes: number
}

export interface KokoroInstallResult {
  ok: boolean
  path?: string
  error?: string
}

/** Where the in-flight download accumulates. Kept across attempts so it can resume. */
function partialPath(): string {
  return join(PATHS.MODELS, 'kokoro-payload.tar.gz.partial')
}

/**
 * Download the payload to `dest`, resuming from whatever is already there.
 *
 * Progress is reported on a ~250ms tick rather than per-chunk: at 550MB a chunk
 * callback fires thousands of times a second and floods IPC for no visible gain.
 */
function fetchPayload(
  url: string,
  dest: string,
  totalExpected: number,
  onProgress?: (p: KokoroProgress) => void
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    // Bytes already on disk from an interrupted attempt — the resume offset.
    let received = 0
    try {
      received = existsSync(dest) ? statSync(dest).size : 0
    } catch {
      received = 0
    }
    if (totalExpected && received >= totalExpected) return resolve({ ok: true })

    let lastTick = 0
    const tick = (force = false): void => {
      const now = Date.now()
      if (!force && now - lastTick < 250) return
      lastTick = now
      onProgress?.({ receivedBytes: received, totalBytes: totalExpected })
    }

    const req = (target: string, redirects: number): void => {
      const headers: Record<string, string> = {}
      // Resume only when we actually have bytes; a Range on a fresh file makes
      // some CDNs answer 416 instead of 200.
      if (received > 0) headers.Range = `bytes=${received}-`

      get(target, { headers }, (res) => {
        const code = res.statusCode ?? 0

        if (code === 301 || code === 302 || code === 307 || code === 308) {
          const loc = res.headers.location
          res.resume() // drain; never write a redirect body
          if (loc && redirects < 5) return req(loc, redirects + 1)
          return resolve({ ok: false, error: 'too many redirects' })
        }

        // 416 = the server thinks we already have it all. Trust the local size
        // check above rather than looping forever on a stale .partial.
        if (code === 416) {
          res.resume()
          return resolve({ ok: true })
        }

        // A server that ignores Range answers 200 and restarts the body at zero;
        // appending that to existing bytes would corrupt the file. Truncate.
        if (code === 200 && received > 0) {
          received = 0
          try {
            rmSync(dest)
          } catch {
            /* best-effort; the write below recreates it */
          }
        }

        if (code !== 200 && code !== 206) {
          res.resume()
          return resolve({ ok: false, error: `HTTP ${code}` })
        }

        const file = createWriteStream(dest, { flags: received > 0 ? 'a' : 'w' })
        res.on('data', (chunk: Buffer) => {
          received += chunk.length
          tick()
        })
        res.pipe(file)
        file.on('finish', () =>
          file.close(() => {
            tick(true)
            resolve({ ok: true })
          })
        )
        // Leave the .partial in place on error — that is what makes a retry resume.
        file.on('error', (err) => resolve({ ok: false, error: err.message }))
      }).on('error', (err) => resolve({ ok: false, error: err.message }))
    }
    req(url, 0)
  })
}

/** SHA-256 of a file, streamed so a 550MB payload never lands in memory at once. */
function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    const rs = createReadStream(path)
    rs.on('data', (c) => h.update(c))
    rs.on('end', () => resolve(h.digest('hex')))
    rs.on('error', reject)
  })
}

/**
 * Ensure the Kokoro payload is installed, downloading + extracting it if needed.
 *
 * Safe to call when it is already installed (returns immediately), and safe to
 * call again after a failure (resumes the partial download).
 */
export async function downloadManagedKokoro(
  onProgress?: (p: KokoroProgress) => void
): Promise<KokoroInstallResult> {
  if (!isKokoroSupportedPlatform()) {
    return { ok: false, error: 'The free voice needs an Apple Silicon Mac.' }
  }

  const root = kokoroRoot()
  if (existsSync(join(root, 'bin', 'python'))) return { ok: true, path: root }

  const spec = CONFIG.COMPANION.KOKORO_DOWNLOAD
  if (!spec.url || !spec.sha256) {
    return { ok: false, error: 'This build has no voice payload configured yet.' }
  }

  const partial = partialPath()
  try {
    mkdirSync(dirname(partial), { recursive: true })
  } catch {
    /* dir may already exist */
  }

  const dl = await fetchPayload(spec.url, partial, spec.sizeBytes, onProgress)
  if (!dl.ok) return { ok: false, error: dl.error }

  // Size first: it is free and catches the common truncation case with a clearer
  // message than a hash mismatch would.
  try {
    const got = statSync(partial).size
    if (spec.sizeBytes && got !== spec.sizeBytes) {
      return { ok: false, error: `Download incomplete (${got} of ${spec.sizeBytes} bytes).` }
    }
  } catch (err) {
    return { ok: false, error: `Could not read the download: ${String(err)}` }
  }

  const digest = await hashFile(partial).catch(() => '')
  if (digest !== spec.sha256) {
    // A wrong hash means these bytes are unusable, so this is the one case where
    // the .partial must go — keeping it would make every retry fail identically.
    try {
      rmSync(partial)
    } catch {
      /* best-effort */
    }
    return { ok: false, error: 'The download was corrupted. Try again.' }
  }

  // Extract beside the final location, then rename, so an interrupted extraction
  // never leaves a half-populated ~/MightyMouse/models/kokoro that later reads as
  // "installed". Same atomic-rename discipline as gaze-model.ts.
  const staging = `${root}.incoming`
  try {
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true })
    const tar = spawnSync('/usr/bin/tar', ['-xzf', partial, '-C', staging, '--strip-components', '1'], {
      encoding: 'utf8'
    })
    if (tar.status !== 0) {
      rmSync(staging, { recursive: true, force: true })
      return { ok: false, error: `Could not unpack the voice: ${tar.stderr?.trim() || 'tar failed'}` }
    }
    if (!existsSync(join(staging, 'bin', 'python'))) {
      rmSync(staging, { recursive: true, force: true })
      return { ok: false, error: 'The voice payload is missing its interpreter.' }
    }
    rmSync(root, { recursive: true, force: true })
    renameSync(staging, root)
  } catch (err) {
    try {
      rmSync(staging, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
    return { ok: false, error: `Install failed: ${String(err)}` }
  }

  // The tarball is ~550MB of pure duplicate now that it is unpacked.
  try {
    rmSync(partial)
  } catch {
    /* best-effort */
  }

  return { ok: true, path: root }
}

/**
 * Delete the installed payload and any partial download.
 *
 * Reports bytes freed so the UI can say what the user got back. The HF model
 * cache is deliberately left alone — it is shared with anything else using
 * Kokoro and is only ~350MB; removeKokoroModelCache() handles it separately.
 */
export function removeManagedKokoro(): { removed: boolean; bytesFreed: number } {
  const root = kokoroRoot()
  const partial = partialPath()
  let bytesFreed = 0

  for (const p of [root, partial]) {
    if (!existsSync(p)) continue
    try {
      // du is far faster than walking a 200k-file venv from Node.
      const du = spawnSync('/usr/bin/du', ['-sk', p], { encoding: 'utf8' })
      const kb = parseInt(du.stdout?.trim().split(/\s+/)[0] || '0', 10)
      if (Number.isFinite(kb)) bytesFreed += kb * 1024
    } catch {
      /* size is cosmetic — never block the delete on it */
    }
    try {
      rmSync(p, { recursive: true, force: true })
    } catch (err) {
      console.error('Failed to remove Kokoro payload:', err)
      return { removed: false, bytesFreed: 0 }
    }
  }

  return { removed: bytesFreed > 0, bytesFreed }
}

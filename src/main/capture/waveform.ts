/**
 * waveform.ts — extract a downsampled amplitude envelope (peak bars) from a
 * capture's audio, in the MAIN process, using the ffmpeg the app already ships.
 *
 * Why main-side and not in the renderer: the renderer can't read these bytes.
 * Decoding in the browser needs `fetch(media://…)`, and a cross-origin fetch
 * from http://localhost to our custom `media://` scheme is rejected by CORS
 * even with Access-Control-Allow-Origin (Electron treats the custom secure
 * scheme as opaque to fetch). The <audio>/<video> ELEMENT can stream it, but
 * fetch/XHR can't read the body — so we compute peaks here over a direct file
 * read and hand the renderer a plain number[] over IPC. No CSP, no CORS, no
 * codec guessing in the browser.
 *
 * How: ffmpeg decodes ANY audio or video-with-audio into raw mono 16-bit PCM on
 * stdout (`-f s16le`). We bucket the samples into BAR_COUNT bins and take the
 * peak |amplitude| per bin, normalized to the loudest bin so quiet clips still
 * fill the bar. Works the same for wav (dictation) and mp4 (recording audio).
 *
 * Best-effort: missing ffmpeg, no audio track, or a decode failure resolves to
 * an empty array — the UI then shows a flat idle strip, never a crash.
 */
import { spawn } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { SETTINGS } from '../store/settings'
import { CONFIG } from '../../shared/config'

/** How many peak bars to produce. The renderer draws exactly this many. */
export const WAVEFORM_BARS = 64

/** Sidecar cache, one per capture folder — same pattern as insights.json. */
const WAVEFORM_FILE = 'waveform.json'

interface WaveformCache {
  v: number
  peaks: number[]
}

/** Bump when the peak shape changes (bar count, normalization) to re-compute. */
const WAVEFORM_VERSION = 1

/** Cached peaks for a capture folder, or null. One small JSON read, never ffmpeg. */
export function readCachedWaveform(folder: string): number[] | null {
  const p = join(folder, WAVEFORM_FILE)
  if (!existsSync(p)) return null
  try {
    const data = JSON.parse(readFileSync(p, 'utf-8')) as WaveformCache
    if (data.v !== WAVEFORM_VERSION || !Array.isArray(data.peaks)) return null
    return data.peaks
  } catch {
    return null
  }
}

/** Peaks for a capture, decoding at most once ever. Empty results cache too. */
export async function cachedWaveform(folder: string, mediaPath: string): Promise<number[]> {
  const hit = readCachedWaveform(folder)
  if (hit) return hit

  const peaks = await extractWaveform(mediaPath)
  try {
    const payload: WaveformCache = { v: WAVEFORM_VERSION, peaks }
    writeFileSync(join(folder, WAVEFORM_FILE), JSON.stringify(payload), 'utf-8')
  } catch {
    // Read-only/full disk shouldn't break the UI — return uncached.
  }
  return peaks
}

/**
 * Decode `mediaPath` (wav/mp4/…) to WAVEFORM_BARS normalized peaks (0..1).
 * Returns [] on any failure so the caller can fall back to a flat strip.
 */
export function extractWaveform(mediaPath: string): Promise<number[]> {
  return new Promise((resolve) => {
    const ffmpeg = SETTINGS.get().ffmpegPath
    if (!existsSync(ffmpeg) || !existsSync(mediaPath)) {
      resolve([])
      return
    }
    // Decode to raw mono signed-16-bit PCM at a low sample rate on stdout. 8 kHz
    // is plenty for an amplitude envelope and keeps the buffer tiny.
    const proc = spawn(ffmpeg, [
      '-v', 'error',
      '-i', mediaPath,
      '-ac', '1',
      '-ar', '8000',
      '-f', 's16le',
      '-'
    ])

    const chunks: Buffer[] = []
    let bytes = 0
    proc.stdout.on('data', (c: Buffer) => {
      chunks.push(c)
      bytes += c.length
      // Hard cap so a very long recording can't balloon memory (≈ enough samples
      // for a clean envelope regardless of length). 8 kHz * 2 bytes * 600s ≈ 9.6MB.
      if (bytes > CONFIG.WAVEFORM_MAX_BYTES) proc.kill()
    })

    const finish = (): void => {
      const buf = Buffer.concat(chunks)
      const sampleCount = Math.floor(buf.length / 2) // 2 bytes per s16 sample
      if (sampleCount < WAVEFORM_BARS) {
        resolve([])
        return
      }
      const block = Math.floor(sampleCount / WAVEFORM_BARS)
      const peaks: number[] = new Array(WAVEFORM_BARS).fill(0)
      let max = 0
      for (let b = 0; b < WAVEFORM_BARS; b++) {
        let peak = 0
        const start = b * block
        for (let i = 0; i < block; i++) {
          const v = Math.abs(buf.readInt16LE((start + i) * 2))
          if (v > peak) peak = v
        }
        peaks[b] = peak
        if (peak > max) max = peak
      }
      resolve(max > 0 ? peaks.map((p) => p / max) : [])
    }

    proc.on('error', () => resolve([]))
    proc.on('close', finish)
  })
}

/**
 * frame-sample.ts — break a recording's video into still frames for OCR, using
 * the ffmpeg the app already ships with. One frame every N seconds (capped), so
 * a long screen recording becomes a handful of images we can OCR + dedupe into
 * an on-screen-text timeline. Free, local.
 *
 * Frames are written to a throwaway temp dir the caller owns and deletes after
 * OCR — they never pollute the capture folder. Best-effort: a missing ffmpeg or
 * a decode failure resolves to [] so video enrichment degrades to "no frames",
 * never a crash.
 */
import { spawn } from 'child_process'
import { existsSync, readdirSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { SETTINGS } from '../store/settings'
import { CONFIG } from '../../shared/config'

export interface SampledFrames {
  /** Temp dir holding the frames — the caller MUST rm it when done. */
  dir: string
  /** Absolute paths to the sampled frame PNGs, in order. */
  frames: string[]
}

/**
 * Sample frames from a video at CONFIG.VIDEO_FRAME_INTERVAL_S spacing, capped at
 * CONFIG.VIDEO_FRAME_MAX. Returns the temp dir + frame paths. On failure returns
 * an empty frame list (dir still created so the caller's cleanup is uniform).
 */
export function sampleFrames(videoPath: string): Promise<SampledFrames> {
  const dir = mkdtempSync(join(tmpdir(), 'mm-frames-'))
  return new Promise((resolve) => {
    const ffmpeg = SETTINGS.get().ffmpegPath
    if (!existsSync(ffmpeg) || !existsSync(videoPath)) {
      resolve({ dir, frames: [] })
      return
    }
    // fps=1/N → one frame per N seconds. -frames:v caps total output so a long
    // clip can't spawn hundreds of files.
    const proc = spawn(ffmpeg, [
      '-i',
      videoPath,
      '-vf',
      `fps=1/${CONFIG.VIDEO_FRAME_INTERVAL_S}`,
      '-frames:v',
      String(CONFIG.VIDEO_FRAME_MAX),
      '-y',
      join(dir, 'frame-%03d.png')
    ])
    const finish = (): void => {
      let frames: string[] = []
      try {
        frames = readdirSync(dir)
          .filter((f) => f.endsWith('.png'))
          .sort()
          .map((f) => join(dir, f))
      } catch {
        frames = []
      }
      resolve({ dir, frames })
    }
    proc.on('error', finish)
    proc.on('close', finish)
  })
}

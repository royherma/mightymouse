import { ChildProcess, spawn } from 'child_process'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { PATHS } from '../store/paths'
import { SETTINGS } from '../store/settings'
import { waitForExit, writeContextFile } from './capture-utils'
import { startEventLogging, stopEventLogging } from './event-logger'
import { transcribe } from './whisper'
import { listAvDevices, resolveDeviceIndex } from './devices'
import { ensureFfmpeg } from './ensure-ffmpeg'
import { CaptureResult } from '../../shared/types'
import { CONFIG } from '../../shared/config'
import { markRecording, clearRecordingMark } from './recording-recovery'

interface ActiveSession {
  folder: string
  audioProc: ChildProcess | null
  videoProc: ChildProcess | null
  audioTmp: string
  videoTmp: string
  startedAt: number
  /** ffmpeg's video process failed to spawn — there is no screen capture. */
  videoFailed?: boolean
}

let active: ActiveSession | null = null

export function isRecording(): boolean {
  return active !== null
}

/** True when the current recording's video process died — no screen is captured. */
export function hasVideoFailed(): boolean {
  return active?.videoFailed === true
}


/**
 * Start a screen+audio recording. Throws a clear, actionable error if ffmpeg
 * isn't resolvable — the caller (capture/index.ts) MUST catch this and fail the
 * HUD rather than let it sit on "Recording" while nothing is actually captured.
 * Before this guard, a missing/wrong ffmpeg path spawned a process that emitted
 * only a console.error on 'error' — startSession() still resolved as if
 * recording had started, so a fresh Mac with no Homebrew ffmpeg saw a HUD stuck
 * on "recording" that produced an empty folder.
 */
export async function startSession(): Promise<void> {
  if (active) return
  const s = SETTINGS.get()
  // Re-resolves if the cached path went stale (e.g. ffmpeg installed while the
  // app was running) — see ensure-ffmpeg.ts. Null means genuinely not installed.
  const ffmpeg = ensureFfmpeg()
  if (!ffmpeg) {
    throw new Error(CONFIG.CAPTURE_ERROR.ffmpegMissing)
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const folder = join(PATHS.CAPTURES, `rec-${stamp}`)
  mkdirSync(folder, { recursive: true })

  const audioTmp = join(PATHS.TMP, `rec-audio-${stamp}.wav`)
  const videoTmp = join(PATHS.TMP, `rec-video-${stamp}.mp4`)

  // Resolve device indexes — cache is hot after prewarm so this is synchronous-fast.
  const devices = await listAvDevices()
  const audioIdx = resolveDeviceIndex(s.audioDevice, devices.audio)
  const videoIdx = resolveDeviceIndex(s.videoDevice, devices.video)

  // Audio: avfoundation mic -> 16kHz mono wav (whisper-friendly)
  // Spawned before writeContextFile (osascript) so mic opens immediately.
  const audioProc = spawn(ffmpeg, [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'avfoundation',
    '-i',
    `:${audioIdx}`,
    '-ac',
    '1',
    '-ar',
    '16000',
    audioTmp
  ])
  audioProc.on('error', (e) => console.error('ffmpeg(audio) spawn error:', e.message))

  // Video: avfoundation screen -> h264 mp4
  const videoProc = spawn(ffmpeg, [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'avfoundation',
    '-framerate',
    '30',
    '-i',
    `${videoIdx}:`,
    '-c:v',
    'h264_videotoolbox',
    '-b:v',
    '3M',
    '-pix_fmt',
    'yuv420p',
    videoTmp
  ])
  // A dead video process must not read as a live recording. This used to be a
  // bare console.error while startSession() resolved anyway, so the HUD flipped
  // to "🔴 Recording" over a process that never started and the user filmed
  // nothing until they hit stop. The flag is checked by isRecording()/stop so
  // the failure surfaces instead of being discovered at the end.
  videoProc.on('error', (e) => {
    console.error('ffmpeg(video) spawn error:', e.message)
    if (active) active.videoFailed = true
  })

  startEventLogging(folder)
  // Fire-and-forget — don't block mic/video on osascript context lookup
  writeContextFile(folder, 'recording-start').catch(() => {})

  active = {
    folder,
    audioProc,
    videoProc,
    audioTmp,
    videoTmp,
    startedAt: Date.now()
  }
  markRecording(folder, { kind: 'recording', audioTmp, videoTmp, startedAt: active.startedAt })
}

/**
 * Cancel an in-progress recording and discard everything. SIGKILL (not SIGINT)
 * so ffmpeg doesn't bother flushing a container we're about to delete. Best-effort
 * teardown — never throws — so a cancel keypress can't wedge the app.
 */
export function cancelSession(): void {
  if (!active) return
  const s = active
  active = null

  stopEventLogging()
  s.audioProc?.kill('SIGKILL')
  s.videoProc?.kill('SIGKILL')

  // Drop the temp media + the run folder (context files may have started there).
  for (const p of [s.audioTmp, s.videoTmp]) {
    try {
      if (existsSync(p)) rmSync(p)
    } catch {}
  }
  try {
    if (existsSync(s.folder)) rmSync(s.folder, { recursive: true, force: true })
  } catch {}
}

// App is quitting: flush the files and leave them + the marker for recording-recovery.ts on next launch.
export function detachSession(): void {
  if (!active) return
  const s = active
  active = null
  stopEventLogging()
  s.audioProc?.kill('SIGINT')
  s.videoProc?.kill('SIGINT')
}

/**
 * Stop recording. Resolves once files are finalized and (if available)
 * transcription completes. onPhase reports progress for HUD/UI.
 */
export function stopSession(onPhase?: (detail: string) => void): Promise<CaptureResult | null> {
  return new Promise((resolve) => {
    if (!active) return resolve(null)
    const s = active
    active = null

    stopEventLogging()

    const durationS = (Date.now() - s.startedAt) / 1000

    onPhase?.('finalizing recording')

    // Send SIGINT so ffmpeg flushes and writes correct container headers.
    // Then wait for both processes to actually exit before touching the files —
    // a fixed timeout races against the flush and truncates the WAV header.
    s.audioProc?.kill('SIGINT')
    s.videoProc?.kill('SIGINT')

    Promise.all([waitForExit(s.audioProc), waitForExit(s.videoProc)]).then(async () => {
      const result: CaptureResult = { kind: 'recording', folder: s.folder, durationS }

      const finalWav = join(s.folder, 'audio.wav')
      const finalMp4 = join(s.folder, 'screen.mp4')

      if (existsSync(s.audioTmp)) {
        try {
          renameSync(s.audioTmp, finalWav)
          result.audioPath = finalWav
        } catch (e) {
          console.error('audio move failed:', e)
        }
      }
      if (existsSync(s.videoTmp)) {
        try {
          renameSync(s.videoTmp, finalMp4)
          result.videoPath = finalMp4
        } catch (e) {
          console.error('video move failed:', e)
        }
      }

      await writeContextFile(s.folder, 'recording-end')
      try {
        writeFileSync(PATHS.LATEST_CAPTURE, s.folder, 'utf-8')
      } catch {}

      if (result.audioPath) {
        onPhase?.('transcribing audio')
        const tr = await transcribe(result.audioPath, join(s.folder, 'transcript'))
        if (tr.ok) {
          result.transcriptPath = tr.transcriptPath
          result.wordCount = tr.wordCount
          const txt = tr.text || ''
          result.transcriptPreview = txt.length > 80 ? txt.slice(0, 80) + '…' : txt || '(empty)'
        } else {
          result.transcriptPreview = `transcription skipped: ${tr.error}`
        }
      }

      clearRecordingMark(s.folder)
      resolve(result)
    })
  })
}

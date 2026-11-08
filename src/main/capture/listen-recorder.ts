// Listen/transcribe session: audio-only recorder for the Cmd+Opt+Shift+L
// hotkey. Mirrors recorder.ts but skips video — it records the mic, saves
// window/app context, transcribes via whisper on stop, and the caller copies
// the raw transcript to the clipboard. Runs independently of the screen
// recorder (separate `active` flag) so the two can't clobber each other.
import { ChildProcess, spawn } from 'child_process'
import { existsSync, mkdirSync, renameSync, rmSync } from 'fs'
import { join } from 'path'
import { PATHS } from '../store/paths'
import { SETTINGS } from '../store/settings'
import { PREFS } from '../store/prefs'
import { waitForExit, writeContextFile } from './capture-utils'
import { transcribe } from './whisper'
import { listAvDevices, resolveDeviceIndex } from './devices'
import { ensureFfmpeg } from './ensure-ffmpeg'
import { CaptureResult } from '../../shared/types'
import { CONFIG } from '../../shared/config'
import { markRecording, clearRecordingMark } from './recording-recovery'
// EXPERIMENTAL: native CoreAudio mic path — gated behind PREFS.getUseNativeMic().
import {
  startNativeListen,
  stopNativeListen,
  cancelNativeListen,
  isNativeListening
} from './native-mic'

interface ActiveListen {
  folder: string
  audioProc: ChildProcess | null
  audioTmp: string
  startedAt: number
}

let active: ActiveListen | null = null

export function isListening(): boolean {
  // EXPERIMENTAL: include native path in the check so HUD state stays correct.
  return active !== null || isNativeListening()
}

/**
 * Start a mic-only listen session. Throws a clear, actionable error if neither
 * the native mic path nor ffmpeg is available — see recorder.ts's startSession
 * for why this must throw rather than resolve silently (a missing ffmpeg used
 * to leave the HUD stuck on "Listening" over an empty recording).
 */
export async function startListen(): Promise<void> {
  if (active || isNativeListening()) return
  const s = SETTINGS.get()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const folder = join(PATHS.CAPTURES, `listen-${stamp}`)
  mkdirSync(folder, { recursive: true })

  const audioTmp = join(PATHS.TMP, `listen-audio-${stamp}.wav`)

  // EXPERIMENTAL: native CoreAudio path — far faster cold-open than ffmpeg.
  // Enabled by writing '1' to ~/MightyMouse/use-native-mic.txt.
  if (PREFS.getUseNativeMic()) {
    writeContextFile(folder, 'listen-start').catch(() => {})
    try {
      await startNativeListen(audioTmp)
      // Reuse `active` to carry folder/audioTmp/startedAt; audioProc is null
      // because native-mic.ts manages the process internally.
      active = { folder, audioProc: null, audioTmp, startedAt: Date.now() }
      markRecording(folder, { kind: 'listen', audioTmp, startedAt: active.startedAt })
    } catch (err) {
      console.error('[listen-recorder] native-mic start failed, falling back to ffmpeg:', err)
      // Fall through to ffmpeg below.
    }
    if (active) return
  }

  // Re-resolves a stale cached path before giving up — see ensure-ffmpeg.ts.
  const ffmpeg = ensureFfmpeg()
  if (!ffmpeg) {
    // Native mic didn't take (disabled or failed above) and ffmpeg isn't
    // resolvable either — nothing can record. Clean up the empty folder we
    // pre-created and fail loudly instead of leaving `active` unset while the
    // HUD already says "Listening".
    try {
      rmSync(folder, { recursive: true, force: true })
    } catch {}
    throw new Error(CONFIG.CAPTURE_ERROR.ffmpegMissing)
  }

  const devices = await listAvDevices()
  const audioIdx = resolveDeviceIndex(s.audioDevice, devices.audio)

  // Audio-only: avfoundation mic -> 16kHz mono wav (whisper-friendly).
  // Leading colon in `-i :idx` selects audio with no video input.
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
  audioProc.on('error', (e) => console.error('ffmpeg(listen-audio) spawn error:', e.message))

  // Fire-and-forget so the mic opens immediately, not gated on osascript.
  writeContextFile(folder, 'listen-start').catch(() => {})

  active = { folder, audioProc, audioTmp, startedAt: Date.now() }
  markRecording(folder, { kind: 'listen', audioTmp, startedAt: active.startedAt })
}

/**
 * Cancel an in-progress listen and discard the audio — no transcription, no
 * clipboard. SIGKILL since the WAV is about to be deleted. Best-effort, never throws.
 */
export function cancelListen(): void {
  if (!active) return
  const s = active
  active = null

  if (s.audioProc === null) cancelNativeListen()
  else s.audioProc.kill('SIGKILL')

  for (const p of [s.audioTmp, s.folder]) {
    try {
      if (existsSync(p)) rmSync(p, { recursive: true, force: true })
    } catch {}
  }
}

// App is quitting: flush the audio and leave it + its marker for recording-recovery.ts on next launch.
export function detachListen(): void {
  if (!active) return
  const s = active
  active = null
  if (s.audioProc === null) void stopNativeListen()
  else s.audioProc.kill('SIGINT')
}

/**
 * Stop listening. Resolves once the wav is finalized and transcription
 * completes. onPhase reports progress for the HUD.
 */
export function stopListen(onPhase?: (detail: string) => void): Promise<CaptureResult | null> {
  return new Promise((resolve) => {
    if (!active) return resolve(null)
    const s = active
    active = null

    const durationS = (Date.now() - s.startedAt) / 1000
    onPhase?.('finalizing audio')

    // EXPERIMENTAL: native path — stopNativeListen() sends SIGINT and waits for
    // the binary to flush + finalize the WAV header, same contract as ffmpeg.
    const nativeStop = s.audioProc === null ? stopNativeListen() : Promise.resolve()

    // SIGINT lets ffmpeg flush + write a correct WAV header. Wait for real exit
    // before touching the file — a fixed timeout races the flush and truncates.
    s.audioProc?.kill('SIGINT')

    Promise.all([nativeStop, waitForExit(s.audioProc)]).then(async () => {
      // Clock starts once the wav is flushed and final — before this point we're
      // waiting on the mic to release, which is recording time, not processing.
      const processingStart = Date.now()
      const result: CaptureResult = { kind: 'listen', folder: s.folder, durationS }

      const finalWav = join(s.folder, 'audio.wav')
      if (existsSync(s.audioTmp)) {
        try {
          renameSync(s.audioTmp, finalWav)
          result.audioPath = finalWav
        } catch (e) {
          console.error('listen audio move failed:', e)
        }
      }

      if (result.audioPath) {
        onPhase?.('transcribing audio')
        const tr = await transcribe(result.audioPath, join(s.folder, 'transcript'))
        // Set on both branches — a failed/timed-out transcription is the most
        // important latency sample there is, so it must not be dropped.
        result.transcribeMs = tr.tookMs
        result.transcribeEngineRan = tr.engine
        result.transcribeFellBack = tr.fellBack
        if (tr.ok) {
          result.transcriptPath = tr.transcriptPath
          result.wordCount = tr.wordCount
          const txt = tr.text || ''
          result.transcriptPreview = txt.length > 80 ? txt.slice(0, 80) + '…' : txt || '(empty)'
        } else {
          result.transcriptPreview = `transcription skipped: ${tr.error}`
        }
      }

      result.processingMs = Date.now() - processingStart
      clearRecordingMark(s.folder)
      resolve(result)
    })
  })
}

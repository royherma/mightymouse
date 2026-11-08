import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { PATHS } from '../store/paths'
import { transcribe, transcribeDraft } from './whisper'

/**
 * The segmented-listen core: one VAD-bounded speech segment in, one transcript
 * out. Extracted from `live-listen.ts` so more than one feature can consume the
 * same loop — Live Companion (transcript → LLM → speak) and hands-free
 * dictation (transcript → paste at the cursor) are consumers #1 and #2.
 *
 * What this module deliberately does NOT own: the mic and the segment
 * boundaries. Those live in a renderer (`useVoiceActivity.ts`) because vad-web
 * needs a DOM `getUserMedia` + `AudioWorklet`, and a main-process VAD would
 * mean hand-rolling `onnxruntime-node` — the same native-ABI risk class as the
 * `better-sqlite3` codesign scar. A consumer supplies a host renderer; this
 * module starts where the finished WAV arrives.
 */

export interface SegmentTranscript {
  ok: boolean
  text: string
  wordCount: number
  /** ms spent in transcribe() only (excludes the temp-file write). */
  tookMs: number
  error?: string
}

/** Where per-segment temp wavs land — swept by the existing tmp cleanup (paths.ts). */
function segmentWavPath(stamp: string): string {
  return join(PATHS.TMP, `segment-${stamp}.wav`)
}

/**
 * Transcribe one already-segmented turn. `wavBytes` is a complete WAV file
 * (header included) as produced by vad-web's `utils.encodeWAV` in the
 * renderer — writing it verbatim is all that's needed, no re-encoding.
 *
 * Runs the SAME `transcribe()` the push-to-talk hotkey and the phone use, so
 * every dictation path reports a comparable `tookMs`.
 */
export async function transcribeSegment(wavBytes: Uint8Array): Promise<SegmentTranscript> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const wavPath = segmentWavPath(stamp)

  try {
    mkdirSync(PATHS.TMP, { recursive: true })
    writeFileSync(wavPath, wavBytes)
  } catch (err) {
    return {
      ok: false,
      text: '',
      wordCount: 0,
      tookMs: 0,
      error: `failed to write segment audio: ${String(err)}`
    }
  }

  const outBase = join(PATHS.TMP, `segment-${stamp}`)
  const result = await transcribe(wavPath, outBase)
  const tookMs = result.tookMs

  // Best-effort cleanup of the segment's wav + transcript txt — single-use
  // scratch files, not a permanent record (unlike listen-recorder.ts's
  // captures/ folder, which the user explicitly asked to save).
  for (const p of [wavPath, `${outBase}.txt`]) {
    try {
      if (existsSync(p)) rmSync(p, { force: true })
    } catch {
      /* best-effort — the tmp sweep (paths.ts cleanupTmp) catches stragglers */
    }
  }

  if (!result.ok) {
    return { ok: false, text: '', wordCount: 0, tookMs, error: result.error }
  }

  return {
    ok: true,
    text: result.text ?? '',
    wordCount: result.wordCount ?? 0,
    tookMs
  }
}

/**
 * Which consumer a WAV arriving over `liveTurnSubmit` belongs to. The host
 * renderer is the same in both cases, so the segment carries its destination
 * rather than the IPC channel implying it.
 */
export const SEGMENT_CONSUMER = {
  /** Live Voice Companion: transcript → LLM → spoken reply. */
  companion: 'companion',
  /** Hands-free dictation: transcript → paste at the cursor. */
  handsFree: 'handsFree'
} as const
export type SegmentConsumer = (typeof SEGMENT_CONSUMER)[keyof typeof SEGMENT_CONSUMER]

export async function transcribeDraftSegment(wavBytes: Uint8Array): Promise<string> {
  const stamp = `draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const wavPath = segmentWavPath(stamp)
  const outBase = join(PATHS.TMP, `segment-${stamp}`)
  try {
    mkdirSync(PATHS.TMP, { recursive: true })
    writeFileSync(wavPath, wavBytes)
    return await transcribeDraft(wavPath, outBase)
  } catch {
    return ''
  } finally {
    for (const p of [wavPath, `${outBase}.txt`]) rmSync(p, { force: true })
  }
}

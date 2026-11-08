// audio-transcribe.ts — the audio pre-step. NO backend (claude / codex CLI, the
// Anthropic Messages API behind mightymouse) can ingest raw audio: the API has only
// text / image / document content blocks, and codex's only attach flag is `-i`
// (images). Verified against each backend's real surface. So an attached audio file
// is transcribed to TEXT here, BEFORE any adapter runs, and folded into the prompt —
// the same Whisper path the listen feature already uses.
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { CONFIG } from '../../shared/config'
import { SETTINGS } from '../store/settings'
import { PATHS } from '../store/paths'
import { transcribe } from '../capture/whisper'
import type { MediaAttachment } from '../../shared/types'

// whisper-cli wants 16kHz mono PCM WAV. An attachment can be any format (m4a, mp3,
// wav), so we always normalize through ffmpeg first into a per-call tmp WAV.
function toWav(ffmpeg: string, src: string, dst: string): Promise<boolean> {
  return new Promise((resolve) => {
    const args = ['-y', '-i', src, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', dst]
    execFile(ffmpeg, args, { timeout: CONFIG.AUDIO_TRANSCODE_TIMEOUT_MS }, (err) => {
      resolve(!err && existsSync(dst))
    })
  })
}

function baseName(p: string): string {
  const slash = p.lastIndexOf('/')
  return slash !== -1 ? p.slice(slash + 1) : p
}

/**
 * Transcribe every audio attachment to text. Returns a single block to append to
 * the user prompt (each clip fenced by its filename), or '' when there are no audio
 * attachments. A failed transcription degrades to a one-line note for that clip —
 * never throws, never blocks the run. Audio attachments are consumed here; the
 * caller passes ONLY the non-audio attachments on to the backend.
 */
export async function transcribeAttachments(
  attachments: readonly MediaAttachment[]
): Promise<string> {
  const audio = attachments.filter((a) => a.kind === 'audio')
  if (audio.length === 0) return ''

  const ffmpeg = SETTINGS.get().ffmpegPath
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const parts: string[] = []

  for (let i = 0; i < audio.length; i++) {
    const a = audio[i]
    const name = a.name && a.name !== '' ? a.name : baseName(a.path)
    if (!existsSync(a.path) || !existsSync(ffmpeg)) {
      parts.push(`--- audio: ${name} (couldn't transcribe — file or ffmpeg missing) ---`)
      continue
    }
    const wav = join(PATHS.TMP, `attach-audio-${stamp}-${i}.wav`)
    const outBase = join(PATHS.TMP, `attach-audio-${stamp}-${i}`)
    const ok = await toWav(ffmpeg, a.path, wav)
    if (!ok) {
      parts.push(`--- audio: ${name} (couldn't decode audio) ---`)
      continue
    }
    const res = await transcribe(wav, outBase)
    if (res.ok && res.text) {
      parts.push(`--- audio transcript: ${name} ---\n${res.text}\n--- end ${name} ---`)
    } else {
      parts.push(`--- audio: ${name} (transcription produced no text) ---`)
    }
  }

  return `\n\n${parts.join('\n\n')}`
}

import { execFile } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { SETTINGS } from '../store/settings'
import { PATHS } from '../store/paths'
import { CONFIG } from '../../shared/config'
import type { TranscribeEngineRan } from '../../shared/types'
import { parakeetCanTranscribe } from '../../shared/whisper-languages'
import { formatTranscript } from '../../shared/transcript-format'
import { englishWhisperModelPath, whisperModelFor, whisperModelPathFor } from './binaries'
import { isParakeetServerReady, parakeetServerUrl } from './parakeet-server'

export interface TranscribeResult {
  ok: boolean
  transcriptPath?: string
  text?: string
  /** Whitespace-split word count of the transcript (0 on failure/empty). */
  wordCount?: number
  /**
   * Wall-clock ms spent inside whisper-cli. Set on EVERY outcome including
   * failure/timeout — a 60s timeout is the most interesting latency datapoint
   * there is, so returning 0 for it would hide the worst cases. Callers feed
   * this to `listen_completed.transcribe_ms`; measuring it here rather than at
   * each call site means the number means the same thing everywhere.
   */
  tookMs: number
  /** Which engine produced this result. Set on EVERY outcome: without it a
   *  transcribe_ms in analytics is unattributable and a regression cannot be
   *  told from a silent fallback to the slower engine. */
  engine?: TranscribeEngineRan
  /** True when parakeet was tried, failed, and whisper produced this instead. */
  fellBack?: boolean
  error?: string
}

/** Count words in a transcript. Whisper emits markers like [BLANK_AUDIO] for
 *  silence — those aren't spoken words, so they don't count. */
export function countWords(text: string): number {
  const cleaned = text.replace(/\[[A-Z_]+\]/g, ' ').trim()
  if (!cleaned) return 0
  return cleaned.split(/\s+/).filter(Boolean).length
}

/**
 * Real-time factor for `listen_completed.rtf`: processing ms ÷ audio ms. Lives
 * here so the Mac and phone call sites can't drift on the zero-guard or the
 * rounding. 3 decimals keeps resolution at the fast end (0.08 vs 0.2 is a real
 * difference) without pretending to sub-millisecond precision.
 */
export function rtfOf(processingMs: number, durationS: number): number {
  if (durationS <= 0) return 0
  return Math.round((processingMs / (durationS * 1000)) * 1000) / 1000
}

/**
 * Transcribe a wav file with whisper-cli (whisper.cpp). Writes <outBase>.txt.
 * Returns the transcript text on success.
 */
// What base.en actually emits for a non-Latin script (verified against Hebrew
// and Japanese: both landed exactly "(speaking in foreign language)"). This
// catches only half the failure — Spanish through base.en comes back as garbled
// phonetic Spanish with no marker at all, which is why the picker exists.
const FOREIGN_SPEECH_MARKER = /[([]\s*(speaks?|speaking)\s+in\s+(a\s+)?foreign\s+language\s*[)\]]/i

/**
 * Parakeet's turn: 2.8x faster than whisper turbo, but only for the 25
 * languages it knows and only when NVIDIA's engine actually unpacked.
 */
function parakeetEligible(lang: string): { bin: string; model: string } | null {
  const s = SETTINGS.get()
  if ((s.transcribeEngine ?? 'parakeet') !== 'parakeet') return null
  if (!parakeetCanTranscribe(lang)) return null
  const bin = join(PATHS.BIN, CONFIG.PARAKEET_BIN_SUBPATH)
  const model = whisperModelPathFor(CONFIG.PARAKEET_MODEL_NAME)
  if (!existsSync(bin) || !existsSync(model)) return null
  return { bin, model }
}

// The resident server already holds the model, so this skips the process +
// dylib + 680 MB load the CLI re-pays per clip. Callers read transcriptPath off
// disk (capture/index.ts:328), so the .txt is written here exactly as the CLI
// would have.
async function transcribeViaServer(
  wavPath: string,
  outBase: string,
  lang: string
): Promise<TranscribeResult> {
  const startedAt = Date.now()
  const txtPath = `${outBase}.txt`
  try {
    const form = new FormData()
    form.append('file', new Blob([readFileSync(wavPath)]), 'audio.wav')
    form.append('language', lang)
    const res = await fetch(`${parakeetServerUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(60_000)
    })
    const tookMs = Date.now() - startedAt
    if (!res.ok) {
      return { ok: false, tookMs, engine: 'parakeet', error: `server HTTP ${res.status}` }
    }
    const body = (await res.json()) as { text?: string }
    const text = (body.text ?? '').trim()
    if (!text) {
      return { ok: false, tookMs, engine: 'parakeet', error: 'server produced no text' }
    }
    writeFileSync(txtPath, text, 'utf-8')
    return {
      ok: true,
      tookMs,
      engine: 'parakeet',
      transcriptPath: txtPath,
      text,
      wordCount: countWords(text)
    }
  } catch (err) {
    return {
      ok: false,
      tookMs: Date.now() - startedAt,
      engine: 'parakeet',
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

function transcribeWithParakeet(
  engine: { bin: string; model: string },
  wavPath: string,
  outBase: string
): Promise<TranscribeResult> {
  return new Promise((resolve) => {
    // -o is the LITERAL output path — unlike whisper's -of, which appends .txt.
    // Passing outBase here writes a file with no extension that nothing reads.
    const txtPath = `${outBase}.txt`
    const args = [
      'transcribe',
      wavPath,
      '--model',
      engine.model,
      '--no-warmup',
      '-l',
      SETTINGS.get().whisperLang || CONFIG.WHISPER_LANG,
      '-o',
      txtPath,
      '--force'
    ]
    // Metal only exists on Apple Silicon; NVIDIA's x86_64 build is CPU-only and
    // rejects the flag.
    if (process.platform === 'darwin' && process.arch === 'arm64') {
      args.push('--device', 'metal')
    }
    const startedAt = Date.now()
    execFile(engine.bin, args, { timeout: 60_000 }, (err) => {
      const tookMs = Date.now() - startedAt
      if (err) return resolve({ ok: false, tookMs, engine: 'parakeet', error: err.message })
      let text = ''
      try {
        text = readFileSync(txtPath, 'utf-8').trim()
      } catch {
        // Unreadable output is the same outcome as empty: whisper gets the clip.
      }
      if (!text)
        return resolve({ ok: false, tookMs, engine: 'parakeet', error: 'parakeet produced no text' })
      resolve({
        ok: true,
        tookMs,
        engine: 'parakeet',
        transcriptPath: txtPath,
        text,
        wordCount: countWords(text)
      })
    })
  })
}

// Live words while the user is still talking: server only, never the CLI or whisper fallback.
export async function transcribeDraft(wavPath: string, outBase: string): Promise<string> {
  if (!isParakeetServerReady()) return ''
  const lang = SETTINGS.get().whisperLang || CONFIG.WHISPER_LANG
  if (!parakeetEligible(lang)) return ''
  const res = await transcribeViaServer(wavPath, outBase, lang)
  return res.ok ? (res.text ?? '').trim() : ''
}

export async function transcribe(wavPath: string, outBase: string): Promise<TranscribeResult> {
  const res = await transcribeVerbatim(wavPath, outBase)
  if (!res.ok || !res.text) return res
  const s = SETTINGS.get()
  const text = formatTranscript(res.text, s.whisperLang || CONFIG.WHISPER_LANG, s.transcriptFormats)
  if (text === res.text) return res
  if (res.transcriptPath) writeFileSync(res.transcriptPath, text, 'utf-8')
  return { ...res, text, wordCount: countWords(text) }
}

async function transcribeVerbatim(wavPath: string, outBase: string): Promise<TranscribeResult> {
  const lang = SETTINGS.get().whisperLang || CONFIG.WHISPER_LANG
  const engine = parakeetEligible(lang)
  if (engine) {
    // Server first, then the CLI on the same model, then whisper. A server that
    // died mid-session must not demote the user to whisper while a working
    // parakeet binary sits on disk.
    let fast = isParakeetServerReady()
      ? await transcribeViaServer(wavPath, outBase, lang)
      : await transcribeWithParakeet(engine, wavPath, outBase)
    if (!fast.ok && isParakeetServerReady()) {
      console.error(`[transcribe] parakeet server failed, retrying on the CLI: ${fast.error}`)
      fast = await transcribeWithParakeet(engine, wavPath, outBase)
    }
    if (fast.ok) return fast
    // The user asked for words, not for a report on which engine we tried.
    // Whisper gets the same clip and the reason is logged, never shown.
    console.error(`[transcribe] parakeet failed, falling back to whisper: ${fast.error}`)
    const slow = await transcribeWithWhisper(wavPath, outBase)
    return { ...slow, fellBack: true }
  }
  return transcribeWithWhisper(wavPath, outBase)
}

// A freshly downloaded whisper-cli takes ~12s on its first run (0.4s after), measured 2026-09-30.
export function warmWhisper(): Promise<void> {
  const wav = join(tmpdir(), 'mm-whisper-warm.wav')
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + 32000, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16000, 24)
  header.writeUInt32LE(32000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(32000, 40)
  writeFileSync(wav, Buffer.concat([header, Buffer.alloc(32000)]))
  const args = ['-m', englishWhisperModelPath(), '-f', wav, '-nt', '-np']
  return new Promise((resolve) => {
    execFile(SETTINGS.get().whisperPath, args, { timeout: 60_000 }, () => resolve())
  })
}

function transcribeWithWhisper(wavPath: string, outBase: string): Promise<TranscribeResult> {
  return new Promise((resolve) => {
    const s = SETTINGS.get()
    // Pre-flight failures never reached whisper, so they report 0ms rather than
    // a misleading few-microsecond "transcription time".
    if (!existsSync(s.whisperPath)) {
      return resolve({
        ok: false,
        tookMs: 0,
        engine: 'whisper',
        error: `whisper-cli not found at ${s.whisperPath}`
      })
    }
    // Resolve from the language, not the stored path: picking a non-English
    // language switches models, and the stored path still points at base.en.
    const lang = s.whisperLang || CONFIG.WHISPER_LANG
    const modelPath =
      lang === 'en' ? englishWhisperModelPath() : whisperModelPathFor(whisperModelFor(lang))
    if (!existsSync(modelPath)) {
      return resolve({ ok: false, tookMs: 0, engine: 'whisper', error: `model not found at ${modelPath}` })
    }
    if (!existsSync(wavPath)) {
      return resolve({ ok: false, tookMs: 0, engine: 'whisper', error: `audio not found at ${wavPath}` })
    }

    // NO -nt (--no-timestamps): it only strips timestamps from STDOUT, and on the
    // -otxt path it collapses the file to the LAST segment — a 16s clip landed as
    // the single word "and". The .txt writer never emits timestamps anyway, so the
    // flag bought nothing and silently truncated every multi-segment capture.
    const args = ['-m', modelPath, '-f', wavPath, '-otxt', '-of', outBase, '-l', lang]

    // 60s ceiling: base.en transcribes any app-length recording well under this.
    // A corrupted wav or wedged model load would otherwise hang the HUD; on
    // timeout execFile SIGKILLs the child and the err branch surfaces a failure.
    const startedAt = Date.now()
    execFile(s.whisperPath, args, { timeout: 60_000 }, (err) => {
      const tookMs = Date.now() - startedAt
      const txtPath = `${outBase}.txt`
      if (err && !existsSync(txtPath)) {
        return resolve({ ok: false, tookMs, engine: 'whisper', error: err.message })
      }
      let text = ''
      try {
        text = readFileSync(txtPath, 'utf-8').trim()
      } catch {
        // No transcript file: the empty-text path below reports it.
      }
      // An .en model given non-English speech never errors — it emits this
      // bracketed marker, or English-shaped nonsense. Pasting either into the
      // user's document is worse than saying nothing, so we point at the fix.
      if (lang === 'en' && FOREIGN_SPEECH_MARKER.test(text)) {
        return resolve({
          ok: false,
          tookMs,
          engine: 'whisper',
          transcriptPath: txtPath,
          error: CONFIG.CAPTURE_ERROR.wrongLanguage
        })
      }
      resolve({
        ok: true,
        tookMs,
        engine: 'whisper',
        transcriptPath: txtPath,
        text,
        wordCount: countWords(text)
      })
    })
  })
}

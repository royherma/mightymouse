import { execFile } from 'node:child_process'
import { readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { envVar, devLog } from '../../shared/env'
import { CONFIG } from '../../shared/config'
import { isKokoroAvailable, kokoroPython } from './ensure-kokoro'
import type { SpokenWord } from '../../shared/types'
import { PREFS } from '../store/prefs'

/**
 * Live Voice Companion — SpeechOutput adapter (Phase 2 of the design,
 *
 * ElevenLabs Flash v2.5 request -> audio bytes. This is a narrow request/response
 * adapter, NOT a BACKENDS entry (adapters.ts) — TTS isn't an LLM backend, it's an
 * output stage, per the design's explicit call ("new src/main/audio/tts.ts module").
 *
 * Playback lives in the renderer (the companion window), not here: the Electron
 * MAIN process has no audio-output device to write PCM to (see sound-window.ts's
 * module doc for the same constraint — that's why UI sounds play via a hidden
 * renderer window, not a main-process audio lib). `speak()` returns the raw audio
 * bytes; the caller (companion-orchestrator.ts) ships them to the companion
 * renderer over IPC, which plays them with a real <audio>/Web Audio element and
 * derives the RMS-driven mouth-openness signal FROM that live playback.
 *
 * Graceful no-key fallback (hard project rule): if ELEVENLABS_API_KEY isn't set,
 * speak() falls back to a FREE, offline voice (no key, no cost, no network)
 * instead of going silent — so the companion always talks out of the box. Four
 * rungs, first match wins:
 *
 *   1. ElevenLabs — a key is set. They paid; nothing overrides it.
 *   2. Kokoro 82M — opt-in download, enabled, Apple Silicon. Free and human-sounding.
 *   3. macOS `say` — darwin. The zero-download floor. Robotic but always there.
 *   4. silent — caption only (non-mac, or `say` itself failed).
 *
 * Every rung below the top exists because the one above it can be absent, and each
 * failure falls DOWN the ladder rather than out of it. Never throws, never
 * fabricates or hardcodes a key.
 */

/** Which concrete TTS provider produced (or didn't produce) an audio result —
 *  matches the `provider` free-text field on CompanionStageEvent. */
export const TTS_PROVIDER = {
  elevenlabs: 'elevenlabs',
  /** Kokoro 82M via MLX — free, offline, opt-in download, Apple Silicon only.
   *  Outranks `say` when installed; never outranks a paid ElevenLabs key. */
  kokoro: 'kokoro',
  /** Free/offline macOS `say` — the default voice when no ElevenLabs key is set. */
  macosSay: 'macos-say',
  /** `say` failed or isn't available (non-mac) AND no key — caption-only fallback. */
  silent: 'silent-no-key'
} as const

export type TtsProvider = (typeof TTS_PROVIDER)[keyof typeof TTS_PROVIDER]

export interface SpeakResult {
  /** Raw encoded audio bytes (mp3), or null when TTS produced no audio (no key,
   *  empty text, or a request failure — all graceful, never thrown). */
  audio: Uint8Array | null
  /** MIME type for the bytes above, for the renderer's <audio> src blob. */
  mimeType: string
  provider: TtsProvider
  /** Real per-word timings, present ONLY on the Kokoro rung — it's the one
   *  provider here that computes them (its pipeline stamps every token). Absent
   *  for `say` and ElevenLabs, so every consumer must treat highlighting as an
   *  enhancement that may not be available, never as guaranteed. */
  words?: SpokenWord[]
  /** Set only on a real request failure (network/HTTP error), not on the
   *  no-key/no-op path — that one is expected, silent-by-design behavior. */
  error?: string
}

const ELEVENLABS_MIME = 'audio/mpeg'

/** One-time warn so a whole live session doesn't spam the console on every turn. */
let warnedNoKey = false

/** Read the configured ElevenLabs key. Env var only for now — no Settings-stored
 *  key exists yet (settings.ts today holds only local tool paths/devices; adding a
 *  secret field there is a separate, deliberate decision, not implied by this
 *  phase). Never logged, never echoed — read to use only. */
function readApiKey(): string {
  return envVar('ELEVENLABS_API_KEY') ?? ''
}

/** True when a real ElevenLabs call would be attempted (key present). */
export function isTtsConfigured(): boolean {
  return readApiKey() !== ''
}

/** Which provider `speak()` will attempt, for the orchestrator's up-front 'start'
 *  stage-event label (before the request resolves). First match wins:
 *    1. ElevenLabs — a key is set (they paid for it; don't override)
 *    2. Kokoro — installed AND enabled AND Apple Silicon
 *    3. macOS `say` — darwin, the zero-download floor
 *    4. silent — caption only
 *  With Kokoro not installed, this returns exactly what it returned before the
 *  rung existed. That equivalence is asserted in __tests__/tts-kokoro.test.ts. */
export function resolvedTtsProvider(): TtsProvider {
  if (isTtsConfigured()) return TTS_PROVIDER.elevenlabs
  if (isKokoroEnabled() && isKokoroAvailable()) return TTS_PROVIDER.kokoro
  return process.platform === 'darwin' ? TTS_PROVIDER.macosSay : TTS_PROVIDER.silent
}

const SAY_MIME = CONFIG.COMPANION.SAY_MIME

/**
 * Free/offline TTS via macOS `say` → 16-bit PCM WAV bytes. No key, no network,
 * no cost — the default voice whenever ElevenLabs isn't configured. Writes to a
 * temp WAV (say has no stdout pipe for audio), reads it back, deletes it. NEVER
 * throws — any failure (non-mac, say missing, exec error) resolves to a
 * null-audio result so the companion degrades to caption-only.
 */
async function speakWithSay(text: string): Promise<SpeakResult> {
  if (process.platform !== 'darwin') {
    return { audio: null, mimeType: SAY_MIME, provider: TTS_PROVIDER.silent }
  }
  // Unique temp path per call so overlapping turns can't clobber each other's
  // file. process.hrtime is monotonic (no Date.now/random dependency).
  const out = join(tmpdir(), `mm-say-${process.pid}-${process.hrtime.bigint()}.wav`)
  const args = [
    '--file-format=WAVE',
    `--data-format=${CONFIG.COMPANION.SAY_DATA_FORMAT}`,
    '-r',
    String(CONFIG.COMPANION.SAY_RATE),
    ...(CONFIG.COMPANION.SAY_VOICE ? ['-v', CONFIG.COMPANION.SAY_VOICE] : []),
    '-o',
    out,
    text
  ]
  try {
    await new Promise<void>((resolve, reject) => {
      execFile('say', args, { timeout: CONFIG.COMPANION.ASK_TIMEOUT_MS }, (err) =>
        err ? reject(err) : resolve()
      )
    })
    const buf = await readFile(out)
    return { audio: new Uint8Array(buf), mimeType: SAY_MIME, provider: TTS_PROVIDER.macosSay }
  } catch (err) {
    return {
      audio: null,
      mimeType: SAY_MIME,
      provider: TTS_PROVIDER.macosSay,
      error: err instanceof Error ? err.message : String(err)
    }
  } finally {
    unlink(out).catch(() => {})
  }
}

const KOKORO_MIME = CONFIG.COMPANION.KOKORO_MIME

/** Where the timestamp-emitting script sits, in dev and in a packaged build —
 *  mirrors phone-remote's resolvePublicDir(), the same asar problem: a spawned
 *  script has to exist as a real file on disk, so it ships via extraResources. */
function kokoroSpeakScript(): string {
  if (!app.isPackaged) return join(app.getAppPath(), 'resources', KOKORO_SPEAK_SCRIPT)
  return join(dirname(app.getPath('exe')), '..', 'Resources', KOKORO_SPEAK_SCRIPT)
}

const KOKORO_SPEAK_SCRIPT = 'kokoro-speak.py'

/** Word timings off the script's stdout. Never throws: highlighting is an
 *  enhancement, so malformed output costs the highlight, not the audio. */
function parseSpokenWords(stdout: string): SpokenWord[] | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout.trim())
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const { words } = parsed as { words?: unknown }
    if (!Array.isArray(words)) return undefined
    const clean = words.filter(
      (x): x is SpokenWord =>
        typeof x?.w === 'string' && typeof x?.s === 'number' && typeof x?.e === 'number'
    )
    return clean.length > 0 ? clean : undefined
  } catch {
    return undefined
  }
}

/** Whether the user has switched the Kokoro voice on. Separate from "is it
 *  installed" so the toggle can kill the rung without deleting 350MB. */
function isKokoroEnabled(): boolean {
  return PREFS.getKokoroEnabled()
}

/**
 * Free/offline TTS via Kokoro 82M (MLX) → WAV bytes. Apache 2.0, no key, no
 * network, no cost — and unlike `say` it sounds like a person.
 *
 * Spawns the CLI per call, which reloads the 82M model every time: measured ~5.1s
 * for 6s of audio on an M1 Max (26 Jul 2026). That is the cost of process
 * isolation in v1; a resident warm process is the known optimization if this
 * latency proves unacceptable in real use.
 *
 * NEVER throws. Every failure path — not installed, spawn error, timeout, missing
 * output file — resolves by delegating to `speakWithSay()`, so a broken Kokoro
 * install degrades to the robotic-but-reliable floor instead of going silent.
 */
async function speakWithKokoro(text: string): Promise<SpeakResult> {
  const python = kokoroPython()
  if (!python) return speakWithSay(text)

  // hrtime is monotonic (no Date.now/random dependency, matching speakWithSay's
  // temp-path scheme), so overlapping turns can't clobber each other's file.
  const out = join(tmpdir(), `mm-kokoro-${process.pid}-${process.hrtime.bigint()}.wav`)
  const args = [
    kokoroSpeakScript(),
    CONFIG.COMPANION.KOKORO_MODEL_REPO,
    CONFIG.COMPANION.KOKORO_VOICE,
    CONFIG.COMPANION.KOKORO_LANG_CODE,
    out
  ]

  try {
    // Text goes over stdin, never argv: a long reply would blow the arg limit,
    // and the script's own contract reads it from there.
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        python,
        args,
        { timeout: CONFIG.COMPANION.KOKORO_TIMEOUT_MS },
        (err, sout) => (err ? reject(err) : resolve(sout))
      )
      child.stdin?.end(text)
    })
    const buf = await readFile(out)
    return {
      audio: new Uint8Array(buf),
      mimeType: KOKORO_MIME,
      provider: TTS_PROVIDER.kokoro,
      words: parseSpokenWords(stdout)
    }
  } catch (err) {
    // Fall through to `say` rather than surfacing an error: the user asked for a
    // voice, and the floor still has one.
    devLog.warn(
      `[tts] kokoro failed, falling back to \`say\`: ${err instanceof Error ? err.message : String(err)}`
    )
    return speakWithSay(text)
  } finally {
    unlink(out).catch(() => {})
  }
}

export async function speakLocal(text: string): Promise<SpeakResult> {
  if (!text.trim()) return { audio: null, mimeType: SAY_MIME, provider: TTS_PROVIDER.silent }
  return isKokoroEnabled() && isKokoroAvailable() ? speakWithKokoro(text.trim()) : speakWithSay(text.trim())
}

/**
 * Speak `text` via ElevenLabs Flash v2.5 (per the design's TTS choice — official
 * ~75ms generation latency claim, §5 Phase 2). Returns the encoded mp3 bytes, or
 * a null-audio SpeakResult when:
 *   - no key is configured (silent/mock mode — the one no-throw contract this
 *     adapter must honor per the project's secrets rule), or
 *   - the text is empty, or
 *   - the HTTP request itself fails (network error, non-2xx) — also graceful,
 *     but flagged via `error` so the orchestrator's stage event can show it.
 * NEVER throws — every failure path resolves to a null-audio result so a flaky
 * TTS call can't crash the companion's live-turn pipeline.
 */
export async function speak(text: string): Promise<SpeakResult> {
  const trimmed = text.trim()
  if (trimmed === '') {
    return { audio: null, mimeType: ELEVENLABS_MIME, provider: TTS_PROVIDER.silent }
  }

  const apiKey = readApiKey()
  if (apiKey === '') {
    // Free/offline tiers, best first: Kokoro if the user installed + enabled it,
    // else macOS `say`. Either way the mouse still speaks with no key and no cost.
    if (isKokoroEnabled() && isKokoroAvailable()) return speakWithKokoro(trimmed)

    if (!warnedNoKey) {
      warnedNoKey = true
      devLog.warn(
        '[tts] ELEVENLABS_API_KEY not set — Live Voice Companion using free macOS `say` voice (no key needed). Install the Kokoro voice in Settings for a natural one, or set a key for ElevenLabs quality.'
      )
    }
    return speakWithSay(trimmed)
  }

  const voiceId = CONFIG.COMPANION.ELEVENLABS_VOICE_ID
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': apiKey,
        Accept: 'audio/mpeg'
      },
      body: JSON.stringify({
        text: trimmed,
        model_id: CONFIG.COMPANION.ELEVENLABS_MODEL_ID
      })
    })

    if (!resp.ok) {
      let detail = ''
      try {
        detail = (await resp.text()).slice(0, 200)
      } catch {
        /* best-effort */
      }
      return {
        audio: null,
        mimeType: ELEVENLABS_MIME,
        provider: TTS_PROVIDER.elevenlabs,
        error: `elevenlabs http ${resp.status}${detail ? `: ${detail}` : ''}`
      }
    }

    const buf = await resp.arrayBuffer()
    return { audio: new Uint8Array(buf), mimeType: ELEVENLABS_MIME, provider: TTS_PROVIDER.elevenlabs }
  } catch (err) {
    return {
      audio: null,
      mimeType: ELEVENLABS_MIME,
      provider: TTS_PROVIDER.elevenlabs,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

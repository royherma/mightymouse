import { useEffect, useRef, useState } from 'react'
import { MicVAD, utils as vadUtils } from '@ricky0123/vad-web'
import { CONFIG } from '../../../shared/config'
// Resolve onnxruntime-web's wasm backend files straight from the installed
// package as Vite-served module URLs (`?url`). This is the ONLY reliable way in
// an electron-vite renderer: ORT loads its backend via a dynamic `import()` of
// the `.mjs` glue, and Vite REFUSES to module-serve a file under `public/`
// (it appends `?import`, then 500s "should not be imported from source code").
// So the old `public/vad/*.mjs` copy could be fetched as a plain asset but
// NEVER imported as a module → `no available backend found`. Importing from
// node_modules here lets Vite serve them as real modules in dev and emit hashed
// assets in the packaged build, and guarantees the wasm matches the exact ORT
// version @ricky0123/vad-web resolves at runtime (pinned to 1.27.0 via the
// package.json `overrides`) — no manual public/ copy to drift out of sync.
// Imported from a local src/ asset dir (NOT node_modules directly): ORT's
// package.json `exports` map doesn't expose ./dist/*, so a bare
// `onnxruntime-web/dist/...?url` import is rejected ("Missing specifier"). These
// two files are copied byte-for-byte from onnxruntime-web@1.27.0's dist by
// scripts/sync-vad-assets.mjs (postinstall) so they can't drift from the
// resolved package version.
import ortWasmUrl from '../vad-assets/ort-wasm-simd-threaded.wasm?url'
import ortMjsUrl from '../vad-assets/ort-wasm-simd-threaded.mjs?url'

/** This hook's fixed identity on the `voice-input` stage of the companion
 *  debug panel (see companion-debug.ts) — there's only ever one VAD adapter. */
const STAGE_PROVIDER = 'vad-web'

/**
 * Live Voice Companion — Phase 1 of the PRD
 * (prds/active/2026-07-12-1783824131-live-voice-companion.md §5, §6
 * `VoiceInputSource`). Wraps `@ricky0123/vad-web`'s `MicVAD` (Silero VAD over
 * ONNX-web + AudioWorklet) to turn a raw mic stream into speech SEGMENTS —
 * "here's one utterance's worth of audio" — firing a callback once per
 * silence-terminated segment.
 *
 * Runs entirely in the RENDERER by design (see the PRD's reality-check table):
 * `@ricky0123/vad-node` is dead, so a main-process VAD means hand-rolling
 * `onnxruntime-node` — same native-binary ABI risk class as the
 * `better-sqlite3` codesign scar. `vad-web` needs a DOM `getUserMedia` +
 * `AudioWorklet`, both renderer-only, so this hook is the seam: it owns the mic
 * + VAD lifecycle and ships each finished segment out over IPC (see
 * `CompanionApp.tsx` / `live-listen.ts`) rather than doing anything with the
 * audio itself.
 *
 * Model + onnxruntime-web wasm assets are bundled as static files under
 * `src/renderer/public/vad/` (Vite serves `public/*` at the app root in both
 * dev and the packaged build — same convention as `public/mediapipe-wasm/` for
 * gaze) so `baseAssetPath`/`onnxWASMBasePath` never depend on a CDN fetch.
 */

/** Where the bundled VAD assets live, relative to the renderer's served root. */
const VAD_ASSET_PATH = '/vad/'

/**
 * Segment-boundary tuning. vad-web's defaults (positive 0.3 / negative 0.25 /
 * redemption 1400ms) never closed a segment in a real room: ambient noise holds
 * Silero's score above 0.25, so the redemption counter resets every frame and
 * `onSpeechEnd` never fires. Symptom is a companion stuck on "listening"
 * forever — 5 speech starts, 0 ends in the dev log.
 *
 * Widening the gap between the two thresholds is the fix: enter on confident
 * speech, exit as soon as it's merely ambiguous, rather than requiring near
 * silence.
 */
const VAD_TUNING = {
  /** Enter speech only on a confident frame — suppresses keyboard/fan starts. */
  positiveSpeechThreshold: 0.5,
  /** Exit well above the noise floor. The default 0.25 sat under typical room
   *  tone, which is what wedged the segment open. */
  negativeSpeechThreshold: 0.35,
  /** Silence needed to call the utterance done. 1400ms felt like a hang and
   *  gave noise 1.4s of chances to re-trigger; ~700ms still clears a
   *  mid-sentence breath. */
  redemptionMs: 700,
  /** Floor for "that was a real utterance", not a cough. */
  minSpeechMs: 250,
  /** Leading audio kept before speech-start so whisper doesn't lose the first
   *  consonant. */
  preSpeechPadMs: 500
} as const

export interface VoiceActivitySegment {
  /** Raw mono float32 samples at 16kHz (vad-web's fixed output rate) — ready
   *  to hand straight to whisper.cpp without resampling on the main side. */
  audio: Float32Array
  /** Wall-clock ms the segment took from speech-start to speech-end. */
  durationMs: number
}

export interface UseVoiceActivityResult {
  /** True once MicVAD has started listening (mic granted, model loaded). */
  active: boolean
  /** True while the VAD currently believes speech is in progress (drives the
   *  companion's `listening` state). */
  speaking: boolean
  /** Set once if mic permission is denied or the model fails to load; the
   *  caller degrades to "no live mode" rather than crashing. */
  error: string | null
}

/**
 * Start/stop a continuous VAD session tied to `enabled`. Calls `onSegment`
 * once per completed speech segment (silence-terminated, not misfired — see
 * vad-web's `onSpeechEnd` vs `onVADMisfire`). `onSpeechStart`/`onSpeechEnd`
 * (mapped to `speaking`) are ALSO exposed as state so the caller can drive
 * "listening" UI the instant speech begins, before the segment is even final.
 */
export function useVoiceActivity(
  enabled: boolean,
  onSegment: (segment: VoiceActivitySegment) => void,
  onDraft?: (audio: Float32Array) => void
): UseVoiceActivityResult {
  const [active, setActive] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Latest onSegment without re-creating the VAD session on every render —
  // MicVAD.new() spins up a mic stream + AudioWorklet, too heavy to redo per keystroke.
  const onSegmentRef = useRef(onSegment)
  onSegmentRef.current = onSegment
  const onDraftRef = useRef(onDraft)
  useEffect(() => {
    onDraftRef.current = onDraft
  }, [onDraft])

  useEffect(() => {
    if (!enabled) {
      setActive(false)
      setSpeaking(false)
      return
    }

    let vad: MicVAD | null = null
    let disposed = false
    const startedAt = Date.now()
    const padFrames: Float32Array[] = []
    let spoken: Float32Array[] | null = null
    let lastDraftAt = 0
    const endDraft = (): void => {
      spoken = null
    }

    window.api.companionStageEventReport({
      stage: 'voice-input',
      provider: STAGE_PROVIDER,
      state: 'start',
      ts: startedAt
    })

    MicVAD.new({
      // The Silero .onnx model IS still loaded by a plain fetch from public/vad/
      // (baseAssetPath) — that path works because it's a normal asset fetch, not
      // a dynamic module import. Only ORT's wasm/mjs glue needed the ?url fix.
      baseAssetPath: VAD_ASSET_PATH,
      // Explicit segment boundaries — the package defaults never close a
      // segment in a real room. See VAD_TUNING.
      ...VAD_TUNING,
      // Force single-threaded WASM: multi-threading needs crossOriginIsolated
      // (COOP/COEP headers) to get a SharedArrayBuffer, which this Electron
      // renderer doesn't set.
      ortConfig: (ort) => {
        ort.env.wasm.numThreads = 1
        // Point ORT at the Vite-resolved module URLs (imported above) instead
        // of a base path into public/. The object form of wasmPaths overrides
        // the .wasm and .mjs files individually with absolute served URLs.
        ort.env.wasm.wasmPaths = { wasm: ortWasmUrl, mjs: ortMjsUrl }
      },
      onFrameProcessed: (_probs, frame) => {
        if (disposed || !onDraftRef.current) return
        if (!spoken) {
          padFrames.push(frame)
          if (padFrames.length * frame.length > (VAD_TUNING.preSpeechPadMs / 1000) * 16000) padFrames.shift()
          return
        }
        spoken.push(frame)
        const now = Date.now()
        if (now - lastDraftAt < CONFIG.COMPANION.DRAFT_EVERY_MS) return
        lastDraftAt = now
        const total = spoken.reduce((n, f) => n + f.length, 0)
        const audio = new Float32Array(total)
        let at = 0
        for (const f of spoken) {
          audio.set(f, at)
          at += f.length
        }
        onDraftRef.current(audio)
      },
      onSpeechStart: () => {
        if (disposed) return
        setSpeaking(true)
        spoken = [...padFrames]
        lastDraftAt = Date.now()
      },
      onVADMisfire: () => {
        if (disposed) return
        endDraft()
        // Speech looked like it started but was too short to count — back to idle.
        setSpeaking(false)
        // Surfaced because a misfire and a wedged-open segment look identical
        // from the UI (both sit on "listening"), and only this tells them apart.
        window.api.companionStageEventReport({
          stage: 'voice-input',
          provider: STAGE_PROVIDER,
          state: 'error',
          detail: 'segment too short (VAD misfire)',
          ts: Date.now()
        })
      },
      onSpeechEnd: (audio: Float32Array) => {
        if (disposed) return
        endDraft()
        setSpeaking(false)
        const durationMs = Math.round((audio.length / 16000) * 1000)
        // Proves the segment actually CLOSED. Its absence — speech-start with no
        // matching end — is the exact signature of the stuck-listening bug that
        // VAD_TUNING fixes, so it has to be observable in the debug panel.
        window.api.companionStageEventReport({
          stage: 'voice-input',
          provider: STAGE_PROVIDER,
          state: 'ok',
          tookMs: durationMs,
          detail: `segment ${durationMs}ms`,
          ts: Date.now()
        })
        onSegmentRef.current({ audio, durationMs })
      }
    })
      .then((instance) => {
        if (disposed) {
          instance.destroy().catch(() => {})
          return
        }
        vad = instance
        vad.start()
        setActive(true)
        window.api.companionStageEventReport({
          stage: 'voice-input',
          provider: STAGE_PROVIDER,
          state: 'ok',
          tookMs: Date.now() - startedAt,
          ts: Date.now()
        })
      })
      .catch((err) => {
        if (disposed) return
        const message = err instanceof Error ? err.message : 'Failed to start voice activity detection'
        // eslint-disable-next-line no-console -- only signal that surfaces the
        // real ORT/model-load exception; the debug panel only gets the message.
        console.error('[useVoiceActivity] MicVAD.new failed:', err)
        setError(message)
        window.api.companionStageEventReport({
          stage: 'voice-input',
          provider: STAGE_PROVIDER,
          state: 'error',
          tookMs: Date.now() - startedAt,
          detail: message,
          ts: Date.now()
        })
      })

    return () => {
      disposed = true
      setActive(false)
      setSpeaking(false)
      vad?.destroy().catch(() => {})
    }
  }, [enabled])

  return { active, speaking, error }
}

/** Re-exported so callers can encode a segment to WAV bytes for IPC transfer
 *  without importing the vad-web package directly (keeps the dependency
 *  surface at one seam). */
export const encodeVoiceSegmentToWav = vadUtils.encodeWAV

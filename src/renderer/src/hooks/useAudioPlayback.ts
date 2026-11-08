import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Live Voice Companion — Phase 2 of the PRD
 * (prds/active/2026-07-12-1783824131-live-voice-companion.md §5, §6
 * `CharacterRenderer`'s mouth-openness input). Plays one TTS clip's raw
 * encoded bytes (mp3, from `src/main/audio/tts.ts` via `LiveTurnResult.audio`)
 * through a real `<audio>` element, and taps its output with a Web Audio
 * AnalyserNode to derive a live 0..1 "mouth openness" value from the actual
 * playback amplitude — the Live2D-style "RMS → ParamMouthOpenY" pattern the
 * PRD's §3 non-goals call for (no viseme set, just amplitude).
 *
 * Mirrors `useMicLevel.ts`'s AnalyserNode + rAF-loop shape, but taps an
 * `<audio>` element's OWN output (via `createMediaElementSource`) instead of
 * a mic input stream — this is a playback tap, not a mic tap. `mouthOpen` is
 * consumed by both WebGL renderers (MouseCharacter's jaw scale, WarpCharacter's
 * jaw warp band) and displayed live in CompanionDebugPanel; the `talking` state
 * itself is driven by the element's real play/pause/ended events, not a fixed
 * timer, so the companion's "talking" window always matches the audio duration.
 */
export interface UseAudioPlaybackResult {
  /** True while the current clip is actively playing. */
  playing: boolean
  /** Live 0..1 mouth-openness, updated ~20fps via React state (cheap enough
   *  for a CSS-driven mouth; a Phase 3 r3f loop should read `mouthOpenRef`
   *  directly at 60fps instead of re-rendering on this). */
  mouthOpen: number
  mouthOpenRef: React.RefObject<number>
  /** Decode + play `bytes` as `mimeType`. Replaces any clip already playing.
   *  No-ops (resolves immediately) on empty/zero-length bytes. */
  play: (bytes: Uint8Array, mimeType: string) => void
  /** Stop playback immediately (e.g. Live mode toggled off mid-reply). */
  stop: () => void
  position: () => { t: number; d: number } | null
}

/** How often the mouthOpen React state re-renders (ms) — matches useMicLevel's
 *  ~15-20fps cadence, plenty smooth for a CSS transform, far cheaper than 60fps. */
const EMIT_INTERVAL_MS = 50

/** Called once when a clip finishes (or is stopped) so the caller can settle
 *  the companion state back to idle without its own timer. */
export function useAudioPlayback(onEnded?: () => void): UseAudioPlaybackResult {
  const [playing, setPlaying] = useState(false)
  const [mouthOpen, setMouthOpen] = useState(0)
  const mouthOpenRef = useRef(0)

  const audioElRef = useRef<HTMLAudioElement | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const bufRef = useRef<Uint8Array<ArrayBuffer> | null>(null)
  const rafRef = useRef(0)
  const urlRef = useRef<string | null>(null)
  const onEndedRef = useRef(onEnded)
  onEndedRef.current = onEnded

  const revokeUrl = (): void => {
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
    }
  }

  const settle = useCallback((): void => {
    setPlaying(false)
    mouthOpenRef.current = 0
    setMouthOpen(0)
    cancelAnimationFrame(rafRef.current)
    onEndedRef.current?.()
  }, [])

  const stop = useCallback((): void => {
    const el = audioElRef.current
    if (el) {
      el.pause()
      el.src = ''
    }
    revokeUrl()
    settle()
  }, [settle])

  const play = useCallback(
    (bytes: Uint8Array, mimeType: string): void => {
      if (!bytes || bytes.byteLength === 0) return

      // Lazily build the audio graph ONCE and reuse it across clips — Web
      // Audio contexts are a finite, semi-expensive resource; re-creating one
      // per turn would leak on a long live session.
      if (!audioElRef.current) {
        const el = new Audio()
        el.autoplay = false
        audioElRef.current = el
      }
      if (!audioCtxRef.current) {
        const AudioCtx = window.AudioContext
        const ctx = new AudioCtx()
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 512
        // A media-element source can only be created ONCE per element (a
        // second call throws "already connected") — safe here since the
        // element itself is created exactly once, above.
        ctx.createMediaElementSource(audioElRef.current).connect(analyser)
        analyser.connect(ctx.destination)
        audioCtxRef.current = ctx
        analyserRef.current = analyser
        bufRef.current = new Uint8Array(new ArrayBuffer(analyser.fftSize))
      }

      const el = audioElRef.current
      const analyser = analyserRef.current
      const buf = bufRef.current
      if (!analyser || !buf) return

      revokeUrl()
      // Copy into a fresh Uint8Array so Blob gets a real, tightly-sized
      // ArrayBuffer — `bytes.buffer` is typed as ArrayBuffer|SharedArrayBuffer
      // (structured-clone over IPC can't guarantee which), and Blob only
      // accepts the former. `.slice()` on the Uint8Array view copies into a
      // plain owned buffer regardless of the source's backing type.
      const ab = bytes.slice().buffer
      const url = URL.createObjectURL(new Blob([ab], { type: mimeType }))
      urlRef.current = url
      el.src = url

      let lastEmit = 0
      const tick = (t: number): void => {
        if (el.paused || el.ended) return
        analyser.getByteTimeDomainData(buf)
        let sum = 0
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128
          sum += v * v
        }
        const rms = Math.sqrt(sum / buf.length)
        // Speech RMS on played-back TTS audio tends to peak well under 1.0 —
        // a modest fixed gain (not a rolling AGC like useMicLevel; a single
        // synthesized voice doesn't need per-room normalization) keeps the
        // mouth visibly moving without a full auto-gain rig Phase 3 doesn't
        // need yet. Phase 3 can retune/replace this once a real rig exists.
        const open = Math.max(0, Math.min(1, rms * 6))
        mouthOpenRef.current = open
        if (t - lastEmit > EMIT_INTERVAL_MS) {
          lastEmit = t
          setMouthOpen(open)
        }
        rafRef.current = requestAnimationFrame(tick)
      }

      // resume() handles the (rare, here) autoplay-policy-suspended case —
      // this audio context is only ever created in response to a user having
      // already granted mic access for Live mode, so suspension shouldn't
      // normally happen, but resume() is a harmless no-op if already running.
      void audioCtxRef.current.resume()
      void el.play().then(() => {
        setPlaying(true)
        rafRef.current = requestAnimationFrame(tick)
      }).catch(() => {
        // Playback failed (e.g. a corrupt/partial clip) — settle to idle
        // rather than leave the companion stuck showing "talking" forever.
        settle()
      })

      el.onended = () => {
        revokeUrl()
        settle()
      }
    },
    [settle]
  )

  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafRef.current)
      audioElRef.current?.pause()
      revokeUrl()
      audioCtxRef.current?.close().catch(() => {})
    }
  }, [])

  const position = useCallback((): { t: number; d: number } | null => {
    const el = audioElRef.current
    return el && !el.paused ? { t: el.currentTime, d: Number.isFinite(el.duration) ? el.duration : 0 } : null
  }, [])

  return { playing, mouthOpen, mouthOpenRef, play, stop, position }
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { MicVAD } from '@ricky0123/vad-web'
import { CONFIG } from '@shared/config'
import { padChunkCount, segmentOutcome, shouldStartUtterance } from './hands-free-rules'
// ORT loads its glue by dynamic module import, which a base path into public/
// cannot satisfy — the same trap already documented in useVoiceActivity.ts.
import ortWasmUrl from './vad-assets/ort-wasm-simd-threaded.wasm?url'
import ortMjsUrl from './vad-assets/ort-wasm-simd-threaded.mjs?url'

/**
 * Hands-free dictation: hold one mic stream open, let a Silero VAD cut it into
 * utterances, and hand each finished utterance to `onSegment` as a webm/opus
 * Blob — the exact shape `sendClip` already ships for a press-and-hold
 * recording. The Mac side is untouched: the blob arrives on the existing
 * `audioMeta` + binary path and pastes at the cursor like any held recording.
 *
 * Two rules this hook exists to enforce, both learned the hard way elsewhere in
 * this directory:
 *
 * 1. ONE getUserMedia for the whole armed session. A second call re-prompts on
 *    iOS Safari and can interrupt the live recording (see MicWaveform.tsx), so
 *    the VAD and every per-utterance MediaRecorder share this hook's stream and
 *    nothing stops its tracks until disarm.
 * 2. One recorder runs CONTINUOUSLY; each utterance is cut from its chunk
 *    buffer. Started per-utterance instead, speech-start loses the word that
 *    triggered it — the VAD needs ~200-500ms to fire, so it is already past.
 */

const TUNING = CONFIG.PHONE_REMOTE.HANDS_FREE_VAD

/** Rolling-buffer granularity. The pad can only be honored to the nearest chunk,
 *  so this is the error bar on `preSpeechPadMs` — small enough to be inaudible,
 *  large enough that a long session isn't thousands of blobs. */
const HANDS_FREE_CHUNK_MS = 100

export interface HandsFreeSegment {
  blob: Blob
  durationMs: number
}

export interface UseHandsFreeMicOptions {
  /** Live arm state. False tears the whole session down, mic included. */
  armed: boolean
  /** One finished utterance, ready for sendClip. Never called for a segment
   *  under MIN_RECORDING_MS — a cough is dropped before it costs a whisper hop. */
  onSegment: (segment: HandsFreeSegment) => void
  /** Diagnostics to the Mac's connection journal (`make phone-log`). Segment
   *  boundaries are invisible on the glass, so this is the only way to tell
   *  "the VAD never fired" from "it fired and the send failed". */
  log?: (line: string) => void
}

export interface UseHandsFreeMicResult {
  /** True once the mic is open and the VAD is running — arming has a visible
   *  delay while ~13MB of ORT wasm loads, so this drives a "starting" state
   *  rather than letting the UI look hung. */
  ready: boolean
  /** True while the VAD believes speech is in progress. */
  speaking: boolean
  /** Set if mic permission is denied or the model fails to load. */
  error: string | null
  /**
   * Suspend the VAD's auto-stop for a deliberate press-and-hold, so a manual
   * hold and the VAD never race to stop one recorder. Returns the
   * shared stream when hands-free owns the mic, so the caller records on it
   * instead of opening a second one; null when not armed.
   */
  beginManualHold: () => MediaStream | null
  /** Resume VAD-driven segmentation after a manual hold ends. */
  endManualHold: () => void
  /** The live shared stream, or null when not armed. Callers must not stop its
   *  tracks — disarm owns that. Clone before handing it to anything that does. */
  getSharedStream: () => MediaStream | null
}

export function useHandsFreeMic({ armed, onSegment, log }: UseHandsFreeMicOptions): UseHandsFreeMicResult {
  const [ready, setReady] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Latest callbacks without re-creating the VAD session on every render:
  // MicVAD.new() opens a mic and loads a model, far too heavy to redo per render.
  const onSegmentRef = useRef(onSegment)
  onSegmentRef.current = onSegment
  const logRef = useRef(log)
  logRef.current = log

  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  /** Chunk 0, held OUT of `chunksRef` so the trim can never reach it: it carries
   *  the WebM header, and a cut without it is a blob ffmpeg refuses. */
  const headerChunkRef = useRef<Blob | null>(null)
  /** Each chunk's end, ms since the recorder started, index-aligned to
   *  `chunksRef` — the clock `padChunkCount` cuts against. */
  const chunkEndsAtRef = useRef<number[]>([])
  const recorderStartedAtRef = useRef(0)
  const startedAtRef = useRef(0)
  /** Index into `chunksRef` where the live utterance begins, or -1 between
   *  utterances. Set at speech-start by reaching back over the pad. */
  const utteranceFromRef = useRef(-1)
  // While true the VAD's speech-end must not stop the recorder — a user-driven
  // hold owns it, and whoever started the recording is the only one allowed to
  // stop it. Reset by endManualHold, and by teardown so an interrupted hold
  // can't wedge the next armed session.
  const manualHoldRef = useRef(false)

  const beginManualHold = useCallback((): MediaStream | null => {
    if (!streamRef.current) return null
    manualHoldRef.current = true
    // A VAD segment already in flight is abandoned, not sent: the user's hold
    // is the newer intent, and its recording covers the same audio.
    stopRecorder({ discard: true })
    return streamRef.current
  }, [])

  const endManualHold = useCallback((): void => {
    manualHoldRef.current = false
  }, [])

  const getSharedStream = useCallback((): MediaStream | null => streamRef.current, [])

  // Declared as hoisted functions so beginManualHold above can call them without
  // a ref dance — they close over refs only, never state.

  /** Close out the utterance in flight. The recorder itself keeps running: it is
   *  the rolling buffer every later utterance is cut from, so stopping it here
   *  is what used to cost the next utterance its head. */
  function stopRecorder({ discard }: { discard: boolean }): void {
    const from = utteranceFromRef.current
    utteranceFromRef.current = -1
    if (from < 0) return
    const chunks = chunksRef.current.slice(from)
    const durationMs = Date.now() - startedAtRef.current
    if (discard) return
    const outcome = segmentOutcome({ chunkCount: chunks.length, durationMs })
    if (outcome === 'drop-empty') return
    if (outcome === 'drop-short') {
      logRef.current?.(`handsfree segment dropped ${durationMs}ms (under min)`)
      return
    }
    const header = headerChunkRef.current
    if (!header) {
      logRef.current?.(`handsfree segment dropped ${durationMs}ms (no header chunk yet)`)
      return
    }
    logRef.current?.(`handsfree segment ${durationMs}ms chunks=${chunks.length}`)
    onSegmentRef.current({ blob: new Blob([header, ...chunks], { type: 'audio/webm' }), durationMs })
  }

  /** Stop the continuous recorder outright — disarm and teardown only. */
  function stopContinuousRecorder(): void {
    const rec = recorderRef.current
    recorderRef.current = null
    utteranceFromRef.current = -1
    chunksRef.current = []
    chunkEndsAtRef.current = []
    // A header describes only the recorder that emitted it.
    headerChunkRef.current = null
    if (!rec || rec.state === 'inactive') return
    rec.ondataavailable = null
    rec.stop()
  }

  useEffect(() => {
    if (!armed) {
      setReady(false)
      setSpeaking(false)
      return
    }

    let vad: MicVAD | null = null
    let stream: MediaStream | null = null
    let disposed = false
    setError(null)

    /** Start the one recorder that runs for the whole armed session. Its chunks
     *  are the rolling buffer; nothing is sent until an utterance is cut. */
    const startContinuousRecorder = (live: MediaStream): void => {
      chunksRef.current = []
      chunkEndsAtRef.current = []
      headerChunkRef.current = null
      utteranceFromRef.current = -1
      recorderStartedAtRef.current = Date.now()
      const rec = new MediaRecorder(live, { mimeType: 'audio/webm;codecs=opus' })
      recorderRef.current = rec
      rec.ondataavailable = (e) => {
        if (!e.data || e.data.size === 0) return
        // Held aside, not buffered — the trim below may discard anything it sees.
        if (!headerChunkRef.current) {
          headerChunkRef.current = e.data
          return
        }
        chunksRef.current.push(e.data)
        chunkEndsAtRef.current.push(Date.now() - recorderStartedAtRef.current)
        // Between utterances only the pad is worth keeping. Trimming from the
        // front would invalidate every index, so it only happens while idle.
        if (utteranceFromRef.current < 0) {
          const keep = padChunkCount({
            chunkEndsAt: chunkEndsAtRef.current,
            speechStartedAt: Date.now() - recorderStartedAtRef.current,
            padMs: TUNING.preSpeechPadMs
          })
          const drop = chunksRef.current.length - keep
          if (drop > 0) {
            chunksRef.current = chunksRef.current.slice(drop)
            chunkEndsAtRef.current = chunkEndsAtRef.current.slice(drop)
          }
        }
      }
      rec.start(HANDS_FREE_CHUNK_MS)
    }

    const startUtterance = (): void => {
      const live = stream
      if (!live) return
      if (!shouldStartUtterance({ disposed, hasStream: true, manualHold: manualHoldRef.current })) return
      // Already inside an utterance — a second speech-start without an
      // intervening end would otherwise move the cut forward and lose the head.
      if (utteranceFromRef.current >= 0) return
      const speechStartedAt = Date.now() - recorderStartedAtRef.current
      const keep = padChunkCount({
        chunkEndsAt: chunkEndsAtRef.current,
        speechStartedAt,
        padMs: TUNING.preSpeechPadMs
      })
      // Reach BACK over the pad: this is the whole fix. The word that triggered
      // the VAD is already in these chunks.
      utteranceFromRef.current = Math.max(0, chunksRef.current.length - keep)
      startedAtRef.current = Date.now()
    }

    navigator.mediaDevices
      ?.getUserMedia({ audio: true })
      .then((s) => {
        if (disposed) {
          s.getTracks().forEach((tr) => tr.stop())
          return
        }
        stream = s
        streamRef.current = s
        logRef.current?.(`handsfree mic open label="${s.getAudioTracks()[0]?.label ?? 'unknown'}"`)
        // Before the VAD exists: the buffer must already be filling when the
        // first speech-start fires, or the first utterance has no pad to reach.
        startContinuousRecorder(s)
        return MicVAD.new({
          // Hand MicVAD the stream we already opened instead of letting it call
          // getUserMedia itself — that second call is what re-prompts on iOS and
          // can interrupt the live recording. This is the whole
          // one-stream-two-consumers rule, and `getStream` is the only seam
          // vad-web offers for it.
          getStream: () => Promise.resolve(s),
          // Ours to close, not vad-web's: the teardown below stops the tracks
          // exactly once, at disarm. Pausing must leave the stream hot or the
          // next utterance has no mic.
          pauseStream: () => Promise.resolve(),
          resumeStream: () => Promise.resolve(s),
          // The .onnx model + worklet stay plain fetches from public/vad/ —
          // those are asset fetches, not module imports, so a base path works.
          baseAssetPath: CONFIG.PHONE_REMOTE.HANDS_FREE_ASSET_PATH,
          ...TUNING,
          // Single-threaded WASM: multi-threading needs crossOriginIsolated
          // (COOP/COEP) for a SharedArrayBuffer, which this page doesn't set.
          ortConfig: (ort) => {
            ort.env.wasm.numThreads = 1
            // Object form overrides the two files individually with served
            // URLs; a base path leaves the dynamic import unresolved.
            ort.env.wasm.wasmPaths = { wasm: ortWasmUrl, mjs: ortMjsUrl }
          },
          onSpeechStart: () => {
            if (disposed) return
            setSpeaking(true)
            startUtterance()
          },
          onVADMisfire: () => {
            if (disposed) return
            setSpeaking(false)
            // Too short to be speech — throw the recording away rather than
            // paying a whisper hop on a cough.
            stopRecorder({ discard: true })
          },
          onSpeechEnd: () => {
            if (disposed) return
            setSpeaking(false)
            // vad-web's own float32 audio is deliberately ignored: the Mac's
            // path wants MediaRecorder's webm/opus, which we already captured.
            stopRecorder({ discard: false })
          }
        })
      })
      .then((instance) => {
        if (!instance) return
        if (disposed) {
          void instance.destroy()
          return
        }
        vad = instance
        vad.start()
        setReady(true)
        logRef.current?.('handsfree vad started')
      })
      .catch((err: unknown) => {
        if (disposed) return
        const name = err instanceof Error ? err.name : ''
        const denied = name === 'NotAllowedError' || name === 'SecurityError'
        const message = denied
          ? 'Microphone access needed'
          : err instanceof Error
            ? err.message
            : 'Could not start hands-free'
        setError(message)
        logRef.current?.(`handsfree start failed name=${name || 'unknown'} msg=${message}`)
      })

    return () => {
      disposed = true
      setReady(false)
      setSpeaking(false)
      manualHoldRef.current = false
      // Abandon any utterance in flight — disarm means stop, not send — then
      // stop the continuous recorder itself, which only teardown may do.
      stopRecorder({ discard: true })
      stopContinuousRecorder()
      void vad?.destroy()
      // The one place tracks are stopped. Anywhere else and the next utterance
      // has no mic and iOS re-prompts.
      stream?.getTracks().forEach((tr) => tr.stop())
      streamRef.current = null
      logRef.current?.('handsfree disarmed')
    }
  }, [armed])

  return { ready, speaking, error, beginManualHold, endManualHold, getSharedStream }
}

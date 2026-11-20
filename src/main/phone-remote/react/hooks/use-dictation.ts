import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { CONFIG } from '@shared/config'
import type { DictationEntry } from '@shared/phone-remote-protocol'
import type { PhoneAudioDestination } from '@shared/types'
import { PHONE_AUDIO_TO } from '@shared/types'
import type { SocketBus } from '../socket-bus'
import { handsFreeDisplay, longPressArmAction, micOpenTimedOut, staysArmed, type HandsFreeDisplay } from '../hands-free-rules'
import { readRms } from '../MicWaveform'
import { toastForRunDone, clipPhoneTextFailedCopy } from '../history-failure'
import { useHandsFreeMic, type UseHandsFreeMicResult } from '../useHandsFreeMic'
import { subscribeNativeIntent, nativeBridge, nativeMicLevel, setNativeMicClaim } from '../native-bridge'
import { useDelayedFlag } from '../useDelayedFlag'
import { useRecordingElapsed } from '../use-recording-elapsed'
import { findMicNodes, micDestinationOf, sameMicNodes } from '../mic-nodes'
import {
  micChromeIsInert,
  micChromeVisible,
  micIgnoreStopTap,
  type MicSidePressKind
} from '../mic-latch-chrome'
import {
  micTraceInertStamp,
  micTraceLeftover,
  micTraceNativeStopped,
  micTraceStop
} from '../mic-trace'
import { hapticTick } from '../haptics'
import { syncMicSourceToNative } from '../mic-source'
import { acquireScreenWakeLock, releaseScreenWakeLock } from '../screen-wake-lock'
import type { UseConnectionResult } from './use-connection'

// Mirrors CONFIG.PHONE_REMOTE.MIN_RECORDING_MS -- reject a too-short hold
// client-side before ever opening a WS binary frame.
const MIN_RECORDING_MS = 300
const MIC_HOLD_THRESHOLD_MS = 500
const MIC_OPEN_TIMEOUT_MS = 6000
// Long-press ARMS hands-free — but only a SILENT hold: speaking during the hold
// marks the press a dictation and the arm stands down, so this never competes
// with press-to-talk on timing (a shared 500ms threshold ate every dictation).
const HANDS_FREE_LONG_PRESS_MS = 1200
// Speech RMS on a phone mic lands ~0.02-0.15 (see MicWaveform's gain note);
// room tone sits under this floor.
const HANDS_FREE_ARM_SILENCE_RMS = 0.02
// Two consecutive samples over the floor = voice; one alone is the tap's thump.
const HANDS_FREE_VOICE_POLL_MS = 100
const HANDS_FREE_ARM_RECHECK_MS = 150
const TRANSCRIBE_HINT_DELAY_MS = 1000
function newClipId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

type MicState = 'idle' | 'opening' | 'recording' | 'toggled'

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

interface UseDictationArgs {
  bus: SocketBus
  send: UseConnectionResult['send']
  sendBinary: UseConnectionResult['sendBinary']
  showToast: (
    text: string,
    historyId?: string | null,
    persist?: boolean,
    failed?: boolean,
    offline?: boolean
  ) => void
  setStatus: (status: string) => void
  connectedRef: React.RefObject<boolean>
  connState: UseConnectionResult['connState']
  chatOpen: boolean
  remoteLog: (message: string) => void
  closeAppSwitcher: () => void
  setChatDictating: (value: boolean) => void
  onRunDone: () => void
  schedulePhoneTextWatchdog: () => void
}

/** Owns phone dictation recording, transcription, and history state. */
export function useDictation({
  bus,
  send,
  sendBinary,
  showToast,
  setStatus,
  connectedRef,
  connState,
  chatOpen,
  remoteLog,
  closeAppSwitcher,
  setChatDictating,
  onRunDone,
  schedulePhoneTextWatchdog
}: UseDictationArgs) {
  const [recording, setRecording] = useState(false)
  const [recordingTo, setRecordingTo] = useState<PhoneAudioDestination>(PHONE_AUDIO_TO.paste)
  // Finger is off after a tap-latch -- Cancel/Stop stay hidden during a hold.
  const [micLatched, setMicLatched] = useState(false)
  const [micLabel, setMicLabel] = useState('Recording…')
  // Run history. Page 0 is pushed by the Mac on connect and after each run, so
  // opening the sheet is instant; later pages are pulled on demand.
  const [historyOpen, setHistoryOpen] = useState(false)
  // Which row to glow when the sheet opens from a toast tap. Cleared once the
  // sheet closes so it doesn't relight on the next unrelated open.
  const [highlightHistoryId, setHighlightHistoryId] = useState<string | null>(null)
  useEffect(() => {
    if (!historyOpen) setHighlightHistoryId(null)
  }, [historyOpen])
  const [dictations, setDictations] = useState<DictationEntry[]>([])
  const [historyHasMore, setHistoryHasMore] = useState(false)
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false)
  const [dictating, setDictating] = useState(false)
  // Which of the Mac's stages the clip we're waiting on has reached, so a long
  // transcription shows movement instead of one frozen spinner. null = nothing
  // in flight. Driven entirely by 'transcribeStage' pushes.
  const [transcribeStage, setTranscribeStage] = useState<'received' | 'transcribing' | null>(null)
  const inFlightClipRef = useRef<{
    id: string
    blob: Blob
    durationMs: number
    to: PhoneAudioDestination
  } | null>(null)
  // Mirrors inFlightClipRef into render so the Cancel/Retry affordances can key
  // off it; the ref is what the WS handler (registered once on mount) reads.
  const [inFlightClipId, setInFlightClipId] = useState<string | null>(null)
  // True once a clip has failed retryably and its blob is still in hand -- this
  // is what turns the indicator into a Retry offer rather than a dead spinner.
  const [retryableClip, setRetryableClip] = useState(false)
  // Mirror of `dictations` for the load-more callback: reading length from a ref
  // keeps that callback stable across pages (same pattern as appSwitchOpenRef).
  const dictationsRef = useRef<DictationEntry[]>([])
  dictationsRef.current = dictations
  const nativeStartRecordingRef = useRef<(() => void) | null>(null)
  const nativeStopRecordingRef = useRef<((discard: boolean) => void) | null>(null)
  const remoteLogRef = useRef(remoteLog)
  remoteLogRef.current = remoteLog
  const transcribeTimerRef = useRef<number | null>(null)

  // Hands-free is the only source that can produce a second clip before the
  // first finishes: `sendClip` has ONE in-flight slot, so an overlapping send
  // replaced the pending clip and its own blob read then bailed on the id
  // check -- the Mac got audioMeta, never the audio, and waited forever.
  const handsFreeQueueRef = useRef<{ blob: Blob; durationMs: number }[]>([])
  const sendHandsFreeSegmentRef = useRef<(seg: { blob: Blob; durationMs: number }) => void>(() => {})

  // The ONE place a wait ends, whatever ended it. Every path that stops waiting
  // -- success, failure, cancel, timeout, socket close -- goes through here, so
  // a new exit can't forget one of the things that must be reset.
  const settleClip = useCallback((opts: { keepBlob?: boolean } = {}) => {
    if (transcribeTimerRef.current !== null) {
      window.clearTimeout(transcribeTimerRef.current)
      transcribeTimerRef.current = null
    }
    // Retry needs the blob to survive the failure that prompted it; everything
    // else drops it so a finished recording isn't held in memory.
    if (!opts.keepBlob) inFlightClipRef.current = null
    setRetryableClip(opts.keepBlob === true)
    setInFlightClipId(null)
    setTranscribeStage(null)
    setDictating(false)
    setChatDictating(false)
    // A kept blob still occupies the slot (Retry needs it), so only a real
    // release may start the next hands-free segment.
    if (opts.keepBlob) return
    const next = handsFreeQueueRef.current.shift()
    if (next) sendHandsFreeSegmentRef.current(next)
  }, [])

  // Native queuedClip used to skip this, so TranscribePill never appeared.
  const armClipInFlight = useCallback(
    (clip: { id: string; blob: Blob; durationMs: number; to: PhoneAudioDestination }) => {
      inFlightClipRef.current = clip
      setInFlightClipId(clip.id)
      setRetryableClip(false)
      setTranscribeStage(null)
      if (clip.to === PHONE_AUDIO_TO.chat) setChatDictating(true)
      else setDictating(true)
      setStatus(clip.to === PHONE_AUDIO_TO.chat ? 'Transcribing…' : 'Running…')
      if (transcribeTimerRef.current !== null) window.clearTimeout(transcribeTimerRef.current)
      transcribeTimerRef.current = window.setTimeout(() => {
        if (inFlightClipRef.current?.id !== clip.id) return
        setStatus('Live')
        showToast('Transcription timed out - tap Retry')
        settleClip({ keepBlob: true })
      }, CONFIG.PHONE_REMOTE.TRANSCRIBE_TIMEOUT_MS)
    },
    [settleClip, showToast]
  )

  const sendClip = useCallback(
    (clip: { id: string; blob: Blob; durationMs: number; to: PhoneAudioDestination }) => {
      // Refused here as well as on the Mac so the phone -- which still holds the
      // blob and knows the duration -- can say something specific, rather than
      // pushing 50MB up a cellular link to be dropped at the far end.
      if (clip.blob.size > CONFIG.PHONE_REMOTE.MAX_AUDIO_BYTES) {
        showToast('That recording is too long to send')
        settleClip()
        return
      }
      armClipInFlight(clip)
      // Meta first, then the blob: the server pairs them by arrival order.
      // sendBinary reports readiness itself -- no separate pre-check, since the
      // socket can drop between this call and the async blob read below either way.
      send({ type: 'audioMeta', durationMs: clip.durationMs, to: clip.to, id: clip.id })
      void clip.blob.arrayBuffer().then((buf) => {
        // Re-checked after the await -- the socket can close, or the user can
        // cancel, while the blob is being read into an ArrayBuffer.
        // The Mac is already holding this clip's audioMeta, so a silent bail
        // here leaves it waiting on a blob that will never arrive.
        if (inFlightClipRef.current?.id !== clip.id) {
          remoteLogRef.current(`clip abandoned id=${clip.id} bytes=${buf.byteLength} (slot taken)`)
          return
        }
        if (sendBinary(buf)) return
        showToast("Can't reach your Mac - recording kept")
        // keepBlob: the socket is down, not the audio. Reconnect is automatic,
        // so throwing the clip away here would destroy the one thing that makes
        // Retry worth offering once it comes back.
        settleClip({ keepBlob: true })
      })
    },
    [armClipInFlight, send, sendBinary, settleClip, showToast]
  )

  // Tell the Mac to drop the clip, then reset immediately rather than waiting
  // for an ack: the user asked for this to stop, so the UI must stop now even if
  // the socket is slow or already gone.
  const cancelTranscribe = useCallback(() => {
    const clip = inFlightClipRef.current
    if (!clip) return
    send({ type: 'audioCancel', id: clip.id })
    setStatus('Live')
    showToast('Transcription cancelled')
    settleClip()
  }, [send, settleClip, showToast])

  // Re-send the retained blob under a NEW id. New id, not the old one, because
  // the Mac may still be finishing (or cancelling) the original -- reusing it
  // would let a stale stage push settle the retry.
  const retryTranscribe = useCallback(() => {
    const clip = inFlightClipRef.current
    if (!clip) return
    sendClip({ ...clip, id: newClipId() })
  }, [sendClip])

  // "I'm not going to retry that" -- drops the retained blob and takes the
  // failed pill off screen. Without it the only way past a failure would be to
  // retry it, which is a strange thing to force on someone who misspoke.
  const dismissTranscribe = useCallback(() => {
    settleClip()
  }, [settleClip])

  useEffect(() => {
    const unsubscribes = [
      bus.subscribe('runDone', (msg) => {
        setStatus('Live')
        settleClip()
        const done = toastForRunDone(msg)
        showToast(done.text, msg.historyId ?? null, false, done.failed)
        onRunDone()
      }),
      bus.subscribe('transcribeStage', (msg) => {
        // Ignore stages for anything but the clip we're actually waiting on --
        // a cancelled clip's Mac side can still be draining, and its stages
        // would otherwise drive the indicator for the clip that replaced it.
        if (inFlightClipRef.current?.id !== msg.id) return
        // null reads as "Uploading…", so 'done' holds 'transcribing' until runDone settles.
        if (msg.stage === 'done') return
        setTranscribeStage(msg.stage)
        setStatus(msg.stage === 'transcribing' ? 'Transcribing…' : 'Uploading…')
      }),
      bus.subscribe('transcribeFailed', (msg) => {
        if (inFlightClipRef.current?.id !== msg.id) return
        setStatus('Live')
        // The blob is retained ONLY when retrying could plausibly work --
        // otherwise the Retry affordance would offer a second identical
        // failure. See the Mac's `retryable` for which is which.
        settleClip({ keepBlob: msg.retryable })
        showToast(msg.retryable ? `${msg.reason} - tap Retry` : msg.reason)
      }),
      bus.subscribe('dictationHistory', (msg) => {
        setDictations((prev) => {
          if (msg.offset === 0) return msg.entries
          const seen = new Set(prev.map((e) => e.id))
          return [...prev, ...msg.entries.filter((e) => !seen.has(e.id))]
        })
        setHistoryHasMore(msg.hasMore)
        setHistoryLoadingMore(false)
      })
    ]
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe())
  }, [bus, onRunDone, settleClip, showToast])

  // Shipped iOS builds only know paste/chat, so a note records as paste and is relabelled on the way out.
  const nativeNoteRef = useRef(false)
  // Same wire contract as sendClip: meta frame, then the blob, never
  // interleaved -- server.ts:1240 resets pending meta before onAudio runs.
  const sendQueuedClip = useCallback(
    (clip: {
      clipId: string
      durationMs: number
      to: PhoneAudioDestination
      audioBase64: string
      phoneText?: string
      macAway?: boolean
    }) => {
      const bytes = base64ToBytes(clip.audioBase64)
      if (bytes.byteLength > CONFIG.PHONE_REMOTE.MAX_AUDIO_BYTES) {
        showToast('That recording is too long to send')
        return
      }
      const audio = bytes.buffer as ArrayBuffer
      const to = nativeNoteRef.current && clip.to === PHONE_AUDIO_TO.paste ? PHONE_AUDIO_TO.note : clip.to
      if (clip.macAway !== true) nativeNoteRef.current = false
      // Late drains are history, not a live wait -- no pill, no Retry blob.
      if (clip.macAway !== true) {
        armClipInFlight({
          id: clip.clipId,
          blob: new Blob([audio]),
          durationMs: clip.durationMs,
          to
        })
      }
      send({
        type: 'audioMeta',
        durationMs: clip.durationMs,
        to,
        id: clip.clipId,
        phoneText: clip.phoneText,
        // Only a clip recorded while the Mac was away is late. A live native
        // recording takes this same route and must still paste.
        queued: clip.macAway === true
      })
      if (sendBinary(audio)) {
        nativeBridge.clipDelivered(clip.clipId)
      } else {
        showToast("Can't reach your Mac - recording kept")
        // Queue still holds the file; don't keepBlob or Retry would double-send.
        if (clip.macAway !== true) settleClip()
      }
    },
    [armClipInFlight, send, sendBinary, settleClip, showToast]
  )

  const [micEls, setMicEls] = useState<HTMLButtonElement[]>([])
  useEffect(() => {
    const found = findMicNodes(document)
    setMicEls((prev) => (sameMicNodes(prev, found) ? prev : found))
  })

  // ── Mic: hold to record, release to send (MediaRecorder, native webm/opus) ──
  const micStateRef = useRef<MicState>('idle')
  const micDownAtRef = useRef(0)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  // The live recording stream, shared with MicWaveform so it can render voice
  // level off the SAME tap MediaRecorder uses -- a second getUserMedia would
  // re-prompt and can interrupt the recording on iOS Safari.
  const micStreamRef = useRef<MediaStream | null>(null)
  const recordedChunksRef = useRef<Blob[]>([])
  const recordStartedAtRef = useRef(0)
  // Set right before mediaRecorder.stop() so its async onstop handler knows
  // whether to send the blob or just throw it away -- read once, then reset,
  // so a later normal stop never accidentally inherits a stale discard flag.
  const discardNextRef = useRef(false)
  // A discard that consumed the gesture (long-press/double-tap arming
  // hands-free) announces nothing: the pill already says what happened, and a
  // "Recording cancelled" toast under it reads as a contradiction.
  const discardSilentRef = useRef(false)
  // Bumped on every startRecording so the mic-open watchdog below only ever
  // resets the attempt IT was armed for -- never a newer one the user
  // started after cancelling the stalled first try.
  const micOpenGenRef = useRef(0)
  const micLatchedAtRef = useRef<number | null>(null)
  const micChromeWasVisibleRef = useRef(false)
  const micDestRef = useRef<PhoneAudioDestination>(PHONE_AUDIO_TO.paste)
  // Filled in once useHandsFreeMic runs below. A ref, not the hook's return
  // value directly, because startRecording is declared above it -- and because
  // rebuilding startRecording whenever the hook's identity changes would
  // rebind every mic listener mid-gesture.
  const handsFreeMicRef = useRef<UseHandsFreeMicResult | null>(null)

  // True while Swift holds the mic instead of MediaRecorder. Not derived from
  // `nativeBridge.available`: a recording that STARTED on the web path must
  // still stop on it, and the shell can't change mid-hold but the branch has to
  // be decided once, at start.
  const nativeCaptureRef = useRef(false)
  // Whether WE asked to throw the clip away, so a `discarded` result can say
  // "cancelled" instead of "hold longer" -- Swift reports one flag for both.
  const nativeDiscardRef = useRef(false)

  // `why` is diagnostic only: a recording ending is indistinguishable in the log
  // from any other, and "it cancelled itself" needs the CALLER, not the effect.
  const stopRecording = useCallback((discard: boolean, silent = false, why = 'unknown') => {
    remoteLogRef.current(
      micTraceStop({
        why,
        discard,
        state: micStateRef.current,
        gen: micOpenGenRef.current,
        inertSince: micLatchedAtRef.current
      })
    )
    micStateRef.current = 'idle'
    setRecording(false)
    setMicLatched(false)
    micLatchedAtRef.current = null
    micOpenGenRef.current++
    if (nativeCaptureRef.current) {
      nativeCaptureRef.current = false
      nativeDiscardRef.current = discard
      discardSilentRef.current = silent
      nativeBridge.nativeMicStop(discard)
      hapticTick()
      return
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      discardNextRef.current = discard
      discardSilentRef.current = silent
      mediaRecorderRef.current.stop()
      // Tick only when a real recording actually ended (send or cancel),
      // not on the state-reset no-op paths.
      hapticTick()
    }
  }, [])

  const latchMic = useCallback(() => {
    micStateRef.current = 'toggled'
    micLatchedAtRef.current = Date.now()
    remoteLogRef.current(micTraceInertStamp('latch'))
    setMicLatched(true)
    setMicLabel('Recording… tap mic to stop')
    setStatus('Recording…')
  }, [])

  const micChromeLive = micChromeVisible(micLatched, recording, chatOpen)

  // Leftover iOS pointer events land when Cancel/Stop mount, not at latchMic.
  // Start the swallow window when the chrome first appears, not at pointerup.
  useLayoutEffect(() => {
    if (micChromeLive && !micChromeWasVisibleRef.current) {
      micLatchedAtRef.current = Date.now()
      remoteLogRef.current(micTraceInertStamp('chrome'))
    }
    micChromeWasVisibleRef.current = micChromeLive
  }, [micChromeLive])

  const micSidePress = useCallback(
    (kind: MicSidePressKind) => {
      if (micChromeIsInert(Date.now(), micLatchedAtRef.current)) {
        remoteLog(
          micTraceLeftover(
            kind === 'cancel' ? 'cancel' : 'stop',
            micStateRef.current,
            micLatchedAtRef.current
          )
        )
        return
      }
      stopRecording(kind === 'cancel', false, kind === 'cancel' ? 'cancel-btn' : 'stop-btn')
    },
    [stopRecording, remoteLog]
  )

  const startRecording = useCallback((to: PhoneAudioDestination = PHONE_AUDIO_TO.paste) => {
    micDestRef.current = to
    setRecordingTo(to)
    // Native shell: hand the mic to Swift. WebKit mutes a getUserMedia track
    // when the app backgrounds, so a recording started here would go silent the
    // moment the phone locks -- which is the whole point of this path. The
    // finished clip comes back through the existing `queuedClip` route, so
    // nothing below this branch has to know it happened.
    if (nativeBridge.available) {
      micStateRef.current = 'opening'
      setStatus('Starting mic…')
      nativeCaptureRef.current = true
      nativeDiscardRef.current = false
      // Stamped on nativeMicStarted, when Swift's recorder actually rolls --
      // not here. An early stamp made hold-release pass JS's 300ms check while
      // Swift still had <300ms (HFP spin-up), which surfaced as "Hold longer".
      recordStartedAtRef.current = 0
      const gen = ++micOpenGenRef.current
      nativeNoteRef.current = to === PHONE_AUDIO_TO.note
      nativeBridge.nativeMicStart(nativeNoteRef.current ? PHONE_AUDIO_TO.paste : to, !connectedRef.current)
      window.setTimeout(() => {
        if (gen !== micOpenGenRef.current) return
        if (!micOpenTimedOut(micStateRef.current)) return
        remoteLogRef.current(`mic stop why=open-timeout state=${micStateRef.current} gen=${gen}`)
        setNativeMicClaim(false)
        nativeCaptureRef.current = false
        micStateRef.current = 'idle'
        setRecording(false)
        micOpenGenRef.current++
        setStatus('Live')
        showToast("Mic didn't start - tap to try again")
      }, MIC_OPEN_TIMEOUT_MS)
      return
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      // Distinct from a user denying the OS prompt: this means the browser
      // never even offered mediaDevices, which only happens on a non-secure
      // origin (http:// on a LAN IP) or a genuinely unsupported browser.
      showToast(window.isSecureContext ? 'Microphone not supported' : 'Needs a secure connection (https)')
      return
    }
    micStateRef.current = 'opening'
    setStatus('Starting mic…')
    const gen = ++micOpenGenRef.current
    // While hands-free owns the mic, a deliberate hold records on ITS stream
    // rather than opening a second one (iOS re-prompts and can interrupt the
    // live recording). beginManualHold also suspends the VAD's auto-stop for
    // the hold's duration, so the two never race to stop one recorder.
    const sharedStream = handsFreeMicRef.current?.beginManualHold() ?? null
    window.setTimeout(() => {
      if (gen !== micOpenGenRef.current) return
      const rec = mediaRecorderRef.current
      if (micStateRef.current === 'idle') return
      if (rec && rec.state === 'recording') return
      remoteLogRef.current(`mic stop why=open-timeout-web state=${micStateRef.current} gen=${gen}`)
      micStateRef.current = 'idle'
      setRecording(false)
      // Same reason as the .catch() below: retire the generation so a
      // pointerup arriving after this reset can't arm 'toggled' over a mic
      // that never opened.
      micOpenGenRef.current++
      setStatus('Live')
      showToast("Mic didn't start - tap to try again")
    }, MIC_OPEN_TIMEOUT_MS)
    ;(sharedStream ? Promise.resolve(sharedStream) : navigator.mediaDevices.getUserMedia({ audio: true }))
      .then((stream) => {
        if (micStateRef.current === 'idle' || gen !== micOpenGenRef.current) {
          // Stopped (toggle-tapped off, or otherwise cancelled) while
          // permission was still resolving -- don't start a recording nobody
          // asked for. A borrowed hands-free stream is never stopped here: it
          // outlives this recording and the next utterance needs it.
          if (!sharedStream) stream.getTracks().forEach((tr) => tr.stop())
          else handsFreeMicRef.current?.endManualHold()
          return
        }
        micStreamRef.current = stream
        recordedChunksRef.current = []
        recordStartedAtRef.current = Date.now()
        const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' })
        mediaRecorderRef.current = mediaRecorder
        mediaRecorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) recordedChunksRef.current.push(e.data)
        }
        stream.getAudioTracks().forEach((tr) => {
          tr.addEventListener('ended', () => {
            remoteLog(
              `mic track ended label="${tr.label}" state=${micStateRef.current} rec=${mediaRecorderRef.current?.state ?? 'none'}`
            )
          })
          tr.addEventListener('mute', () => {
            remoteLog(`mic track mute label="${tr.label}" state=${micStateRef.current}`)
          })
          tr.addEventListener('unmute', () => {
            remoteLog(`mic track unmute label="${tr.label}" state=${micStateRef.current}`)
          })
        })
        mediaRecorder.onerror = () => {
          remoteLog(`mic recorder error state=${micStateRef.current} rec=${mediaRecorder.state}`)
        }
        // Which device actually opened. If a dead tap follows a line whose
        // label names the glasses, the device swap is the trigger.
        remoteLog(`mic open ok label="${stream.getAudioTracks()[0]?.label ?? 'unknown'}"`)
        mediaRecorder.onstop = () => {
          if (sharedStream) {
            // Hands-free owns this stream and keeps it hot for the next
            // utterance -- stopping its tracks here is exactly the bug that
            // makes iOS re-prompt mid-session.
            handsFreeMicRef.current?.endManualHold()
          } else {
            stream.getTracks().forEach((tr) => tr.stop())
            micStreamRef.current = null
          }
          const discard = discardNextRef.current
          discardNextRef.current = false
          const silent = discardSilentRef.current
          discardSilentRef.current = false
          if (discard) {
            if (!silent) showToast('Recording cancelled')
            setStatus('Live')
            return
          }
          const heldMs = Date.now() - recordStartedAtRef.current
          if (heldMs < MIN_RECORDING_MS) {
            showToast('Hold longer')
            setStatus('Live')
            return
          }
          const blob = new Blob(recordedChunksRef.current, { type: 'audio/webm' })
          const to = micDestRef.current
          micDestRef.current = PHONE_AUDIO_TO.paste
          // sendClip owns the meta frame, the blob, the wait flags, the status
          // line and the timeout -- one call so a second caller (Retry) can't
          // reproduce five of those six and quietly miss the last.
          sendClip({ id: newClipId(), blob, durationMs: heldMs, to })
        }
        mediaRecorder.start()
        if (micStateRef.current === 'opening') micStateRef.current = 'recording'
        // "Mic is actually hot now" -- lands after the async open, which is
        // exactly when a visual-only cue is easiest to miss mid-glance.
        hapticTick()
        setRecording(true)
        const label = micStateRef.current === 'toggled' ? 'Recording… tap mic to stop' : 'Recording…'
        setMicLabel(label)
        setStatus(label)
      })
      .catch((err: unknown) => {
        micStateRef.current = 'idle'
        setRecording(false)
        if (sharedStream) handsFreeMicRef.current?.endManualHold()
        // Retire this attempt's generation so a pointerup still in flight (the
        // finger is usually still down on a denied prompt) can't arm 'toggled'
        // over the idle mic it just reset.
        micOpenGenRef.current++
        setStatus('Live')
        const name = err instanceof Error ? err.name : ''
        const denied = name === 'NotAllowedError' || name === 'SecurityError'
        showToast(denied ? 'Microphone access needed' : "Mic unavailable - can't open it")
        if (denied) send({ type: 'micDenied' })
        remoteLog(`mic open failed name=${name || 'unknown'}`)
      })
  }, [sendClip, showToast, remoteLog, send])

  useEffect(() => {
    if (!recording) return
    const startedAt = Date.now()
    const timer = window.setInterval(() => {
      const mins = Math.round((Date.now() - startedAt) / 60000)
      showToast(`Still recording - ${mins} min - tap Stop to send`)
    }, CONFIG.PHONE_REMOTE.RECORDING_REMINDER_MS)
    return () => window.clearInterval(timer)
  }, [recording, showToast])

  // Hold the phone's screen on for as long as a recording is live. The mic here
  // is a getUserMedia track and WebKit mutes it the instant the app backgrounds
  // (see the nativeCaptureRef note above), so a display timeout mid-sentence
  // eats the rest of the dictation with no error to show for it. The re-acquire
  // is not optional: iOS releases the lock whenever the page hides and never
  // restores it, so coming back from a notification would otherwise leave the
  // screen free to sleep again while still recording.
  useEffect(() => {
    if (!recording) return
    void acquireScreenWakeLock()
    const onVis = (): void => {
      if (document.visibilityState === 'visible') void acquireScreenWakeLock()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      void releaseScreenWakeLock()
    }
  }, [recording])

  useEffect(() => {
    const md = navigator.mediaDevices
    if (!md || !md.addEventListener) return
    const onChange = (): void => {
      remoteLog(`mic devicechange state=${micStateRef.current} rec=${mediaRecorderRef.current?.state ?? 'none'}`)
    }
    md.addEventListener('devicechange', onChange)
    return () => md.removeEventListener('devicechange', onChange)
  }, [remoteLog])

  useEffect(() => {
    const onVis = (): void => {
      remoteLog(
        `mic visibility=${document.visibilityState} state=${micStateRef.current} rec=${mediaRecorderRef.current?.state ?? 'none'} tracks=${micStreamRef.current?.getAudioTracks().map((t) => t.readyState).join(',') || 'none'}`
      )
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [remoteLog])

  const micDown = useCallback(
    (to: PhoneAudioDestination = PHONE_AUDIO_TO.paste) => {
      closeAppSwitcher()
      remoteLog(
        `mic down state=${micStateRef.current} rec=${mediaRecorderRef.current?.state ?? 'none'} gen=${micOpenGenRef.current} to=${to}`
      )
      // Stamped on EVERY down (not just the start-recording path) so micUp
      // never computes heldMs against a stale timestamp from an earlier press.
      micDownAtRef.current = Date.now()
      switch (micStateRef.current) {
        case 'toggled':
        case 'recording':
          // Tap while a recording is live (toggle-armed, or a press-to-talk
          // whose release event iOS dropped): stop and send, same as Stop.
          if (micIgnoreStopTap(micStateRef.current, Date.now(), micLatchedAtRef.current)) {
            remoteLogRef.current(
              micTraceLeftover('mic-btn', micStateRef.current, micLatchedAtRef.current)
            )
            return
          }
          stopRecording(false, false, 'tap-while-live')
          return
        case 'opening':
          stopRecording(true, false, 'tap-while-opening')
          setStatus('Live')
          return
        case 'idle':
          startRecording(to)
          return
      }
    },
    [startRecording, stopRecording, closeAppSwitcher]
  )

  // Toggle a recording from a control that has no press-and-hold: the Control
  // Center Record button, or a hold on the trackpad. Goes through micDown so it
  // IS a mic tap -- from 'idle' that opens the mic, and from a live recording it
  // stops and sends, so firing it twice behaves like tapping the mic twice.
  // Latched to 'toggled' (what micUp does on a short tap) because there is no
  // release event coming: nothing is holding a finger down.
  const toggleRecording = useCallback(() => {
    const wasIdle = micStateRef.current === 'idle'
    micDown()
    if (wasIdle) latchMic()
  }, [micDown, latchMic])

  nativeStartRecordingRef.current = toggleRecording

  nativeStopRecordingRef.current = (discard: boolean) => stopRecording(discard, false, 'native-intent')

  const micUp = useCallback(() => {
    // heldMs is logged because which branch runs below is otherwise invisible:
    // a tap under the threshold and a hold that missed it read identically.
    const heldMs = Date.now() - micDownAtRef.current
    remoteLog(
      `mic up state=${micStateRef.current} rec=${mediaRecorderRef.current?.state ?? 'none'} gen=${micOpenGenRef.current} held=${heldMs}ms`
    )
    if (micStateRef.current !== 'opening' && micStateRef.current !== 'recording') return
    // Snapshot the generation this release belongs to. getUserMedia can settle
    // (or be reset by the watchdog) between the top of this function and the
    // 'toggled' write at the bottom, and that write is unconditional.
    const gen = micOpenGenRef.current
    if (heldMs >= MIC_HOLD_THRESHOLD_MS && micStateRef.current === 'recording') {
      const recordedMs =
        recordStartedAtRef.current > 0 ? Date.now() - recordStartedAtRef.current : 0
      if (recordedMs >= MIN_RECORDING_MS) {
        stopRecording(false, false, 'hold-release')
        return
      }
    }
    if (gen !== micOpenGenRef.current) return
    latchMic()
  }, [stopRecording, latchMic])

  // One gate: `handsFreeArmed` says the mode is running. There is no capability
  // flag any more — the gesture IS the entry point, so the mode can never be
  // armed-but-unavailable. A mic merely on still must never auto-paste.
  const [handsFreeArmed, setHandsFreeArmed] = useState(false)
  const handsFreeArmedRef = useRef(false)
  handsFreeArmedRef.current = handsFreeArmed

  sendHandsFreeSegmentRef.current = (seg: { blob: Blob; durationMs: number }) => {
    sendClip({ id: newClipId(), blob: seg.blob, durationMs: seg.durationMs, to: PHONE_AUDIO_TO.paste })
  }

  const onHandsFreeSegment = useCallback(
    (seg: { blob: Blob; durationMs: number }) => {
      if (inFlightClipRef.current) {
        handsFreeQueueRef.current.push(seg)
        remoteLogRef.current(`handsfree queued depth=${handsFreeQueueRef.current.length}`)
        return
      }
      sendHandsFreeSegmentRef.current(seg)
    },
    []
  )

  const handsFreeMic = useHandsFreeMic({
    armed: handsFreeArmed,
    onSegment: onHandsFreeSegment,
    log: remoteLog
  })
  handsFreeMicRef.current = handsFreeMic

  // Every way arming can end, in one gate: the Mac gone, or the mic refused.
  // Both disarm rather than pause.
  useEffect(() => {
    const ok = staysArmed({
      connected: connState.kind === 'connected',
      error: handsFreeMic.error
    })
    if (!ok && handsFreeArmedRef.current) {
      remoteLog(`handsfree disarm reason=gate conn=${connState.kind} err=${handsFreeMic.error ?? 'none'}`)
      setHandsFreeArmed(false)
    }
  }, [connState, handsFreeMic.error, remoteLog])

  useEffect(() => {
    if (handsFreeMic.error) showToast(handsFreeMic.error)
  }, [handsFreeMic.error, showToast])

  const handsFreeState: HandsFreeDisplay = handsFreeDisplay(handsFreeArmed, handsFreeMic.ready)
  // Drives the recording VISUALS only (waveform, label). Deliberately not folded
  // into `recording`: Cancel/Stop call stopRecording(), which owns the
  // press-and-hold recorder, not the VAD's.
  const handsFreeSpeaking = handsFreeArmed && handsFreeMic.speaking

  // MicWaveform polls its ref, so pointing one at the VAD's own stream reuses
  // the recording HUD's meter with no second getUserMedia -- which on iOS
  // Safari would interrupt the capture it is trying to visualise.
  const handsFreeStreamRef = useRef<MediaStream | null>(null)
  handsFreeStreamRef.current = handsFreeSpeaking ? handsFreeMic.getSharedStream() : null

  const disarmHandsFree = useCallback(() => {
    remoteLog('handsfree disarm reason=ui')
    setHandsFreeArmed(false)
  }, [remoteLog])

  useEffect(() => {
    const els = micEls
    // Zero means nothing is listening -- on-device that is indistinguishable
    // from a state machine refusing the tap.
    remoteLog(`mic bind n=${els.length}`)
    if (els.length === 0) return
    let longPressTimer: number | null = null
    // Set by the long-press timer (or the double-tap branch) so the pointerup
    // that follows knows the press was already consumed by arming, and must not
    // also run the mic's normal release path (which would immediately toggle a
    // recording on).
    let armedByThisPress = false
    // Timestamp of the previous pointerdown, for the double-tap gesture.
    let lastDownAt = 0
    // Only a tap that STARTED a recording can be tap 1 of a double-tap. Without
    // this, a tap that stopped a recording (or disarmed) paired with the next
    // tap and armed hands-free — on-device that read as taps doing nothing.
    let lastDownStartedRecording = false

    // Voice tap for the silence-gated arm. Reads the SAME stream MediaRecorder
    // holds (a second getUserMedia re-prompts on iOS); under native capture the
    // level rides the bridge instead.
    let voiceHeard = false
    // Loudest sample of the current press — logged on a stand-down so an arm
    // that never fires says how far off the silence floor it was.
    let peakRms = 0
    let voiceStreak = 0
    let voicePollTimer: number | null = null
    let voiceCtx: AudioContext | null = null
    let voiceAnalyser: AnalyserNode | null = null
    let voiceSource: MediaStreamAudioSourceNode | null = null
    let voiceBuf: Uint8Array<ArrayBuffer> | null = null

    const stopVoicePoll = (): void => {
      if (voicePollTimer !== null) window.clearInterval(voicePollTimer)
      voicePollTimer = null
      voiceStreak = 0
      try {
        voiceSource?.disconnect()
        voiceAnalyser?.disconnect()
        void voiceCtx?.close()
      } catch {
        /* already torn down */
      }
      voiceCtx = null
      voiceAnalyser = null
      voiceSource = null
      voiceBuf = null
    }

    const attachVoiceTap = (stream: MediaStream): void => {
      try {
        const Ctor: typeof AudioContext =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
        voiceCtx = new Ctor()
        // iOS hands back a SUSPENDED context that reads all zeros forever.
        if (voiceCtx.state === 'suspended') void voiceCtx.resume()
        voiceAnalyser = voiceCtx.createAnalyser()
        voiceAnalyser.fftSize = 512
        voiceSource = voiceCtx.createMediaStreamSource(stream)
        voiceSource.connect(voiceAnalyser)
        voiceBuf = new Uint8Array(voiceAnalyser.fftSize)
      } catch {
        // Web Audio blocked: no voice info, so a long hold arms like before.
        voiceAnalyser = null
      }
    }

    const startVoicePoll = (): void => {
      stopVoicePoll()
      voiceHeard = false
      peakRms = 0
      voicePollTimer = window.setInterval(() => {
        // The stream lands async (getUserMedia), so attach late like MicWaveform.
        if (!voiceAnalyser && micStreamRef.current) attachVoiceTap(micStreamRef.current)
        const rms = voiceAnalyser && voiceBuf ? readRms(voiceAnalyser, voiceBuf) : nativeMicLevel()
        if (rms > peakRms) peakRms = rms
        voiceStreak = rms >= HANDS_FREE_ARM_SILENCE_RMS ? voiceStreak + 1 : 0
        if (voiceStreak >= 2) voiceHeard = true
      }, HANDS_FREE_VOICE_POLL_MS)
    }

    const clearLongPress = (): void => {
      if (longPressTimer !== null) window.clearTimeout(longPressTimer)
      longPressTimer = null
      stopVoicePoll()
    }

    /** Both gestures land here so hold and double-tap can never diverge. */
    const arm = (src: 'double-tap' | 'long-press'): void => {
      remoteLog(`handsfree arm src=${src}`)
      // The gesture already started a recording — throw it away rather than
      // pasting the half-second of reaching for the second tap. Silent: the
      // pill announces the arming; a "cancelled" toast would contradict it.
      stopRecording(true, true, `arm-${src}`)
      // Overwrite whatever startRecording left up ('Starting mic…' / 'Recording…')
      // in the same tick it's torn down, so arming reads as one transition
      // rather than a mic that started and died.
      setStatus(CONFIG.UI_LABELS.HANDS_FREE_HUD_STARTING)
      setHandsFreeArmed(true)
      hapticTick()
    }

    function onPointerDown(e: PointerEvent): void {
      e.preventDefault()
      armedByThisPress = false
      const now = Date.now()
      const gapMs = lastDownAt !== 0 ? now - lastDownAt : -1
      const isDoubleTap = gapMs !== -1 && gapMs < CONFIG.LISTEN_DOUBLE_TAP_MS
      lastDownAt = now

      if (handsFreeArmedRef.current) {
        // Any tap while armed disarms — the design's "tap mic to stop listening".
        // Deliberately before micDown so it never starts a recording instead.
        remoteLog(`handsfree disarm reason=tap gap=${gapMs}ms`)
        setHandsFreeArmed(false)
        hapticTick()
        lastDownAt = 0
        lastDownStartedRecording = false
        return
      }
      const to = micDestinationOf(e.currentTarget as Element)
      if (to === PHONE_AUDIO_TO.note) {
        lastDownAt = 0
        lastDownStartedRecording = false
        micDown(to)
        return
      }
      // Double-tap arms, same as the Mac's listen hotkey — but only paired with
      // a tap 1 that started a recording (arm() discards it). A stop-tap or
      // disarm-tap never seeds the pair: arming off those ate the next dictation.
      if (isDoubleTap && lastDownStartedRecording) {
        armedByThisPress = true
        lastDownStartedRecording = false
        arm('double-tap')
        return
      }
      // Every tap-after-a-start-tap logs its gap: a value just over the window
      // is a double-tap arm that missed; seconds apart is a deliberate stop.
      if (lastDownStartedRecording && gapMs >= CONFIG.LISTEN_DOUBLE_TAP_MS) {
        remoteLog(`handsfree double-tap miss gap=${gapMs}ms window=${CONFIG.LISTEN_DOUBLE_TAP_MS}`)
      }
      lastDownStartedRecording = micStateRef.current === 'idle'
      const armIfSilent = (): void => {
        longPressTimer = null
        const action = longPressArmAction({
          voiceHeard,
          micOpening: micStateRef.current === 'opening',
          micRecording: micStateRef.current === 'recording'
        })
        if (action === 'recheck') {
          longPressTimer = window.setTimeout(armIfSilent, HANDS_FREE_ARM_RECHECK_MS)
          return
        }
        if (action !== 'arm') {
          // The long-press arm failing is otherwise indistinguishable from the
          // user never trying — and peak vs the floor is the calibration data.
          remoteLog(
            `handsfree stand-down voiceHeard=${voiceHeard} peak=${peakRms.toFixed(4)} floor=${HANDS_FREE_ARM_SILENCE_RMS} state=${micStateRef.current}`
          )
          return
        }
        armedByThisPress = true
        arm('long-press')
      }
      startVoicePoll()
      longPressTimer = window.setTimeout(armIfSilent, HANDS_FREE_LONG_PRESS_MS)
      micDown()
    }
    function onPointerUp(e: PointerEvent): void {
      e.preventDefault()
      clearLongPress()
      if (armedByThisPress) {
        armedByThisPress = false
        lastDownAt = 0
        return
      }
      // A press that ran its full course is spent: leaving lastDownAt set made
      // the NEXT ordinary tap read as tap 2 of a double-tap and arm hands-free.
      // Only a release fast enough to still be inside the window can pair.
      if (Date.now() - lastDownAt >= CONFIG.LISTEN_DOUBLE_TAP_MS) lastDownAt = 0
      micUp()
    }
    for (const el of els) {
      el.addEventListener('pointerdown', onPointerDown, { passive: false })
      el.addEventListener('pointerup', onPointerUp)
      el.addEventListener('pointercancel', onPointerUp)
    }
    return () => {
      clearLongPress()
      for (const el of els) {
        el.removeEventListener('pointerdown', onPointerDown)
        el.removeEventListener('pointerup', onPointerUp)
        el.removeEventListener('pointercancel', onPointerUp)
      }
    }
    // Keyed on the NODES, never on a proxy for them (layout/deckMode/
    // splitConcept). A gate unmounting the deck changes no proxy, so those
    // deps left the mic bound to nothing for the rest of the session.
    // `armed` is read through a ref for the same reason — re-running this
    // effect on it would rebind every listener mid-gesture.
  }, [micDown, micUp, micEls, remoteLog, stopRecording])

  useEffect(() => {
    syncMicSourceToNative()
    return subscribeNativeIntent((event) => {
      if (event.type === 'startRecording') nativeStartRecordingRef.current?.()
      if (event.type === 'queuedClip') sendQueuedClip(event)
      // Swift's capture is live. Only NOW is the HUD allowed to claim it's
      // recording -- the permission sheet can sit in front of this for a while.
      if (event.type === 'nativeMicStarted') {
        if (micStateRef.current === 'opening') micStateRef.current = 'recording'
        recordStartedAtRef.current = Date.now()
        hapticTick()
        setRecording(true)
        setStatus('Recording…')
        // Meta documents the HFP hand-off as failing SILENTLY -- the route just
        // stays on the phone. Swift reports what the route ACTUALLY is, so say
        // so rather than let a glasses recording quietly come from the phone.
        if (event.requested === 'glasses' && event.source === 'phone') {
          showToast("Recording from your phone - glasses mic isn't connected")
        }
      }
      if (event.type === 'nativeMicStopped') {
        remoteLogRef.current(
          micTraceNativeStopped({
            discarded: event.discarded,
            durationMs: event.durationMs,
            jsDiscard: nativeDiscardRef.current,
            silent: discardSilentRef.current,
            transcribing: event.transcribing
          })
        )
        setStatus('Live')
        if (nativeDiscardRef.current) {
          if (!discardSilentRef.current) showToast('Recording cancelled')
        } else if (event.discarded) showToast('Hold longer')
        // Only when the Mac is genuinely away. Connected, the clip goes straight
        // up the socket and the Mac's own transcript lands in a second or two --
        // the phone's preview would just be a worse answer arriving first.
        else if (event.transcribing && !connectedRef.current) {
          showToast(CONFIG.UI_LABELS.CLIP_PHONE_TEXT_PENDING, null, true, false, true)
          // A persist toast has no auto-hide, and the Task behind it dies with a
          // backgrounded app without ever reporting -- so the spinner needs its
          // own way out or it sits there for the rest of the session. Cleared by
          // showToast, so the words landing first cancel this.
          schedulePhoneTextWatchdog()
        }
        nativeDiscardRef.current = false
        discardSilentRef.current = false
      }
      // Just the words plus the cloud-off mark -- the mark is what says "your
      // Mac hasn't seen this yet", so no sentence is added around the text.
      // Both of these are dropped while connected: the Mac's own transcript is
      // already on its way and is the one that gets pasted, so showing the
      // phone's guess first would only contradict it a second later.
      if (event.type === 'clipPhoneText' && !connectedRef.current)
        showToast(event.text, null, false, false, true)
      // Not a failed RUN -- the recording is safe and still gets typed out. Only
      // the on-phone preview is missing, so this reads as an offline note, not red.
      if (event.type === 'clipPhoneTextFailed' && !connectedRef.current)
        showToast(clipPhoneTextFailedCopy(event.reason), null, false, false, true)
      if (event.type === 'nativeMicFailed') {
        nativeCaptureRef.current = false
        micStateRef.current = 'idle'
        micOpenGenRef.current++
        setRecording(false)
        setMicLatched(false)
        micLatchedAtRef.current = null
        setStatus('Live')
        showToast(
          event.reason === 'denied' ? 'Microphone access needed' : "Mic unavailable - can't open it"
        )
      }
      // The Live Activity's Stop, pressed from the Lock Screen. Send what's
      // been recorded rather than dropping it: the user asked to stop, not to
      // throw away.
      if (event.type === 'nativeStopRequested') {
        nativeStopRecordingRef.current?.(false)
      }
    }, ['startRecording', 'nativeMicStarted'])
  }, [schedulePhoneTextWatchdog, sendQueuedClip, showToast])

  // Re-paste a past dictation at the Mac's cursor. Sends the id only; the Mac
  // resolves it against its own buffer and runs the same paste path a fresh
  // dictation gets.
  const onPasteDictation = useCallback(
    (id: string) => {
      send({ type: 'pasteDictation', id })
      showToast('Pasted')
    },
    [send, showToast]
  )

  // Ask for the page after what we're already holding. Guarded on the in-flight
  // flag so a double-tap can't request the same page twice.
  const onLoadMoreHistory = useCallback(() => {
    setHistoryLoadingMore((inFlight) => {
      if (inFlight) return inFlight
      send({ type: 'getDictationHistory', offset: dictationsRef.current.length })
      return true
    })
  }, [send])

  // Only surfaced once the wait has actually been slow -- see the constant.
  const transcribing = useDelayedFlag(dictating, TRANSCRIBE_HINT_DELAY_MS)

  // Appended here rather than at the ~8 setStatus('Recording…') call sites, so
  // one source ticks and both layouts get it.
  const recordingElapsed = useRecordingElapsed(recording)

  return {
    recording,
    recordingTo,
    micLatched,
    micLabel,
    handsFree: handsFreeState,
    handsFreeSpeaking,
    handsFreeStreamRef,
    disarmHandsFree,
    transcribing,
    transcribeStage,
    inFlightClipId,
    inFlightClipRef,
    retryableClip,
    cancelTranscribe,
    retryTranscribe,
    dismissTranscribe,
    micSidePress,
    micStreamRef,
    historyOpen,
    setHistoryOpen,
    highlightHistoryId,
    setHighlightHistoryId,
    dictations,
    historyHasMore,
    historyLoadingMore,
    onLoadMoreHistory,
    onPasteDictation,
    micDown,
    micUp,
    toggleRecording,
    sendQueuedClip,
    settleClip,
    handsFreeMicRef,
    recordingElapsed
  }
}

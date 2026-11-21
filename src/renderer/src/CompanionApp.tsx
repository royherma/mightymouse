import type { JSX } from 'react'
import { Component, useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Ear, Sparkles, MessageCircle, Smile, Circle, X, ChevronDown } from 'lucide-react'
import { CONFIG } from '../../shared/config'
import { COMPANION_STATE_LABEL, type CompanionState, type LiveTurnResult } from '../../shared/companion-state'
import {
  COMPANION_DEBUG_MAX_EVENTS,
  WAKE_EVENT,
  type CompanionStageEvent
} from '../../shared/companion-debug'
import { decideBargeIn, echoTail, loudMs } from '../../shared/companion-barge-in'
import { useVoiceActivity, encodeVoiceSegmentToWav, type VoiceActivitySegment } from './hooks/useVoiceActivity'
import { WAKE_THRESHOLD } from './lib/wake-word'
import { useAudioPlayback } from './hooks/useAudioPlayback'
import { useMicLevel } from './hooks/useMicLevel'
import CompanionDebugPanel from './components/CompanionDebugPanel'
import { StageView } from './components/StageView'
import { HideoutView, useHideout } from './components/HideoutView'
import MouseCharacter from './components/MouseCharacter'
import WarpCharacter from './components/WarpCharacter'
import {
  DEFAULT_COMPANION_RENDERER,
  toCompanionRenderer,
  type CompanionRendererId
} from '../../shared/companion-renderers'
import {
  COMPANION_SIZE_MINI,
  COMPANION_SIZE_DEBUG,
  DEFAULT_COMPANION_SIZE,
  toCompanionSize,
  type CompanionSize
} from '../../shared/companion-size'
import { Button } from './components/Button'
import { VoiceChat, companionChatCss, useVoiceTurns, type VoiceTurn } from './companion-chat'
import { CompanionPill, companionPillCss, PILL_DONE_MS, PILL_FAILED_MS, type PillOutcome } from './companion-pill'

// Live Voice Companion overlay (?window=companion) — Phase 2 of the design
// Real mic
// input, real transcript, real LLM reply (existing ask pipeline via
// companion-orchestrator.ts), real (or gracefully-silent) TTS. State machine:
//   idle -[VAD speech-start]-> listening -[VAD speech-end]-> thinking
//        -[liveTurnResult, has audio]-> talking -[audio onEnded]-> idle
//        -[liveTurnResult, no audio]-> talking -[TALKING_HOLD_MS]-> idle
//        talking -[VAD speech-start]-> listening   (barge-in: cut the clip)
//        thinking -[VAD speech-start]-> listening  (barge-in: drop the reply)
// `useVoiceActivity` (renderer-side VAD, see that file's module doc for why it
// runs here and not in main) drives listening/segment-capture; each finished
// segment is WAV-encoded and shipped to main (`live-listen.ts`) over
// `liveTurnSubmit`, which replies async over `onLiveTurnResult` with the real
// answer and (when TTS is configured) its spoken audio. `useAudioPlayback`
// plays that clip and derives a live RMS-driven mouth-openness value from the
// ACTUAL playback amplitude — fed straight into `<MouseCharacter>`'s jaw scale
// (Phase 3) so `talking`'s duration always matches the real audio instead of a
// guessed hold. When TTS has no audio (no key configured), the companion falls
// back to the fixed TALKING_HOLD_MS timer so the caption still gets a visible
// beat on screen. The mic loop itself is
// gated on the SAME "Live mode" PREFS toggle Phase 0 used for window
// visibility (`liveCompanion` in settingsGetPrefs) — no separate toggle: if the
// companion window is up, the user opted into the whole live experience.
//
// Self-contained <style> block (standalone overlay, mirrors IslandApp.tsx) —
// doesn't inherit the renderer's global index.css.

const T = CONFIG.THEME_TOKENS

// Per-state accent + glyph — same "state carries its own color" convention as
// IslandApp's ACCENT map. reacting reuses green (a positive, momentary flash).
const ACCENT: Record<CompanionState, string> = {
  idle: T.textMutedLight,
  listening: T.accent,
  thinking: T.orange,
  talking: T.blue,
  reacting: T.green
}

interface Caption {
  heard: string
  forMe: boolean
  reply?: string
  failed?: boolean
}

const CAPTION_IGNORED_MAX_WORDS = 12
const ECHO_LAG_S = 1
// Measured: our own reply after echo cancelling is loud for 64-160ms of a clip, a voice for 1s+.
const ECHO_GATE_RMS = 0.02
const ECHO_GATE_MIN_MS = 300
const ECHO_TAIL_MS = 400


// Bars still move for nearby voices before the name, at a third of the height, so the mic visibly works.
const IDLE_BARS_SCALE = 0.35

function Glyph({ state }: { state: CompanionState }): JSX.Element {
  const size = 22
  switch (state) {
    case 'listening':
      return <Ear size={size} />
    case 'thinking':
      return <Sparkles size={size} />
    case 'talking':
      return <MessageCircle size={size} />
    case 'reacting':
      return <Smile size={size} />
    default:
      return <Circle size={size} />
  }
}

/**
 * Phase 3: wraps `<MouseCharacter>` so a WebGL/r3f init failure (missing GPU
 * context, a driver quirk, anything three.js can throw during mount) degrades
 * to the Phase 0 placeholder blob instead of crashing the whole companion
 * window. Deliberately minimal — a class boundary is the only way to catch a
 * render-phase throw in React, no retry/reset logic needed for this surface.
 */
class CharacterBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  componentDidCatch(error: unknown): void {
    console.error('[companion] MouseCharacter failed to render, falling back to placeholder:', error)
  }
  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

export default function CompanionApp(): JSX.Element {
  const [state, setState] = useState<CompanionState>('idle')
  const [liveEnabled, setLiveEnabled] = useState(false)
  // Which visualization draws the character (mouse3d | warp2d | placeholder).
  // Read from PREFS on mount; live-swapped from the dev debug panel's picker
  // (no window recreate — just a prop change here). See companion-renderers.ts.
  const [renderer, setRenderer] = useState<CompanionRendererId>(DEFAULT_COMPANION_RENDERER)
  // How much screen this conversation takes: full, or the bottom-right puck.
  // A SIZE, not a mode — the same conversation either way, nothing restarts.
  const [size, setSize] = useState<CompanionSize>(DEFAULT_COMPANION_SIZE)
  const [transcript, setTranscript] = useState('')
  const [reply, setReply] = useState('')
  // The step feed Stage draws from. Kept OLDEST-first (the debug panel keeps
  // its own copy newest-first) so the chip strip reads left-to-right in the
  // order the agent actually did things.
  const [stageEvents, setStageEvents] = useState<CompanionStageEvent[]>([])
  // Last model that actually answered, latched from the response stage-event.
  // Latched (not derived per-render) so it survives the events list being
  // trimmed, and stays readable while the next turn is still starting.
  const [model, setModel] = useState('')
  // Stage's input bar has focus. VAD is muted while it does, so saying the
  // sentence out loud as you type it can't fire a second turn from room noise.
  const [typing, setTyping] = useState(false)
  const [micPaused, setMicPaused] = useState(false)
  useEffect(() => window.api.onCompanionMicPaused(setMicPaused), [])
  const [caption, setCaption] = useState<Caption | null>(null)
  const { turns, steps, recent: chatRecent, addStep, clearSteps, finishTurn } = useVoiceTurns()
  const [chatSessionId, setChatSessionId] = useState<string | undefined>(undefined)
  const [chatHover, setChatHover] = useState(false)
  const captionTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const draftSeqRef = useRef(0)
  const draftBusyRef = useRef(false)
  const followUpTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hideout = useHideout()
  // Guards against a slow whisper transcribe resolving AFTER the user already
  // flipped Live mode off mid-turn — the companion should stay idle, not pop
  // back to "talking" for a turn nobody's listening for anymore.
  const liveEnabledRef = useRef(liveEnabled)
  liveEnabledRef.current = liveEnabled || !!hideout?.open
  // Current state readable from effects without making them depend on `state`
  // — a barge-in effect that re-ran on every state change would re-interrupt
  // itself as it transitions into `listening`.
  const stateRef = useRef(state)
  stateRef.current = state
  const hideoutOpenRef = useRef(false)
  hideoutOpenRef.current = !!hideout?.open
  const wakeReadyRef = useRef(false)
  const wakeHeardAtRef = useRef(0)
  const handleWakeHeard = useCallback(() => {
    wakeHeardAtRef.current = Date.now()
    if (stateRef.current === 'idle') setState('listening')
  }, [])
  const mayTranscribe = useCallback(
    () =>
      !wakeReadyRef.current ||
      wakeArmedRef.current ||
      hideoutOpenRef.current ||
      stateRef.current === 'thinking' ||
      stateRef.current === 'talking' ||
      Date.now() - wakeHeardAtRef.current < CONFIG.COMPANION.WAKE_ARM_MS,
    []
  )
  // Settle-to-idle timer for the `talking` hold — cleared/replaced on every
  // new turn so overlapping turns can't race each other back to idle early.
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // When the current segment entered `thinking` — read back once the mocked
  // reply arrives so the state floors at THINKING_MIN_MS instead of flashing
  // for one frame on a fast local transcribe.
  const thinkingStartedAtRef = useRef(0)
  const [outcome, setOutcome] = useState<PillOutcome>(null)
  const outcomeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flashOutcome = useCallback((next: Exclude<PillOutcome, null>) => {
    if (outcomeTimer.current) clearTimeout(outcomeTimer.current)
    setOutcome(next)
    outcomeTimer.current = setTimeout(() => setOutcome(null), next === 'done' ? PILL_DONE_MS : PILL_FAILED_MS)
  }, [])
  useEffect(() => {
    if (state === 'listening' || state === 'thinking') setOutcome(null)
  }, [state])

  // "Live mode" is the SAME PREFS toggle Phase 0 used for window visibility
  // (liveCompanion) — if this window exists at all the user already opted in,
  // so no separate always-listening toggle. Read once on mount; the window is
  // only alive while the toggle is on, so a live re-check isn't needed.
  useEffect(() => {
    window.api
      .settingsGetPrefs()
      .then((prefs) => {
        setLiveEnabled(prefs.liveCompanion)
        setRenderer(toCompanionRenderer(prefs.companionRenderer))
        const saved = toCompanionSize(prefs.companionSize)
        const opening = saved === COMPANION_SIZE_DEBUG ? COMPANION_SIZE_MINI : saved
        setSize(opening)
        if (opening !== saved) window.api.settingsSetCompanionSize(opening).catch(() => {})
      })
      .catch(() => setLiveEnabled(false))
  }, [])

  // Persist + apply a picker change from the debug panel. Write-through so a
  // reload restores the same visualization; the local state drives the swap now.
  const handleRendererChange = useCallback((next: CompanionRendererId) => {
    setRenderer(next)
    window.api.settingsSetCompanionRenderer(next).catch(() => {})
  }, [])

  // Minimize / expand. Main re-applies the window bounds off the same pref, so
  // the local state and the real window can't disagree. The conversation is
  // untouched — this only changes how much screen it takes.
  const handleSizeChange = useCallback((next: CompanionSize) => {
    setSize(next)
    window.api.settingsSetCompanionSize(next).catch(() => {})
  }, [])

  // Dismiss the companion (available to EVERY user, not dev-only). Flips Live
  // mode off — not just a window hide — so it closes AND stays closed next
  // launch, matching the Settings toggle. setCompanionWindow(false) tears down
  // this window as a side effect, so no separate close call is needed.
  const handleClose = useCallback(() => {
    window.api.settingsSetCompanion(false).catch(() => {})
  }, [])

  // Monotonic id for the turn currently in flight. liveTurnSubmit is
  // fire-and-forget over IPC with no correlation id on the way back, so when a
  // barge-in supersedes an in-flight turn its reply still arrives — and would
  // speak an answer to a question the user already talked over. Bumping this on
  // every new segment lets the result handler drop anything that isn't the
  // newest turn.
  const turnSeqRef = useRef(0)
  const replyPlayingRef = useRef(false)
  const clipTextRef = useRef('')
  const echoTailRef = useRef('')
  const bargeInRef = useRef<() => void>(() => {})
  const replyEndedAtRef = useRef(0)
  const ownVoiceOnly = (audio: Float32Array): boolean => {
    const startedAt = Date.now() - audio.length / 16
    const overReply = replyPlayingRef.current || startedAt - ECHO_TAIL_MS < replyEndedAtRef.current
    return overReply && loudMs(audio, ECHO_GATE_RMS) < ECHO_GATE_MIN_MS
  }

  const showCaption = useCallback((next: Caption | null) => {
    setCaption(next)
    if (captionTimer.current) clearTimeout(captionTimer.current)
    if (!next) return
    const hold = (): void => {
      captionTimer.current = setTimeout(() => {
        if (stateRef.current === 'thinking' || stateRef.current === 'talking') hold()
        else setCaption(null)
      }, CONFIG.COMPANION.CAPTION_HOLD_MS)
    }
    hold()
  }, [])

  const handleSegment = useCallback((segment: VoiceActivitySegment) => {
    if (!liveEnabledRef.current) return
    draftSeqRef.current += 1
    const wakeHeard = segment.wakePeak !== undefined && segment.wakePeak >= WAKE_THRESHOLD
    const send = mayTranscribe()
    if (segment.wakePeak !== undefined)
      console.log(`[wake] sentence ms=${segment.durationMs} peak=${segment.wakePeak.toFixed(3)} -> ${send ? 'parakeet' : 'skipped'}`)
    if (!send) return
    if (ownVoiceOnly(segment.audio)) {
      console.log(`[companion] dropped own voice loudMs=${loudMs(segment.audio, ECHO_GATE_RMS)}`)
      return
    }
    window.api.liveTurnSubmit(new Uint8Array(encodeVoiceSegmentToWav(segment.audio)), echoTailRef.current, wakeHeard)
  }, [mayTranscribe])

  const handleDraft = useCallback(
    (audio: Float32Array) => {
      if (!liveEnabledRef.current || draftBusyRef.current || !mayTranscribe() || ownVoiceOnly(audio)) return
      draftBusyRef.current = true
      const seq = draftSeqRef.current
      window.api
        .liveTurnDraft(new Uint8Array(encodeVoiceSegmentToWav(audio)), echoTailRef.current)
        .then((draft) => {
          if (seq !== draftSeqRef.current || !draft.text) return
          if (replyPlayingRef.current) bargeInRef.current()
          showCaption({ heard: draft.text, forMe: draft.addressed })
        })
        .catch(() => {})
        .finally(() => {
          draftBusyRef.current = false
        })
    },
    [showCaption, mayTranscribe]
  )

  // Typed instruction from Stage's input bar. Deliberately the SAME bookkeeping
  // handleSegment does — bump the turn seq, clear the last turn's text, show
  // `thinking` — so a typed turn and a spoken one behave identically from here
  // on; main runs both through runLiveTurnFromText.
  const handleSubmitText = useCallback((text: string) => {
    if (!liveEnabledRef.current) return
    // Submitting mid-run is a barge-in: the old run is still clicking through an
    // app, and letting it finish alongside the new instruction is the exact
    // double-driving the abort exists to prevent.
    if (stateRef.current === 'thinking') window.api.companionAbortTurn()
    turnSeqRef.current += 1
    clearSteps()
    setTranscript(text)
    setReply('')
    setState('thinking')
    if (settleTimer.current) clearTimeout(settleTimer.current)
    thinkingStartedAtRef.current = Date.now()
    window.api.companionSendText(text)
  }, [])

  const micWanted = (liveEnabled || !!hideout?.open) && !micPaused
  const {
    speaking,
    error: vadError,
    wakeReady
  } = useVoiceActivity(micWanted && !typing, handleSegment, handleDraft, handleWakeHeard)
  wakeReadyRef.current = wakeReady

  // Live 0..1 mic loudness from the USER's voice — the "clearly hearing you"
  // signal. Feeds the character's ear-perk/head-lean AND the ring's live swell
  // while listening. Its own getUserMedia tap coexists with VAD's (browsers
  // share the mic device across consumers). Only meaningful while listening;
  // gated on liveEnabled so the tap tears down when Live mode is off.
  const { norm: micLevel } = useMicLevel(micWanted)

  // Settle back to idle once the real TTS clip finishes playing — the primary
  // path for how long `talking` lasts when audio is present (see the module
  // doc). `mouthOpen` is the live RMS of THAT clip, so the jaw in both WebGL
  // renderers moves in step with the words actually being spoken.
  // Set while a barge-in is tearing down the current clip. stopReply() runs the
  // same settle() path as a natural end — including this onEnded callback — so
  // without the flag the interrupt would immediately stamp `idle` over the
  // `listening` we just set, and the user's own turn would look ignored.
  const bargingInRef = useRef(false)
  const ackPlayingRef = useRef(false)

  const { mouthOpen, playing: ttsPlaying, play: playReply, stop: stopReply, position: ttsPosition } = useAudioPlayback(() => {
    if (bargingInRef.current || ackPlayingRef.current) {
      bargingInRef.current = false
      ackPlayingRef.current = false
      return
    }
    setState('idle')
  })

  const speakingRef = useRef(false)
  const echoFromRef = useRef({ at: 0, lag: 0 })
  useEffect(() => {
    if (replyPlayingRef.current && !ttsPlaying) replyEndedAtRef.current = Date.now()
    replyPlayingRef.current = ttsPlaying
  }, [ttsPlaying])

  const playClip = useCallback(
    (audio: Uint8Array, mimeType: string, text = '') => {
      clipTextRef.current = text
      echoFromRef.current = { at: 0, lag: 0 }
      if (speakingRef.current) echoTailRef.current = `${echoTailRef.current} ${text}`.trim()
      playReply(audio, mimeType)
    },
    [playReply]
  )

  useEffect(() => {
    speakingRef.current = speaking
    if (!speaking) return
    const pos = replyPlayingRef.current ? ttsPosition() : null
    echoFromRef.current = pos ? { at: pos.t / pos.d, lag: ECHO_LAG_S / pos.d } : { at: 0, lag: 0 }
    echoTailRef.current = pos ? echoTail(clipTextRef.current, echoFromRef.current.at, echoFromRef.current.lag) : ''
  }, [speaking, ttsPosition])

  useEffect(
    () =>
      window.api.onCompanionAck((clip) => {
        if (stateRef.current !== (clip.announce ? 'idle' : 'thinking')) return
        ackPlayingRef.current = !clip.announce
        playClip(clip.audio, clip.mimeType, clip.text)
      }),
    [playClip]
  )

  // Live mode flipped off mid-reply — stop any in-flight TTS playback
  // immediately instead of letting a clip finish talking into a muted room.
  useEffect(() => {
    if (!liveEnabled) stopReply()
  }, [liveEnabled, stopReply])

  const wakeArmedRef = useRef(false)

  // Barge-in fires on a heard "hey Mighty" (or "stop"), not on speech-start: in a room,
  // any voice would otherwise cut off the run the user actually asked for.
  const cutCurrentTurn = useCallback(() => {
    // Read the live state from a ref rather than deciding inside a setState
    // updater: React may invoke an updater twice (StrictMode / re-render), which
    // would fire stopReply and the turn-id bump more than once per interruption.
    const cut = decideBargeIn(stateRef.current)
    if (cut.interrupted) {
      // Bumping the turn id is what makes an interrupt during `thinking` work:
      // the in-flight reply still arrives, and the result handler drops it
      // because the id no longer matches.
      if (cut.supersedeTurn) turnSeqRef.current += 1
      // No companionAbortTurn here: main already aborted, and a late abort would kill the NEW run.
      if (cut.clearSettleTimer && settleTimer.current) clearTimeout(settleTimer.current)
      if (cut.stopAudio) {
        bargingInRef.current = true
        stopReply()
      }
      // Clear the interrupted turn's text so the bubble doesn't keep showing a
      // half-spoken reply while the companion is listening to the new question.
      setTranscript('')
      setReply('')
      window.api.companionStageEventReport({
        stage: 'voice-input',
        provider: 'barge-in',
        state: 'ok',
        detail: `interrupted while ${stateRef.current}`,
        ts: Date.now()
      })
    }
  }, [stopReply])

  useEffect(() => {
    bargeInRef.current = () => {
      if (!hideout?.open) return
      const pos = ttsPosition()
      const { at, lag } = echoFromRef.current
      if (pos) echoTailRef.current = echoTail(clipTextRef.current, at, lag, (pos.t + ECHO_LAG_S) / pos.d)
      const talking = stateRef.current === 'talking'
      if (stateRef.current !== 'idle') cutCurrentTurn()
      if (!talking) stopReply()
    }
  }, [hideout?.open, ttsPosition, cutCurrentTurn, stopReply])

  const handleWake = useCallback(
    (kind: string) => {
      cutCurrentTurn()
      if (settleTimer.current) clearTimeout(settleTimer.current)
      wakeArmedRef.current = kind === WAKE_EVENT.armed
      if (kind === WAKE_EVENT.request) {
        clearSteps()
        turnSeqRef.current += 1
        setTranscript('')
        setReply('')
        setState('thinking')
        thinkingStartedAtRef.current = Date.now()
      } else if (kind === WAKE_EVENT.armed) {
        setState('listening')
        settleTimer.current = setTimeout(() => {
          wakeArmedRef.current = false
          setState('idle')
        }, CONFIG.COMPANION.WAKE_ARM_MS)
      } else {
        setState('idle')
      }
    },
    [cutCurrentTurn]
  )
  const handleStop = useCallback(() => {
    window.api.companionAbortTurn()
    handleWake(WAKE_EVENT.stop)
  }, [handleWake])

  const handleWakeRef = useRef(handleWake)
  handleWakeRef.current = handleWake

  // Drive `listening` the instant VAD detects speech — independent of the
  // segment callback, which only fires once the segment is FINISHED.
  useEffect(() => {
    if (speaking && stateRef.current === 'idle' && mayTranscribe()) setState('listening')
  }, [speaking, mayTranscribe])

  useEffect(() => {
    if (!vadError) return
    setState('idle')
  }, [vadError])

  // Stage's step feed. Subscribed unconditionally (not gated on the renderer)
  // so switching to Stage mid-run shows the steps that already happened rather
  // than an empty strip until the next click.
  useEffect(() => {
    const unsubscribe = window.api.onCompanionStageEvent((event: CompanionStageEvent) => {
      setStageEvents((prev) => [...prev, event].slice(-COMPANION_DEBUG_MAX_EVENTS))
      if (event.stage === 'wake' && event.detail) handleWakeRef.current(event.detail)
      if (event.stage === 'step' && event.say) addStep(event.say)
      if (event.model) setModel(event.model)
    })
    return unsubscribe
  }, [addStep])

  useEffect(() => {
    const unsubscribe = window.api.onLiveTurnResult((result: LiveTurnResult) => {
      if (!liveEnabledRef.current) return
      if (result.ignored && result.error === WAKE_EVENT.armed) {
        showCaption({ heard: result.transcript, forMe: true, reply: "I'm listening" })
        return
      }
      if (result.ignored) {
        if (stateRef.current === 'listening' && !wakeArmedRef.current) setState('idle')
        const words = result.transcript.trim().split(/\s+/).filter(Boolean).length
        showCaption(words > 0 && words <= CAPTION_IGNORED_MAX_WORDS ? { heard: result.transcript, forMe: false } : null)
        return
      }

      // Snapshot the turn this reply belongs to. If the user barges in while
      // it's still in flight, handleSegment bumps the counter and this reply is
      // stale — dropping it is what stops the mouse answering a question the
      // user already talked over.
      const seqAtArrival = turnSeqRef.current

      const elapsed = Date.now() - thinkingStartedAtRef.current
      const remaining = Math.max(0, CONFIG.COMPANION.THINKING_MIN_MS - elapsed)

      if (settleTimer.current) clearTimeout(settleTimer.current)
      settleTimer.current = setTimeout(() => {
        // Re-checked after the THINKING_MIN_MS floor, not just before it — the
        // interruption usually lands inside that delay.
        if (turnSeqRef.current !== seqAtArrival) return
        if (result.sessionId) setChatSessionId(result.sessionId)
        if (!result.ok) {
          setState('idle')
          const stopped = result.error === 'stopped'
          if (result.transcript) {
            finishTurn({ heard: result.transcript, reply: stopped ? 'Stopped' : "Couldn't do that", failed: !stopped })
            setCaption(null)
          } else clearSteps()
          if (result.transcript && !stopped) flashOutcome('failed')
          return
        }
        setTranscript(result.transcript)
        setReply(result.reply)
        setState('talking')
        flashOutcome('done')
        finishTurn({ heard: result.transcript, reply: result.reply })
        setCaption(null)
        wakeArmedRef.current = true
        if (followUpTimer.current) clearTimeout(followUpTimer.current)
        followUpTimer.current = setTimeout(() => {
          wakeArmedRef.current = false
        }, CONFIG.COMPANION.FOLLOW_UP_MS)

        ackPlayingRef.current = false
        if (result.audio && result.audio.byteLength > 0) {
          // Real TTS clip: talking's duration is driven by the audio's own
          // play/ended lifecycle (see the useAudioPlayback onEnded callback
          // above), not a guessed timer.
          playClip(result.audio, result.audioMimeType || 'audio/mpeg', result.spokenText)
        } else {
          // No audio (TTS silent/no-key, or a request failure) — hold long enough
          // to actually READ the reply: scale to its length so a multi-sentence
          // answer doesn't flash away, floored at TALKING_HOLD_MS and capped at
          // TALKING_HOLD_MAX_MS so a runaway reply can't pin the companion open.
          const readMs = Math.min(
            CONFIG.COMPANION.TALKING_HOLD_MAX_MS,
            Math.max(
              CONFIG.COMPANION.TALKING_HOLD_MS,
              result.reply.length * CONFIG.COMPANION.TALKING_MS_PER_CHAR
            )
          )
          settleTimer.current = setTimeout(() => {
            setState('idle')
          }, readMs)
        }
      }, remaining)
    })
    return unsubscribe
  }, [playClip, showCaption, finishTurn, clearSteps])

  useEffect(() => {
    return () => {
      if (settleTimer.current) clearTimeout(settleTimer.current)
      stopReply()
    }
  }, [stopReply])

  // Enter/leave flickers when the window flips click-through, so decide from the pointer's target.
  useEffect(() => {
    if (size !== COMPANION_SIZE_MINI) return
    let over = false
    const onMove = (e: MouseEvent): void => {
      const next = e.target instanceof Element && e.target.closest('.companion-pill, .companion-chat') !== null
      if (next === over) return
      over = next
      setChatHover(next)
      window.api.companionSetInteractive(next).catch(() => {})
    }
    document.addEventListener('mousemove', onMove)
    return () => document.removeEventListener('mousemove', onMove)
  }, [size])

  const accent = ACCENT[state]
  // Speech bubble is speaker-aware so it's obvious WHO is talking: the user's
  // side (listening/thinking) vs the mouse's side (talking) get distinct colors,
  // alignment, and a "You"/"Mouse" label + tail. `from` drives the styling.
  const bubble: { text: string; from: 'user' | 'mouse' } | null =
    state === 'talking'
      ? { text: reply, from: 'mouse' }
      : state === 'thinking'
        ? { text: transcript, from: 'user' }
        : state === 'listening'
          ? { text: CONFIG.COMPANION.LISTENING_CAPTION, from: 'user' }
          : null

  // Ring state for the canvas wrapper: a faint always-on "armed" ring while Live
  // mode is on but idle, brightening to the accent + swelling with the user's
  // voice while listening. Renderer-agnostic (drawn on the wrapper, not inside
  // the character) so both warp2d + mouse3d get it. Passed to CSS as vars.
  const listening = state === 'listening'
  const ringActive = liveEnabled && (listening || state === 'idle')
  const ringColor = listening ? ACCENT.listening : T.textMutedLight
  // 0..1 ring intensity: faint floor while idle-armed, riding mic level while listening.
  const ringLevel = listening ? 0.45 + micLevel * 0.55 : ringActive ? 0.16 : 0

  // The CSS blob — both the explicit `placeholder` renderer AND the shared
  // degrade target when a WebGL renderer (mouse3d/warp2d) throws.
  const blob = (
    <div className="blob" style={{ ['--accent' as string]: accent }}>
      <div className="glyph">
        <Glyph state={state} />
      </div>
      <span className="label">{COMPANION_STATE_LABEL[state]}</span>
    </div>
  )

  // Minimized: the whole conversation collapses to one puck in the corner, so
  // the screen is the user's again without ending anything. Clicking it goes
  // straight back to full — the only control it has, because a puck with a menu
  // is just a small window.
  //
  // The ring is the ENTIRE status display at this size — there's no caption, no
  // bubble, no step feed to fall back on — so it carries both signals: it swells
  // with the user's voice while listening, and breathes on a fixed cycle while
  // the agent is thinking or talking, when there is no mic level to ride.
  if (hideout?.open) {
    const mic = vadError ? 'blocked' : micPaused ? 'busy' : 'on'
    return <HideoutView hideout={hideout} state={state} mic={mic} micLevel={micLevel} mouthOpen={mouthOpen} speaking={ttsPlaying} position={ttsPosition} />
  }
  if (size === COMPANION_SIZE_MINI || size === COMPANION_SIZE_DEBUG) {
    const working = state === 'thinking' || state === 'talking'
    const debugOpen = size === COMPANION_SIZE_DEBUG
    const paused = micPaused && !working
    const liveTurn: VoiceTurn | null =
      caption || (state === 'thinking' && steps.length > 0)
        ? {
            id: -1,
            heard: caption?.heard ?? '',
            note: caption && !caption.forMe ? 'Not for me' : undefined,
            steps: state === 'thinking' ? steps : [],
            reply: caption?.reply,
            failed: caption?.failed,
            live: true
          }
        : null
    const barsLevel = listening
      ? Math.sqrt(micLevel)
      : ttsPlaying
        ? Math.sqrt(mouthOpen)
        : state === 'idle'
          ? speaking
            ? Math.sqrt(micLevel) * IDLE_BARS_SCALE
            : 0
          : null
    return (
      <>
        <style>{companionCss()}</style>
        <div className="companion-puck-host">
        <div className="companion-puck-col">
        {!debugOpen && (
          <VoiceChat
            turns={liveTurn ? [...turns, liveTurn] : turns}
            hidden={!(chatHover || chatRecent || working || caption)}
            onOpenChat={chatSessionId ? () => void window.api.mighty.open(false, chatSessionId) : undefined}
          />
        )}
        <CompanionPill
          state={state}
          outcome={outcome}
          step={state === 'thinking' ? steps[steps.length - 1] : undefined}
          paused={paused}
          micLevel={micLevel}
          barsLevel={barsLevel}
          workingSince={state === 'thinking' ? thinkingStartedAtRef.current : null}
          onStop={handleStop}
          onClose={handleClose}
          onContextMenu={(e) => {
            e.preventDefault()
            handleSizeChange(debugOpen ? COMPANION_SIZE_MINI : COMPANION_SIZE_DEBUG)
          }}
        />
        </div>

        {debugOpen && (
          <div className="companion-puck-debug">
            <CompanionDebugPanel
              renderer={renderer}
              onRendererChange={handleRendererChange}
              state={state}
              mouthOpen={mouthOpen}
              micLevel={micLevel}
              speaking={speaking}
              playing={ttsPlaying}
              model={model}
            />
          </div>
        )}
        </div>
      </>
    )
  }

  // Stage takes over the WHOLE window (companion-window.ts sizes it to the
  // work area at full size), so it returns before the centered character
  // layout rather than nesting inside it.
  if (renderer === 'stage') {
    return (
      <>
        <style>{companionCss()}</style>
        <StageView
          state={state}
          transcript={transcript}
          reply={reply}
          events={stageEvents}
          onInteractiveChange={(interactive) =>
            window.api.companionSetInteractive(interactive).catch(() => {})
          }
          onSubmitText={handleSubmitText}
          onTypingChange={setTyping}
          onMinimize={() => handleSizeChange(COMPANION_SIZE_MINI)}
        />
      </>
    )
  }

  return (
    <>
      <style>{companionCss()}</style>
      <div className="companion-root">
        <div className="companion-stage">
          {/* Close (✕) — dismisses the companion for ANY user (turns Live mode
              off). Pinned top-right, always visible, above the character. */}
          <Button
            variant="bare"
            className="companion-close"
            onClick={handleClose}
            title="Close companion"
            aria-label="Close companion"
          >
            <X size={14} strokeWidth={2.5} />
          </Button>

          {/* Minimize (⌄) — back to the corner puck. Sits beside close because
              they are the same kind of control (how much of me you want), and
              the pair reads as one choice instead of two hidden ones. */}
          <Button
            variant="bare"
            className="companion-minimize"
            onClick={() => handleSizeChange(COMPANION_SIZE_MINI)}
            title="Minimize"
            aria-label="Minimize"
          >
            <ChevronDown size={14} strokeWidth={2.5} />
          </Button>

          {/* Dev-only debug panel, absolutely anchored to the TOP of the window
              and growing DOWNWARD from there — it floats over the empty space
              above the character and never shifts the character's position (the
              window is tall enough now that it doesn't clip). Renders null
              outside dev. */}
          <div className="companion-top">
            <CompanionDebugPanel
              renderer={renderer}
              onRendererChange={handleRendererChange}
              state={state}
              mouthOpen={mouthOpen}
              micLevel={micLevel}
              speaking={speaking}
              playing={ttsPlaying}
              model={model}
            />
          </div>

          {renderer === 'placeholder' ? (
            blob
          ) : (
            // `key` forces a fresh mount (and a fresh error boundary) when the
            // user swaps mouse3d ⇄ warp2d, so a prior renderer's thrown-fatal
            // state can't stick to the newly-selected one.
            <CharacterBoundary key={renderer} fallback={blob}>
              <div
                className={`companion-canvas${ringActive ? ' is-listening-ring' : ''}`}
                style={{
                  ['--ring-color' as string]: ringColor,
                  ['--ring-level' as string]: ringLevel
                }}
              >
                {renderer === 'warp2d' ? (
                  <WarpCharacter state={state} mouthOpen={mouthOpen} micLevel={micLevel} />
                ) : (
                  <MouseCharacter state={state} mouthOpen={mouthOpen} />
                )}
              </div>
            </CharacterBoundary>
          )}

          {/* Bottom slot: the speaker-aware speech bubble. `is-user` (your
              side) vs `is-mouse` (the mouse's reply) get distinct color +
              alignment + label so it's clear who's talking. Reserves its own
              row so the character doesn't shift as bubbles appear/disappear. */}
          <div className="companion-bottom">
            {bubble && (
              <div className={`bubble ${bubble.from === 'user' ? 'is-user' : 'is-mouse'}`}>
                <span className="bubble-who">{bubble.from === 'user' ? 'You' : 'Mouse'}</span>
                <span className="bubble-text">{bubble.text}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

function companionCss(): string {
  return `
  html, body, #root {
    margin: 0; height: 100%; background: transparent; overflow: hidden;
    font-family: -apple-system, 'SF Pro Display', system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }

  .companion-root {
    width: 100%; height: 100%;
    display: flex; align-items: center; justify-content: center;
    -webkit-app-region: no-drag;
  }

  .companion-puck-host {
    display: flex; flex-direction: row-reverse;
    align-items: stretch; justify-content: flex-start;
    gap: 8px;
    width: 100%; height: 100%;
    padding: ${CONFIG.COMPANION.PAD}px;
    box-sizing: border-box;
  }
  .companion-puck-col {
    display: flex; flex-direction: column;
    align-items: flex-end; justify-content: flex-end;
    gap: 8px;
    width: ${CONFIG.COMPANION.CAPTION_W}px;
    flex: none;
  }
  .companion-puck-debug {
    position: relative;
    flex: 1; min-width: 0;
    overflow: hidden;
  }
  .companion-puck-debug > .companion-debug {
    position: absolute;
    inset: 0;
    left: 0 !important;
    top: 0 !important;
    width: auto;
    max-width: none;
    max-height: none;
  }

  ${companionChatCss()}
  ${companionPillCss()}
  @keyframes companion-rise {
    from { opacity: 0; transform: translateY(6px); }
    to   { opacity: 1; transform: none; }
  }

  /* Full-height column: debug/transcript slot on top, character in the middle,
     caption slot on the bottom — everything IN-FLOW and inside the window, so
     nothing clips against the transparent bounds (the old layout floated the
     panel + caption OUTSIDE via position:absolute, which is what got cut off).
     The window background is transparent, so the empty gaps show nothing. */
  .companion-stage {
    position: relative;
    width: 100%; height: 100%;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    padding: 12px; box-sizing: border-box;
  }

  /* Close button: pinned to the very top-right corner of the window, above the
     debug panel and character. Small, low-key until hovered. Always rendered
     (every user can dismiss the companion), unlike the dev-only debug panel. */
  .companion-close, .companion-minimize {
    position: absolute;
    top: 10px;
    z-index: 2;
    display: flex; align-items: center; justify-content: center;
    width: 24px; height: 24px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: ${T.surface1};
    color: ${T.textMutedMedium};
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
    cursor: pointer;
    -webkit-app-region: no-drag;
    opacity: 0.55;
    transition: opacity 140ms ease, color 140ms ease, background 140ms ease;
  }
  .companion-close:hover, .companion-minimize:hover {
    opacity: 1;
    color: ${T.onSurface};
    background: ${T.surface2};
  }
  .companion-close { right: 10px; }
  /* Left of close, one button-width plus a gap. */
  .companion-minimize { right: 40px; }

  /* Debug HUD layer: covers the whole window and is purely a positioning
     context — the panel inside is absolutely placed and DRAGGABLE, so this can
     no longer be a top strip (a strip clamps how far down the panel can go).
     pointer-events:none keeps the empty area click-through to the character. */
  .companion-top {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }
  .companion-top > * { pointer-events: auto; }

  /* Bubble slot: absolutely pinned to the bottom, out of flow, so it doesn't
     shift the centered character. Alignment flips per speaker (user vs mouse). */
  .companion-bottom {
    position: absolute;
    bottom: 12px; left: 12px; right: 12px;
    display: flex;
    pointer-events: none;
  }
  .companion-bottom > * { pointer-events: auto; }

  /* r3f's Canvas fills its parent, so this needs an explicit size — matches
     the CONFIG.COMPANION window bounds minus a little breathing room. Drag
     handling lives in MouseCharacter's onPointerDown/onPointerMove (reports
     deltas to main over companionDragMove), so this box just needs to be the
     thing the pointer lands on. */
  /* Character framed as a soft rounded card — clips the portrait's hard black
     square corners into a contained, designed object (was a floating cutout).
     The canvas child is clipped to this radius via overflow:hidden. */
  .companion-canvas {
    position: relative;
    width: 180px; height: 180px;
    border-radius: 22px;
    overflow: hidden;
    background: ${T.surface1};
    border: 1px solid ${T.surfaceBorderAlt};
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.32);
    -webkit-app-region: no-drag;
    cursor: grab;
  }
  .companion-canvas > * { border-radius: inherit; }

  /* "Clearly listening" ring — a glow drawn AROUND the card via a ring + glow
     box-shadow (drawn outside the card's overflow:hidden, unlike an ::after
     child which would be clipped). Faint always-on while Live+idle ("armed"),
     bright + swelling in the accent color while listening. --ring-level (0..1)
     rides the user's live mic level; --ring-color is the state accent. Layered
     on top of the card's own base drop-shadow so both show. Renderer-agnostic. */
  .companion-canvas.is-listening-ring {
    box-shadow:
      0 10px 30px rgba(0, 0, 0, 0.32),
      0 0 0 calc(1px + var(--ring-level, 0) * 2px) var(--ring-color, ${T.accent}),
      0 0 calc(6px + var(--ring-level, 0) * 30px) var(--ring-color, ${T.accent});
    border-color: var(--ring-color, ${T.surfaceBorderAlt});
    transition: box-shadow 120ms ease, border-color 160ms ease;
    animation: companion-ring-breathe 1.4s ease-in-out infinite;
  }

  @keyframes companion-ring-breathe {
    0%, 100% { filter: brightness(1); }
    50% { filter: brightness(calc(1 + var(--ring-level, 0) * 0.25)); }
  }

  .blob {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 8px;
    width: 128px; height: 128px;
    border-radius: 50%;
    background: ${T.surface1};
    border: 2px solid var(--accent, ${T.textMutedLight});
    color: var(--accent, ${T.textMutedLight});
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.22), 0 0 24px var(--accent, transparent);
    transition: border-color 220ms ease, color 220ms ease, box-shadow 220ms ease;
    animation: companion-breathe 2.4s ease-in-out infinite;
  }

  .glyph { display: flex; align-items: center; justify-content: center; }

  .label {
    font-size: var(--font-sm, 12px);
    font-weight: 600;
    letter-spacing: -0.01em;
    color: ${T.onSurface};
    opacity: 0.85;
  }

  /* Speech bubble — speaker-aware. A tiny "You"/"Mouse" label on top of the
     text, distinct color + alignment + tail per side, so it's unmistakable who
     is talking. Long replies wrap + scroll inside the bubble. */
  .bubble {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-width: 88%;
    position: relative;
    font-size: var(--font-sm, 12px);
    line-height: 1.35;
    border-radius: 14px;
    padding: 7px 12px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.24);
    max-height: 96px;
    overflow-y: auto;
    animation: companion-bubble-in 160ms ease;
  }

  .bubble-who {
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    opacity: 0.7;
  }
  .bubble-text { color: ${T.onSurface}; }

  /* YOUR side: accent-tinted, aligned LEFT, tail on the left. */
  .bubble.is-user {
    margin-right: auto;
    background: ${T.accent};
    text-align: left;
  }
  .bubble.is-user .bubble-who { color: ${T.onSurface}; }
  .bubble.is-user .bubble-text { color: ${T.onSurface}; }
  .bubble.is-user::after {
    content: '';
    position: absolute;
    left: 14px; bottom: -5px;
    width: 10px; height: 10px;
    background: ${T.accent};
    transform: rotate(45deg);
    border-radius: 2px;
  }

  /* MOUSE side: neutral surface, aligned RIGHT, tail on the right + a blue
     "Mouse" label matching the talking-state accent. */
  .bubble.is-mouse {
    margin-left: auto;
    background: ${T.surface2};
    border: 1px solid ${T.surfaceBorderAlt};
    text-align: left;
  }
  .bubble.is-mouse .bubble-who { color: ${T.blue}; }
  .bubble.is-mouse::after {
    content: '';
    position: absolute;
    right: 14px; bottom: -5px;
    width: 10px; height: 10px;
    background: ${T.surface2};
    border-right: 1px solid ${T.surfaceBorderAlt};
    border-bottom: 1px solid ${T.surfaceBorderAlt};
    transform: rotate(45deg);
    border-radius: 2px;
  }

  @keyframes companion-bubble-in {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: translateY(0); }
  }

  @keyframes companion-breathe {
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.04); }
  }
  `
}

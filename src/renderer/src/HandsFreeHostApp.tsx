import type { JSX } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useVoiceActivity, encodeVoiceSegmentToWav, type VoiceActivitySegment } from './hooks/useVoiceActivity'
import { HANDS_FREE_STATE, type HandsFreeState } from '../../shared/hands-free-state'
import { CONFIG } from '../../shared/config'

// 12s, not the ~2s a local model load takes: macOS's mic permission prompt is
// user-paced, and cutting someone off mid-reach for the Allow button would turn
// a working start into a failure. Long enough to answer, short enough that a
// real hang doesn't read as forever.
const MIC_START_TIMEOUT_MS = 12_000

/**
 * Hands-free dictation's host renderer (`?window=handsfree`) — the mic and the
 * VAD, and nothing else. It renders no UI: the mode's visible surface is the
 * HUD card in main (see capture/hands-free.ts). This window exists purely
 * because vad-web needs a DOM `getUserMedia` + `AudioWorklet`, which main
 * cannot provide (useVoiceActivity.ts's module doc has the full reasoning).
 *
 * The window's whole lifetime IS one hands-free session — main opens it on
 * start and closes it on stop — so the VAD is unconditionally enabled here
 * rather than gated on a pref.
 */
export default function HandsFreeHostApp(): JSX.Element {
  const handleSegment = useCallback((segment: VoiceActivitySegment) => {
    window.api.handsFreeSegment(new Uint8Array(encodeVoiceSegmentToWav(segment.audio)))
  }, [])

  const { active, speaking, error } = useVoiceActivity(true, handleSegment)

  // MicVAD.new() REJECTS on a denied mic or a bad model, which `error` covers.
  // It can also never settle at all — an unanswered permission prompt, a stalled
  // AudioWorklet — and that path sets no signal, leaving the HUD on "warming
  // up…" with no way out but the stop hotkey. This is the exit for that case.
  const [timedOut, setTimedOut] = useState(false)
  useEffect(() => {
    if (active || error) return
    const timer = setTimeout(() => setTimedOut(true), MIC_START_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [active, error])

  const failure = error ?? (timedOut ? CONFIG.UI_LABELS.HANDS_FREE_HUD_MIC_TIMEOUT : null)

  // One derived state, not three signals: the HUD asks "what state is this in",
  // the same question the phone's pill answers. Precedence is failure first,
  // then speech, then readiness — `active` only flips once the mic is granted
  // and the model has loaded, which is what `starting` covers.
  const state: HandsFreeState = failure
    ? HANDS_FREE_STATE.failed
    : !active
      ? HANDS_FREE_STATE.starting
      : speaking
        ? HANDS_FREE_STATE.speaking
        : HANDS_FREE_STATE.listening

  useEffect(() => {
    window.api.handsFreeHostState(failure ? { state, message: failure } : { state })
  }, [state, failure])

  return <></>
}

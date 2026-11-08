import { clipboard } from 'electron'
import { CONFIG } from '../../shared/config'
import { HUD_CAPTURE, HUD_MODE } from '../../shared/types'
import { pasteText } from '../platform'
import { setActivity } from '../activity'
import {
  startHud,
  updateHud,
  dismissHud,
  doneHud,
  failHud,
  morphHud,
  updateHudSpeaking,
  widenHud,
  narrowHud
} from '../hud-window'
import { startHandsFreeHost, stopHandsFreeHost } from '../hands-free-host'
import { transcribeSegment } from './segmented-listen'
import { HANDS_FREE_STATE, type HandsFreeHostState } from '../../shared/hands-free-state'
import { countWords } from './whisper'
import { EVENTS } from '../store/events'
import { SPEECH } from '../store/speech'

/**
 * Hands-free dictation — consumer #2 of the segmented-listen core. The mic
 * stays open and every pause pastes what was said at the cursor, until the
 * user stops it. Live Companion is consumer #1 (`live-listen.ts`); both share
 * `segmented-listen.ts` and the same renderer-side VAD.
 *
 * Started by a double-tap of the listen hotkey (`capture/index.ts`), stopped by
 * a single tap. There is deliberately no setting: the gesture IS the entry
 * point, so the mode can never be armed-but-unavailable.
 */

/** The one live session, or null. Hands-free is global — a second start while
 *  one runs is a no-op, not a second mic. */
/** `pending` counts utterances HANDED to whisper; `segments` counts the ones that
 *  came back with words. They differ (silence, failures), and the card id has to
 *  key off the former — it's minted before the outcome is known. */
let session: {
  runId: string
  startedAt: number
  segments: number
  words: number
  pending: number
} | null = null

/** One card per utterance. Derived from the session id + a counter, so two
 *  utterances inside the same millisecond can't collide (rid() is ms-resolution). */
function segmentHudId(runId: string, seq: number): string {
  return `${runId}:s${seq}`
}

/** Same shape as capture/index.ts's rid() so hands-free runs sort alongside
 *  every other capture in runs/ and the history panel. */
function rid(): string {
  return `hf:${(Date.now() % 0xffff).toString(16).padStart(4, '0')}`
}

export function isHandsFreeActive(): boolean {
  return session !== null
}

/** The live session's HUD card, so the Esc→Enter cancel can arm the right one. */
export function handsFreeHudId(): string | null {
  return session?.runId ?? null
}

/** `starting` is load-bearing: the VAD model is ~15MB, and a mic that only lit
 *  up once ready reads as a dropped gesture. */
function showStarting(runId: string): void {
  startHud(
    runId,
    CONFIG.UI_LABELS.HANDS_FREE_HUD,
    CONFIG.UI_LABELS.HANDS_FREE_HUD_STARTING,
    HUD_MODE.recording,
    HUD_CAPTURE.handsFree
  )
}

/** Ready and listening — the steady state, and where the stop instruction lives. */
function showListening(runId: string): void {
  morphHud(
    runId,
    HUD_CAPTURE.handsFree,
    CONFIG.UI_LABELS.HANDS_FREE_HUD,
    CONFIG.UI_LABELS.HANDS_FREE_HUD_LISTENING
  )
}

/**
 * Begin a hands-free session. Idempotent: calling it while one is live returns
 * false rather than opening a second mic.
 */
export function startHandsFree(): boolean {
  if (session) return false
  const runId = rid()
  session = { runId, startedAt: Date.now(), segments: 0, words: 0, pending: 0 }
  showStarting(runId)
  setActivity('listening', CONFIG.UI_LABELS.HANDS_FREE_HUD)
  EVENTS.append({ run_id: runId, event: 'hands_free_start' })
  startHandsFreeHost()
  return true
}

/** End the live session, if any. Safe to call when nothing is running. */
export function stopHandsFree(): void {
  if (!session) return
  const { runId, startedAt, segments, words } = session
  session = null
  stopHandsFreeHost()
  dismissHud(runId)
  setActivity('done', CONFIG.UI_LABELS.HANDS_FREE_HUD_DONE)
  EVENTS.append({
    run_id: runId,
    event: 'hands_free_stop',
    duration_s: Math.round((Date.now() - startedAt) / 1000),
    segments,
    chars: words
  })
}

/**
 * The host renderer's VAD state, rendered onto the HUD. One entry point taking
 * one enum, mirroring how the phone's pill answers the same question — two
 * surfaces owning one mode is exactly where a second vocabulary would drift.
 *
 * `off` never arrives from the host: the window's lifetime IS the session, so
 * stopping is main's decision (`stopHandsFree`), not the renderer's.
 */
export function setHandsFreeHostState({ state, message }: HandsFreeHostState): void {
  if (!session) return
  const { runId } = session

  switch (state) {
    case HANDS_FREE_STATE.starting:
      showStarting(runId)
      return
    case HANDS_FREE_STATE.listening:
      showListening(runId)
      updateHudSpeaking(runId, false)
      // Back to the instruction line, which needs the room.
      widenHud(runId)
      return
    case HANDS_FREE_STATE.speaking:
      updateHud(runId, CONFIG.UI_LABELS.HANDS_FREE_HUD_SPEAKING, true)
      updateHudSpeaking(runId, true)
      // The wave replaces the text while talking — 320px of pill around a
      // waveform reads as a broken layout, so track the content.
      narrowHud(runId)
      return
    case HANDS_FREE_STATE.failed: {
      // Mic denied or the model failed to load — nothing to retry into, so the
      // session ends rather than sitting on a HUD that will never hear anything.
      const reason = message ?? CONFIG.UI_LABELS.HANDS_FREE_HUD_FAILED
      session = null
      stopHandsFreeHost()
      failHud(runId, reason)
      setActivity('error', CONFIG.UI_LABELS.HANDS_FREE_HUD_FAILED)
      EVENTS.append({ run_id: runId, event: 'hands_free_failed', error: reason })
      return
    }
    case HANDS_FREE_STATE.off:
      return
  }
}

/**
 * One VAD-bounded segment: transcribe it and paste it at the cursor. Each
 * segment is its own paste — that continuous drip IS the mode, as opposed to
 * plain dictation's one paste on stop.
 *
 * Never throws: a failed segment leaves the session listening, because the next
 * utterance is very likely fine and tearing the mode down mid-sentence is worse
 * than dropping one phrase.
 */
export async function handleHandsFreeSegment(wavBytes: Uint8Array): Promise<void> {
  if (!session) return
  const { runId } = session

  // Raise the card HERE, not after whisper returns: this call IS the moment the
  // VAD decided you stopped talking, and whisper takes ~1.2s. Showing it only on
  // completion left a dead beat where the mode card had gone quiet and nothing
  // acknowledged the utterance. The seq is claimed now so it survives the await.
  const seq = ++session.pending
  const segId = segmentHudId(runId, seq)
  startHud(
    segId,
    CONFIG.UI_LABELS.HANDS_FREE_SEGMENT_HUD,
    CONFIG.UI_LABELS.HANDS_FREE_SEGMENT_WORKING,
    HUD_MODE.act,
    HUD_CAPTURE.handsFree
  )

  const result = await transcribeSegment(wavBytes)
  // Re-check: the user may have tapped stop while whisper was running, and a
  // paste landing after that would type into whatever they moved on to. Every
  // exit past this point owns segId — an early return that skips it strands a
  // card on "transcribing…" with nothing left alive to finish it.
  if (!session) {
    dismissHud(segId)
    return
  }

  if (!result.ok) {
    EVENTS.append({ run_id: runId, event: 'hands_free_segment_failed', error: result.error })
    failHud(segId, result.error ?? CONFIG.UI_LABELS.HANDS_FREE_HUD_FAILED)
    return
  }

  const text = result.text.trim()
  // countWords, not truthiness: silence transcribes to markers like
  // [BLANK_AUDIO], which are non-empty and would paste verbatim.
  if (countWords(text) === 0) {
    // Nothing was said — a card reading "nothing heard" is noise, so it just goes.
    dismissHud(segId)
    return
  }

  session.segments += 1
  session.words += result.wordCount

  clipboard.writeText(text)
  try {
    await pasteText(text)
  } catch (err) {
    console.error('hands-free paste failed:', err)
  }

  SPEECH.append({
    ts: new Date().toISOString(),
    run_id: runId,
    words: result.wordCount,
    duration_s: 0,
    chars: text.length,
    ok: true
  })
  EVENTS.append({
    run_id: runId,
    event: 'hands_free_segment',
    chars: text.length,
    transcribe_ms: result.tookMs
  })

  doneHud(segId, true, text, undefined, 0, { transcribeMs: result.tookMs })
}

import { CONFIG } from '@shared/config'

/** Hands-free dictation's decisions, split from `useHandsFreeMic` so they are
 *  testable without a DOM. The hook still owns the mic, VAD and recorder. */

export interface SegmentOutcomeInput {
  /** Blobs collected by MediaRecorder. Empty means the stop discarded them. */
  chunkCount: number
  durationMs: number
}

export type SegmentOutcome = 'send' | 'drop-empty' | 'drop-short'

/** Short segments are dropped before the network, not after: a cough is ~100ms
 *  and a whisper hop is not free. */
export function segmentOutcome({ chunkCount, durationMs }: SegmentOutcomeInput): SegmentOutcome {
  if (chunkCount <= 0) return 'drop-empty'
  if (durationMs < CONFIG.PHONE_REMOTE.MIN_RECORDING_MS) return 'drop-short'
  return 'send'
}

export interface UtteranceStartInput {
  disposed: boolean
  hasStream: boolean
  manualHold: boolean
}

/** A manual hold owns the recorder for its whole duration: the VAD keeps running
 *  (it drives the speaking indicator) but a second recorder here would leave two
 *  racing to stop one stream. */
export function shouldStartUtterance({ disposed, hasStream, manualHold }: UtteranceStartInput): boolean {
  return !disposed && hasStream && !manualHold
}

export interface PadWindowInput {
  /** Chunk boundaries, oldest first, as ms since the recorder started. */
  chunkEndsAt: number[]
  /** When the VAD called speech-start, same clock. */
  speechStartedAt: number
  padMs: number
}

/** How many trailing chunks to keep so an utterance carries `padMs` of audio
 *  from BEFORE the VAD fired. The VAD needs ~200-500ms of speech to decide
 *  speech is happening, so the word that triggered it is already in the past by
 *  the time onSpeechStart runs — a recorder started there loses the head of
 *  every utterance, and a short one entirely. Counts back from the cut, keeping
 *  the first chunk that starts at or before the pad boundary. */
export function padChunkCount({ chunkEndsAt, speechStartedAt, padMs }: PadWindowInput): number {
  const boundary = speechStartedAt - padMs
  let kept = 0
  for (let i = chunkEndsAt.length - 1; i >= 0; i--) {
    kept++
    // This chunk STARTS at the previous chunk's end; once that is at or before
    // the boundary the pad is covered and older chunks are dead weight.
    const startsAt = i === 0 ? 0 : chunkEndsAt[i - 1]
    if (startsAt <= boundary) break
  }
  return kept
}

export type MicState = 'idle' | 'opening' | 'recording' | 'toggled'

/** Only `opening` is stuck; every other state has capture running. `toggled` is
 *  a short tap's live recording — cancelling it killed tap-to-record at 6s. */
export function micOpenTimedOut(state: MicState): boolean {
  return state === 'opening'
}

export interface ArmedInput {
  connected: boolean
  error: string | null
}

/** Losing any gate disarms rather than pausing: a segment finishing against a
 *  dead socket cannot paste, and coming back armed is not something the user
 *  asked for. */
export function staysArmed({ connected, error }: ArmedInput): boolean {
  return connected && error === null
}

export type MicSource = 'share-handsfree' | 'open-own'

/** The mirror's WebRTC mic. A second getUserMedia while hands-free holds one
 *  open re-prompts on iOS and can silence one of the two, so borrow instead —
 *  and clone the track, since stopMirror stops whatever it was handed. */
export function micSourceForMirror(handsFreeStreamLive: boolean): MicSource {
  return handsFreeStreamLive ? 'share-handsfree' : 'open-own'
}

export type HandsFreeDisplay = 'off' | 'starting' | 'listening'

/** `starting` is load-bearing: ~15MB of model + wasm loads first, so a mic that
 *  only lit up once ready would look like it ignored the long-press. */
export function handsFreeDisplay(armed: boolean, ready: boolean): HandsFreeDisplay {
  if (!armed) return 'off'
  return ready ? 'listening' : 'starting'
}

export interface LongPressArmInput {
  /** Sustained voice detected at any point since pointerdown. */
  voiceHeard: boolean
  micOpening: boolean
  micRecording: boolean
}

export type LongPressArmAction = 'arm' | 'recheck' | 'stand-down'

/** The long-press arm fires only on a provably SILENT hold — hold-and-talk is a
 *  dictation, and this gate is what lets the two gestures share the mic without
 *  a timing collision (a shared 500ms threshold once ate every dictation). A
 *  mic still opening can't prove silence yet; a failed one is nothing to arm over. */
export function longPressArmAction({ voiceHeard, micOpening, micRecording }: LongPressArmInput): LongPressArmAction {
  if (voiceHeard) return 'stand-down'
  if (micOpening) return 'recheck'
  return micRecording ? 'arm' : 'stand-down'
}

/** The class the mic carries per state, shared by both layouts so a skin only
 *  ever has to style one set of names. `speaking` seats the button for the
 *  duration of an utterance -- armed-but-idle deliberately does not seat. */
export function handsFreeMicClass(state: HandsFreeDisplay, speaking = false): string {
  if (state === 'off') return ''
  if (state === 'starting') return ' handsFreeStarting'
  return speaking ? ' handsFree handsFreeHot' : ' handsFree'
}

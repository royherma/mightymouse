/**
 * Live Voice Companion — character state union.
 *
 * The companion overlay (?window=companion) cycles through these states to show
 * what the mouse character is "doing" at any moment. Phase 0 drives this with a
 * scripted timer loop (no mic, no LLM); later phases drive it from the real
 * VoiceInputSource/ResponseSource/SpeechOutput pipeline (see the PRD's §6 adapter
 * seam) without changing this union or its consumers.
 *
 * Named union + const array (not bare string literals) per the repo's no-magic-
 * strings rule — anything that compares against a companion state does so through
 * `CompanionState` or `COMPANION_STATES`, never a hand-typed string.
 */

export const COMPANION_STATES = ['idle', 'listening', 'thinking', 'talking', 'reacting'] as const

export type CompanionState = (typeof COMPANION_STATES)[number]

export function isCompanionState(value: unknown): value is CompanionState {
  return typeof value === 'string' && (COMPANION_STATES as readonly string[]).includes(value)
}

/** Human-readable label per state, for the Phase 0 placeholder + any debug UI. */
export const COMPANION_STATE_LABEL: Record<CompanionState, string> = {
  idle: 'Idle',
  listening: 'Listening',
  thinking: 'Thinking…',
  talking: 'Talking',
  reacting: 'Reacting'
}

/**
 * One finished voice turn, pushed main → companion renderer once a VAD segment
 * (see `useVoiceActivity.ts`) has been transcribed and answered. See
 * `live-listen.ts` (`TranscriptSource` + `ResponseSource`) and
 * `CHANNELS.liveTurnResult` in ipc.ts.
 *
 * `ok: false` means transcription (or, in Phase 2+, the LLM turn) failed —
 * `error` carries a short reason and `transcript`/`reply` are empty; the
 * companion falls back to idle rather than show garbage.
 *
 * Phase 2 (`SpeechOutput`, real `src/main/audio/tts.ts`): `audio` carries the
 * spoken reply's raw encoded bytes for the renderer to play and derive its
 * RMS-driven mouth-openness signal from — see `useAudioPlayback.ts`. Electron's
 * `webContents.send` structured-clones a `Uint8Array` natively (same as
 * `liveTurnSubmit` already ships one main-ward), so no base64 round-trip is
 * needed. `audio` is undefined/absent whenever TTS produced nothing (no key
 * configured, empty reply, or a request failure) — the companion still shows
 * the caption, it just doesn't speak. Never a secret: just encoded mp3 bytes.
 */
export interface LiveDraft {
  text: string
  addressed: boolean
}

export interface LiveTurnResult {
  ok: boolean
  ignored?: boolean
  transcript: string
  reply: string
  error?: string
  audio?: Uint8Array
  audioMimeType?: string
  spokenText?: string
  /**
   * Mighty session this turn landed in — the same conversation typing would have
   * produced, so a spoken exchange is resumable in chat. Absent when the turn
   * never reached the LLM (empty transcript, transcribe failure). The renderer
   * doesn't need to echo it back: main holds the live session (see
   * live-listen.ts's liveSessionId) so a renderer reload can't split a
   * conversation in two.
   */
  sessionId?: string
}

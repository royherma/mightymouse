/**
 * Live Voice Companion — debug/verify stage events (Phase 0.5 of the design,
 *
 * Every adapter behind the companion's §6 seam (VoiceInputSource,
 * TranscriptSource, ResponseSource, SpeechOutput, CharacterRenderer — mock AND
 * real, once Phases 1-4 build them) emits one `CompanionStageEvent` per stage
 * transition. This is a cheap, typed observability hook — NOT a new transport:
 * it reuses the same `webContents.send` → `CHANNELS.*` → `ipcRenderer.on`
 * streaming pattern already proven by `CHANNELS.islandActivity` /
 * `CHANNELS.busyPhase`. The dev-only `CompanionDebugPanel` is the only
 * consumer today.
 *
 * Named unions + a const array (not bare string literals), per the repo's
 * no-magic-strings rule — anything that compares against a stage or provider
 * does so through these exports, never a hand-typed string.
 */

/** Which leg of the companion pipeline this event describes. */
export const COMPANION_STAGES = [
  'voice-input',
  'transcript',
  'response',
  'speech-output',
  'character-renderer',
  // Phase 4 (screen-aware vision, companion-vision-trigger.ts +
  // companion-orchestrator.ts): fired when a voice turn's transcript trips the
  // on-screen-reference trigger and a screenshot is attached to the ask call.
  'vision',
  // One action the agent took while driving the Mac — a click, a keystroke, a
  // fresh screenshot. Unlike the stages above (one per turn, one per pipeline
  // leg), a single turn emits one of these per STEP, which is what makes a long
  // act run legible instead of one silent minute of `thinking`.
  'step',
  'wake'
] as const

export const WAKE_EVENT = { armed: 'armed', request: 'request', stop: 'stop' } as const
export type WakeEventKind = (typeof WAKE_EVENT)[keyof typeof WAKE_EVENT]

export type CompanionStage = (typeof COMPANION_STAGES)[number]

/** Lifecycle of one stage's unit of work. */
export const COMPANION_STAGE_STATES = ['start', 'ok', 'error'] as const

export type CompanionStageState = (typeof COMPANION_STAGE_STATES)[number]

/**
 * One stage-event, as emitted by an adapter and pushed to the debug panel.
 * `tookMs` is only meaningful on `ok`/`error` (the terminal edge) — omit or 0
 * on `start`. `detail` is a short free-text note (e.g. a canned transcript, an
 * error message) for the panel's expanded row, not a structured field.
 */
export interface CompanionStageEvent {
  stage: CompanionStage
  /** Which concrete adapter fired this, e.g. 'mock', 'whisper', 'elevenlabs'. */
  provider: string
  state: CompanionStageState
  /** Wall-clock ms this stage took, if known. */
  tookMs?: number
  detail?: string
  /** Absolute path to a screenshot this event produced, if any. The renderer
   *  turns it into a URL with `window.api.mediaUrl()` — main deliberately does
   *  NOT send a media:// URL, so the scheme's encoding lives in exactly one
   *  place (preload/index.ts:475) the way HudPreview already does it. */
  imagePath?: string
  /** Wall-clock ms this event was created, for panel ordering/relative time. */
  ts: number
  /** The model that ran this turn, as `runLabel()` renders it ("Claude Code ·
   *  Opus 5"). Only the `response` stage sets it — that's the only stage that
   *  runs a model. The SAME string the agent is told it is (run-mighty.ts:134),
   *  so what the panel reports and what the model claims can never drift. */
  model?: string
}

/** Human-readable label per stage, for the debug panel's column. */
export const COMPANION_STAGE_LABEL: Record<CompanionStage, string> = {
  'voice-input': 'Voice input',
  transcript: 'Transcript',
  response: 'Response',
  'speech-output': 'Speech output',
  'character-renderer': 'Character',
  vision: 'Vision',
  step: 'Step',
  wake: 'Wake phrase'
}

/** How many recent stage events the debug panel keeps in view. Several turns'
 *  worth — a turn burns ~6 events, and comparing a bad turn against the good one
 *  before it is the whole point of keeping a scrollback.
 *
 *  Raised from 200 once a turn could DRIVE the Mac: an act run emits one `step`
 *  per click/keystroke/screenshot, so a single "book me a flight" turn can spend
 *  40+ on its own and the previous turn — the one you're comparing against —
 *  would scroll out of the buffer before it finished. */
export const COMPANION_DEBUG_MAX_EVENTS = 500

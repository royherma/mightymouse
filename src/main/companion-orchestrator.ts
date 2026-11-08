import { CONFIG } from '../shared/config'
import { WAKE_EVENT } from '../shared/companion-debug'
import { PREFS } from './store/prefs'
import { runMighty } from './mighty/run-mighty'
import { abortRun, resolveRunModel } from './backend/runner'
import { speak, resolvedTtsProvider } from './audio/tts'
import { sendCompanionStageEvent, setCompanionRunActive } from './companion-window'
import { actStepLabel } from '../shared/act-step-label'
import { runLabel } from '../shared/model-label'
import { fireScreenshot } from './capture/screenshot'
import { looksLikeScreenReference } from '../shared/companion-vision-trigger'
import type { MediaAttachment, SpokenWord, TurnUsage } from '../shared/types'

/**
 * Live Voice Companion — the LLM half of a spoken turn.
 *
 * A voice turn runs through `runMighty` with `source: 'voice'`, exactly like the
 * phone does with `source: 'phone'`. That single call is what makes speaking and
 * typing the same conversation: the turn lands in a real Mighty session, shows up
 * in History, resumes on any surface, and carries the previous turns as context —
 * none of which is voice-specific code here, it all falls out of the session model.
 *
 * `hud-run.ts` is still deliberately NOT called: that pipeline is wired to HUD
 * cards, the panel renderer, and paste-focus logic a headless voice turn has no
 * window to route to. `runMighty` is the seam without those ties.
 *
 * What voice DOES change about the run is spoken-answer shape — see
 * `CONFIG.SYSTEM_PROMPT_VOICE_BREVITY`, appended by `buildMightySystemPrompt` for
 * this source only. Everything else (backend, model, project, memory, sandbox) is
 * whatever the user's chat would have used.
 */

export interface CompanionAskResult {
  ok: boolean
  reply: string
  error?: string
  /**
   * Session this turn landed in — the SAME id on every following turn, which is
   * what gives voice its memory. Callers hold it and pass it back in.
   */
  sessionId: string
  /** ms spent in the LLM call only. */
  tookMs: number
  usage?: TurnUsage
  answeredBy: { backend: string; model: string; label: string }
}

export interface CompanionSpeakResult {
  /** Raw encoded audio bytes (mp3), or null when TTS is silent (no key, empty
   *  reply, or a request failure — see tts.ts's graceful no-throw contract). */
  audio: Uint8Array | null
  mimeType: string
  /** ms spent in the TTS call only. */
  tookMs: number
  provider: string
  words?: SpokenWord[]
}

/** Which concrete adapter fired a stage event in this phase — matches the
 *  `provider` free-text field on CompanionStageEvent (companion-debug.ts). */
const RESPONSE_STAGE_PROVIDER = {
  /** Prefixed so the debug panel can tell "real ask, backend X" from Phase 1's
   *  'mock' canned-reply provider at a glance. */
  prefix: 'ask:'
} as const

/** `provider` value the vision stage-event uses — matches the OS screenshot tool. */
const VISION_STAGE_PROVIDER = 'screencapture'

/**
 * Phase 4 (screen-aware vision) — timestamps (ms) of the most recent turns
 * that attached a screenshot, oldest first. In-memory only: the companion
 * process is the only writer/reader and a restart resetting the window is
 * fine (nothing here is a persisted user setting, unlike PREFS toggles).
 */
const visionAttachTimestamps: number[] = []

/**
 * The companion's in-flight run, or null between turns.
 *
 * Held so "stop" kills THIS run and nothing else — `abortAllRuns()` would also
 * take out a panel or scheduled run the user never spoke to, which is a much
 * bigger blast radius than the word "stop" promises.
 */
let liveRunId: string | null = null

/**
 * Kill the live turn that's running right now. Returns true if there was one.
 *
 * Only meaningful once a turn can DRIVE the Mac: before that, "stop" just had to
 * drop a reply (the renderer's own turn-id bump does that). A run that is clicking
 * through Safari keeps clicking until the process dies, so the reply-drop alone
 * left the user watching the thing they just told to stop.
 */
export function abortCompanionTurn(): boolean {
  if (!liveRunId) return false
  const killed = abortRun(liveRunId)
  liveRunId = null
  return killed
}

/**
 * True if attaching another screenshot right now would stay within
 * `CONFIG.COMPANION.VISION_MAX_TURNS_PER_MIN`. Prunes timestamps older than a
 * minute as a side effect so the array never grows unbounded across a long
 * live-mode session.
 */
function underVisionRateLimit(now: number): boolean {
  const windowStart = now - 60_000
  while (visionAttachTimestamps.length > 0 && visionAttachTimestamps[0] < windowStart) {
    visionAttachTimestamps.shift()
  }
  return visionAttachTimestamps.length < CONFIG.COMPANION.VISION_MAX_TURNS_PER_MIN
}

/**
 * Phase 4 (screen-aware vision): if `transcript` looks like
 * it's referencing on-screen content AND the per-minute rate guard has
 * headroom, grab a screenshot via the EXISTING `screenshot.ts` capture util
 * (same `fireScreenshot()` the panel's ⌘⌥⇧O hotkey calls) and return it as a
 * `MediaAttachment` ready for `runBackend`'s `attachments` list — the same
 * plumbing `hud-run.ts` uses for the panel's "see my screen" context image, no
 * new vision-attach path. Returns `null` (no attachment) when the trigger
 * doesn't fire, the rate guard is exhausted, or the capture itself fails —
 * any of these just means the turn answers without vision, never a thrown
 * error. Emits one `vision` stage-event either way so the debug panel shows
 * why a turn did or didn't see the screen.
 */
async function maybeAttachScreenshot(transcript: string): Promise<MediaAttachment | null> {
  if (!looksLikeScreenReference(transcript)) return null

  const now = Date.now()
  if (!underVisionRateLimit(now)) {
    sendCompanionStageEvent({
      stage: 'vision',
      provider: VISION_STAGE_PROVIDER,
      state: 'error',
      detail: `rate limited (max ${CONFIG.COMPANION.VISION_MAX_TURNS_PER_MIN}/min)`,
      ts: now
    })
    return null
  }

  const startedAt = Date.now()
  sendCompanionStageEvent({ stage: 'vision', provider: VISION_STAGE_PROVIDER, state: 'start', ts: startedAt })

  try {
    const capture = await fireScreenshot()
    if (!capture.screenshotPath) {
      sendCompanionStageEvent({
        stage: 'vision',
        provider: VISION_STAGE_PROVIDER,
        state: 'error',
        tookMs: Date.now() - startedAt,
        detail: 'no screenshot path returned',
        ts: Date.now()
      })
      return null
    }

    visionAttachTimestamps.push(startedAt)
    sendCompanionStageEvent({
      stage: 'vision',
      provider: VISION_STAGE_PROVIDER,
      state: 'ok',
      tookMs: Date.now() - startedAt,
      detail: capture.screenshotPath,
      ts: Date.now()
    })
    return { path: capture.screenshotPath, kind: 'image' }
  } catch (err) {
    sendCompanionStageEvent({
      stage: 'vision',
      provider: VISION_STAGE_PROVIDER,
      state: 'error',
      tookMs: Date.now() - startedAt,
      detail: err instanceof Error ? err.message : String(err),
      ts: Date.now()
    })
    return null
  }
}

/**
 * Run one spoken turn through `runMighty` and return what to say back.
 *
 * Pass `sessionId` to continue an existing conversation — spoken or typed, it's
 * the same session. Omit it on the first turn and read the id off the result;
 * every later turn passes it back, which is the whole of voice's "memory".
 *
 * Never throws: `runMighty` resolves with an `error` field rather than rejecting,
 * so the companion always gets an answer to settle on instead of hanging in
 * "thinking" forever.
 */
export async function runCompanionAskTurn(
  transcript: string,
  sessionId?: string
): Promise<CompanionAskResult> {
  const backend = PREFS.getBackend()
  const provider = `${RESPONSE_STAGE_PROVIDER.prefix}${backend}`
  // The label the run footer and the system prompt both use, so the panel, the
  // UI, and what the model says it is all read from one string.
  const rawModel = resolveRunModel(backend)
  const model = runLabel(backend, rawModel)
  const answeredBy = { backend, model: rawModel, label: model }
  const startedAt = Date.now()

  sendCompanionStageEvent({ stage: 'response', provider, state: 'start', model, ts: startedAt })

  // Can this turn drive the Mac, or only answer? Read per turn so the Settings
  // toggle applies to the very next thing the user says.
  const screenControl = PREFS.getLiveActs()

  // Phase 4: decide (cheap, synchronous trigger check + rate guard) whether
  // this turn should see the screen BEFORE the run starts — a screenshot, if
  // any, rides in as a normal `attachments` entry, same as chat's own media
  // (adapters.ts already knows how to translate a MediaAttachment per-backend;
  // no new vision path here).
  //
  // Skipped entirely under screenControl: runMighty already captures a fresh
  // frame for the control prompt, so this would attach a SECOND picture of the
  // same screen — double the vision tokens, and two images the agent has to
  // guess between when reading off coordinates.
  const visionAttachment = screenControl ? null : await maybeAttachScreenshot(transcript)
  const attachments = visionAttachment ? [visionAttachment] : []

  setCompanionRunActive(true, screenControl, () => {
    abortCompanionTurn()
    setCompanionRunActive(false, false, () => {})
    sendCompanionStageEvent({ stage: 'wake', provider: 'esc', state: 'ok', detail: WAKE_EVENT.stop, ts: Date.now() })
  })
  const result = await runMighty({
    message: transcript,
    sessionId,
    source: 'voice',
    attachments,
    screenControl,
    onRunId: (id) => {
      liveRunId = id
    },
    // The frame the agent is about to read. Shown as a step of its own so the
    // user can see WHAT it looked at — a stale or wrong-display capture is the
    // failure that makes every click after it land in the wrong place, and it
    // is invisible from the labels alone.
    onScreenshot: (screenshotPath) => {
      sendCompanionStageEvent({
        stage: 'step',
        provider,
        state: 'ok',
        detail: 'looked at the screen',
        imagePath: screenshotPath,
        ts: Date.now()
      })
    },
    // Every tool call the agent makes becomes one `step` event. Without this a
    // turn that spends a minute clicking through an app is a single silent
    // `thinking` — the user can't tell driving from hung, and can't tell WHICH
    // click went wrong when it does.
    onEvent: (event) => {
      const label = actStepLabel(event)
      if (!label) return
      sendCompanionStageEvent({
        stage: 'step',
        provider,
        state: 'ok',
        detail: label,
        ts: Date.now()
      })
    }
  })

  // The run is over one way or another — a later "stop" must not kill whatever
  // run happens to be holding this id next.
  liveRunId = null
  setCompanionRunActive(false, false, () => {})

  const tookMs = Date.now() - startedAt

  if (result.error) {
    sendCompanionStageEvent({
      stage: 'response',
      provider,
      state: 'error',
      tookMs,
      model,
      // runMighty's `answer` on a failure is already a human sentence ("That took
      // too long…"), so it's both the debug detail and what gets spoken.
      detail: result.answer || result.error,
      ts: Date.now()
    })
    return { ok: false, reply: result.answer, error: result.error, sessionId: result.sessionId, tookMs, usage: result.usage, answeredBy }
  }

  sendCompanionStageEvent({
    stage: 'response',
    provider,
    state: 'ok',
    tookMs,
    model,
    detail: result.answer,
    ts: Date.now()
  })
  return { ok: true, reply: result.answer, sessionId: result.sessionId, tookMs, usage: result.usage, answeredBy }
}

/**
 * Speak `text` via the real TTS adapter (tts.ts), emitting a `speech-output`
 * stage event either way — 'ok' with the real `elevenlabs` provider, or 'ok'
 * with `silent-no-key` when no key is configured (graceful no-op, not an
 * error: the companion just stays caption-only). A genuine request failure
 * (network/HTTP) is reported as 'error' but still resolves with `audio: null`
 * so the companion falls back to caption-only rather than crashing the turn.
 */
export async function speakCompanionReply(text: string): Promise<CompanionSpeakResult> {
  const startedAt = Date.now()
  // Label the 'start' event up front so the debug panel shows which path is
  // about to run without waiting for the request to resolve.
  sendCompanionStageEvent({
    stage: 'speech-output',
    provider: resolvedTtsProvider(),
    state: 'start',
    ts: startedAt
  })

  const result = await speak(text)
  const tookMs = Date.now() - startedAt

  sendCompanionStageEvent({
    stage: 'speech-output',
    provider: result.provider,
    state: result.error ? 'error' : 'ok',
    tookMs,
    detail: result.error ?? (result.audio ? `${result.audio.byteLength} bytes` : 'silent'),
    ts: Date.now()
  })

  return { audio: result.audio, mimeType: result.mimeType, tookMs, provider: result.provider, words: result.words }
}

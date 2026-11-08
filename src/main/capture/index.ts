// Capture controller: wires the Cmd+Opt+Shift+O tap/hold hotkey to screenshot
// and recording, with HUD feedback. Equivalent to the Hammerspoon init.lua +
// session.lua public surface.
import { clipboard, nativeImage } from 'electron'
import { execFileSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { PATHS } from '../store/paths'
import { HUD_MODE, HUD_CAPTURE, SETTINGS_SECTION } from '../../shared/types'
import { CONFIG } from '../../shared/config'
import { showSettingsWindow } from '../settings-window'
import { startCaptureHotkey, stopCaptureHotkey, isCaptureHotkeyAvailable } from './capture-hotkey'
import { fireScreenshot } from './screenshot'
import {
  ensureScreenPermission,
  openScreenPermissionFix,
  SCREEN_ACTION,
  type ScreenAction,
  ensureMicPermission,
  MIC_ACTION,
  type MicAction
} from './screen-permission'
import {
  startSession,
  stopSession,
  cancelSession,
  detachSession,
  isRecording,
  hasVideoFailed
} from './recorder'
import { startListen, stopListen, cancelListen, detachListen, isListening } from './listen-recorder'
import { startHandsFree, stopHandsFree, isHandsFreeActive, handsFreeHudId } from './hands-free'
import { runSmartDictation } from './smart-dictation'
import { rtfOf, countWords } from './whisper'
import { logCapture } from './capture-actions'
import { pasteText } from '../platform'
import { sendToFirstRunRenderer } from '../first-run-window'
import { CHANNELS } from '../../shared/ipc'
import {
  startHud as rawStartHud,
  updateHud as rawUpdateHud,
  doneHud as rawDoneHud,
  failHud as rawFailHud,
  dismissHud as rawDismissHud,
  armHudCancel as rawArmHudCancel,
  updateHudHoldProgress as rawUpdateHudHoldProgress,
  morphHud as rawMorphHud,
  widenHud as rawWidenHud,
  markHudRouteNext,
  markHudSubmitNext,
  warmHud
} from '../hud-window'
import { EVENTS } from '../store/events'
import { SPEECH } from '../store/speech'
import { PREFS } from '../store/prefs'
import { SETTINGS } from '../store/settings'
import { heldTranscript, offerVoiceRoute } from '../voice-routing/offer'
import { warmJev } from '../actions/decide-transport'
import { prewarmActions } from '../actions/engine'
import { submitFrontmost } from '../voice-routing/deliver'
import { setActivity } from '../activity'
import { track } from '../analytics'
import { ANALYTICS_EVENT, LISTEN_SOURCE } from '../../shared/analytics-events'
import { trackChecklistStep } from '../activation-checklist'

function rid(): string {
  return `c:${(Date.now() % 0xffff).toString(16).padStart(4, '0')}`
}

// HUD is user-toggleable (Settings → "Show capture HUD"). Read the pref fresh
// per call so a toggle takes effect without restarting. When off, all four
// become no-ops — capture/recording/transcription still run, just silently.
const hudOn = (): boolean => PREFS.getCaptureHud()
const startHud: typeof rawStartHud = (...a) => {
  if (hudOn()) rawStartHud(...a)
}
const updateHud: typeof rawUpdateHud = (...a) => {
  if (hudOn()) rawUpdateHud(...a)
}
const doneHud: typeof rawDoneHud = (...a) => {
  if (hudOn()) rawDoneHud(...a)
}
const failHud: typeof rawFailHud = (...a) => {
  if (hudOn()) rawFailHud(...a)
}
const dismissHud: typeof rawDismissHud = (...a) => {
  if (hudOn()) rawDismissHud(...a)
}
const armHudCancel: typeof rawArmHudCancel = (...a) => {
  if (hudOn()) rawArmHudCancel(...a)
}
const updateHudHoldProgress: typeof rawUpdateHudHoldProgress = (...a) => {
  if (hudOn()) rawUpdateHudHoldProgress(...a)
}
const morphHud: typeof rawMorphHud = (...a) => {
  if (hudOn()) rawMorphHud(...a)
}
const widenHud: typeof rawWidenHud = (...a) => {
  if (hudOn()) rawWidenHud(...a)
}

async function handleTap(): Promise<void> {
  const runId = rid()
  startHud(runId, '📸 Screenshot', 'capturing…', HUD_MODE.screenshot)
  setActivity('screenshot')
  EVENTS.append({ run_id: runId, event: 'capture_tap' })
  // Ask BEFORE capturing: screencapture returns a black PNG rather than an error
  // when the grant is missing, so the catch below can never see it.
  if (!(await guardScreen(SCREEN_ACTION.screenshot, runId))) return
  try {
    const res = await fireScreenshot()
    // Drop the image straight onto the clipboard so it's ready to paste anywhere.
    if (res.screenshotPath) {
      clipboard.writeImage(nativeImage.createFromPath(res.screenshotPath))
    }
    // Log it into runs/ + the history panel, and offer Ask/Act: the agent gets the
    // image + its folder as context and can describe it, extract text, or act on it.
    const { folder, screenshotPath } = logCapture({
      runId,
      kind: 'screenshot',
      folder: res.folder,
      screenshotPath: res.screenshotPath
    })
    doneHud(runId, true, 'Screenshot saved', folder, undefined, {
      actions: ['ask', 'act'],
      preview: screenshotPath ? { path: screenshotPath, kind: 'image' } : null
    })
    setActivity('done', 'Screenshot saved')
    EVENTS.append({ run_id: runId, event: 'screenshot_done', folder })
    track(ANALYTICS_EVENT.capture_screenshot)
  } catch (err) {
    failHud(runId, 'screenshot failed (Screen Recording permission?)')
    setActivity('error', 'Screenshot failed')
    EVENTS.append({ run_id: runId, event: 'screenshot_failed', error: String(err) })
  }
}

let recordingHudId: string | null = null
let maxRecTimer: NodeJS.Timeout | null = null
let capHit = false
let recordLastFired = 0
const RECORD_COOLDOWN_MS = 1000

// Two-step discard: Esc arms (reveals the "Esc again to cancel" hint), a second Esc within
// CANCEL_DOUBLE_ESC_MS confirms. Cleared on each capture start.
let cancelArmed = false
let cancelArmTimer: NodeJS.Timeout | null = null
const CANCEL_DOUBLE_ESC_MS = 1500

// The HUD auto-dismisses, so text alone can't carry this fix — open Settings at
// the Install button. Deliberately ONLY this failure; the rest have no button.
function openFixIfFfmpegMissing(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  if (message !== CONFIG.CAPTURE_ERROR.ffmpegMissing) return
  showSettingsWindow(SETTINGS_SECTION.binaries)
}

/**
 * Screen-permission gate for a capture run that has already opened a HUD.
 *
 * On denial the HUD carries the message (it's the surface the user is looking
 * at) and the Setup window opens behind it, where the grant row and its button
 * live — so the run ends in a fix, not a black frame. Returns false when the
 * caller must abort.
 */
async function guardScreen(action: ScreenAction, runId: string): Promise<boolean> {
  const ok = await ensureScreenPermission(action, (message) => {
    failHud(runId, message)
    setActivity('error', message)
    openScreenPermissionFix()
  })
  if (!ok) EVENTS.append({ run_id: runId, event: 'screen_permission_blocked', action })
  return ok
}

/** Same gate for the mic. A denied mic records silence, never an error. */
async function guardMic(action: MicAction, runId: string): Promise<boolean> {
  const ok = await ensureMicPermission(action, (message) => {
    failHud(runId, message)
    setActivity('error', message)
    openScreenPermissionFix()
  })
  if (!ok) EVENTS.append({ run_id: runId, event: 'mic_permission_blocked', action })
  return ok
}

async function handleHoldStart(): Promise<void> {
  const now = Date.now()
  if (now - recordLastFired < RECORD_COOLDOWN_MS) return
  recordLastFired = now

  const runId = rid()
  recordingHudId = runId
  capHit = false
  cancelArmed = false
  startHud(runId, '🔴 Recording', 'audio + video + events', HUD_MODE.recording, HUD_CAPTURE.screen)
  setActivity('recording')
  EVENTS.append({ run_id: runId, event: 'recording_start' })
  // Without this the HUD flips to "🔴 Recording" over an ffmpeg process that is
  // capturing a black stream (or already dead) — the user films nothing.
  if (!(await guardScreen(SCREEN_ACTION.recording, runId))) {
    recordingHudId = null
    return
  }
  // Screen alone isn't enough here: this path films AND records, so a denied mic
  // yields a video with a silent track that looks fine until playback.
  if (!(await guardMic(MIC_ACTION.recording, runId))) {
    recordingHudId = null
    return
  }
  try {
    await startSession()
  } catch (err) {
    recordingHudId = null
    failHud(runId, err instanceof Error ? err.message : String(err))
    setActivity('error', 'Recording failed')
    EVENTS.append({ run_id: runId, event: 'recording_failed', error: String(err) })
    openFixIfFfmpegMissing(err)
    return
  }

  // A spawn error arrives on the next tick, after startSession() has already
  // resolved — so a dead video process can only be caught here, not by the
  // catch above. Without this the HUD sits on "🔴 Recording" over nothing.
  await new Promise((r) => setTimeout(r, CONFIG.RECORDER_SPAWN_GRACE_MS))
  if (hasVideoFailed()) {
    await cancelSession()
    recordingHudId = null
    failHud(runId, CONFIG.CAPTURE_ERROR.videoFailed)
    setActivity('error', 'Recording failed')
    EVENTS.append({ run_id: runId, event: 'recording_failed', error: 'video process failed' })
    return
  }

  // Auto-stop guard: people forget recordings are running. Read fresh each time
  // so a Settings change takes effect without restart.
  const maxMin = PREFS.getMaxRecordingMin()
  if (maxRecTimer) clearTimeout(maxRecTimer)
  maxRecTimer = setTimeout(() => {
    capHit = true
    void handleStop()
  }, maxMin * 60_000)
}

async function handleStop(): Promise<void> {
  if (maxRecTimer) {
    clearTimeout(maxRecTimer)
    maxRecTimer = null
  }
  const hitCap = capHit
  capHit = false
  const runId = recordingHudId || rid()
  recordingHudId = null
  // Mic is closed — freeze the timer here and keep it frozen through the phases
  // below. `false` also drops the waveform so the phase text is readable.
  updateHud(runId, 'Analyzing…', true, false)
  // The phase text needs the full width the waveform didn't — see hudStart in
  // ipc/phone-remote.ts for the same pairing.
  widenHud(runId)
  setActivity('thinking', 'Analyzing…')
  EVENTS.append({ run_id: runId, event: 'recording_stop', cap_hit: hitCap })
  // Phase updates must re-assert the freeze: an update that omits it now leaves the
  // freeze alone, but one that passed the old `false` default would RESUME the timer.
  const res = await stopSession((detail) => updateHud(runId, detail, true))
  if (!res) {
    failHud(runId, 'no active recording')
    setActivity('error', 'No recording')
    return
  }
  const base = res.transcriptPreview
    ? `📝 ${res.transcriptPreview}`
    : `Saved (${res.durationS?.toFixed(0)}s)`
  const summary = hitCap ? `⏱ Max length reached · ${base}` : base
  // Offer Ask/Act on the recording: the agent gets the whole folder (transcript,
  // video, event log) as context and decides what to use. Read the full
  // transcript so a "summarize what I said" style ask has the words up front.
  let transcript = ''
  if (res.transcriptPath && existsSync(res.transcriptPath)) {
    try {
      transcript = readFileSync(res.transcriptPath, 'utf-8').trim()
      // eslint-disable-next-line no-empty -- best-effort read, missing transcript is fine
    } catch {}
  }
  const { folder, videoPath } = logCapture({
    runId,
    kind: 'recording',
    folder: res.folder,
    transcript,
    durationS: res.durationS,
    videoPath: res.videoPath
  })
  // Reveal the capture FOLDER (not just the video) so a tap opens everything —
  // recording, transcript, context, event log — for the user to browse after.
  // The card still shows a short looping preview of the video itself.
  doneHud(runId, true, summary, folder, res.durationS, {
    actions: ['ask', 'act'],
    preview: videoPath ? { path: videoPath, kind: 'video' } : null
  })
  setActivity('done', 'Recording saved', res.durationS)
  EVENTS.append({
    run_id: runId,
    event: 'recording_done',
    folder,
    duration_s: res.durationS,
    has_transcript: !!res.transcriptPath
  })
  track(ANALYTICS_EVENT.recording_completed, { duration_s: res.durationS ?? 0 })
}

// ── Listen / transcribe (Cmd+Opt+Shift+L) ─────────────────────────────────
// Tap = plain toggle (and stops a live hands-free session). Double-tap inside
// LISTEN_DOUBLE_TAP_MS = hands-free dictation — see capture/hands-free.ts.
// Holding past LISTEN_SMART_HOLD_MS upgrades to smart dictation MID-SESSION —
// see handleListenHoldSmart + smart-dictation.ts.
let listenHudId: string | null = null
let listenLastFired = 0
const LISTEN_COOLDOWN_MS = 1000
// Whether the current listen session has been upgraded to smart dictation. Reset
// on start + on stop.
let smartMode = false
// True the instant handleListen() decides to START a session, false once that
// session is stopped/cancelled/failed. Set synchronously (before any await), unlike
// isListening() which depends on startListen()'s async mic warmup (up to ~400ms on
// the native path) actually completing. The hold-upgrade timer fires at
// CONFIG.LISTEN_SMART_HOLD_MS (3000ms) — well past that window in practice, but the
// gate is here for correctness regardless of tuning — so it must gate on this
// flag, not isListening(), or the upgrade silently no-ops every time.
let listenSessionPending = false
// Bumped on every session start and every cancel. An async continuation compares
// the generation it captured against this one: a mismatch means the session it
// belongs to was cancelled while it was awaiting, so it must not resume.
let listenGen = 0
let routeThisListen = false
let submitThisListen = false
// True from the moment the mic closes until the transcript has been delivered.
// The submit-on-Enter arming outlives the session flags on purpose: both
// isListening() and listenSessionPending go false the instant stopListenAndCopy
// starts, so without this the whole "Transcribing…" phase — the natural moment
// to press Enter — was a dead window.
let listenTranscribing = false
// The transcribing run's card, so an Enter pressed after the mic closed still
// gets its "⏎ send" marker — listenHudId is nulled the moment stop begins.
let listenTranscribingHudId: string | null = null

async function handleListen(): Promise<void> {
  const now = Date.now()

  // A tap always stops a live hands-free session — same key, same "stop what is
  // listening" meaning it has for plain dictation. Above the cooldown gate on
  // purpose: the arming double-tap is itself two presses inside the window, so
  // a gated stop would leave the user unable to quit for a full second.
  if (isHandsFreeActive()) {
    listenLastFired = now
    stopHandsFree()
    return
  }

  if (now - listenLastFired < LISTEN_COOLDOWN_MS) return

  // A STOP must not arm the cooldown: stamping it before this branch meant the
  // tap that ended a recording also swallowed the next tap for a full second, so
  // starting again took two presses. Only a START stamps it — that is the gesture
  // the cooldown exists to debounce.
  if (isListening() || listenSessionPending) {
    await stopListenAndCopy()
    return
  }
  listenLastFired = now
  const runId = rid()
  const gen = ++listenGen
  listenHudId = runId
  smartMode = false
  routeThisListen = false
  submitThisListen = false
  listenSessionPending = true
  cancelArmed = false
  startHud(runId, '🎙 Listening', 'recording audio…', HUD_MODE.recording)
  setActivity('listening')

  // Before listen_start, so a blocked run never enters the funnel as a started
  // one. guardMic fails the HUD that's already up and opens the grant row.
  if (!(await guardMic(MIC_ACTION.listen, runId))) {
    listenHudId = null
    listenSessionPending = false
    return
  }

  // A double-tap cancels this session DURING the guardMic await, then arms
  // hands-free. Without this check the cancelled session resumes here, paints
  // a card nothing owns (listenHudId now belongs to no one) and leaves it
  // ticking forever — three stacked orange cards from one double-tap.
  if (gen !== listenGen) {
    dismissHud(runId)
    return
  }

  EVENTS.append({ run_id: runId, event: 'listen_start' })
  warmJev()
  prewarmActions()
  try {
    await startListen()
  } catch (err) {
    listenHudId = null
    listenSessionPending = false
    failHud(runId, err instanceof Error ? err.message : String(err))
    setActivity('error', 'Listen failed')
    EVENTS.append({ run_id: runId, event: 'listen_failed', error: String(err) })
    openFixIfFfmpegMissing(err)
  }
}

// Two listen presses inside CONFIG.LISTEN_DOUBLE_TAP_MS → hands-free dictation.
// Detection lives in capture-hotkey.ts (see onListenDoubleTap) because the raw
// press is the only thing that sees both taps; by the time a press reaches
// handleListen() the first tap's session has already suppressed the second.
function handleListenDoubleTap(): void {
  if (isHandsFreeActive()) return
  // Tap 1 already opened a plain session. Discard it rather than transcribing
  // it: those few hundred ms are the user reaching for the second tap, not
  // dictation, and pasting them would corrupt what they're about to say.
  cancelActiveListen()
  cancelArmed = false
  startHandsFree()
}

// Listen key HELD past the threshold → upgrade to smart dictation. Fires while a
// listen session is live (the hold started plain listen on keydown, then crossed
// the threshold). Swaps the plain card for the smart variant (✨ + colored wave +
// a "morph" animation) so the user sees the flip before they finish speaking. It
// does NOT stop the session — recording continues; only what happens on STOP
// changes (screen-aware run vs verbatim paste). Gates on listenSessionPending, not
// isListening() — see the comment on that flag for why. No-op if no session is
// pending or already smart, so a held-then-repeat can't double-fire.
function handleListenHoldSmart(): void {
  // Tap-tap-HOLD is one physical gesture and must resolve to one mode.
  // Hands-free wins: the user who double-tapped asked for it explicitly,
  // whereas a hold is only ever an upgrade of a plain session.
  if (isHandsFreeActive()) return
  if (SETTINGS.get().holdForSmartDictation !== true) return
  if (!listenSessionPending || smartMode) return
  smartMode = true
  // Morph the SAME card in place instead of dismissHud()+startHud() on a new
  // window — that pair used to visibly hide the HUD for a frame (window close is
  // sync, the replacement's loadFile/ready-to-show isn't) and fired relayoutHuds()
  // twice, double-shifting any other stacked card. morphHud pushes the new
  // capture/title/subtitle onto the existing window; listenHudId/listenStartedAt
  // both stay put since it's still the same card and the same session clock.
  if (listenHudId) {
    morphHud(
      listenHudId,
      HUD_CAPTURE.smartListen,
      CONFIG.UI_LABELS.SMART_LISTEN,
      CONFIG.UI_LABELS.SMART_LISTEN_SUBTITLE
    )
    EVENTS.append({ run_id: listenHudId, event: 'listen_smart_upgrade' })
  }
  setActivity('listening')
}

// Ticks while the listen key is physically held, before the tap/hold threshold
// fires — pct is 0..1. Pushed straight to the plain listen card so its glow
// intensifies in real time, giving the user visible feedback the hold is
// registering (vs. the old dead silence until the smart-dictation flip).
function handleListenRouteNow(): void {
  if (routeThisListen || !(listenSessionPending || listenTranscribing)) return
  if (!PREFS.getVoiceRouting()) return
  routeThisListen = true
  const card = listenHudId || listenTranscribingHudId
  if (hudOn() && card) markHudRouteNext(card)
}

// Enter during the recording: press Return once the words have landed, so a
// dictated prompt sends itself instead of waiting for a second keystroke.
function handleListenSubmitNow(): void {
  if (!listenSessionPending && !listenTranscribing) return
  if (submitThisListen) return
  submitThisListen = true
  const card = listenHudId || listenTranscribingHudId
  if (hudOn() && card) markHudSubmitNext(card)
}

function handleListenHoldProgress(pct: number): void {
  if (!listenHudId || SETTINGS.get().holdForSmartDictation !== true) return
  updateHudHoldProgress(listenHudId, pct)
}

async function stopListenAndCopy(): Promise<void> {
  const runId = listenHudId || rid()
  listenHudId = null
  listenSessionPending = false
  listenTranscribing = true
  listenTranscribingHudId = runId
  // Mic is closed the moment the user releases, so the timer stops here and stays
  // stopped through transcription. `false` drops the waveform: this card is no
  // longer a live recording, and leaving it on hid the phase text behind the wave.
  updateHud(runId, 'Transcribing…', true, false)
  widenHud(runId)
  setActivity('thinking', 'Transcribing…')
  EVENTS.append({ run_id: runId, event: 'listen_stop' })
  // Re-assert the freeze on every phase update — see handleStop above.
  const res = await stopListen((detail) => updateHud(runId, detail, true))
  if (!res) {
    listenTranscribing = false
    listenTranscribingHudId = null
    submitThisListen = false
    failHud(runId, 'no active listen session')
    setActivity('error', 'No audio')
    return
  }

  // Snapshot + reset the smart flag now (the session is over). Reading it here
  // means a late hold-upgrade after stop can't retro-flip an already-plain run.
  const wasSmart = smartMode
  smartMode = false
  const routeNow = routeThisListen
  routeThisListen = false
  const submitNow = submitThisListen
  submitThisListen = false
  listenTranscribing = false
  listenTranscribingHudId = null

  // Read the full transcript (preview is truncated) and copy it raw.
  let copied = false
  let text = ''
  if (res.transcriptPath && existsSync(res.transcriptPath)) {
    try {
      text = readFileSync(res.transcriptPath, 'utf-8').trim()
    } catch (err) {
      console.error('listen transcript read failed:', err)
    }
  }

  // Smart dictation (double-tapped): hand the transcript to the screen-aware flow
  // instead of the plain copy/paste below. It owns the HUD from here (pastes an
  // adapted result or shows an answer), and falls back to pasting the verbatim
  // transcript on any failure — so it's never worse than plain dictation. We still
  // log the voice note + SPEECH analytics below (the run happened either way).
  if (wasSmart) {
    // Fire-and-forget: the screen-aware run drives the HUD to completion itself.
    void runSmartDictation(text, runId, res.wordCount ?? 0)
    logCapture({ runId, kind: 'listen', folder: res.folder, transcript: text, durationS: res.durationS })
    SPEECH.append({
      ts: new Date().toISOString(),
      run_id: runId,
      words: res.wordCount ?? 0,
      duration_s: res.durationS ?? 0,
      chars: text.length,
      ok: true
    })
    EVENTS.append({
      run_id: runId,
      event: 'listen_done',
      duration_s: res.durationS,
      copied: false,
      pasted: false,
      chars: text.length,
      smart: true
    })
    track(ANALYTICS_EVENT.listen_completed, {
      words: res.wordCount ?? 0,
      wpm: (res.durationS ?? 0) > 0 ? Math.round(((res.wordCount ?? 0) / (res.durationS ?? 0)) * 60) : 0,
      duration_s: res.durationS ?? 0,
      source: LISTEN_SOURCE.mac,
      transcribe_ms: res.transcribeMs ?? 0,
      transcode_ms: 0,
      total_ms: res.processingMs ?? 0,
      rtf: rtfOf(res.processingMs ?? 0, res.durationS ?? 0),
      engine: res.transcribeEngineRan,
      fell_back: res.transcribeFellBack
    })
    return
  }

  let pasted = false
  // countWords, not truthiness: silence transcribes to markers like
  // [BLANK_AUDIO], which are non-empty and would paste verbatim.
  if (countWords(text) > 0) {
    clipboard.writeText(text)
    copied = true
    // Auto-paste the transcript into whatever app is frontmost (default ON).
    // The HUD is non-activating so focus stays on the user's app. The text is
    // already on the clipboard above, so pasteText takes its fast path (no
    // clipboard round-trip, no restore) — fire it immediately, no extra delay.
    // Voice routing takes over the paste when it is on: pasting into whatever is
    // frontmost AND then routing would deliver the text twice, in two different
    // places. offerVoiceRoute resolves false whenever routing did not take the
    // job (flag off, no key, ranking failed), so the normal paste still runs.
    const routed = await offerVoiceRoute(runId, text, routeNow, submitNow)
    if (!routed && PREFS.getListenAutoPaste()) {
      pasteText(text)
        .then(() => (submitNow ? submitFrontmost() : undefined))
        .catch((err) => console.error('listen auto-paste failed:', err))
      pasted = true
    }
  }

  // Log the voice note into runs/ + the history panel the moment it finishes —
  // whether or not anything was transcribed — so every capture is tracked.
  const { folder } = logCapture({
    runId,
    kind: 'listen',
    folder: res.folder,
    transcript: text,
    durationS: res.durationS
  })
  if (copied) {
    // Offer Ask / Act on the transcript right from the HUD (the spoken words
    // become the instruction); logCapture re-stashed the moved folder for the click.
    // Reveal the capture folder so a tap opens the saved audio + transcript.
    doneHud(runId, true, res.transcriptPreview || '', folder, res.durationS, {
      actions: ['ask', 'act'],
      // Hover mode held this transcript instead of ranking it, so the card
      // offers the ranking as a button rather than opening one uninvited.
      canVoiceRoute: heldTranscript(runId) !== '',
      transcribeMs: res.processingMs
    })
    setActivity('done', 'Transcribed', res.durationS)
  } else {
    doneHud(runId, true, `${res.transcriptPreview || 'nothing transcribed'}`, folder, res.durationS, {
      transcribeMs: res.processingMs
    })
    setActivity('done', 'Nothing heard', res.durationS)
  }
  EVENTS.append({
    run_id: runId,
    event: 'listen_done',
    folder,
    duration_s: res.durationS,
    copied,
    pasted,
    chars: text.length
  })
  const listenWords = res.wordCount ?? 0
  const listenDurS = res.durationS ?? 0
  if (listenWords > 0 && !PREFS.getTranscribeSucceeded()) {
    PREFS.setTranscribeSucceeded()
    trackChecklistStep('transcribe')
  }
  track(ANALYTICS_EVENT.listen_completed, {
    words: listenWords,
    wpm: listenDurS > 0 ? Math.round((listenWords / listenDurS) * 60) : 0,
    duration_s: listenDurS,
    source: LISTEN_SOURCE.mac,
    transcribe_ms: res.transcribeMs ?? 0,
    // The Mac mic records 16kHz mono wav directly (see listen-recorder.ts's
    // ffmpeg args) — whisper's native input format, so there is no transcode
    // stage to time here. Only the phone pays that cost.
    transcode_ms: 0,
    total_ms: res.processingMs ?? 0,
    rtf: rtfOf(res.processingMs ?? 0, listenDurS),
    engine: res.transcribeEngineRan,
    fell_back: res.transcribeFellBack
  })
  sendToFirstRunRenderer(CHANNELS.firstRunTranscript, text)
  // Speech analytics: log the dictation run (words + recording length) so the
  // Speech section can derive WPM. Separate from HISTORY — pure transcription is
  // not an LLM run and must not inflate the run KPIs.
  SPEECH.append({
    ts: new Date().toISOString(),
    run_id: runId,
    words: res.wordCount ?? 0,
    duration_s: res.durationS ?? 0,
    chars: text.length,
    ok: true
  })
}

/** True while a screen recording, a listen session, or hands-free is live. */
function isCapturing(): boolean {
  return isRecording() || isListening() || isHandsFreeActive()
}

function liveCaptureHudId(): string | null {
  return isRecording() ? recordingHudId : isHandsFreeActive() ? handsFreeHudId() : listenHudId
}

function clearCancelArmTimer(): void {
  if (cancelArmTimer) clearTimeout(cancelArmTimer)
  cancelArmTimer = null
}

/** Esc during a live capture: first press arms + shows the hint, a second within 1.5s discards. */
function handleArmCancel(): void {
  if (!isCapturing()) return
  if (cancelArmed) {
    handleCancel()
    return
  }
  cancelArmed = true
  const runId = liveCaptureHudId()
  if (runId) armHudCancel(runId, true)
  clearCancelArmTimer()
  cancelArmTimer = setTimeout(() => {
    cancelArmTimer = null
    cancelArmed = false
    if (runId) armHudCancel(runId, false)
  }, CANCEL_DOUBLE_ESC_MS)
}

/**
 * Confirm-discard the in-progress capture (second Esc after the first armed it): kill the
 * process, delete temp files, dismiss the HUD. No transcription, no clipboard,
 * no Ask/Act card — the recording never happened. No-op unless armed.
 */
function handleCancel(): void {
  if (!cancelArmed) return
  cancelArmed = false
  clearCancelArmTimer()
  if (isRecording()) {
    if (maxRecTimer) {
      clearTimeout(maxRecTimer)
      maxRecTimer = null
    }
    capHit = false
    const runId = recordingHudId
    recordingHudId = null
    cancelSession()
    setActivity('idle')
    if (runId) {
      dismissHud(runId)
      EVENTS.append({ run_id: runId, event: 'recording_cancel' })
    }
    return
  }
  // Hands-free holds no partial transcript to discard — the segments it already
  // pasted are the user's text and stay put. Cancelling it just means stopping.
  if (isHandsFreeActive()) {
    stopHandsFree()
    return
  }
  cancelActiveListen()
}

/**
 * Discard a live listen session without transcribing it: kill the recorder,
 * dismiss the card, reset the flags. Shared by the double-Esc cancel and by the
 * double-tap, which has to throw away tap 1's session before arming hands-free.
 * No-op when nothing is listening.
 */
function cancelActiveListen(): void {
  if (!isListening() && !listenSessionPending) return
  const runId = listenHudId
  listenHudId = null
  smartMode = false
  listenSessionPending = false
  submitThisListen = false
  routeThisListen = false
  // Retires any continuation still awaiting inside handleListen().
  listenGen++
  cancelListen()
  setActivity('idle')
  if (runId) {
    dismissHud(runId)
    EVENTS.append({ run_id: runId, event: 'listen_cancel' })
  }
}

/**
 * Mouse-driven equivalent of the double-Esc cancel: a direct click on the HUD
 * card's cancel button IS the explicit confirmation, so this skips the
 * two-step arm and discards immediately. Guarded by runId so a click on a
 * stale/background card can't cancel whichever capture happens to be live.
 */
function cancelActiveCapture(runId: string): void {
  if (recordingHudId !== runId && listenHudId !== runId && handsFreeHudId() !== runId) return
  cancelArmed = true
  handleCancel()
}

/**
 * Mouse-driven equivalent of pressing the record hotkey again while
 * recording, or the listen hotkey again while listening: finalizes the
 * capture normally (transcribe/save), same as the keyboard stop path.
 * Guarded by runId for the same reason as cancelActiveCapture.
 */
function finishActiveCapture(runId: string): void {
  if (recordingHudId === runId) {
    void handleStop()
    return
  }
  if (handsFreeHudId() === runId) {
    stopHandsFree()
    return
  }
  if (listenHudId === runId) {
    void handleListen()
  }
}

export function startCapture(handlers: {
  onRewrite: () => void
  onMain: () => void
  onChat: () => void
  onSuggest: () => void
  onStop: () => void
  onToggleSelectionBar: () => void
  onNavigator: () => void
  onToggleVoice: () => void
  onReply: () => void
  onCanvas: () => void
}): boolean {
  warmHud()
  return startCaptureHotkey({
    onTap: handleTap,
    onHoldStart: handleHoldStart,
    onPressWhileRecording: handleStop,
    isRecording,
    onRewrite: handlers.onRewrite,
    onListen: handleListen,
    isListenSessionActive: () => isListening() || listenSessionPending,
    onListenDoubleTap: handleListenDoubleTap,
    onListenHoldSmart: handleListenHoldSmart,
    onListenHoldProgress: handleListenHoldProgress,
    onListenRouteNow: handleListenRouteNow,
    onListenSubmitNow: handleListenSubmitNow,
    canSubmitListen: () => listenSessionPending || listenTranscribing,
    onMain: handlers.onMain,
    onChat: handlers.onChat,
    onSuggest: handlers.onSuggest,
    onStop: handlers.onStop,
    onToggleSelectionBar: handlers.onToggleSelectionBar,
    onNavigator: handlers.onNavigator,
    onToggleVoice: handlers.onToggleVoice,
    onReply: handlers.onReply,
    onCanvas: handlers.onCanvas,
    onArmCancel: handleArmCancel,
    isCapturing
  })
}

// The navigator overlay fires the same capture actions the chord does, so it
// reuses these module-private handlers rather than forking a second path.
export function navigatorCaptureAction(kind: 'listen' | 'listenSend' | 'capture'): void {
  if (kind === 'listenSend') {
    if (!isListening() && !listenSessionPending) return
    handleListenSubmitNow()
    void handleListen()
  } else if (kind === 'listen') void handleListen()
  else void handleTap()
}

export function stopCapture(): void {
  stopCaptureHotkey()
  // Flushes (never deletes) an in-flight recording so the next launch recovers it.
  detachSession()
  detachListen()
}

/**
 * Kill capture children left behind by a PREVIOUS process. stopCapture() covers
 * the graceful quit, but a SIGKILL / crash / dev-restart never runs it: ffmpeg is
 * reparented to launchd and keeps recording forever. Seen 2026-08-17 — a listen
 * session survived ~14h and wrote a 1.6GB wav while holding the mic. cleanupTmp()
 * can't catch it either, since a live writer keeps the file's mtime at "now".
 *
 * Matched on the OUTPUT PATH (our app-owned tmp dir), never the binary name —
 * ffmpeg is a shared system binary and the user has their own encodes running.
 * Every long-lived capture child writes into PATHS.TMP (recorder.ts rec-audio/
 * rec-video, listen-recorder.ts listen-audio), so the path is the safe fence.
 */
export function killOrphanedCaptureChildren(): number[] {
  // Own pid excluded so a live child of THIS process is never in scope — at
  // startup there are none, but that keeps the call safe to run at any time.
  const self = process.pid
  let out = ''
  try {
    out = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024
    })
  } catch {
    return [] // ps unavailable — nothing to do, never block startup on this
  }
  const signalled: number[] = []

  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
    if (!m) continue
    const [, pidStr, ppidStr, command] = m
    const pid = Number(pidStr)
    if (pid === self || Number(ppidStr) === self) continue
    // The tmp dir path is the fence: only our own capture writes there.
    if (!command.includes(PATHS.TMP)) continue

    // SIGINT so ffmpeg finalizes the file; recoverInterruptedRecordings SIGKILLs any holdout.
    try {
      process.kill(pid, 'SIGINT')
      signalled.push(pid)
      console.log(`[capture] stopped orphaned capture child pid=${pid}`)
    } catch {
      // Already gone, or not ours to kill — either way nothing to recover.
    }
  }
  return signalled
}


export { isCaptureHotkeyAvailable, isRecording }
export { cancelActiveCapture, finishActiveCapture }


// HUD quick-actions for a capture result (listen / screen-recording / screenshot).
// Every capture writes a folder; clicking Ask or Act on its HUD card hands the
// WHOLE folder to the agent as context (transcript, video, screenshot, events)
// and lets the LLM decide what to use. The user may add an instruction via the
// card's follow-up input, but it's optional — the system prompt + a neutral
// default instruction frame the capture so a bare tap still does something
// useful (or the agent says it can't, via the normal ACT_RESULT contract).
//
// The actual prompts -> backend -> History -> HUD pipeline lives in the shared
// hud-run service; this module only stashes the capture context and hands off.
import { join } from 'path'
import { PREFS } from '../store/prefs'
import { EVENTS } from '../store/events'
import { runningHud, failHud } from '../hud-window'
import { runHudRun, clearHudThread, type ResolvedActionExtra } from '../backend/hud-run'
import { estimateDuration } from '../estimator/duration-estimator'
import { buildMemoryBlob } from '../backend/context-memory'
import { createRunFolder } from '../store/run-folder'
import { readCaptureContext } from './capture-utils'
import { HISTORY, historyTimestamp } from '../store/history'
import { MIGHTY } from '../store/mighty'
import { CONFIG } from '../../shared/config'
import type { HudActionKind, CaptureKind, HistoryEntry } from '../../shared/types'

/** What a capture HUD card can act on. The folder is always present (every
 *  capture writes one); transcript/screenshotPath are set per capture kind. */
export interface CaptureContext {
  /** Capture run folder — handed to the agent so it can read everything in it. */
  folder: string
  kind: CaptureKind
  /** Spoken-words transcript, for listen/recording. Seeds the instruction. */
  transcript?: string
  /** Screenshot image path, for screenshot captures. */
  screenshotPath?: string
  /** The Mighty session logCapture() opened for this capture (the capture itself is
   *  its first turn). A later Ask/Act on this card APPENDS to it, so a voice note and
   *  the follow-up it triggered read as ONE conversation. Absent in incognito (no
   *  session is persisted) — the follow-up then mints its own, as before. */
  sessionId?: string
}

// Capture context keyed by HUD runId, so a button click long after the run can
// recover what to act on. Cleared when the card is dismissed.
const captures = new Map<string, CaptureContext>()

/** Stash a capture's context so its HUD card's Ask/Act buttons can use it. */
export function rememberCapture(runId: string, ctx: CaptureContext): void {
  captures.set(runId, ctx)
}

/** What a finished capture hands logCapture to file it under the unified runs/ tree. */
export interface CaptureLogInput {
  runId: string
  kind: CaptureKind
  /** The capture's working folder (captures/<kind>-<stamp>/), moved into runs/. */
  folder: string
  /** Spoken transcript (listen/recording) — becomes the row's instruction when present. */
  transcript?: string
  /** Screenshot image path, rewritten to its new home after the folder move. */
  screenshotPath?: string
  /** Recording video path, rewritten to its new home after the folder move. */
  videoPath?: string
  durationS?: number
}

/** What logCapture returns: the capture's new folder, plus the primary media
 *  asset's rewritten path (screenshot PNG / recording MP4) so callers can show a
 *  preview that points at the MOVED file, not the pre-move location. */
export interface CaptureLogResult {
  /** The capture's NEW folder under runs/ (or the original on incognito/failure). */
  folder: string
  /** Absolute path to the screenshot, rewritten to its new home. Null if none. */
  screenshotPath: string | null
  /** Absolute path to the recording video, rewritten to its new home. Null if none. */
  videoPath: string | null
}

/**
 * Log a finished capture into the SAME unified home every LLM run uses: move its
 * folder to runs/<ts>-<kind>-<slug>-<id>/ and write ONE history row so a screenshot,
 * a voice note, or a recording shows in the panel the instant it's made — no Ask
 * needed. Returns the capture's NEW folder (callers reveal that + re-stash it for
 * Ask/Act, so a later action enriches the same row + folder via the shared run_id).
 *
 * Incognito (or any move/append failure) returns the original folder untouched —
 * the capture's own artifact is never lost to logging.
 */
export function logCapture(input: CaptureLogInput): CaptureLogResult {
  if (PREFS.getIncognito()) {
    return {
      folder: input.folder,
      screenshotPath: input.screenshotPath ?? null,
      videoPath: input.videoPath ?? null
    }
  }

  const transcript = (input.transcript || '').trim()
  // The row's headline: the spoken words if any, else a plain kind label.
  const instruction = transcript !== '' ? transcript : CONFIG.CAPTURE_HISTORY_LABEL[input.kind]
  const ts = historyTimestamp()

  // Move the populated capture folder into runs/ under the canonical name.
  // Mirror the capture's context (front app / window / URL) into run.json so the
  // block is uniform across kinds. Read from the sidecar the capture already wrote
  // (BEFORE the folder move below) rather than re-capturing — that's the moment the
  // user actually fired the capture. The richer per-moment detail (recording start
  // vs end) still lives in the context-*.txt sidecars a single block can't hold.
  const capCtx = readCaptureContext(input.folder, input.kind)

  const runDir = createRunFolder({
    runId: input.runId,
    ts,
    kind: input.kind,
    instruction,
    backend: '',
    adoptFrom: input.folder,
    context: {
      front_app: capCtx.frontApp || undefined,
      window_title: capCtx.windowTitle || undefined,
      browser_url: capCtx.browserURL || undefined,
      screenshot_path: input.screenshotPath || undefined
    }
  })
  const folder = runDir ?? input.folder
  // Media assets moved with their folder — re-home each path to the new folder so
  // a preview/reveal points at the moved file, not the emptied pre-move location.
  const rehome = (p?: string): string | null =>
    p ? (runDir ? join(folder, p.slice(input.folder.length + 1)) : p) : null
  const screenshotPath = rehome(input.screenshotPath)
  const videoPath = rehome(input.videoPath)

  // Open the CONVERSATION for this capture, with the capture itself as turn one.
  // Without this a voice note only ever existed as a history row, so a later Ask/Act
  // opened a conversation whose first message was the transcript re-used as the
  // question — and an Act opened none at all. The turn carries no session runId, so
  // the empty `a` renders settled rather than as a thinking bubble (see
  // MightySession.runId in types.ts). Incognito no-ops inside the store, and
  // newSession returns a record that was never written — so don't hand a follow-up a
  // session id that isn't on disk, or it would append into a phantom.
  const sessionId = PREFS.getIncognito()
    ? undefined
    : MIGHTY.appendTurn(undefined, {
        source: input.kind === 'screenshot' ? 'capture' : 'listen',
        q: instruction,
        a: '',
        ts,
        ok: true,
        backend: ''
      })

  // Re-stash so the HUD card's Ask/Act runs against the moved folder + that session.
  captures.set(input.runId, {
    folder,
    kind: input.kind,
    transcript,
    screenshotPath: screenshotPath ?? undefined,
    sessionId
  })

  // One history row. `mode` is a placeholder AppMode (rows require one); the real
  // kind rides on capture_kind, which readRecent surfaces as the panel chip.
  const entry: HistoryEntry = {
    schema_version: CONFIG.HISTORY_SCHEMA_VERSION,
    run_id: input.runId,
    ts,
    duration_s: input.durationS ?? 0,
    instruction,
    mode: 'ask',
    capture_kind: input.kind,
    selection: '',
    selection_chars: 0,
    result: transcript || undefined,
    ok: true,
    backend: '',
    model: '',
    ctx_attached: false,
    // Same context already written into the run folder above — carried on the row
    // so a capture attributes to its app like every other history entry.
    front_app: capCtx.frontApp || undefined,
    window_title: capCtx.windowTitle || undefined,
    browser_url: capCtx.browserURL || undefined,
    screenshot_path: screenshotPath ?? null,
    run_dir: runDir ?? undefined,
    source: 'capture',
    // The conversation opened just above. Carried on the row because `captures`
    // is in-memory and keyed by this run — a replay days later finds nothing
    // there, and the row is all that's left to rejoin the session by.
    session_id: sessionId
  }
  HISTORY.append(entry)

  return { folder, screenshotPath, videoPath }
}

/** True if this card is a live capture (screenshot/recording/listen) with its folder
 *  still remembered — i.e. a skill launched from it should attach the capture file,
 *  not a serialized chat. */
export function isCaptureCard(runId: string): boolean {
  return captures.has(runId)
}

/** The conversation logCapture opened for this capture, if any (undefined in
 *  incognito, where nothing was written). Smart dictation uses it to settle the
 *  capture's empty turn with the answer it produced — that turn is the ONLY
 *  record of a listen run in MIGHTY, so without this the conversation stayed a
 *  question with no reply everywhere the session is read (Mighty window, phone). */
export function getCaptureSessionId(runId: string): string | undefined {
  return captures.get(runId)?.sessionId
}

export function clearCaptureAction(runId: string): void {
  captures.delete(runId)
  // The ask thread for this card (built by hud-run on first Ask) dies with it.
  clearHudThread(runId)
}

/**
 * Run Ask or Act on a capture via the shared hud-run service. The capture folder
 * (and the screenshot path, when present) is passed as a context file so the
 * agent can read everything inside; the transcript, if any, seeds the instruction
 * so a voice command still works as "do what I said." No typed input is required.
 */
export function runCaptureAction(
  runId: string,
  action: HudActionKind,
  typedInstruction?: string,
  actionExtra?: ResolvedActionExtra | null
): void {
  const cap = captures.get(runId)
  if (!cap) {
    failHud(runId, 'capture expired - capture again')
    return
  }

  // Instruction precedence: what the user TYPED into the card's hover input wins;
  // else the spoken transcript IS the command (listen/recording); else a neutral
  // framing so the agent inspects the capture and decides (or reports it can't).
  const typed = (typedInstruction || '').trim()
  const spoken = (cap.transcript || '').trim()
  const instruction =
    typed !== ''
      ? typed
      : spoken !== ''
        ? spoken
        : cap.kind === 'screenshot'
          ? 'Look at the attached screenshot and the files in its folder, then help with whatever it shows.'
          : 'Review the files in this capture folder and help with whatever they show.'

  // What this turn shows AS THE QUESTION in the conversation. Usually the same as
  // `instruction`, but NOT when the transcript is standing in for a typed command:
  // logCapture already wrote the spoken words as turn one, so repeating them here
  // would render the same sentence twice in a row. The agent still receives the full
  // `instruction` — only the displayed question is relabeled.
  const turnQ =
    typed === '' && spoken !== '' && cap.sessionId
      ? action === 'ask'
        ? CONFIG.CAPTURE_TURN_Q.ask
        : CONFIG.CAPTURE_TURN_Q.act
      : instruction

  const short = instruction.length > 40 ? instruction.slice(0, 40) + '…' : instruction
  const etaMs = estimateDuration(action, PREFS.getBackend())?.etaMs ?? 0
  runningHud(runId, 'Working on it', short, etaMs)
  EVENTS.append({
    run_id: runId,
    event: 'capture_action_start',
    action,
    kind: cap.kind,
    chars: instruction.length
  })

  // Hand over the folder (and screenshot path) as context files; act mode grants
  // read access to their parent dirs so the agent can open transcript/video/etc.
  const contextFiles = [cap.folder]
  if (cap.screenshotPath) contextFiles.push(cap.screenshotPath)

  runHudRun({
    runId,
    historyRunId: runId,
    mode: action,
    instruction,
    selection: '',
    selFile: '',
    ctxData: null,
    finderFiles: contextFiles,
    conversationHistory: [],
    sessionTitle: '',
    actionExtra: actionExtra ?? null,
    memoryBlob: buildMemoryBlob({ mode: action }),
    backend: PREFS.getBackend(),
    source: 'listen',
    triggerApp: '',
    // Continue the conversation the capture itself opened, instead of minting a
    // second one that has no idea the voice note/screenshot exists.
    sessionId: cap.sessionId,
    turnQ
  })
}

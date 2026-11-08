/**
 * Phone Remote — mic recording tail: a held/toggled mic recording -> toWav ->
 * transcribe -> clipboard + pasteText + logCapture, the exact same verbatim-
 * dictation tail plain Listen uses on stop (see stopListenAndCopy() in
 * capture/index.ts) — no LLM call, just paste. The card is raised with the
 * same HUD_MODE.recording + HUD_CAPTURE.listen kind as a keyboard-triggered
 * Listen, and the run is logged into runs/ + History + Speech analytics the
 * same way, so it's indistinguishable from a Mac-side Listen.
 * Also owns the phone-session voice/move/click/chat counters (flushed to
 * analytics on disconnect) since handlePhoneAudio is the only place that
 * bumps voiceRuns mid-flight.
 */
import { clipboard } from 'electron'
import { execFile } from 'child_process'
import { existsSync, mkdirSync, statSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { CONFIG } from '../../shared/config'
import { devLog } from '../../shared/env'
import { PREFS } from '../store/prefs'
import { PATHS } from '../store/paths'
import { SETTINGS } from '../store/settings'
import { pasteText } from '../platform'
import { transcribe, rtfOf, countWords } from '../capture/whisper'
import { logCapture } from '../capture/capture-actions'
import { EVENTS } from '../store/events'
import { SPEECH } from '../store/speech'
import { startHud, updateHud, widenHud, doneHud, failHud } from '../hud-window'
import { runHudRun } from '../backend/hud-run'
import { estimateDuration } from '../estimator/duration-estimator'
import { buildMemoryBlob } from '../backend/context-memory'
import { HUD_MODE, HUD_CAPTURE, PHONE_AUDIO_TO, type PhoneAudioDestination, type HistoryEntry } from '../../shared/types'
import { track } from '../analytics'
import { ANALYTICS_EVENT, LISTEN_SOURCE } from '../../shared/analytics-events'
import { trackChecklistStep } from '../activation-checklist'
import {
  sendToPhone,
  sendDictationHistory,
  isPhoneRun,
  type DictationEntry,
  type DictationPage
} from '../phone-remote/server'
import { HISTORY } from '../store/history'
import { abortRun } from '../backend/runner'
import type { PhoneRemoteMessage } from '../../shared/phone-remote-protocol'
// Circular with the facade (it imports this module too) — safe because the
// only use is inside handlePhoneAudio's body, called long after both modules
// have finished evaluating.
import { sendClipboardState } from './phone-remote-context'
import { notePhoneFirstStep } from './phone-first-steps'
import { CHANNELS } from '../../shared/ipc'
import { sendToFirstRunRenderer } from '../first-run-window'

type Msg<T extends PhoneRemoteMessage['type']> = Extract<PhoneRemoteMessage, { type: T }>

interface PhoneSessionCounters {
  startedAt: number
  moves: number
  clicks: number
  voiceRuns: number
  chatTurns: number
  messages: number
  messageTypes: Set<string>
}

const MAX_SESSION_MESSAGE_TYPES = 12

function emptyPhoneSession(): PhoneSessionCounters {
  return { startedAt: 0, moves: 0, clicks: 0, voiceRuns: 0, chatTurns: 0, messages: 0, messageTypes: new Set() }
}

let phoneSession: PhoneSessionCounters = emptyPhoneSession()

export function flushPhoneSession(): void {
  if (phoneSession.startedAt === 0) return
  const { startedAt, moves, clicks, voiceRuns, chatTurns, messages, messageTypes } = phoneSession
  phoneSession = emptyPhoneSession()
  track(ANALYTICS_EVENT.phone_session_ended, {
    duration_s: Math.round((Date.now() - startedAt) / 1000),
    moves,
    clicks,
    voice_runs: voiceRuns,
    chat_turns: chatTurns,
    messages,
    message_types: [...messageTypes].join(','),
    idle: moves === 0 && clicks === 0 && voiceRuns === 0 && chatTurns === 0
  })
}

/** Starts a fresh counters window at connect time — replaces the whole object
 *  so a stale flush mid-swap can't race a half-written one. */
export function resetPhoneSession(): void {
  phoneSession = { ...emptyPhoneSession(), startedAt: Date.now() }
}

export function bumpPhoneMessage(type: string): void {
  phoneSession.messages += 1
  if (phoneSession.messageTypes.size < MAX_SESSION_MESSAGE_TYPES) phoneSession.messageTypes.add(type)
}

export function bumpPhoneMoves(): void {
  phoneSession.moves += 1
  notePhoneFirstStep('move')
  sendToFirstRunRenderer(CHANNELS.firstRunPhoneMoved)
}

export function bumpPhoneClicks(): void {
  phoneSession.clicks += 1
  notePhoneFirstStep('tap')
}

export function bumpPhoneChatTurns(): void {
  phoneSession.chatTurns += 1
}

const HISTORY_PASTE_LOOKUP_LIMIT = 500

// 160: the store caps result_detail at 200, but the sheet shows it as one wrapped
// line under a row -- past ~160 it pushes the next row off a phone screen.
const PHONE_FAIL_DETAIL_CHARS = 160

export const cancelledClips = new Set<string>()
// Only ever holds ids for clips that are in flight or just finished, so this is
// a runaway guard rather than a working limit -- see the eviction comment.
export const MAX_TRACKED_CANCELLED_CLIPS = 32

// ~30ms of 16kHz mono s16: above any ffmpeg header (44-78 bytes), far below the shortest real clip.
const NO_AUDIO_MAX_WAV_BYTES = 1024

export function toWav(ffmpeg: string, src: string, dst: string): Promise<boolean> {
  return new Promise((resolve) => {
    const args = ['-y', '-i', src, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', dst]
    execFile(ffmpeg, args, { timeout: CONFIG.AUDIO_TRANSCODE_TIMEOUT_MS }, (err, _stdout, stderr) => {
      const ok = !err && existsSync(dst)
      // Why ffmpeg refused it. Discarding this left "couldn't decode audio"
      // with no evidence behind it. Tail only: the banner is 20 lines.
      if (!ok) devLog.error('Phone Remote: transcode failed', stderr.trim().split('\n').slice(-4).join(' | '))
      resolve(ok)
    })
  })
}

export function cleanupTmp(paths: string[]): void {
  for (const p of paths) {
    try {
      if (existsSync(p)) unlinkSync(p)
    } catch {
      // best-effort cleanup; a leftover tmp file is not worth surfacing
    }
  }
}

export function pasteableText(item: { result?: string; instruction: string }): string {
  const text = item.result?.trim() || item.instruction.trim()
  return text
}

export function actDictation(id: string): void {
  const row = HISTORY.readRecent(HISTORY_PASTE_LOOKUP_LIMIT).find((r) => r.run_id === id)
  if (!row) return
  const instruction = row.instruction.trim()
  if (instruction === '') return

  // The raw entry, for `session_id` — HistoryItem is the RENDERER's projection and
  // deliberately omits it (a conversation id has no business crossing to a window).
  // Both reads hit the same in-memory cache, so this is a lookup, not a second scan.
  const entry = HISTORY.readAllEntries().find((e) => e.run_id === id)

  const runId = `phone:${randomUUID().slice(0, 8)}`
  const short = instruction.length > 40 ? instruction.slice(0, 40) + '…' : instruction
  const backend = PREFS.getBackend()
  const etaMs = estimateDuration('act', backend)?.etaMs ?? 0
  startHud(runId, 'Working on it', short, HUD_MODE.act, HUD_CAPTURE.listen, etaMs)
  EVENTS.append({ run_id: runId, event: 'phone_act_dictation', source_run_id: id, chars: instruction.length })
  sendToPhone({ type: 'actProgress', runId, phase: 'Starting…', detail: instruction })
  runHudRun({
    runId,
    historyRunId: runId,
    mode: 'act',
    instruction,
    selection: '',
    selFile: '',
    ctxData: null,
    finderFiles: [],
    conversationHistory: [],
    sessionTitle: '',
    actionExtra: null,
    memoryBlob: buildMemoryBlob({ mode: 'act' }),
    backend,
    source: 'phone',
    triggerApp: '',
    sessionId: entry?.session_id,
    turnQ:
      entry?.session_id !== undefined && instruction === (row.result ?? '').trim()
        ? CONFIG.CAPTURE_TURN_Q.act
        : instruction
  })
}

export function readHistoryPageForPhone(offset: number, limit: number): DictationPage {
  const rows = HISTORY.readRecent(offset + limit + 1)
  const page = rows.slice(offset, offset + limit)
  // `reason`/`result_detail` are on the raw entry — HistoryItem is the RENDERER's
  // projection and drops both. Same in-memory cache, so this is a lookup, not a scan.
  const failedIds = new Set(page.filter((i) => !i.ok).map((i) => i.run_id))
  const rawByRunId = new Map<string, HistoryEntry>()
  if (failedIds.size > 0) {
    for (const e of HISTORY.readAllEntries()) {
      if (failedIds.has(e.run_id)) rawByRunId.set(e.run_id, e)
    }
  }
  const entries: DictationEntry[] = []
  for (const item of page) {
    const text = pasteableText(item)
    if (text === '') continue
    const entry: DictationEntry = {
      id: item.run_id,
      text,
      kind: item.mode,
      // ts is an ISO string on disk; the phone wants epoch ms for its own
      // relative-time math. A malformed/absent ts falls back to 0 rather than
      // NaN, which would render as "NaNm ago".
      at: Date.parse(item.ts) || 0
    }
    if (!item.ok) {
      const raw = rawByRunId.get(item.run_id)
      entry.failed = true
      if (raw?.reason) entry.reason = raw.reason
      const detail = raw?.result_detail?.trim()
      if (detail) entry.detail = detail.slice(0, PHONE_FAIL_DETAIL_CHARS)
      if (item.run_state) entry.runState = item.run_state
    }
    entries.push(entry)
  }
  return { entries, offset, hasMore: rows.length > offset + limit }
}

export async function handlePhoneAudio(
  data: Buffer,
  recordingDurationMs: number,
  to: PhoneAudioDestination = PHONE_AUDIO_TO.paste,
  clipId = '',
  // A clip recorded while the Mac was away, draining now. The user spoke minutes
  // ago and is looking at some other app, so nothing about this is live: no HUD,
  // no clipboard stomp, no paste into whatever happens to be frontmost. It lands
  // in History, the only place a late transcript can go without hijacking focus.
  queued = false
): Promise<void> {
  // Register before the first await so an 'audioCancel' that arrives while the
  // very first write is still running is not dropped as "unknown clip".
  if (clipId !== '') cancelledClips.delete(clipId)
  // Read at each stage boundary rather than once: the point is to notice a
  // cancel that landed DURING the stage we just finished.
  const cancelled = (): boolean => clipId !== '' && cancelledClips.has(clipId)
  const stage = (s: 'received' | 'transcribing' | 'done'): void => {
    if (clipId !== '') sendToPhone({ type: 'transcribeStage', id: clipId, stage: s })
  }
  const fail = (reason: string, retryable: boolean): void => {
    if (to === PHONE_AUDIO_TO.chat) sendToPhone({ type: 'chatTranscript', ok: false, text: '', reason })
    if (clipId !== '') sendToPhone({ type: 'transcribeFailed', id: clipId, reason, retryable })
    if (to === PHONE_AUDIO_TO.note && clipId !== '') sendToPhone({ type: 'relayNoteDone', id: clipId, ok: false, reason })
  }
  // A cancelled clip is not a failure -- the phone already reset its own UI when
  // the user tapped Cancel, so pushing a reason would surface a toast for a
  // thing they deliberately stopped. Just stop working and clean up.
  const abandon = (paths: string[]): void => {
    if (clipId !== '') cancelledClips.delete(clipId)
    cleanupTmp(paths)
  }
  const isChat = to === PHONE_AUDIO_TO.chat
  const historyOnly = queued || to === PHONE_AUDIO_TO.note
  const silent = isChat || historyOnly
  const hudStart = (subtitle: string): void => {
    if (silent) return
    startHud(runId, '🎙 Listening', subtitle, HUD_MODE.recording, HUD_CAPTURE.listen, 0, recordingStartedAtMs)
    updateHud(runId, subtitle, true, false, recordingDurationMs / 1000)
    // recording:false swaps the compact waveform for the title + phase text, which
    // does not fit the narrow RECORDING_W the card opened at — without this the
    // title clips to "🎙 List…". Same pairing as smart-dictation's stop flip.
    widenHud(runId)
  }
  const hudFail = (message: string): void => {
    if (silent) return
    failHud(runId, message)
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const folder = join(PATHS.CAPTURES, `listen-${stamp}`)
  mkdirSync(folder, { recursive: true })
  const webmPath = join(PATHS.TMP, `phone-audio-${stamp}.webm`)
  const wavPath = join(folder, 'audio.wav')
  const outBase = join(folder, 'transcript')
  const runId = `phone:${randomUUID().slice(0, 8)}`
  const startedAt = Date.now()
  // Backdate the HUD's timer to when the phone actually STARTED recording
  // (not when transcoding begins), so the card shows the real clip length
  // counting up from where it left off instead of restarting at 0.
  const recordingStartedAtMs = startedAt - recordingDurationMs

  try {
    writeFileSync(webmPath, data)
  } catch (err) {
    devLog.error('Phone Remote: failed to write recording', err)
    // Retryable: this is a transient disk/permission failure, not something
    // about the audio itself, so the same bytes may well land on a second try.
    fail("Couldn't save that recording", true)
    return
  }

  stage('received')

  const ffmpeg = SETTINGS.get().ffmpegPath
  if (!existsSync(ffmpeg)) {
    hudStart('ffmpeg not found')
    hudFail('ffmpeg not found')
    cleanupTmp([webmPath])
    // NOT retryable: ffmpeg is still going to be missing on the next attempt.
    fail('ffmpeg not found', false)
    return
  }

  hudStart('transcribing…')
  stage('transcribing')

  const transcodeStart = Date.now()
  const transcoded = await toWav(ffmpeg, webmPath, wavPath)
  const transcodeMs = Date.now() - transcodeStart
  cleanupTmp([webmPath])
  // Checked here rather than only at the end so a cancel during the transcode
  // skips the expensive whisper call entirely -- that is the whole point of
  // being able to cancel a long clip.
  if (cancelled()) {
    abandon([wavPath])
    return
  }
  if (!transcoded) {
    hudFail("couldn't decode audio")
    fail("Couldn't decode that audio", true)
    return
  }
  if (statSync(wavPath).size <= NO_AUDIO_MAX_WAV_BYTES) {
    devLog.warn(`Phone Remote: clip had no audio samples (sent ${data.length} bytes, ${recordingDurationMs}ms)`)
    hudFail('no sound reached the Mac')
    fail(CONFIG.UI_LABELS.PHONE_CLIP_NO_SOUND, true)
    return
  }

  const result = await transcribe(wavPath, outBase)
  const durationS = recordingDurationMs / 1000

  // Whisper is the long stage, so this is where a cancel most often lands. The
  // result is dropped rather than pasted: pasting text into the frontmost app
  // after the user said "stop" is the one outcome cancel exists to prevent.
  if (cancelled()) {
    abandon([])
    hudFail('cancelled')
    return
  }

  // countWords, not a non-empty check: silence and background noise come back
  // as markers like [BLANK_AUDIO], which are non-empty and would paste verbatim.
  if (!result.ok || !result.text || countWords(result.text) === 0) {
    hudFail("couldn't hear that")
    fail("Couldn't hear that", true)
    return
  }

  const text = result.text.trim()
  stage('done')

  if (isChat) {
    // No doneHud either: it pushes a 'runDone' back to the phone (see
    // hud-window.ts's isPhoneRun branch), which would stomp the composer's own
    // status with a "Ready" for a run the user never started on the Mac.
    sendToPhone({ type: 'chatTranscript', ok: true, text })
    return
  }

  const pasted = !historyOnly && PREFS.getListenAutoPaste()
  if (!historyOnly) {
    clipboard.writeText(text)
    // Auto-paste into whatever app is frontmost, same as Listen's default-ON
    // behavior (PREFS.getListenAutoPaste()) — the HUD is non-activating so
    // focus stays wherever the user's cursor already was.
    if (pasted) {
      pasteText(text).catch((err) => devLog.error('Phone Remote: auto-paste failed', err))
    }
  }

  // Same tail as stopListenAndCopy(): file the run into runs/ + History right
  // away, so a phone dictation shows up in the panel exactly like a Mac one.
  const { folder: loggedFolder } = logCapture({
    runId,
    kind: 'listen',
    folder,
    transcript: text,
    durationS
  })
  // logCapture() above wrote this run into HISTORY, so the phone's sheet is now
  // one row stale -- push the refreshed first page.
  sendDictationHistory()
  if (to === PHONE_AUDIO_TO.note && clipId !== '') sendToPhone({ type: 'relayNoteDone', id: clipId, ok: true, text })
  // This dictation just wrote the clipboard, so a paste key that rendered
  // disabled a moment ago is now wrong.
  if (!historyOnly) sendClipboardState()
  EVENTS.append({
    run_id: runId,
    event: 'listen_done',
    folder: loggedFolder,
    duration_s: durationS,
    copied: !historyOnly,
    pasted,
    chars: text.length
  })
  SPEECH.append({
    ts: new Date().toISOString(),
    run_id: runId,
    words: result.wordCount ?? 0,
    duration_s: durationS,
    chars: text.length,
    ok: true
  })
  const totalMs = Date.now() - startedAt
  if (!PREFS.getTranscribeSucceeded()) {
    PREFS.setTranscribeSucceeded()
    trackChecklistStep('transcribe')
  }
  track(ANALYTICS_EVENT.listen_completed, {
    words: result.wordCount ?? 0,
    wpm: durationS > 0 ? Math.round(((result.wordCount ?? 0) / durationS) * 60) : 0,
    duration_s: durationS,
    source: LISTEN_SOURCE.phone,
    transcribe_ms: result.tookMs,
    transcode_ms: transcodeMs,
    total_ms: totalMs,
    rtf: rtfOf(totalMs, durationS),
    engine: result.engine,
    fell_back: result.fellBack
  })
  phoneSession.voiceRuns += 1
  notePhoneFirstStep('talk')
  sendToFirstRunRenderer(CHANNELS.firstRunTranscript, text)

  doneHud(runId, true, text, loggedFolder, durationS, {
    actions: ['ask', 'act'],
    transcribeMs: totalMs
  })
}

// --- Dispatch handlers (moved verbatim from ipc/phone-remote.ts, C9a) ---

export function handleGetDictationHistory(msg: Msg<'getDictationHistory'>): void {
  sendDictationHistory(msg.offset ?? 0)
}

export function handlePasteDictation(msg: Msg<'pasteDictation'>): void {
  const row = HISTORY.readRecent(HISTORY_PASTE_LOOKUP_LIMIT).find((r) => r.run_id === msg.id)
  if (!row) return
  const text = pasteableText(row)
  if (text === '') return
  // Same clipboard + paste tail a fresh dictation gets, so re-pasting a past
  // run is indistinguishable from having just produced it.
  clipboard.writeText(text)
  pasteText(text).catch((err) => devLog.error('Phone Remote: re-paste failed', err))
}

export function handleActDictation(msg: Msg<'actDictation'>): void {
  actDictation(msg.id)
}

export function handleAudioCancel(msg: Msg<'audioCancel'>): void {
  if (typeof msg.id !== 'string' || msg.id === '') return
  const id = msg.id.slice(0, 64)
  cancelledClips.add(id)
  // Bounded so a client spamming ids for clips that never arrive can't grow
  // this without limit. Dropping the oldest is safe: a cancel that outlives
  // this many newer ones is for a clip that finished long ago.
  if (cancelledClips.size > MAX_TRACKED_CANCELLED_CLIPS) {
    const oldest = cancelledClips.values().next()
    if (!oldest.done) cancelledClips.delete(oldest.value)
  }
}

export function handleStopRun(msg: Msg<'stopRun'>): void {
  // Never trust a wire string: only ids this feature minted (`phone:` prefix)
  // may be killed. Without this check a crafted message could reach a desktop
  // HUD card's run or a background task -- abortRun takes any live run id.
  if (typeof msg.runId !== 'string' || !isPhoneRun(msg.runId)) return
  const killed = abortRun(msg.runId)
  EVENTS.append({ run_id: msg.runId, event: 'run_stopped' })
  track(ANALYTICS_EVENT.run_stopped, { killed: killed ? 1 : 0 })
}

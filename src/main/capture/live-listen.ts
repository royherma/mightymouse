import { isCompanionMicPaused, sendCompanionStageEvent, sendToCompanion } from '../companion-window'
import {
  runCompanionAskTurn,
  speakCompanionReply,
  abortCompanionTurn
} from '../companion-orchestrator'
import { isStopUtterance, matchWakePhrase, splitCommands, stripEcho } from '../../shared/companion-barge-in'
import { CONFIG } from '../../shared/config'
import { WAKE_EVENT, type WakeEventKind } from '../../shared/companion-debug'
import { transcribeSegment, transcribeDraftSegment } from './segmented-listen'
import { randomUUID } from 'crypto'
import { proposeActions, runProposal, expireProposals, primeActions } from '../actions/engine'
import { quickOpenApp, SCREEN_ACTION_ID } from '../actions/capabilities/system'
import { speak, type SpeakResult } from '../audio/tts'
import { CHANNELS } from '../../shared/ipc'
import { playSound } from '../sound-window'
import { warmJev, takeJevInputTokens } from '../actions/decide-transport'
import type { LiveDraft, LiveTurnResult } from '../../shared/companion-state'
import type { TurnUsage } from '../../shared/types'
import { pickLine } from '../hideout-news'
import { isHideoutOpen, isHideoutPaused, recordHideoutTurn, runHideoutTurn, setHideoutWords, showHideoutTurn } from '../hideout'
import { HIDEOUT_HOP, voiceHop, type HideoutHop } from '../../shared/hideout'

/**
 * Live Voice Companion — Phase 1 of the PRD
 * (prds/active/2026-07-12-1783824131-live-voice-companion.md §5, §6
 * `TranscriptSource`). Consumer #1 of the segmented-listen core: a VAD-bounded
 * segment becomes a transcript (`segmented-listen.ts`), then this module runs
 * it as a normal Mighty turn and speaks the answer.
 *
 * The transcribe half used to live here and now lives in `segmented-listen.ts`
 * so hands-free dictation can be consumer #2 without a second copy of the loop
 * (see that module's doc for why the mic + VAD stay in a renderer). What is
 * left here is exactly the Companion-specific part: ask, remember the session,
 * speak.
 */

/** Which concrete adapter fired a stage event in this phase — matches the
 *  `provider` free-text field on CompanionStageEvent (see companion-debug.ts). */
const STAGE_PROVIDER = {
  whisper: 'whisper'
} as const

/**
 * The Mighty session the current run of live mode is talking in. Set by the first
 * turn that reaches the LLM, reused by every turn after it — that reuse IS voice's
 * memory, since runMighty feeds a session's prior turns back as context.
 *
 * Lives in main, not the renderer, on purpose: the companion window can reload
 * (HMR, a crash, the user toggling live mode's UI) mid-conversation, and a
 * renderer-held id would split one conversation into two sessions. Cleared by
 * `endLiveSession()` when live mode is switched off — the next run of live mode
 * is a new conversation, not a continuation of one from an hour ago.
 */
let liveSessionId: string | undefined

/**
 * Start the next voice turn in `sessionId` instead of a fresh conversation. Call
 * with no argument to end the current one (the next turn opens a new session).
 *
 * This is the seam that makes voice and chat interchangeable in BOTH directions:
 * voice already lands in a normal session, and passing a chat's session id here
 * lets the user pick up a typed conversation by talking.
 */
export function setLiveSession(sessionId?: string): void {
  liveSessionId = sessionId
}

/** The session live mode is currently talking in, if any. */
export function getLiveSession(): string | undefined {
  return liveSessionId
}

/**
 * One full voice turn: transcribe a VAD-segmented WAV, hand the transcript to
 * `runCompanionAskTurn` (which runs it through `runMighty` as a normal Mighty
 * turn — see companion-orchestrator.ts), then speak the answer via
 * `speakCompanionReply` (gracefully silent with no TTS key). Emits a
 * `CompanionStageEvent` at the start/end of each leg (the debug panel — see
 * companion-debug.ts) so the pipeline is verifiable without guesswork.
 *
 * Every turn after the first continues the SAME session (`liveSessionId`), which
 * is both what gives voice memory and what makes the exchange show up in chat as
 * one ordinary conversation.
 *
 * Never throws — an empty/failed transcript, or a failed ask-turn, still
 * resolves to an `ok: false` LiveTurnResult so the IPC handler
 * (ipc/windows.ts) always has something to push back, and the companion can
 * settle to idle instead of hanging on "thinking" forever. A TTS failure
 * (network/HTTP) does NOT fail the whole turn — the reply still ships back
 * `ok: true` with no `audio`, so the companion falls back to caption-only.
 */
export async function runLiveTurn(wavBytes: Uint8Array, echoTail = ''): Promise<LiveTurnResult> {
  if (isCompanionMicPaused()) return { ok: false, ignored: true, transcript: '', reply: '', error: 'paused' }
  const startedAt = Date.now()
  turnRoute = ''
  turnUsage = undefined
  turnHops = []
  turnFast = 0
  turnStartedAt = startedAt
  turnFirstSound = null
  takeJevInputTokens()
  const result = await handleLiveTurn(wavBytes, echoTail)
  if (result.audio) markFirstSound()
  logTurn(result.transcript, result, startedAt)
  return result
}

async function handleLiveTurn(wavBytes: Uint8Array, echoTail: string): Promise<LiveTurnResult> {
  const transcribeStart = Date.now()
  sendCompanionStageEvent({
    stage: 'transcript',
    provider: STAGE_PROVIDER.whisper,
    state: 'start',
    ts: transcribeStart
  })

  warmJev()
  warmAcks()
  const transcribed = await transcribeSegment(wavBytes)

  if (!transcribed.ok) {
    sendCompanionStageEvent({
      stage: 'transcript',
      provider: STAGE_PROVIDER.whisper,
      state: 'error',
      tookMs: transcribed.tookMs,
      detail: transcribed.error,
      ts: Date.now()
    })
    return { ok: false, transcript: '', reply: '', error: transcribed.error }
  }

  turnHops.push({ ...HIDEOUT_HOP.whisper, ms: transcribed.tookMs, usd: 0 })
  sendCompanionStageEvent({
    stage: 'transcript',
    provider: STAGE_PROVIDER.whisper,
    state: 'ok',
    tookMs: transcribed.tookMs,
    detail: transcribed.text,
    ts: Date.now()
  })

  // Empty transcript (silence/noise the VAD misjudged as speech) — no reply,
  // no "response" stage event; the caller treats this the same as a failure.
  if (!transcribed.text.trim()) {
    return { ok: false, transcript: '', reply: '', error: 'empty transcript' }
  }

  const wake = matchWakePhrase(transcribed.text)
  const heard = wake.addressed || isStopUtterance(transcribed.text) ? transcribed.text : stripEcho(transcribed.text, echoTail)
  if (!heard) {
    console.log(`[voice-turn] dropped own voice heard=${JSON.stringify(transcribed.text)}`)
    return { ok: false, ignored: true, transcript: '', reply: '', error: 'own voice' }
  }

  // A bare "stop" is a command to the app, not a question for the agent. The
  // renderer has already killed the in-flight run by the time this transcript
  // exists (it aborts on speech-START, before whisper has anything to show);
  // running it as a turn on top of that would answer "stop" with a sentence and
  // start a fresh run, which is the opposite of what was asked for.
  //
  // Anything longer falls through deliberately: "no, the other tab" both stops
  // the old run and becomes the next instruction.
  if (isStopUtterance(heard)) {
    abortCompanionTurn()
    sendWakeEvent(WAKE_EVENT.stop)
    return { ok: false, transcript: heard, reply: '', error: 'stopped' }
  }

  const armed = Date.now() < wakeArmedUntil
  const inHideout = !wake.addressed && !armed && isHideoutOpen()
  if (inHideout) {
    sendWakeEvent(WAKE_EVENT.request)
    const hideout = await runHideoutTurn(heard, true)
    if (hideout) {
      turnRoute = `hideout×${hideout.commands}`
      turnHops.push(...hideout.hops)
      return hideout.result
    }
  }
  if (!wake.addressed && !armed && !(inHideout && !isHideoutPaused())) {
    return { ok: false, ignored: true, transcript: heard, reply: '', error: 'not addressed' }
  }
  wakeArmedUntil = 0
  const request = wake.addressed ? wake.request : heard.trim()
  if (!request) {
    wakeArmedUntil = Date.now() + CONFIG.COMPANION.WAKE_ARM_MS
    sendWakeEvent(WAKE_EVENT.armed)
    return { ok: false, ignored: true, transcript: heard, reply: '', error: WAKE_EVENT.armed }
  }

  abortCompanionTurn()
  sendWakeEvent(WAKE_EVENT.request)
  const result = await runLiveTurnFromText(request)
  if (result.ok) wakeArmedUntil = Date.now() + CONFIG.COMPANION.FOLLOW_UP_MS
  return result
}

export async function runLiveDraft(wavBytes: Uint8Array, echoTail = ''): Promise<LiveDraft> {
  const raw = await transcribeDraftSegment(wavBytes)
  const heardName = matchWakePhrase(raw).addressed
  const text = heardName ? raw : stripEcho(raw, echoTail)
  const addressed = heardName || Date.now() < wakeArmedUntil
  if (addressed) {
    primeActions('voice')
    warmJev()
    warmAcks()
  }
  if (heardName && Date.now() - lastChimeAt > CONFIG.COMPANION.WAKE_ARM_MS) {
    lastChimeAt = Date.now()
    playSound('record-start')
  }
  return { text, addressed }
}

let lastChimeAt = 0

let wakeArmedUntil = 0

function sendWakeEvent(kind: WakeEventKind): void {
  sendCompanionStageEvent({ stage: 'wake', provider: 'wake-phrase', state: 'ok', detail: kind, ts: Date.now() })
}

/**
 * The half of a live turn that starts once there are WORDS — ask, latch the
 * session, speak the reply. Split out so typed input (Stage's input bar) is the
 * same turn as a spoken one rather than a parallel path: same session, same
 * screen control, same spoken reply. The only thing typing skips is whisper.
 */
export async function runLiveTurnFromText(text: string): Promise<LiveTurnResult> {
  const said = text.trim()
  if (!said) return { ok: false, transcript: '', reply: '', error: 'empty transcript' }

  // Typed "stop" means the same thing as spoken "stop" — kill the run, don't
  // answer it. The abort itself is the renderer's (it fires on submit, before
  // this); without this the stopped run would be replaced by a fresh one.
  if (isStopUtterance(said)) {
    abortCompanionTurn()
    return { ok: false, transcript: said, reply: '', error: 'stopped' }
  }

  const hideout = await runHideoutTurn(said, true)
  if (hideout) {
    turnRoute = `hideout×${hideout.commands}`
    turnHops.push(...hideout.hops)
    return hideout.result
  }

  const ack = startAck(said)
  try {
    return await answerTurn(said, ack)
  } finally {
    ack.done()
  }
}

async function answerTurn(said: string, ack: Ack): Promise<LiveTurnResult> {
  const clauses = splitCommands(said)
  const done: FastDone[] = []
  const quickAt = Date.now()
  for (const clause of clauses) {
    const d = await runFastAction(clause, ack)
    if (!d) break
    done.push(d)
  }
  turnFast = done.length
  turnHops.push({ ...HIDEOUT_HOP.quick, ms: Date.now() - quickAt })
  const lines = done.map((d) => d.line)
  if (done.length === clauses.length) {
    turnRoute = `fast×${done.length}`
    if (done.some((d) => d.answer)) return voicedReply(said, lines.join(' '), undefined, SPOKEN_SENTENCES)
    showHideoutTurn(said, lines.join(' · '), [])
    return actionDone(said, lines.join(' · '))
  }

  turnRoute = done.length ? `fast×${done.length}+agent` : 'agent'
  const ask = done.length ? `${said} (already done: ${lines.join('; ')})` : said
  ack.now('check')
  const askResult = await runCompanionAskTurn(ask, liveSessionId)
  turnUsage = askResult.usage
  const by = askResult.answeredBy
  turnHops.push({
    key: `${by.backend}:${by.model}`,
    icon: by.backend,
    model: by.model,
    label: by.label,
    local: by.backend === 'local' || by.backend === 'mlx',
    ms: askResult.tookMs,
    ...(turnUsage ? { usd: turnUsage.free ? 0 : (turnUsage.costUsd ?? 0) } : {})
  })
  // Latch the session on the FIRST turn that reaches the LLM, and keep it even
  // when that turn failed — a timed-out turn still wrote a (failed) turn into a
  // real session, and the follow-up belongs in the same conversation.
  if (askResult.sessionId) liveSessionId = askResult.sessionId

  if (!askResult.ok) {
    showHideoutTurn(said, "That didn't work. Say it again to retry.", [])
    return {
      ok: false,
      transcript: said,
      reply: '',
      error: askResult.error,
      sessionId: askResult.sessionId || undefined
    }
  }
  return voicedReply(said, askResult.reply, askResult.sessionId || undefined)
}

const SPOKEN_SENTENCES = 2

function firstSentences(text: string, n: number): string {
  return text.split(/(?<=[.!?])\s+/).slice(0, n).join(' ')
}

async function voicedReply(said: string, reply: string, sessionId?: string, sentences?: number): Promise<LiveTurnResult> {
  showHideoutTurn(said, reply, [], true)
  const spokenText = sentences ? firstSentences(reply, sentences) : reply
  const spoken = await speakCompanionReply(spokenText)
  const voice = voiceHop(spoken.provider, spoken.tookMs)
  if (voice) turnHops.push(voice)
  if (spoken.words) setHideoutWords(spoken.words)
  return {
    ok: true,
    transcript: said,
    reply,
    sessionId,
    ...(spoken.audio ? { audio: spoken.audio, audioMimeType: spoken.mimeType, spokenText } : {})
  }
}

type FastDone = { line: string; answer: boolean }

async function runFastAction(said: string, ack: Ack): Promise<FastDone | null> {
  const quick = await quickOpenApp(said)
  if (quick) {
    sendStep(`Opening ${quick.app}`)
    const opened = await quick.run()
    if (opened.ok) return { line: opened.line, answer: false }
  }
  const runId = randomUUID()
  const card = await proposeActions(runId, 'voice', said)
  const top = card?.proposals[0]
  if (!top?.preselected) {
    if (card) expireProposals(runId)
    return null
  }
  const answer = top.actionId === SCREEN_ACTION_ID
  if (answer) ack.now('look')
  sendStep([top.title, ...top.chips.map((c) => c.label)].join(' · '))
  const result = await runProposal(runId, top.proposalId)
  return result.ok ? { line: result.line, answer } : null
}

const ACKS = {
  look: ['Let me look.', 'Eyes on it.', 'Peeking now.'],
  check: ['Let me check that.', 'On it.', 'Digging in.'],
  wait: ['One sec.', 'Hang on.', 'Working on it.']
}
type AckKey = keyof typeof ACKS
type Ack = { now: (key: AckKey) => void; done: () => void }
const ackClips = new Map<string, Promise<SpeakResult>>()

function warmAcks(): void {
  for (const line of Object.values(ACKS).flat()) {
    if (ackClips.has(line)) continue
    const clip = speak(line)
    ackClips.set(line, clip)
    void clip.then((r) => r.audio || ackClips.delete(line))
  }
}

function startAck(said: string): Ack {
  let fired = false
  let over = false
  showHideoutTurn(said, '', [])
  const fire = (key: AckKey): void => {
    if (fired || over) return
    fired = true
    clearTimeout(timer)
    const line = pickLine(ACKS[key], {})
    showHideoutTurn(said, line, [])
    warmAcks()
    void ackClips.get(line)?.then((clip) => {
      if (over || !clip.audio) return
      markFirstSound()
      sendToCompanion(CHANNELS.companionAck, { audio: clip.audio, mimeType: clip.mimeType, text: line })
    })
  }
  const timer = setTimeout(() => fire('wait'), CONFIG.COMPANION.ACK_AFTER_MS)
  return {
    now: fire,
    done: () => {
      over = true
      clearTimeout(timer)
    }
  }
}

let turnRoute = ''
let turnUsage: TurnUsage | undefined
let turnHops: HideoutHop[] = []
let turnFast = 0
let turnStartedAt = 0
let turnFirstSound: number | null = null

function markFirstSound(): void {
  if (turnFirstSound === null && turnStartedAt) turnFirstSound = Date.now() - turnStartedAt
}

function logTurn(heard: string, result: LiveTurnResult, startedAt: number): void {
  const route = result.ignored ? `ignored:${result.error}` : result.ok ? turnRoute : `failed:${result.error ?? turnRoute}`
  const jevTok = takeJevInputTokens()
  const jevUsd = (jevTok * CONFIG.COMPUTER_USE.JEV_USD_PER_M_INPUT_TOKENS) / 1_000_000
  const agentUsd = turnUsage?.free ? 'free' : (turnUsage?.costUsd?.toFixed(5) ?? '?')
  const quick = turnHops.find((h) => h.key === HIDEOUT_HOP.quick.key)
  if (quick) quick.usd = jevUsd
  if (!result.ignored) recordHideoutTurn(turnHops.filter((h) => h !== quick || turnFast > 0 || jevTok > 0), turnFirstSound)
  const agent = turnUsage ? ` agentTok=${turnUsage.inputTokens}/${turnUsage.outputTokens} agentUsd=${agentUsd}` : ''
  console.log(
    `[voice-turn] heard=${JSON.stringify(heard)} route=${route} ms=${Date.now() - startedAt} jevTok=${jevTok} jevUsd=${jevUsd.toFixed(5)}${agent}`
  )
}

function sendStep(detail: string): void {
  sendCompanionStageEvent({ stage: 'step', provider: 'decide', state: 'start', detail, ts: Date.now() })
}

// A done action is shown and chimed, not read aloud: speech synthesis costs ~2s.
function actionDone(said: string, line: string): LiveTurnResult {
  playSound('success')
  markFirstSound()
  return { ok: true, transcript: said, reply: line }
}

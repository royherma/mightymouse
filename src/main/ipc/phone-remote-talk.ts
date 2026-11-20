import { devLog } from '../../shared/env'
import { CONFIG } from '../../shared/config'
import { RUN_EVENT, type MightySession } from '../../shared/types'
import type { PhoneRemoteMessage } from '../../shared/phone-remote-protocol'
import { decideTalk, TALK, TALK_LABELS, talkId, talkText } from '../../shared/talk'
import { agentMessageBody } from '../../shared/attachments'
import { runMighty } from '../mighty/run-mighty'
import { MIGHTY } from '../store/mighty'
import { PREFS } from '../store/prefs'
import { abortRun } from '../backend/runner'
import { sendToPhone } from '../phone-remote/server'
import { routeTalk, type TalkRoute, type TalkSink } from '../talk/talk-route'
import { deliverToAgent } from '../voice-routing/deliver-helper'
import {
  defaultCodeUiHarness,
  projectRootFor,
  startNewAgent,
  type NewAgentSink
} from '../voice-routing/new-agent-sink'
import { reasonText } from './voice-routing'
import { recordOpeningTurn } from './phone-remote-chat'

type Msg<T extends PhoneRemoteMessage['type']> = Extract<PhoneRemoteMessage, { type: T }>

interface TalkTurn {
  text: string
  route: TalkRoute | null
  started: boolean
  cancelled: boolean
  runId: string
}

interface TalkOutcome {
  ok: boolean
  reply: string
  target: string
  openLabel?: string
}

const turns = new Map<string, TalkTurn>()

function remember(id: string, turn: TalkTurn): void {
  turns.delete(id)
  turns.set(id, turn)
  while (turns.size > TALK.HISTORY_MAX) {
    const oldest = turns.keys().next().value
    if (oldest === undefined) break
    turns.delete(oldest)
  }
}

function talkSession(): MightySession {
  const existing = MIGHTY.listSessions().find((s) => !s.archived && s.title === TALK.SESSION_TITLE)
  return existing ?? MIGHTY.newSession(TALK.SESSION_TITLE)
}

export async function handleTalkText(rawId: unknown, rawText: unknown): Promise<void> {
  const id = talkId(rawId)
  const text = talkText(rawText)
  if (id === '' || text === '') return
  const turn: TalkTurn = { text, route: null, started: false, cancelled: false, runId: '' }
  remember(id, turn)
  sendToPhone({ type: 'talkHeard', id, text })
  const route = await routeTalk(text).catch((err: unknown) => {
    devLog.warn('[talk] routing failed, doing it on the computer', err)
    return null
  })
  if (turns.get(id) !== turn) return
  turn.route = route
  const decision = route ?? decideTalk([], null, 0)
  sendToPhone({
    type: 'talkRoute',
    id,
    auto: decision.auto,
    pick: decision.pick,
    options: decision.options
  })
}

async function runOnComputer(id: string, turn: TalkTurn): Promise<TalkOutcome> {
  const session = talkSession()
  const result = await runMighty({
    message: turn.text,
    sessionId: session.id,
    source: 'talk',
    screenControl: PREFS.getLiveActs(),
    onRunId: (runId) => {
      turn.runId = runId
      if (turn.cancelled) abortRun(runId)
    },
    onPhase: (phase, detail) => sendToPhone({ type: 'talkStep', id, phase, detail }),
    onEvent: (event) => {
      if (event.kind === RUN_EVENT.text && event.text !== '')
        sendToPhone({ type: 'talkStep', id, chunk: event.text })
    }
  })
  turn.runId = ''
  if (result.error === 'stopped')
    return { ok: false, reply: TALK_LABELS.cancelled, target: TALK_LABELS.done_.computer }
  if (result.error !== undefined) {
    const reason =
      CONFIG.UI_LABELS.RUN_FAIL_REASON[result.error] ?? CONFIG.UI_LABELS.RUN_FAIL_UNKNOWN
    return { ok: false, reply: reason, target: TALK_LABELS.done_.computer }
  }
  return { ok: true, reply: result.answer, target: TALK_LABELS.done_.computer }
}

async function startFresh(
  sink: NewAgentSink,
  turn: TalkTurn,
  header: string
): Promise<TalkOutcome> {
  const target = `${TALK_LABELS.done_['new-agent']} ${sink.project}`
  const harness = defaultCodeUiHarness()
  if (!harness) return { ok: false, reply: TALK_LABELS.noHarness, target }
  const cwd = await projectRootFor(sink.cwd)
  const started = await startNewAgent(
    { ...sink, cwd },
    agentMessageBody([], header + turn.text),
    harness,
    { reveal: false }
  )
  if (!started.ok)
    return { ok: false, reply: `${TALK_LABELS.cantStart} ${reasonText(started, harness)}.`, target }
  recordOpeningTurn({ pane: started.pane, cwd }, turn.text, [])
  return { ok: true, reply: TALK_LABELS.agentStarted, target }
}

async function handOff(sink: TalkSink, turn: TalkTurn, header: string): Promise<TalkOutcome> {
  if (sink.kind === 'new-agent') return startFresh(sink, turn, header)
  const target = `${TALK_LABELS.done_.agent} ${sink.label}`
  const sent = await deliverToAgent(header, turn.text, sink, 'paste', '')
  if (!sent.ok) return { ok: false, reply: TALK_LABELS.noHelper, target }
  return { ok: true, reply: TALK_LABELS.agentHasIt, target, openLabel: sink.session.label }
}

export async function handleTalkGo(msg: Msg<'talkGo'>): Promise<void> {
  const id = talkId(msg.id)
  const turn = turns.get(id)
  if (!turn || turn.started || turn.cancelled || typeof msg.target !== 'string') return
  const sink = msg.target === TALK.COMPUTER_ID ? null : turn.route?.sinks.get(msg.target)
  if (sink === undefined) {
    sendToPhone({ type: 'talkDone', id, ok: false, reply: TALK_LABELS.noHelper, target: '' })
    return
  }
  turn.started = true
  try {
    const outcome =
      sink === null
        ? await runOnComputer(id, turn)
        : await handOff(sink, turn, turn.route?.screenHeader ?? '')
    sendToPhone({ type: 'talkDone', id, ...outcome })
  } catch (err) {
    devLog.error('[talk] turn failed', err)
    sendToPhone({ type: 'talkDone', id, ok: false, reply: TALK_LABELS.failed, target: '' })
  }
}

export function handleTalkSend(msg: Msg<'talkSend'>): void {
  void handleTalkText(msg.id, msg.text)
}

export function handleTalkCancel(msg: Msg<'talkCancel'>): void {
  const id = talkId(msg.id)
  const turn = turns.get(id)
  if (!turn) return
  turn.cancelled = true
  if (turn.runId !== '') abortRun(turn.runId)
  if (!turn.started) turns.delete(id)
}

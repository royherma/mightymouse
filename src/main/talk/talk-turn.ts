import { devLog } from '../../shared/env'
import { CONFIG } from '../../shared/config'
import type { TalkMediaWire, TalkOptionKind } from '../../shared/phone-remote-protocol'
import type {
  MediaAttachment,
  MightyChatResult,
  MightyRunSource,
  MightySession,
  RunEvent,
  RunFailReason
} from '../../shared/types'
import { decideTalk, TALK, TALK_LABELS, type TalkDecision } from '../../shared/talk'
import { agentMessageBody, basename, turnMedia } from '../../shared/attachments'
import { runMighty } from '../mighty/run-mighty'
import { broadcastMightyTurnAppended } from '../mighty/broadcast'
import { MIGHTY } from '../store/mighty'
import { PREFS } from '../store/prefs'
import { abortRun } from '../backend/runner'
import { routeTalk, type TalkRoute, type TalkSink } from './talk-route'
import { deliverToAgent } from '../voice-routing/deliver-helper'
import {
  defaultCodeUiHarness,
  projectRootFor,
  startNewAgent,
  type NewAgentSink
} from '../voice-routing/new-agent-sink'
import { reasonText } from '../ipc/voice-routing'
import { recordOpeningTurn } from '../ipc/phone-remote-chat'

export type TalkComputerRun = Pick<MightyChatResult, 'answer' | 'sessionId' | 'error'>

export interface TalkEvents {
  offered?: (decision: TalkDecision) => void
  onRunId?: (runId: string) => void
  onPhase?: (phase: string, detail: string, sessionId: string) => void
  onEvent?: (event: RunEvent, sessionId: string) => void
  runOnComputer?: (text: string, sessionId: string) => Promise<TalkComputerRun>
}

export interface TalkStart {
  source: MightyRunSource
  attachments?: MediaAttachment[]
  events?: TalkEvents
}

export interface TalkOutcome {
  kind: TalkOptionKind
  ok: boolean
  reply: string
  target: string
  sessionId: string
  error?: RunFailReason
  openLabel?: string
  media?: TalkMediaWire
}

interface PendingTalk extends Required<TalkStart> {
  text: string
  route: TalkRoute | null
  started: boolean
  cancelled: boolean
  runId: string
  picked?: (target: string) => void
}

const turns = new Map<string, PendingTalk>()

function remember(id: string, turn: PendingTalk): void {
  turns.delete(id)
  turns.set(id, turn)
  while (turns.size > TALK.HISTORY_MAX) {
    const oldest = turns.keys().next().value
    if (oldest === undefined) break
    turns.delete(oldest)
  }
}

export function findTalkSession(): MightySession | undefined {
  return MIGHTY.listSessions().find((s) => !s.archived && s.title === TALK.SESSION_TITLE)
}

export function talkSession(): MightySession {
  return findTalkSession() ?? MIGHTY.newSession(TALK.SESSION_TITLE)
}

export function isTalkSession(sessionId: string | undefined): boolean {
  return !!sessionId && findTalkSession()?.id === sessionId
}

export async function offerTalk(id: string, text: string, start: TalkStart): Promise<TalkDecision | null> {
  const turn: PendingTalk = {
    text,
    source: start.source,
    attachments: start.attachments ?? [],
    events: start.events ?? {},
    route: null,
    started: false,
    cancelled: false,
    runId: ''
  }
  remember(id, turn)
  const route = await routeTalk(text).catch((err: unknown) => {
    devLog.warn('[talk] routing failed, doing it on the computer', err)
    return null
  })
  if (turns.get(id) !== turn) return null
  turn.route = route
  const decision = route ?? decideTalk([], null, 0)
  turn.events.offered?.(decision)
  return decision
}

export async function goTalk(id: string, target: string): Promise<TalkOutcome | null> {
  const turn = turns.get(id)
  if (!turn || turn.started || turn.cancelled) return null
  const sink = target === TALK.COMPUTER_ID ? null : turn.route?.sinks.get(target)
  if (sink === undefined) return failed(TALK_LABELS.noHelper)
  turn.started = true
  try {
    return sink === null ? await runOnComputer(turn) : record(turn, await handOff(sink, turn))
  } catch (err) {
    devLog.error('[talk] turn failed', err)
    return failed(TALK_LABELS.failed)
  }
}

export async function runTalk(id: string, text: string, start: TalkStart & { waitMs: number }): Promise<TalkOutcome> {
  const decision = await offerTalk(id, text, start)
  const turn = turns.get(id)
  if (!decision || !turn) return failed(TALK_LABELS.cancelled)
  const target =
    decision.options.length > 1 && start.waitMs > 0
      ? await waitForPick(turn, decision.pick, start.waitMs)
      : decision.pick
  return (await goTalk(id, target)) ?? failed(TALK_LABELS.cancelled)
}

function waitForPick(turn: PendingTalk, fallback: string, ms: number): Promise<string> {
  return new Promise((resolve) => {
    const done = (target: string): void => {
      clearTimeout(timer)
      turn.picked = undefined
      resolve(target)
    }
    const timer = setTimeout(() => done(fallback), ms)
    turn.picked = done
  })
}

export function pickTalk(id: string, target: string): void {
  turns.get(id)?.picked?.(target)
}

export function cancelTalk(id: string): boolean {
  const turn = turns.get(id)
  if (!turn) return false
  turn.cancelled = true
  if (turn.runId !== '') abortRun(turn.runId)
  if (!turn.started) turns.delete(id)
  turn.picked?.('')
  return true
}

function failed(reply: string): TalkOutcome {
  return { kind: 'computer', ok: false, reply, target: '', sessionId: findTalkSession()?.id ?? '' }
}

async function computerRun(turn: PendingTalk, sessionId: string): Promise<TalkComputerRun> {
  if (turn.events.runOnComputer) return turn.events.runOnComputer(turn.text, sessionId)
  return runMighty({
    message: turn.text,
    sessionId,
    source: turn.source,
    attachments: turn.attachments.length > 0 ? turn.attachments : undefined,
    screenControl: PREFS.getLiveActs(),
    onRunId: (runId) => {
      turn.runId = runId
      if (turn.cancelled) abortRun(runId)
      turn.events.onRunId?.(runId)
    },
    onPhase: turn.events.onPhase,
    onEvent: turn.events.onEvent
  })
}

async function runOnComputer(turn: PendingTalk): Promise<TalkOutcome> {
  const result = await computerRun(turn, talkSession().id)
  turn.runId = ''
  const base = { kind: 'computer' as const, target: TALK_LABELS.done_.computer, sessionId: result.sessionId }
  if (result.error === 'stopped') return { ...base, ok: false, reply: TALK_LABELS.cancelled, error: result.error }
  if (result.error !== undefined) {
    const reason =
      CONFIG.UI_LABELS.RUN_FAIL_REASON[result.error] ?? CONFIG.UI_LABELS.RUN_FAIL_UNKNOWN
    return { ...base, ok: false, reply: reason, error: result.error }
  }
  return { ...base, ok: true, reply: result.answer, media: deliverables(result.sessionId) }
}

function deliverables(sessionId: string): TalkMediaWire | undefined {
  const turns = MIGHTY.getSession(sessionId)?.turns ?? []
  const turn = turns.length - 1
  const items = turnMedia(turns[turn]?.sources, turns[turn]?.artifacts)
    .map((m, item) => ({ item, kind: m.kind, name: basename(m.path), mine: m.mine }))
    .filter((m) => !m.mine)
    .map(({ item, kind, name }) => ({ item, kind, name }))
  return items.length > 0 ? { sessionId, turn, items } : undefined
}

function paths(turn: PendingTalk): string[] {
  return turn.attachments.map((a) => a.path)
}

type HandOff = Omit<TalkOutcome, 'sessionId'>

async function startFresh(sink: NewAgentSink, turn: PendingTalk, header: string): Promise<HandOff> {
  const target = `${TALK_LABELS.done_['new-agent']} ${sink.project}`
  const base = { kind: 'new-agent' as const, target }
  const harness = defaultCodeUiHarness()
  if (!harness) return { ...base, ok: false, reply: TALK_LABELS.noHarness }
  const cwd = await projectRootFor(sink.cwd)
  const started = await startNewAgent(
    { ...sink, cwd },
    agentMessageBody(paths(turn), header + turn.text),
    harness,
    { reveal: false }
  )
  if (!started.ok)
    return { ...base, ok: false, reply: `${TALK_LABELS.cantStart} ${reasonText(started, harness)}.` }
  recordOpeningTurn({ pane: started.pane, cwd }, turn.text, paths(turn))
  return { ...base, ok: true, reply: TALK_LABELS.agentStarted }
}

async function handOff(sink: TalkSink, turn: PendingTalk): Promise<HandOff> {
  const header = turn.route?.screenHeader ?? ''
  if (sink.kind === 'new-agent') return startFresh(sink, turn, header)
  const base = { kind: 'agent' as const, target: `${TALK_LABELS.done_.agent} ${sink.label}` }
  const sent = await deliverToAgent(header, turn.text, sink, 'paste', paths(turn)[0] ?? '')
  if (!sent.ok) return { ...base, ok: false, reply: TALK_LABELS.noHelper }
  return { ...base, ok: true, reply: TALK_LABELS.agentHasIt, openLabel: sink.session.label }
}

export function recordTalkTurn(source: PendingTalk['source'], said: string, done: string): void {
  const sessionId = MIGHTY.appendTurn(talkSession().id, { source, q: said, a: done, ts: new Date().toISOString(), ok: true, backend: '' })
  broadcastMightyTurnAppended(sessionId)
}

function record(turn: PendingTalk, outcome: HandOff): TalkOutcome {
  const files = paths(turn)
  const sessionId = MIGHTY.appendTurn(talkSession().id, {
    source: turn.source,
    q: turn.text,
    a: `${outcome.reply}\n\n_${outcome.target}_`,
    ts: new Date().toISOString(),
    ok: outcome.ok,
    backend: '',
    ...(files.length > 0 ? { sources: files } : {})
  })
  broadcastMightyTurnAppended(sessionId)
  return { ...outcome, sessionId }
}

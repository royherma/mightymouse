import { appendFileSync, readFileSync } from 'fs'
import { ipcMain } from 'electron'
import { CHANNELS } from '../../shared/ipc'
import { devLog } from '../../shared/env'
import type { AgentTranscriptTurn } from '../../shared/types'
import {
  PULSE_AXES,
  PULSE_VERDICTS,
  pulseLevelToScore,
  type PulseAxisKey,
  type PulseRow,
  type PulseScope,
  type PulseState,
  type PulseVerdictKey
} from '../../shared/session-pulse'
import { PATHS } from '../store/paths'
import { PREFS } from '../store/prefs'
import { callJev, takeDecideFailure, type DecideBody } from '../actions/decide-transport'
import { addSessionTurnEndedListener } from './mcp/http-listener'
import { resolveSessionRef } from './session-control'
import { readSessionTranscript } from './session-transcript'
import { readSessionChecklist } from './session-checklist'
import { getMightyWindow } from '../mighty/mighty-window'

const CALL_TIMEOUT_MS = 10_000
// The Stop hook can land before the CLI flushes the reply to its transcript.
const TRANSCRIPT_SETTLE_MS = 1_500
const MAX_TURN_CHARS = 1_200
const MAX_RECENT_TURNS = 8
const MAX_STATE_BYTES = 16_000
const PREVIOUS_ROWS = 3

const rowsBySession = new Map<string, PulseRow[]>()
const scoring = new Set<string>()
const errors = new Map<string, string>()
const turnEndedAt = new Map<string, number>()
let allLoaded = false

function readLog(): PulseRow[] {
  const rows: PulseRow[] = []
  try {
    for (const line of readFileSync(PATHS.PULSE_LOG, 'utf-8').split('\n')) {
      if (!line) continue
      try {
        rows.push(JSON.parse(line) as PulseRow)
      } catch {
        continue
      }
    }
  } catch {
    // no log yet
  }
  return rows
}

function loadAll(): void {
  if (allLoaded) return
  const grouped = new Map<string, PulseRow[]>()
  for (const row of readLog()) {
    if (typeof row.sessionId !== 'string') continue
    const rows = grouped.get(row.sessionId) ?? []
    upsert(rows, row)
    grouped.set(row.sessionId, rows)
  }
  for (const [sessionId, rows] of grouped) if (!rowsBySession.has(sessionId)) rowsBySession.set(sessionId, rows)
  allLoaded = true
}

function loadRows(sessionId: string): PulseRow[] {
  loadAll()
  let rows = rowsBySession.get(sessionId)
  if (!rows) {
    rows = []
    rowsBySession.set(sessionId, rows)
  }
  return rows
}

// Fresh = the last finished turn was scored; a later reply the user already answered, or a turn that ended after scoring, makes it stale.
function freshRow(sessionId: string): PulseRow | undefined {
  const rows = loadRows(sessionId)
  const latest = rows.reduce<PulseRow | undefined>((a, r) => (!a || r.replyAt >= a.replyAt ? r : a), undefined)
  if (!latest) return undefined
  if (scoring.has(sessionId)) return latest
  if ((turnEndedAt.get(sessionId) ?? 0) > latest.at) return undefined
  const session = resolveSessionRef(sessionId)
  if (!session?.sessionId) return latest
  const turns = readSessionTranscript(session).filter((t) => t.role !== 'tool')
  const answeredLater = turns.some(
    (t, i) => t.role === 'agent' && t.at > latest.replyAt && turns[i + 1]?.role === 'you'
  )
  return answeredLater ? undefined : latest
}

export function freshRows(sessionIds: readonly string[]): Record<string, PulseRow> {
  const out: Record<string, PulseRow> = {}
  if (!Array.isArray(sessionIds)) return out
  loadAll()
  for (const id of sessionIds) {
    if (typeof id !== 'string' || !rowsBySession.get(id)?.length) continue
    const row = freshRow(id)
    if (row) out[id] = row
  }
  return out
}

function upsert(rows: PulseRow[], row: PulseRow): void {
  const at = rows.findIndex((r) => r.at === row.at)
  if (at === -1) rows.push(row)
  else rows[at] = row
}

function saveRow(row: PulseRow): void {
  upsert(loadRows(row.sessionId), row)
  if (PREFS.getIncognito()) return
  try {
    appendFileSync(PATHS.PULSE_LOG, JSON.stringify(row) + '\n', 'utf-8')
  } catch (err) {
    console.error('Failed to append pulse row:', err)
  }
}

function clip(text: string): string {
  return text.length > MAX_TURN_CHARS ? `${text.slice(0, MAX_TURN_CHARS)}…` : text
}

function buildBody(goal: string, turns: readonly AgentTranscriptTurn[], previous: readonly PulseRow[]): DecideBody {
  const opening = turns.find((t) => t.role === 'you')
  let recent = turns
    .filter((t) => t !== opening && t.role !== 'tool')
    .slice(-MAX_RECENT_TURNS)
    .map((t) => ({ from: t.role === 'you' ? 'user' : 'agent', text: clip(t.recap ? `${t.text}\n${t.recap}` : t.text) }))
  const state = (): Record<string, unknown> => ({
    goal: clip(goal || opening?.text || ''),
    first_request: clip(opening?.text ?? ''),
    recent_turns: recent,
    previous_scores: previous.map((r) => ({ ...r.scores, verdict: r.verdict }))
  })
  while (recent.length > 1 && JSON.stringify(state()).length > MAX_STATE_BYTES) recent = recent.slice(1)

  const questions: Record<string, unknown> = {}
  for (const axis of PULSE_AXES) {
    questions[axis.key] = { type: 'score', instructions: axis.ask, criteria: axis.levels }
  }
  const criteria: Record<string, string> = {}
  for (const [key, verdict] of Object.entries(PULSE_VERDICTS)) criteria[key] = verdict.when
  questions['verdict'] = {
    type: 'choice',
    instructions: "Which one best describes this coding agent's session after its latest reply?",
    criteria
  }
  return { state: state(), questions }
}

function parseRow(
  answers: Record<string, unknown>,
  sessionId: string,
  replyAt: number,
  ms: number
): PulseRow | null {
  const scores = {} as Record<PulseAxisKey, number>
  for (const axis of PULSE_AXES) {
    const score = (answers[axis.key] as { score?: unknown } | undefined)?.score
    if (typeof score !== 'number' || !Number.isFinite(score)) return null
    scores[axis.key] = pulseLevelToScore(score)
  }
  const choice = (answers['verdict'] as { choice?: unknown } | undefined)?.choice
  const verdict: PulseVerdictKey =
    typeof choice === 'string' && choice in PULSE_VERDICTS ? (choice as PulseVerdictKey) : 'on_track'
  return { at: Date.now(), sessionId, replyAt, scores, verdict, ms }
}

const listeners: ((sessionId: string) => void)[] = []

export function addPulseListener(listener: (sessionId: string) => void): void {
  listeners.push(listener)
}

function notify(sessionId: string): void {
  getMightyWindow()?.webContents.send(CHANNELS.pulseChanged, sessionId)
  for (const listener of listeners) listener(sessionId)
}

async function scoreSession(sessionId: string, force = false): Promise<void> {
  if (scoring.has(sessionId)) return
  const session = resolveSessionRef(sessionId)
  if (!session?.sessionId) return
  const turns = readSessionTranscript(session)
  const lastReply = [...turns].reverse().find((t) => t.role === 'agent')
  if (!lastReply) return
  const rows = loadRows(sessionId)
  if (!force && rows.some((r) => r.replyAt === lastReply.at)) return

  scoring.add(sessionId)
  errors.delete(sessionId)
  notify(sessionId)
  try {
    const goal = readSessionChecklist(sessionId)?.goal ?? ''
    const body = buildBody(goal, turns, rows.filter((r) => r.replyAt !== lastReply.at).slice(-PREVIOUS_ROWS))
    const result = await callJev(body, CALL_TIMEOUT_MS)
    const row = result && parseRow(result.answers, sessionId, lastReply.at, result.latencyMs)
    if (row) {
      saveRow(row)
      devLog.log(`[pulse] ${sessionId.slice(0, 8)} ${row.verdict} ${JSON.stringify(row.scores)} ${row.ms}ms`)
    } else {
      errors.set(sessionId, takeDecideFailure() || "Couldn't score this reply.")
    }
  } finally {
    scoring.delete(sessionId)
    notify(sessionId)
  }
}

function scopeOf(sessionId: string): PulseScope {
  if (PREFS.getPulseEnabled()) return 'all'
  return PREFS.getPulseSessions().has(sessionId) ? 'this' : 'off'
}

function sessionIdOf(ref: string): string | undefined {
  return typeof ref === 'string' && ref !== '' ? resolveSessionRef(ref)?.sessionId : undefined
}

export function stateFor(ref: string): PulseState {
  const sessionId = sessionIdOf(ref)
  if (!sessionId) return { enabled: PREFS.getPulseEnabled(), scoring: false, rows: [] }
  const scope = scopeOf(sessionId)
  return {
    enabled: scope !== 'off',
    scope,
    scoring: scoring.has(sessionId),
    rows: loadRows(sessionId),
    error: errors.get(sessionId)
  }
}

export function scorePulse(ref: string, force: boolean): void {
  const sessionId = sessionIdOf(ref)
  if (sessionId) void scoreSession(sessionId, force)
}

export function setPulseScope(ref: string, scope: PulseScope): void {
  if (scope !== 'all' && scope !== 'this' && scope !== 'off') return
  const sessionId = sessionIdOf(ref)
  PREFS.setPulseEnabled(scope === 'all')
  if (sessionId) PREFS.setPulseSession(sessionId, scope === 'this')
  notify('')
}

export function registerPulseIpc(): void {
  addSessionTurnEndedListener((sessionId) => {
    turnEndedAt.set(sessionId, Date.now())
    if (scopeOf(sessionId) === 'off') {
      notify(sessionId)
      return
    }
    setTimeout(() => void scoreSession(sessionId), TRANSCRIPT_SETTLE_MS)
  })

  ipcMain.handle(CHANNELS.pulseState, (_e, ref: string) => stateFor(ref))

  ipcMain.handle(CHANNELS.pulseFresh, (_e, sessionIds: string[]) => freshRows(sessionIds))

  ipcMain.handle(CHANNELS.pulseSetEnabled, (_e, on: boolean) => {
    PREFS.setPulseEnabled(on === true)
    notify('')
    return on === true
  })

  ipcMain.handle(CHANNELS.pulseSetScope, (_e, ref: string, scope: PulseScope) => setPulseScope(ref, scope))

  ipcMain.handle(CHANNELS.pulseScoreNow, (_e, ref: string, force?: boolean) => scorePulse(ref, force === true))
}

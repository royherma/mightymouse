/**
 * The Mac-side request store — spine of the agent-relay design.
 *
 * Owns the lifecycle of every notify/ask/approve/show call an MCP tool makes:
 * mint a request_id, hold it pending, resolve it from whichever surface
 * answers first (phone sheet, HUD, notification), expire it on timeout, and
 * write every resolution to an append-only audit log. This module has no
 * knowledge of MCP, push, or UI — those are separate design items that import
 * this store's typed API.
 */

import { randomUUID } from 'crypto'
import { appendFileSync, readFileSync } from 'fs'
import { EventEmitter } from 'events'
import { PATHS } from '../store/paths'
import { devLog } from '../../shared/env'
import { senderMatchKey } from '../../shared/relay-cards'
import { track } from '../analytics'
import { ANALYTICS_EVENT } from '../../shared/analytics-events'
import type { AgentOrigin } from './mcp/http-listener'
import type { DecisionWire } from '../../shared/decision-score'

export const RELAY_VERBS = ['notify', 'ask', 'approve', 'show', 'photos_get'] as const
export type RelayVerb = (typeof RELAY_VERBS)[number]

// What a notify ANNOUNCES, as opposed to `level`, which is only how alarming it
// is -- a question is not a warning, so severity could never express this.
// Defaults to 'done': fire-and-forget means nobody is waiting.
//
// 'waiting' was REMOVED rather than reworded. A notify settles
// inside mint() below, so no notify has ever been waiting on anyone -- the
// state was unspellably false, and its "Waiting on You" headline read exactly
// like `ask`, the one verb that does block and does render reply buttons.
// Agents used it to mean "I replied, your turn", which put a demand on a card
// holding no way to answer. Zod REJECTS it now instead of mapping it to a
// neighbour: falling back to 'done' would tell someone a stopped agent had
// finished, and the error names `ask` as the verb that actually waits.
// 'blocked' went the same way, and for the same reason: a notify
// resolves on mint, so "⛔ Can't Continue" printed a demand on a card with no
// buttons and a "Delivered" outcome. Agents reached for it to mean "I need your
// permission", which is `approve` -- the verb that waits, carries risk, and
// renders the two buttons that actually unblock them.
// Re-exported, not redefined: the phone and the renderer import the shared
// module directly (a renderer cannot import this file), and a second copy of
// the bands is how two surfaces end up disagreeing about what amber means.
export { RELAY_PROGRESS_BANDS, relayProgressBand, type RelayProgressBand } from '../../shared/relay-progress'

export const RELAY_NOTIFY_STATES = ['done', 'progress'] as const
export type RelayNotifyState = (typeof RELAY_NOTIFY_STATES)[number]

// 'dismissed' is its own terminal state, not a flavour of resolved: the agent
// must tell "saw it and declined" from "nobody was there" from a real answer.
export const RELAY_REQUEST_STATUSES = ['pending', 'resolved', 'timedout', 'dismissed'] as const
export type RelayRequestStatus = (typeof RELAY_REQUEST_STATUSES)[number]

// design cross-cutting: "suggest 600s" default for any blocking verb so an
// unattended agent at 3am doesn't hang forever without a floor.
export const RELAY_DEFAULT_TIMEOUT_MS = 600_000

// notify never blocks: it resolves the instant it's minted, so callers
// never wait on a human. Kept far below the blocking default rather than 0 --
// a 0 timeout would collide with "resolved before anyone read it" bookkeeping.
const RELAY_NOTIFY_TIMEOUT_MS = 1_000

// Unlike notify, a `show` exists to be LOOKED AT -- it once reused notify's 1s
// and the card vanished before a picture registered as a picture.
export const RELAY_SHOW_TIMEOUT_MS = 120_000

// How long a dismiss stays undoable. The agent is NOT told until this elapses
// (the 'delivered' emit): once it has its answer it moves on, so a later undo
// could only put a card back on a screen, which is worse than no undo at all.
export const RELAY_UNDO_WINDOW_MS = 8_000

/** How long a part-answered interview may sit untouched before the human gets
 *  a nudge. The alternative is burning the full 600s timeout in
 *  silence: they answered question 1 on a lock screen, never opened the card,
 *  and the agent is blocked on questions they don't know exist. */
export const RELAY_STALL_NUDGE_MS = 60_000

// How long a settled request stays in memory before the sweep drops it. Well
// past the longest tail any surface renders (Previous and Cleared cap at a few
// dozen), so a row is only ever swept after it has scrolled out of reach.
export const RELAY_RETENTION_MS = 6 * 60 * 60 * 1000

// How often the sweep runs. Cheap (one Map scan), so the interval is set by how
// promptly memory should come back, not by cost.
const RELAY_SWEEP_INTERVAL_MS = 10 * 60 * 1000

// How much of the append-only audit log the history restore reads back. Sized
// well past RELAY_RETENTION_MS of ordinary traffic (a row is a few hundred
// bytes) so the retention cutoff is what bounds history, never this number.
const RESTORE_TAIL_BYTES = 512 * 1024
const DECISION_TAIL_BYTES = 4 * 1024 * 1024
const DECISION_HISTORY_CAP = 200

// Which audit events are a settled request worth redrawing, and what status
// each restores as. 'created' and 'fetched' are deliberately absent: neither is
// terminal, and restoring one as pending would show a card nobody can answer.
const RESTORED_STATUS: Partial<Record<RelayAuditRow['event'], RelayRequestStatus>> = {
  sent: 'resolved',
  resolved: 'resolved',
  timedout: 'timedout',
  dismissed: 'dismissed'
}

/** Lives in the protocol file -- it rides the wire now. Imported as well as
 *  re-exported: a bare `export … from` binds nothing in this file's own scope. */
import type { RelayResolvedViaWire as RelayResolvedVia } from '../../shared/phone-remote-protocol'
export type { RelayResolvedVia }
import {
  bufferAnswer,
  cursorFor,
  isComplete,
  type RelayInterviewAnswer,
  type RelayQuestion
} from '../../shared/relay-interview'

export interface RelayRequestParams {
  /** Who is asking, as a human-readable label ("mm-dev-298 - ShowAndTell/dev").
   *  Stated by the agent, or derived by the stdio shim when it says nothing.
   *  A LABEL, never a credential: any local process can claim any name. */
  from?: string
  /** Where the calling agent runs. Attached by the listener from the shim's
   *  header, never by the agent -- it exists so the audit log can attribute a
   *  request to a checkout even when the agent stated no name at all. */
  cwd?: string
  /** The shim's "go to this session" address (cmux/tmux/terminal ids), attached
   *  by the listener the same way `cwd` is -- never stated by the agent. Lets
   *  the HUD's "go to session" button jump to the actual terminal a card came
   *  from, when the agent ran under something the Mac can address. */
  origin?: AgentOrigin
  /** Which session sent it, attached by the listener like `cwd` and `origin`.
   *  The unambiguous half of the sender join: `from` is a name two unnamed
   *  panes in one checkout share, and joining on it alone marked both rows
   *  "Handed back" when only one of them stopped. Absent on an older shim. */
  sessionId?: string
  /** A drill, not a real request. Set by the relay CLI so a rehearsal
   *  that reads "drop the prod table" can never be mistaken for the real thing.
   *  Every surface that renders a request must show it -- a marker on one screen
   *  is worse than none, because the other screens then look trustworthy. */
  test?: boolean
  title?: string
  body?: string
  level?: 'info' | 'success' | 'warn' | 'error'
  /** notify only. What the card announces (RELAY_NOTIFY_STATES). Drives the
   *  headline, so a card cannot say "finished" over a body that is asking. */
  state?: RelayNotifyState
  /** How far through the WHOLE job, 0-1. Magnitude for the `state: 'progress'`
   *  that already exists -- NOT a synonym for done: an agent can be at 1.0 and
   *  still verifying, and collapsing the two would make that unspellable.
   *  Rendered as a ring or a bar, never printed as a bare float. */
  progress?: number
  question?: string
  options?: string[]
  /** The whole array for a multi-question ask. ADDITIVE -- `question`/`options`
   *  keep carrying question 0, so nothing that only knows the single-question
   *  shape has to change. Absent for N=1. See shared/relay-interview.ts. */
  questions?: RelayQuestion[]
  context?: string
  decision?: DecisionWire
  action?: string
  detail?: string
  risk?: 'low' | 'high'
  imagePath?: string
  capture?: boolean
  caption?: string
  waitForAck?: boolean
  /** notify only. Hook ping that an agent is waiting -- settles on send, and
   *  the phone opens that session rather than Needs you. */
  idle?: boolean
  /** notify only. One sentence recapping the work just finished. An idle ping
   *  has no news of its own, so without this the banner is a bare prompt for
   *  the next instruction and cannot say which session it came from or what
   *  state the person is picking up from. */
  last?: string
}

export interface RelayResponse {
  answer?: string
  /** Which question of a multi-question ask this answers. Stated by the card,
   *  which knows its own cursor; omitted by the lock screen and every N=1
   *  surface, where the store falls back to the first unanswered index. */
  questionIndex?: number
  /** This answer REPLACES one already held for `questionIndex`. Only a card that
   *  stepped back onto an answered question sets it -- it is what tells a
   *  deliberate change apart from two surfaces racing, which the store cannot
   *  see for itself. */
  revise?: boolean
  /** 0-based option rows for a multiSelect question; validated in resolve() against options.length. */
  picks?: number[]
  approved?: boolean
  note?: string
  acked?: boolean
  /** Where a pulled photo landed on this Mac. Set by the image path that
   *  resolves a photos_get, so the agent gets a file rather than prose. An
   *  absolute path on the Mac, never a phone-side id. */
  imagePath?: string
  /** Why this settled without a human answer. 'dismissed' means someone
   *  actively cleared it; 'timeout' means it expired unattended. The agent
   *  should behave differently: a dismiss is a decision, a timeout is silence. */
  reason?: 'timeout' | 'dismissed'
}

export interface RelayRequest {
  id: string
  verb: RelayVerb
  params: RelayRequestParams
  createdAt: number
  timeoutMs: number
  status: RelayRequestStatus
  response: RelayResponse | null
  resolvedAt: number | null
  resolvedBy: string | null
  resolvedVia: RelayResolvedVia | null
  /** Answers held for a multi-question ask that is not finished yet. Empty for
   *  every N=1 request, which is what keeps `resolve()`'s one-shot semantics
   *  untouched: with no `params.questions` there is nothing to buffer INTO, so
   *  the first answer settles exactly as it always has. */
  buffered: RelayInterviewAnswer[]
  /** Set the first time the NSE's GET /relay-request succeeds for this id.
   *  Dedupe flag only -- the NSE/phone app may re-fetch the same request, and
   *  delivery proof must fire at most once per request or the count inflates. */
  fetched: boolean
}

interface RelayAuditRow {
  ts: string
  requestId: string
  verb: RelayVerb
  params: RelayRequestParams
  // 'created' is what makes a PENDING request visible: without it the log holds
  // only terminal states, so an ask still waiting for an answer -- the exact
  // thing you debug -- leaves no trace at all.
  // 'fetched' is delivery proof (docs/agent-relay.md gap #3): the NSE hitting
  // GET /relay-request is the only signal the Mac gets that a push actually
  // reached the phone, as opposed to vanishing between APNs and the device.
  event: 'created' | 'sent' | 'resolved' | 'timedout' | 'dropped-late' | 'dismissed' | 'fetched'
  response: RelayResponse | null
  deviceId: string | null
  via: RelayResolvedVia | null
  picked?: number
}

export interface ScoredPick {
  scores: number[][]
  picked: number
  best: number
}

function scoredPickOf(params: RelayRequestParams, response: RelayResponse | null, picked?: number): ScoredPick | null {
  const d = params.decision
  if (!d || params.test) return null
  const idx = picked ?? (response?.answer !== undefined ? (params.options ?? []).indexOf(response.answer) : -1)
  return idx >= 0 && idx < d.scores.length ? { scores: d.scores, picked: idx, best: d.best } : null
}

function appendAudit(row: RelayAuditRow): void {
  try {
    appendFileSync(PATHS.AGENT_RELAY_LOG, JSON.stringify(row) + '\n', 'utf-8')
  } catch (err) {
    console.error('[agent-relay] failed to append audit row', err)
  }
}

/** Unique, in-range picks only -- anything else is dropped rather than mistyped into checkboxes. */
function validPicks(raw: number[] | undefined, optionsLength: number): number[] | undefined {
  if (!raw?.length || optionsLength <= 0) return undefined
  if (new Set(raw).size !== raw.length) return undefined
  if (raw.some((n) => n < 0 || n >= optionsLength)) return undefined
  return raw
}

/** Fired on every store mutation (mint / resolve / timeout) so the HUD and the
 *  phone-remote "Code" sheet can each subscribe without polling. Payload is
 *  the full RelayRequest so a listener never has to re-fetch. */
// 'changed' is for SURFACES -- anything that draws the request. 'delivered' is
// for the AGENT, and fires once a settlement is final. They are separate because
// a dismiss changes every screen immediately while staying undoable for a few
// seconds, so the two audiences genuinely learn about it at different times.
type RelayStoreEvent = 'changed' | 'delivered' | 'stalled'

class RelayRequestStore extends EventEmitter {
  private requests = new Map<string, RelayRequest>()
  private timers = new Map<string, NodeJS.Timeout>()
  /** Stall nudges for part-answered interviews. Separate from `timers` because
   *  a nudge does NOT end the request -- it fires while the timeout is still
   *  counting, and re-arms each time another question is answered. */
  private stallTimers = new Map<string, NodeJS.Timeout>()
  /** Dismisses whose undo window is still open, so the agent has not been told
   *  yet. Separate from `timers`, which holds request TIMEOUTS -- a card in here
   *  has already left the inbox and is counting down to being delivered, which
   *  is the opposite direction. */
  private undoTimers = new Map<string, NodeJS.Timeout>()
  private sweepTimer: NodeJS.Timeout | null = null
  /** Whether the audit log has been read back yet. Hydration is lazy rather
   *  than done in the constructor because importing this store must stay free
   *  of file IO -- the stdio shim and every test import it too. */
  private restored = false
  private scoredPicks: ScoredPick[] | null = null

  mint(verb: RelayVerb, params: RelayRequestParams, timeoutMs?: number): RelayRequest {
    const resolvedTimeoutMs =
      timeoutMs ?? (verb === 'notify' ? RELAY_NOTIFY_TIMEOUT_MS : RELAY_DEFAULT_TIMEOUT_MS)
    const request: RelayRequest = {
      id: randomUUID(),
      verb,
      params,
      createdAt: Date.now(),
      timeoutMs: resolvedTimeoutMs,
      status: 'pending',
      response: null,
      resolvedAt: null,
      resolvedBy: null,
      resolvedVia: null,
      buffered: [],
      fetched: false
    }
    this.requests.set(request.id, request)
    this.startSweep()
    if (verb === 'notify') {
      // Fire-and-forget: resolves itself immediately, no timer, no wait.
      this.settle(request.id, {}, null, null)
    } else {
      // notify is excluded: it settles on the line above and logs 'sent' there,
      // so a 'created' row here would double every one of them.
      appendAudit({
        ts: new Date().toISOString(),
        requestId: request.id,
        verb,
        params,
        event: 'created',
        response: null,
        deviceId: null,
        via: null
      })
      track(ANALYTICS_EVENT.relay_request_sent, { verb })
      const timer = setTimeout(() => this.timeout(request.id), resolvedTimeoutMs)
      // Never let a 600s outstanding request keep the process alive on its own.
      timer.unref()
      this.timers.set(request.id, timer)
    }
    this.emit('changed' satisfies RelayStoreEvent, this.get(request.id))
    return this.get(request.id)!
  }

  get(id: string): RelayRequest | null {
    return this.requests.get(id) ?? null
  }

  /** Both of a request's timers, cleared together. One helper rather than three
   *  copies: a terminal transition that forgets the stall timer would nudge the
   *  human about a card they already answered. */
  private clearTimers(id: string): void {
    const timer = this.timers.get(id)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(id)
    }
    this.clearStallTimer(id)
  }

  private clearStallTimer(id: string): void {
    const stall = this.stallTimers.get(id)
    if (stall) {
      clearTimeout(stall)
      this.stallTimers.delete(id)
    }
  }

  /** Re-armed on every buffered answer, so the countdown measures silence since
   *  the LAST one rather than since the card was minted. Emits and stops: one
   *  nudge per quiet stretch, never a repeating alarm. */
  private armStallNudge(id: string): void {
    this.clearStallTimer(id)
    const stall = setTimeout(() => {
      this.stallTimers.delete(id)
      const request = this.requests.get(id)
      if (!request || request.status !== 'pending') return
      this.emit('stalled' satisfies RelayStoreEvent, request)
    }, RELAY_STALL_NUDGE_MS)
    stall.unref()
    this.stallTimers.set(id, stall)
  }

  /** Delivery proof (docs/agent-relay.md gap #3): call this from the
   *  GET /relay-request handler once credential + request are both valid --
   *  never from a 404 or a rate-limited attempt, or the audit log would read
   *  as "delivered" for a fetch that never found real content. Dedupes on
   *  `request.fetched` so a re-fetch (NSE retry, phone app also polling) never
   *  double-logs or double-counts the analytics event. No-op if the id is
   *  unknown -- callers already 404 before reaching here. */
  markFetched(id: string, deviceId: string | null): void {
    const request = this.requests.get(id)
    if (!request || request.fetched) return
    request.fetched = true
    appendAudit({
      ts: new Date().toISOString(),
      requestId: id,
      verb: request.verb,
      params: request.params,
      event: 'fetched',
      response: null,
      deviceId,
      via: null
    })
    track(ANALYTICS_EVENT.relay_request_delivered, { verb: request.verb })
  }

  /** Every request still awaiting a human, newest first — the HUD row and the
   *  Code sheet both render straight off this. */
  listPending(): RelayRequest[] {
    return [...this.requests.values()]
      .filter((r) => r.status === 'pending')
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  /** createdAt per sender whose NEWEST request is the idle "your turn" ping.
   *  Reads the whole map, not the capped resolved tail — other sessions' traffic
   *  must not be able to silently clear a still-idle session's marker. */
  idleSinceBySender(): Map<string, number> {
    return this.idleSinceKeyedBy((r) => (r.params.from ? senderMatchKey(r.params.from) : undefined))
  }

  /** The same answer keyed on session id instead of name. Preferred wherever a
   *  row has an id: two unnamed panes in one checkout share a `from`, so the
   *  name map marked BOTH "Handed back" when only one of them stopped. Rows
   *  from a shim too old to send the header simply never appear here, and the
   *  caller falls back to the name map for them. */
  idleSinceBySessionId(): Map<string, number> {
    return this.idleSinceKeyedBy((r) => r.params.sessionId)
  }

  /** The idle "your turn" notifies belonging to one session, newest first.
   *
   *  These settle at mint (they ask nothing), so they never reach the store's
   *  change feed as a retirement and nothing ever clears their lock-screen
   *  card -- it sat there tappable forever while the session had already moved
   *  on. The UserPromptSubmit hook is the signal that it is dead: the moment a
   *  human types into that session, "your turn" is answered by construction.
   *
   *  Only cards NEWER than the turn are excluded by the caller; matching is by
   *  session id first and sender name second, mirroring idleSince's own two
   *  maps, because a shim too old to send the id header only has the name. */
  idleNotifiesForSession(sessionId: string, senderKey: string | undefined): RelayRequest[] {
    this.restoreFromAudit()
    return [...this.requests.values()]
      .filter((r) => r.verb === 'notify' && r.params.idle === true)
      .filter((r) => {
        if (r.params.sessionId) return r.params.sessionId === sessionId
        return senderKey !== undefined && r.params.from !== undefined
          ? senderMatchKey(r.params.from) === senderKey
          : false
      })
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  private idleSinceKeyedBy(keyOf: (r: RelayRequest) => string | undefined): Map<string, number> {
    this.restoreFromAudit()
    const newest = new Map<string, RelayRequest>()
    for (const r of this.requests.values()) {
      const key = keyOf(r)
      if (!key) continue
      const cur = newest.get(key)
      if (!cur || r.createdAt > cur.createdAt) newest.set(key, r)
    }
    const idle = new Map<string, number>()
    for (const [key, r] of newest) {
      if (r.verb === 'notify' && r.params.idle === true) idle.set(key, r.createdAt)
    }
    return idle
  }

  /** Rebuild settled requests from the audit log, once per process.
   *
   *  The Map is memory-only, so every Mac restart used to wipe 100% of history
   *  and the phone's Previous/Cleared tabs came back permanently empty. Only
   *  terminal rows are replayed: a still-pending one lost the agent blocked on
   *  it when the old process died, so its card could never be answered. */
  private restoreFromAudit(): void {
    if (this.restored) return
    this.restored = true
    let text: string
    try {
      const buf = readFileSync(PATHS.AGENT_RELAY_LOG)
      const from = Math.max(0, buf.length - RESTORE_TAIL_BYTES)
      // A byte-offset slice can land mid-line; the first partial one is dropped
      // by the JSON.parse guard below, which is why no seek-to-newline is needed.
      text = buf.subarray(from).toString('utf-8')
    } catch {
      return // no log yet == no history, not an error
    }

    const cutoff = Date.now() - RELAY_RETENTION_MS
    // Staged rather than written straight into `this.requests`: the log is read
    // oldest-first and one id can settle twice (a dismiss, an undo, then a real
    // answer), so the LAST terminal row is the one that stuck.
    const restored = new Map<string, RelayRequest>()
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let row: RelayAuditRow
      try {
        row = JSON.parse(line) as RelayAuditRow
      } catch {
        continue
      }
      const status = RESTORED_STATUS[row.event]
      if (!status || !row.requestId) continue
      const ts = Date.parse(row.ts)
      if (!Number.isFinite(ts) || ts < cutoff) continue
      restored.set(row.requestId, {
        id: row.requestId,
        verb: row.verb,
        params: row.params ?? {},
        // No createdAt is logged on a terminal row. Using the settle time keeps
        // ordering right and reports a 0s wait, which is visibly wrong-but-safe
        // next to inventing a duration the log cannot support.
        createdAt: ts,
        timeoutMs: 0,
        status,
        response: row.response,
        resolvedAt: ts,
        resolvedBy: row.deviceId,
        resolvedVia: row.via,
        // Replayed rows are already settled, so there is nothing left to
        // collect -- an empty buffer is the truthful value, not a lossy one.
        buffered: [],
        fetched: false
      })
    }

    for (const [id, request] of restored) {
      // A request minted by THIS process is already here with a real createdAt
      // and possibly a live undo timer. The log row carries neither, so the
      // live object always wins over its own replayed row.
      if (!this.requests.has(id)) this.requests.set(id, request)
    }
  }

  recentScoredPicks(): ScoredPick[] {
    if (this.scoredPicks) return this.scoredPicks
    const picks: ScoredPick[] = []
    try {
      const buf = readFileSync(PATHS.AGENT_RELAY_LOG)
      const text = buf.subarray(Math.max(0, buf.length - DECISION_TAIL_BYTES)).toString('utf-8')
      for (const line of text.split('\n')) {
        if (!line.includes('"decision"') || !line.includes('"event":"resolved"')) continue
        try {
          const row = JSON.parse(line) as RelayAuditRow
          const pick = row.verb === 'ask' ? scoredPickOf(row.params ?? {}, row.response, row.picked) : null
          if (pick) picks.push(pick)
        } catch {
          continue
        }
      }
    } catch {
      // no log yet
    }
    this.scoredPicks = picks.slice(-DECISION_HISTORY_CAP)
    return this.scoredPicks
  }

  /** The N most recently settled requests, newest first. notify IS included:
   *  it settles the instant it's minted, so excluding it left a tapped notify
   *  push in neither list — and the Code sheet's notification-tap effect needs
   *  the request in one of them or the tap silently does nothing. Dismissed
   *  rows still have their own Cleared tab. */
  listRecentResolved(limit: number): RelayRequest[] {
    this.restoreFromAudit()
    return [...this.requests.values()]
      .filter((r) => r.status !== 'pending' && r.status !== 'dismissed')
      .sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0))
      .slice(0, limit)
  }

  /** Everything cleared without an answer, newest first — the Cleared tab. */
  listDismissed(limit: number): RelayRequest[] {
    this.restoreFromAudit()
    return [...this.requests.values()]
      .filter((r) => r.status === 'dismissed')
      .sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0))
      .slice(0, limit)
  }

  /** Resolve from whichever surface answered. First answer wins regardless of
   *  which surface it came from -- a request already resolved or timed
   *  out is a no-op, not an error, and a late answer past timeout is dropped
   *  and audit-logged (§6 cross-cutting) rather than silently accepted. */
  resolve(
    id: string,
    response: RelayResponse,
    deviceId: string | null,
    via: RelayResolvedVia
  ): 'resolved' | 'buffered' | 'already-resolved' | 'unknown' {
    const request = this.requests.get(id)
    if (!request) return 'unknown'
    if (request.status === 'timedout') {
      appendAudit({
        ts: new Date().toISOString(),
        requestId: id,
        verb: request.verb,
        params: request.params,
        event: 'dropped-late',
        response,
        deviceId,
        via
      })
      return 'already-resolved'
    }
    if (request.status === 'resolved' || request.status === 'dismissed') return 'already-resolved'

    // Multi-question: hold the answer and leave the request PENDING. Nothing is
    // typed into the picker until every question is answered -- the
    // whole array arrived up front, so the full set is validated before the
    // first keystroke rather than discovered one Enter at a time.
    const questions = request.params.questions
    if (questions && questions.length > 1 && response.answer !== undefined) {
      const index = response.questionIndex ?? cursorFor(questions, request.buffered)
      // Every question already answered, or an index off the end: nothing left
      // to hold this answer in, so fall through and settle rather than growing
      // a buffer the burst would never read.
      if (index >= 0 && index < questions.length) {
        const question = questions[index]
        const picks = question.multiSelect
          ? validPicks(response.picks, question.options?.length ?? 0)
          : undefined
        // Bad picks never buffer -- it would tell the human they'd answered.
        if (question.multiSelect && !picks) {
          devLog.warn('[agent-relay] dropped a multiSelect answer with invalid picks', {
            index,
            optionsLength: question.options?.length ?? 0
          })
          this.emit('changed' satisfies RelayStoreEvent, request)
          return 'buffered'
        }
        // A revision is only a revision if that index is actually held -- a
        // `revise` on an unanswered question is an ordinary first answer, and
        // trusting the flag blindly would let a stale card hold the interview
        // open forever on the branch below.
        const revising = response.revise === true && request.buffered.some((a) => a.index === index)
        request.buffered = bufferAnswer(
          request.buffered,
          { index, answer: response.answer, picks },
          revising
        )
        // A revision NEVER settles, even when it completes the set: changing an
        // earlier answer must not fire the burst out from under someone who is
        // still stepping through. The move forward onto the last unanswered
        // question is what ends the interview, and after a revision that
        // question is already answered -- so the card sends the final answer
        // again without `revise`, and this falls through to settle.
        if (revising || !isComplete(questions, request.buffered)) {
          // Questions remain: start (or restart) the quiet countdown, so a card
          // abandoned after question 1 gets a nudge instead of burning the full
          // timeout in silence.
          this.armStallNudge(id)
          this.emit('changed' satisfies RelayStoreEvent, request)
          return 'buffered'
        }
        // Last answer in: settle ONCE, carrying question 0's answer as the
        // response so every existing single-question reader keeps working. The
        // burst reads `buffered` for the rest.
        this.settle(id, { ...response, answer: request.buffered[0].answer }, deviceId, via)
        return 'resolved'
      }
    }

    this.settle(id, response, deviceId, via)
    return 'resolved'
  }

  /** Clear a request without answering it, unblocking the agent instead of
   *  burning the full 600s timeout. Hard rule, same as timeout(): a dismissed
   *  `approve` resolves FALSE — clearing must never read as consent. */
  dismiss(id: string, deviceId: string | null): 'dismissed' | 'already-resolved' | 'unknown' {
    const request = this.requests.get(id)
    if (!request) return 'unknown'
    if (request.status !== 'pending') return 'already-resolved'

    this.clearTimers(id)
    request.status = 'dismissed'
    request.resolvedAt = Date.now()
    request.resolvedBy = deviceId
    request.resolvedVia = 'dismiss'
    request.response =
      request.verb === 'approve'
        ? { approved: false, reason: 'dismissed' }
        : { reason: 'dismissed' }

    // The card leaves every surface NOW (the emit below), but the agent is not
    // told until the window closes -- see `deliverDismiss`. The two halves are
    // split precisely so undo has something real to cancel.
    const deliver = setTimeout(() => this.deliverDismiss(id), RELAY_UNDO_WINDOW_MS)
    deliver.unref()
    this.undoTimers.set(id, deliver)
    this.emit('changed' satisfies RelayStoreEvent, request)
    return 'dismissed'
  }

  /** The undo window closed: tell the agent, and only now write the audit row
   *  and the metric. Auditing at dismiss time would log clears that were taken
   *  back, which makes the dismiss rate unreadable -- the number is supposed to
   *  say how often the inbox produces things people throw away. */
  private deliverDismiss(id: string): void {
    this.undoTimers.delete(id)
    const request = this.requests.get(id)
    // Undone, or swept. Either way there is nothing to deliver.
    if (!request || request.status !== 'dismissed') return

    appendAudit({
      ts: new Date().toISOString(),
      requestId: id,
      verb: request.verb,
      params: request.params,
      event: 'dismissed',
      response: request.response,
      deviceId: request.resolvedBy,
      via: 'dismiss'
    })
    // The counterpart to relay_request_timeout: a rising dismiss rate means the
    // inbox is generating things people throw away, which is a content problem,
    // not a delivery one. Separating them is the only way to tell those apart.
    track(ANALYTICS_EVENT.relay_request_dismissed, {
      verb: request.verb,
      seconds: Math.round(((request.resolvedAt ?? Date.now()) - request.createdAt) / 1000)
    })
    // The emit the agent is actually waiting on. Marked so `awaitResolution`
    // can tell it apart from the cosmetic one dismiss() already fired.
    this.emit('delivered' satisfies RelayStoreEvent, request)
    this.emit('changed' satisfies RelayStoreEvent, request)
  }

  /** True while a dismiss is still undoable, i.e. settled on screen but not yet
   *  delivered to the agent. The one honest answer to "can this still be taken
   *  back", so both the UI and `awaitResolution` read it rather than each
   *  inferring the window from a timestamp. */
  undoPending(id: string): boolean {
    return this.undoTimers.has(id)
  }

  /** Put a dismissed card back in the inbox. Only possible while its undo window
   *  is open -- once the agent has been told, its `ask`/`approve` call has
   *  already returned and there is nothing left to un-tell. Returns false so the
   *  caller can say "too late" rather than silently doing nothing. */
  undismiss(id: string): boolean {
    const deliver = this.undoTimers.get(id)
    if (!deliver) return false
    clearTimeout(deliver)
    this.undoTimers.delete(id)

    const request = this.requests.get(id)
    if (!request) return false

    request.status = 'pending'
    request.response = null
    request.resolvedAt = null
    request.resolvedBy = null
    request.resolvedVia = null

    // Restart the ORIGINAL timeout from now rather than resuming what was left
    // of it: a card taken back with 4s remaining would time out under the user's
    // hands, which reads as the undo having failed.
    const timer = setTimeout(() => this.timeout(id), request.timeoutMs)
    timer.unref()
    this.timers.set(id, timer)

    this.emit('changed' satisfies RelayStoreEvent, request)
    return true
  }

  private timeout(id: string): void {
    const request = this.requests.get(id)
    if (!request || request.status !== 'pending') return
    request.status = 'timedout'
    request.resolvedAt = Date.now()
    request.resolvedVia = 'timeout'
    // Hard rule (§6 approve, matched for ask/show): never auto-approve. A
    // timed-out approve resolves false with an explicit reason, never true.
    request.response =
      request.verb === 'approve' ? { approved: false, reason: 'timeout' } : { reason: 'timeout' }
    this.timers.delete(id)
    this.clearStallTimer(id)
    appendAudit({
      ts: new Date().toISOString(),
      requestId: id,
      verb: request.verb,
      params: request.params,
      event: 'timedout',
      response: request.response,
      deviceId: null,
      via: 'timeout'
    })
    // A rising rate here is the silent failure this feature is most prone to:
    // the push never landed, or landed somewhere the human couldn't answer it.
    track(ANALYTICS_EVENT.relay_request_timeout, {
      verb: request.verb,
      seconds: Math.round(request.timeoutMs / 1000)
    })
    this.emit('delivered' satisfies RelayStoreEvent, request)
    this.emit('changed' satisfies RelayStoreEvent, request)
  }

  private settle(
    id: string,
    response: RelayResponse,
    deviceId: string | null,
    via: RelayResolvedVia | null
  ): void {
    const request = this.requests.get(id)
    if (!request) return
    this.clearTimers(id)
    request.status = 'resolved'
    request.response = response
    request.resolvedAt = Date.now()
    request.resolvedBy = deviceId
    request.resolvedVia = via
    const pick = request.verb === 'ask' ? scoredPickOf(request.params, response) : null
    if (pick && this.scoredPicks) this.scoredPicks = [...this.scoredPicks, pick].slice(-DECISION_HISTORY_CAP)
    // notify is nobody's answer -- it settles itself at mint -- so it logs as
    // 'sent' rather than 'resolved'. It still logs: §6 audits EVERY verb, and
    // an unpaired Mac has the log as notify's only surface.
    appendAudit({
      ts: new Date().toISOString(),
      requestId: id,
      verb: request.verb,
      params: request.params,
      event: request.verb === 'notify' ? 'sent' : 'resolved',
      response,
      deviceId,
      via,
      picked: pick?.picked
    })
    // The number this whole subsystem is judged on: how long a human left the
    // agent blocked. notify reports 0 by construction, never a real wait.
    if (request.verb !== 'notify') {
      track(ANALYTICS_EVENT.relay_request_resolved, {
        verb: request.verb,
        seconds: Math.round((request.resolvedAt - request.createdAt) / 1000),
        via: via ?? 'unknown'
      })
    }
    this.emit('delivered' satisfies RelayStoreEvent, request)
    this.emit('changed' satisfies RelayStoreEvent, request)
  }

  /** Drop settled requests past their retention. Started lazily on the first
   *  mint rather than at module load so importing the store (a test, the shim)
   *  never plants an interval nobody asked for. */
  private startSweep(): void {
    if (this.sweepTimer) return
    const timer = setInterval(() => this.sweep(), RELAY_SWEEP_INTERVAL_MS)
    timer.unref()
    this.sweepTimer = timer
  }

  private sweep(): void {
    const cutoff = Date.now() - RELAY_RETENTION_MS
    for (const [id, request] of this.requests) {
      // Pending is never swept however old it is: an agent is still blocked on
      // it, and dropping it here would leave that call waiting on an emit that
      // can no longer come. The timeout is what ends a pending request.
      if (request.status === 'pending') continue
      // Nor is a dismiss still inside its undo window -- its delivery timer
      // holds this id and would find nothing.
      if (this.undoTimers.has(id)) continue
      if ((request.resolvedAt ?? request.createdAt) < cutoff) this.requests.delete(id)
    }
  }

  /** Test-only: drop every in-flight timer and request so suites don't leak
   *  handles or bleed state into the next test. */
  resetForTests(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    for (const timer of this.stallTimers.values()) clearTimeout(timer)
    for (const timer of this.undoTimers.values()) clearTimeout(timer)
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.sweepTimer = null
    this.timers.clear()
    this.stallTimers.clear()
    this.undoTimers.clear()
    this.requests.clear()
    // Reset too, or a suite that cleared the store gets it silently refilled
    // from the real audit log on the next history read.
    this.restored = false
    this.removeAllListeners()
  }
}

export const relayRequestStore = new RelayRequestStore()

export function onRelayStoreChanged(listener: (request: RelayRequest) => void): () => void {
  relayRequestStore.on('changed' satisfies RelayStoreEvent, listener)
  return () => relayRequestStore.off('changed' satisfies RelayStoreEvent, listener)
}

/** Subscribe as the AGENT rather than as a surface: fires only once a request
 *  has finally settled, which for a dismiss is after its undo window closes.
 *  Anything that unblocks an MCP call must use this, never 'changed'. */
export function onRelayDelivered(listener: (request: RelayRequest) => void): () => void {
  relayRequestStore.on('delivered' satisfies RelayStoreEvent, listener)
  return () => relayRequestStore.off('delivered' satisfies RelayStoreEvent, listener)
}

/** A part-answered interview has gone quiet. Fires once per quiet
 *  stretch and only while the request is still pending, so a listener may push
 *  without re-checking whether the human already finished. */
export function onRelayStalled(listener: (request: RelayRequest) => void): () => void {
  relayRequestStore.on('stalled' satisfies RelayStoreEvent, listener)
  return () => relayRequestStore.off('stalled' satisfies RelayStoreEvent, listener)
}

/** Row identity as far as the handoff join is concerned. Structural rather than
 *  `AgentSession`, so the CLI's session route can pass its own shape. */
export type HandoffRow = { sessionId?: string; stated?: string; label: string }

/** "When did this row hand back?", built once per snapshot for a whole list.
 *
 * Id first, name second -- and the name only when exactly ONE row answers to
 * it. The old unconditional name join is the bleed: `from` is a human name, and
 * two unnamed Cursor panes in one checkout share it, so one agent's idle ping
 * marked its twin "Handed back" while that twin was still working.
 *
 * The name fallback stays for unshared names on purpose. Every ping minted
 * before `sessionId` rode the wire is name-keyed only, so an id-only join would
 * blank the handoff on every existing row until its agent next stopped. */
export function handoffResolver(
  rows: readonly HandoffRow[]
): (row: HandoffRow) => number | undefined {
  const byId = relayRequestStore.idleSinceBySessionId()
  const byName = relayRequestStore.idleSinceBySender()
  const rowsPerName = new Map<string, number>()
  for (const r of rows) {
    const key = senderMatchKey(r.stated ?? r.label)
    rowsPerName.set(key, (rowsPerName.get(key) ?? 0) + 1)
  }
  return (row) => {
    const hit = row.sessionId !== undefined ? byId.get(row.sessionId) : undefined
    if (hit !== undefined) return hit
    const key = senderMatchKey(row.stated ?? row.label)
    return rowsPerName.get(key) === 1 ? byName.get(key) : undefined
  }
}

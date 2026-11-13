/**
 * Both doors -- an agent pointed straight at this port, and `npx
 * mightymouse-code` proxying over stdio -- hit the SAME McpServer, so a fix
 * here reaches both. Stateless transport (one JSON-RPC request per HTTP call)
 * because a session would outlive an app restart the agent never sees.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CONFIG } from '../../../shared/config'
import type { AgentOrigin } from '../../../shared/types'
import type { Suggestion } from '../../../shared/swipe-suggest'
import { devLog } from '../../../shared/env'
import { AGENT_SESSIONS } from '../../store/agent-sessions'
import { buildAgentRelayMcpServer } from './build-server'
import { TLDR_MAX, SESSION_ID_MIN_PREFIX } from './session-tldr-file'
import { recallSessionStart, rememberSessionStart } from './session-starts'
import { CoordinationService } from '../coordination/service'
import { COORDINATION } from '../../../shared/coordination'
import { PATHS } from '../../store/paths'
import { handlePageReply } from '../page-reply'
import { codexThreadIdForAgent } from '../codex-threads'

export { TLDR_MAX }

let httpServer: Server | null = null
let coordination: CoordinationService | null = null
export function getCoordinationService(): CoordinationService {
  return coordination ??= new CoordinationService(PATHS.ROOT)
}
let lastAgentSeen: { at: number; from?: string } | null = null

/** Orphan detection is a few cheap signal-0 calls, so this is about how long a
 *  dead agent may sit in the list, not about cost. */
const SWEEP_MS = 30_000
let sweep: NodeJS.Timeout | null = null

const UNNAMED_SESSION = CONFIG.UI_LABELS.CODE_SESSION_UNNAMED

export interface AgentSession {
  label: string
  since: number
  /** The shim's derived repo/branch — the join key for a later `from` upgrade. */
  derived?: string
  /** Where the agent is running, so two same-named checkouts stay distinct. */
  cwd?: string
  /** What the agent called itself. Shown UNDER `label`, never as it: a dictated
   *  name arrives garbled ("mm-ask-interiv-eueqetions-help") often enough that
   *  it can't be the string you navigate by. */
  stated?: string
  /** Set once the socket closes. The row survives GRACE_MS so a blip stops
   *  bouncing the count, and a reconnect can reclaim the name below. */
  staleSince?: number
  /** The agent's own session id, when it sent one. The ONLY field here that
   *  survives a rename, which makes it the join key for a reconnect. */
  sessionId?: string
  /** What the shim could see about its own session that this process cannot:
   *  the checkout split into parts, the process id, and which agent/effort/
   *  entrypoint is running. Every key is optional -- a plain `claude` in a
   *  terminal exposes fewer of them than one under the cmux wrapper. */
  facts?: SessionFacts
  /** The shim's "go to this session" address, when it could derive one. */
  origin?: AgentOrigin
  /** Failed presence opens before this socket registered. Absent means first
   *  try; a large number is the fingerprint of a flaky path to this port. */
  attempts?: number
  /** One plain line saying what this session is ABOUT, in the agent's own words.
   *  Every other field here is identity (which repo, which pane, which model) or
   *  an event; with six panes open on one checkout this is the only thing that
   *  tells them apart by subject. Declared by the agent via `recap`, and
   *  deliberately rewritten as the work moves on. */
  tldr?: string
  /** How far along the agent says it is, 0-1, declared via `notify`. Not carried
   *  on the reconnect payload below: a stale number outlives the work it
   *  described, so a restart should drop the ring rather than restore a lie. */
  progress?: number
  affects?: string[]
  /** When the current turn STARTED, or undefined between turns. Set by the
   *  UserPromptSubmit hook and cleared by Stop, so it means mid-turn only --
   *  a session waiting on a build it kicked off has already ended its turn and
   *  is not busy. Deliberately NEVER restamped: its age is what proves a turn
   *  is still plausible, and refreshing it would let a wedged session claim
   *  "Responding..." forever. Liveness is `lastActivityAt`'s job, not this. */
  busySince?: number
  /** When this session last PROVED it was working, refreshed by every tool-use
   *  ping. `busySince` alone could only say a human typed here once, so an agent
   *  grinding autonomously for an hour decayed to "Connected" at the 10-minute
   *  cap and read as idle. Split from `busySince` so both facts stay true: that
   *  one is turn AGE (never refreshed), this one is LIVENESS (always refreshed),
   *  and a killed agent now stops refreshing and decays in one short window
   *  instead of lying for ten minutes. */
  lastActivityAt?: number
  /** When this session's last turn ENDED. `lastActivityAt` is cleared by Stop,
   *  so an idle session carries no record of when it last did anything and every
   *  between-turns agent ranks identically on `since` — the terminal's open time.
   *  This one survives the turn, and is what recency ranking and the staleness
   *  cutoff actually read. */
  lastTurnEndedAt?: number
}

export interface SessionFacts {
  repo?: string
  branch?: string
  pid?: number
  /** The AGENT's pid, not the shim's — `pid` above is the proxy, and killing it
   *  leaves `claude` running headless with the row gone. Absent on any shim
   *  older than 0.2.3, which must read as "wrap-up unavailable": falling back to
   *  `pid` here would signal the wrong process. */
  agentPid?: number
  agent?: string
  effort?: string
  entrypoint?: string
  model?: string
  /** The session's subject, carried so a RECONNECT restores it. The live Map does
   *  not survive an app restart by design, and the agent should not have to
   *  re-declare after one -- so the shim reads the line back off disk and hands
   *  it over here, the same way it already recovers a name. */
  tldr?: string
}

/** Declared in `shared/types.ts` now that the renderer and the phone both read
 *  it off a session, and re-exported here so every existing importer of
 *  `AgentOrigin` from this module keeps working. */
export type { AgentOrigin } from '../../../shared/types'

/** Anything the shim sends is display text, so it is bounded and type-checked
 *  here rather than trusted: a wrong shape must leave the row plain, never
 *  break the list that renders it. */
function parseFacts(raw: string | undefined): SessionFacts | undefined {
  if (!raw) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const source = parsed as Record<string, unknown>
    const text = (v: unknown): string | undefined =>
      typeof v === 'string' && v.trim() ? v.trim().slice(0, 80) : undefined
    const facts: SessionFacts = {
      repo: text(source.repo),
      branch: text(source.branch),
      pid: typeof source.pid === 'number' && Number.isInteger(source.pid) ? source.pid : undefined,
      agentPid:
        typeof source.agentPid === 'number' && Number.isInteger(source.agentPid) && source.agentPid > 1
          ? source.agentPid
          : undefined,
      agent: text(source.agent),
      effort: text(source.effort),
      entrypoint: text(source.entrypoint),
      model: text(source.model),
      // Its own cap: every other fact here is a short identity token, while this
      // is a sentence, and 80 would cut one mid-word.
      tldr:
        typeof source.tldr === 'string' && source.tldr.trim()
          ? source.tldr.trim().slice(0, TLDR_MAX)
          : undefined
    }
    return Object.values(facts).some((v) => v !== undefined) ? facts : undefined
  } catch {
    // Malformed JSON means an older or broken shim. The row still works.
    return undefined
  }
}

/** Same defensive shape as parseFacts: a wrong type here must drop the field,
 *  never throw, since this rides an ordinary tool call and can't block it. */
/** Absent, junk, and zero all mean the same thing here: arrived first try. */
function parseAttempts(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

function parseOrigin(raw: string | undefined): AgentOrigin | undefined {
  if (!raw) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const source = parsed as Record<string, unknown>
    const text = (v: unknown): string | undefined =>
      typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : undefined
    const origin: AgentOrigin = {
      cmuxWorkspaceId: text(source.cmuxWorkspaceId),
      cmuxTabId: text(source.cmuxTabId),
      cmuxBundleId: text(source.cmuxBundleId),
      tmuxPane: text(source.tmuxPane),
      tmuxSocket: text(source.tmuxSocket),
      termProgram: text(source.termProgram),
      hostBundleId: text(source.hostBundleId)
    }
    return Object.values(origin).some((v) => v !== undefined) ? origin : undefined
  } catch {
    return undefined
  }
}

// Keyed by the socket: one live shim holds one entry. Entries outlive their
// socket by GRACE_MS (see reapStale) so a dropped connection reads as a blip
// rather than a session that ended.
const sessions = new Map<unknown, AgentSession>()

/** A socket close is usually a blip, not a terminal the human closed: holding
 *  the row briefly stops the count flickering and lets a reconnect reclaim it. */
const GRACE_MS = 30_000

const closing = new Set<unknown>()

/** Names of sessions whose socket dropped, keyed by derived checkout, so a
 *  reconnect within the grace window comes back as itself instead of unnamed.
 *  `since` rides along because the row's age claims to be how long the terminal
 *  has been open -- re-stamping it on reconnect printed "2m" on a four-hour
 *  session, and that stamp is also the sort key when an agent has sent no card. */
const recentNames = new Map<
  string,
  { label: string; stated?: string; tldr?: string; since: number; at: number }
>()

/** ONE builder for both sides of the reclaim: formatting the key inline at each
 *  site let a stray NUL make them disagree on strings that printed identically. */
function reclaimKeyFor(of: Pick<AgentSession, 'derived' | 'cwd' | 'sessionId' | 'origin'>): string {
  const clean = (v: string | undefined): string => (v ?? '').replace(/\0/g, '').trim()
  // Identity CANNOT anchor this key: a rename changes it, and a rename is
  // exactly when a session reconnects wanting to be reclaimed. It stays the
  // fallback for an agent sending no session id, which can't rename anyway.
  // Without an id, every pane in one checkout shares `derived`, so the pane tells them apart.
  const pane = clean(of.origin?.tmuxPane)
  return `${clean(of.sessionId) || (pane && `pane:${pane}:${clean(of.origin?.tmuxSocket)}`) || clean(of.derived)}${clean(of.cwd)}`
}

/** A shim outlives its agent when the terminal is killed rather than closed:
 *  the socket stays open with nothing behind it, so the row claims an agent that
 *  can never answer. Signal 0 tests existence without touching the process.
 *  Only a session that REPORTED a pid can be checked -- absence of a pid means
 *  unknown, never dead, so an older shim is left exactly where it is. */
function agentProcessGone(session: AgentSession): boolean {
  const pid = session.facts?.pid
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (err) {
    // EPERM means it exists under another user -- alive, just not ours to signal.
    return (err as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

function reapStale(): void {
  const cutoff = Date.now() - GRACE_MS
  let changed = false
  for (const [key, session] of sessions) {
    if (session.staleSince !== undefined && session.staleSince < cutoff) {
      sessions.delete(key)
      changed = true
    } else if (agentProcessGone(session)) {
      sessions.delete(key)
      changed = true
    }
  }
  for (const [key, entry] of recentNames) {
    if (entry.at < cutoff) recentNames.delete(key)
  }
  if (changed) onSessionsChanged?.()
}

export function isAgentRelayMcpRunning(): boolean {
  return httpServer !== null
}

/** Drops a wrapped session's row NOW rather than waiting out GRACE_MS plus a
 *  sweep tick. The grace exists so a dropped socket reads as a blip -- but a
 *  wrap is the one case where the end is intended, and holding the row for
 *  another half-minute makes the count lie about work that is already over.
 *  Also forgets the reclaim entry, so the pane's NEXT agent starts as itself
 *  instead of inheriting the wrapped session's name and age. */
export function forgetAgentSession(sessionId: string): void {
  let changed = false
  for (const [key, session] of sessions) {
    if (session.sessionId !== sessionId) continue
    sessions.delete(key)
    recentNames.delete(reclaimKeyFor(session))
    changed = true
  }
  if (changed) onSessionsChanged?.()
}

/** Open agent sessions right now — 0 when every terminal is closed. Sessions
 *  inside the grace window are excluded: this drives the count, and a blip must
 *  not read as an agent that is still working. */
export function liveAgentSessions(): AgentSession[] {
  return [...sessions.values()]
    .filter((s) => s.staleSince === undefined)
    .sort((a, b) => a.since - b.since)
}

/** Set by the phone-remote IPC layer, which owns the suggestion path. Injected
 *  rather than imported: this module is upstream of it, and the route only
 *  exists so a terminal can fire what only a handset otherwise can. */
/** Injected rather than imported: the request store already imports this module
 *  for its `AgentOrigin` type, so reaching back for a value would close a cycle.
 *  Same shape as `suggestProbe` below, and for the same reason. */
let idleProbe:
  | ((rows: readonly AgentSession[]) => (row: AgentSession) => number | undefined)
  | undefined
export function setIdleProbe(fn: typeof idleProbe): void {
  idleProbe = fn
}

let suggestProbe: ((label: string) => Promise<Suggestion[]>) | undefined
export function setSuggestProbe(fn: typeof suggestProbe): void {
  suggestProbe = fn
}

/** Live sessions plus the ones inside their grace window, which the Code tab
 *  renders faded rather than dropping. */
export function listedAgentSessions(): AgentSession[] {
  return [...sessions.values()].sort((a, b) => a.since - b.since)
}

/** The only trustworthy answer to "is an agent connected?" — a config file with
 *  our entry in it proves nothing ran, and Claude Code stores its servers
 *  per-project, so the file check misses a working setup entirely. */
export function lastAgentContact(): { at: number; from?: string } | null {
  return lastAgentSeen
}

/** Node decodes header bytes as latin-1, so any non-ASCII the shim sent (a
 *  folder with an accent, an emoji in a session name) arrives mojibaked --
 *  "Â·" for "·". Re-reading those bytes as UTF-8 restores it; text that was
 *  plain ASCII all along is byte-identical either way, so this is safe to run
 *  unconditionally. */
function decodeHeader(raw: string | string[] | undefined): string | undefined {
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim()
  if (!value) return undefined
  return Buffer.from(value, 'latin1').toString('utf8')
}

const CODEX_ID_TRIES = 20
const CODEX_ID_RETRY_MS = 1500

// Shims before 0.2.8 send no id for a Codex launched through npx; Codex opens its chat file a moment after start.
async function adoptCodexThreadId(key: IncomingMessage['socket'], agentPid: number): Promise<void> {
  if (!(agentPid > 1)) return
  for (let i = 0; i < CODEX_ID_TRIES; i++) {
    if (!sessions.get(key) || sessions.get(key)?.staleSince !== undefined || sessions.get(key)?.sessionId) return
    const id = await codexThreadIdForAgent(agentPid)
    const now = sessions.get(key)
    if (id && now && !now.sessionId) {
      sessions.set(key, { ...now, sessionId: id })
      onSessionsChanged?.()
      return
    }
    await new Promise((done) => setTimeout(done, CODEX_ID_RETRY_MS))
  }
}

/** Never ends the response: the open socket IS the registration, and the OS
 *  tears it down when the shim process dies. */
function registerPresence(req: IncomingMessage, res: ServerResponse): void {
  reapStale()
  const key = req.socket
  const derived = decodeHeader(req.headers[CONFIG.AGENT_RELAY.IDENTITY_HEADER])
  const cwd = decodeHeader(req.headers[CONFIG.AGENT_RELAY.CWD_HEADER])
  const sessionId = decodeHeader(req.headers[CONFIG.AGENT_RELAY.SESSION_HEADER])
  const facts = parseFacts(decodeHeader(req.headers[CONFIG.AGENT_RELAY.FACTS_HEADER]))
  const origin = parseOrigin(decodeHeader(req.headers[CONFIG.AGENT_RELAY.ORIGIN_HEADER]))
  const attempts = parseAttempts(decodeHeader(req.headers[CONFIG.AGENT_RELAY.ATTEMPTS_HEADER]))

  // A session that dropped moments ago and came straight back is the same
  // terminal: give it its name back rather than resetting it to the derived
  // label, which is what made a reconnect look like a brand-new agent.
  const reclaimKey = reclaimKeyFor({ derived, cwd, sessionId, origin })
  const reclaimed = recentNames.get(reclaimKey)
  if (reclaimed) recentNames.delete(reclaimKey)

  // A reconnect SUPERSEDES the dropped socket's row: same terminal, so leaving
  // the old row to fade out next to the new one rendered as a duplicate.
  for (const [k, s] of sessions) {
    if ((s.staleSince !== undefined || closing.has(k)) && reclaimKeyFor(s) === reclaimKey) {
      sessions.delete(k)
    }
  }

  // The in-memory reclaim only spans GRACE_MS, which an app restart always
  // exceeds -- so the disk cache is what carries `since` across one. Ordered
  // after it because a live blip has the fresher answer of the two.
  const known = reclaimed?.since ?? recallSessionStart(reclaimKey)
  if (known === undefined) AGENT_SESSIONS.started()
  const since = known ?? Date.now()
  rememberSessionStart(reclaimKey, since)

  sessions.set(key, {
    // A reconnect carrying a NEW identity is a rename, not a fresh session, so
    // the incoming label wins over the reclaimed one -- reclaim exists to keep
    // the `stated` name across the gap, not to pin the old label forever.
    label: derived ?? reclaimed?.label ?? UNNAMED_SESSION,
    stated: reclaimed?.stated,
    since,
    derived,
    cwd,
    sessionId,
    facts,
    origin,
    attempts,
    // The header wins: it is what the shim just read off disk, so an agent that
    // re-declared while the app was down comes back saying the new thing. The
    // reclaimed value only covers a blip too short for any of that to happen.
    tldr: facts?.tldr ?? reclaimed?.tldr
  })

  // Node closes an idle socket after ~2min by default, which would drop a
  // session that is simply waiting for the user to type.
  req.socket.setTimeout(0)
  req.socket.setKeepAlive(true)
  res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' })
  res.write('ok\n')

  const drop = (): void => {
    const session = sessions.get(key)
    if (!session || session.staleSince !== undefined || closing.has(key)) return
    closing.add(key)
    // Recorded even when the session never named itself: the name was the only
    // thing worth reclaiming before, but `since` is worth reclaiming for every
    // session, and an unnamed one that blipped would otherwise reset its age.
    const named = session.label !== (session.derived ?? UNNAMED_SESSION) || session.stated
    recentNames.set(reclaimKeyFor(session), {
      label: named ? session.label : (session.derived ?? UNNAMED_SESSION),
      stated: session.stated,
      tldr: session.tldr,
      since: session.since,
      at: Date.now()
    })
    setTimeout(() => {
      closing.delete(key)
      const current = sessions.get(key)
      if (!current) return
      // Mark, don't delete: reapStale removes it once the grace window passes.
      sessions.set(key, { ...current, staleSince: Date.now() })
      onSessionsChanged?.()
      setTimeout(reapStale, GRACE_MS + 1_000).unref()
    }, CONFIG.AGENT_RELAY.RENAME_GAP_MS).unref()
  }
  req.socket.once('close', drop)
  req.socket.once('error', drop)
  onSessionsChanged?.()
  if (!sessionId && facts?.agent === 'codex' && origin?.tmuxPane) void adoptCodexThreadId(key, Number(facts.agentPid))
}

function isCaller(session: AgentSession, caller: { origin?: AgentOrigin; sessionId?: string }): boolean {
  if (caller.sessionId && session.sessionId === caller.sessionId) return true
  const pane = caller.origin?.tmuxPane
  return !!pane && session.origin?.tmuxPane === pane && session.origin?.tmuxSocket === caller.origin?.tmuxSocket
}

/**
 * A verb call knows the agent's real name ("mm-dev-298 - ShowAndTell/dev");
 * presence only ever knows the derived repo/branch, which is identical for
 * every session in one checkout. The two arrive on different sockets, so the
 * derived string is the only join key -- and with several sessions sharing it,
 * the one that has not been named yet is the one that just called.
 */
export function nameAgentSession(
  derived: string | undefined,
  stated: string,
  caller: { origin?: AgentOrigin; sessionId?: string } = {}
): void {
  const claimed = stated.trim()
  if (!claimed) return

  // Live sessions only: a socket inside its grace window is on its way out, and
  // naming it would hand the label to a row that is about to be reaped.
  const candidates = [...sessions.entries()].filter(
    ([, s]) => s.derived === derived && s.staleSince === undefined
  )
  if (candidates.length === 0) return

  const own = candidates.find(([, s]) => isCaller(s, caller))
  if (own) {
    if (own[1].stated !== undefined) return
    for (const [key, s] of candidates) {
      if (s.stated === claimed) sessions.set(key, { ...s, stated: undefined })
    }
    sessions.set(own[0], { ...own[1], stated: claimed })
    onSessionsChanged?.()
    return
  }

  if (candidates.some(([, s]) => s.stated === claimed)) return

  // The derived repo/branch stays the label: a dictated name arrives garbled
  // too often to be the string the human navigates by, so it rides as a subtitle.
  const target = candidates.find(([, s]) => s.stated === undefined)
  if (!target) return
  sessions.set(target[0], { ...target[1], stated: claimed })
  onSessionsChanged?.()
}

/** The one live id this string means, or undefined for none AND for a prefix
 *  fitting several -- resolving those to the first hit would retitle a
 *  bystander's row. Prefixes are accepted because the list prints the head. */
export function resolveSessionId(id: string): string | undefined {
  const hits = new Set<string>()
  for (const [, session] of sessions) {
    if (session.sessionId === id) return id
    if (id.length >= SESSION_ID_MIN_PREFIX && session.sessionId?.startsWith(id)) {
      hits.add(session.sessionId)
    }
  }
  return hits.size === 1 ? [...hits][0] : undefined
}

/** OVERWRITES, unlike `nameAgentSession`: a name is defended, a subject
 *  changes with the work. Keyed on `sessionId`, never the derived string a
 *  whole checkout shares. Returns whether a row carried the id. */
export function setAgentSessionTldr(sessionId: string | undefined, text: string): boolean {
  const id = sessionId?.trim()
  if (!id) return false

  const full = resolveSessionId(id)
  if (!full) return false

  const tldr = text.trim().slice(0, TLDR_MAX) || undefined
  let matched = false
  let changed = false
  for (const [key, session] of sessions) {
    if (session.sessionId !== full) continue
    matched = true
    if (session.tldr === tldr) continue
    sessions.set(key, { ...session, tldr })
    changed = true
  }
  if (changed) onSessionsChanged?.()
  return matched
}

export function setAgentSessionAffects(sessionId: string, names: string[]): void {
  const affects = names.length ? names : undefined
  let changed = false
  for (const [key, session] of sessions) {
    if (session.sessionId !== sessionId) continue
    sessions.set(key, { ...session, affects })
    changed = true
  }
  if (changed) onSessionsChanged?.()
}

/** How far along the agent says it is, 0-1. A SESSION field, like `tldr`: the
 *  number belongs to the agent, not to whichever card happened to carry it, so
 *  it survives a card the sheet fails to match. `undefined` clears the ring. */
export function setAgentSessionProgress(
  sessionId: string | undefined,
  progress: number | undefined
): boolean {
  const id = sessionId?.trim()
  if (!id) return false

  const full = resolveSessionId(id)
  if (!full) return false

  let matched = false
  let changed = false
  for (const [key, session] of sessions) {
    if (session.sessionId !== full) continue
    matched = true
    if (session.progress === progress) continue
    sessions.set(key, { ...session, progress })
    changed = true
  }
  if (changed) onSessionsChanged?.()
  return matched
}

/** Flips the mid-turn flag. Same shape as `setAgentSessionTldr` and for the same
 *  reason: keyed on `sessionId`, never the derived string a whole checkout
 *  shares, or six panes in one repo would light up together. `at` is passed in
 *  rather than stamped here so the hook's own moment survives a slow relay. */
export function setAgentSessionBusy(
  sessionId: string | undefined,
  busy: boolean,
  at: number = Date.now()
): boolean {
  const id = sessionId?.trim()
  if (!id) return false

  const full = resolveSessionId(id)
  if (!full) return false
  compacting.delete(full)

  let matched = false
  let changed = false
  let turnStarted = false
  let turnEnded = false
  for (const [key, session] of sessions) {
    if (session.sessionId !== full) continue
    matched = true
    if (!busy) {
      // Turn over: both stamps go. Leaving activity behind would keep the row
      // claiming "Responding..." after Stop already said otherwise.
      if (session.busySince === undefined && session.lastActivityAt === undefined) continue
      sessions.set(key, {
        ...session,
        busySince: undefined,
        lastActivityAt: undefined,
        lastTurnEndedAt: session.lastActivityAt ?? at
      })
      changed = true
      turnEnded = true
      continue
    }
    // A second `--on` inside one turn must NOT restamp `busySince`: the age of
    // the turn is what the staleness cap measures, and refreshing it would let a
    // wedged session claim "Responding..." forever by heartbeat alone. Activity
    // IS refreshed every time -- that is the whole point of the second field, and
    // it is what keeps a long autonomous run from decaying to "Connected".
    const busySince = session.busySince ?? at
    // The RISING edge only: `busySince` already set means the turn was underway
    // and this is a liveness ping, not a person typing. Collected rather than
    // fired inline so one turn notifies once even across duplicate session rows.
    if (session.busySince === undefined) turnStarted = true
    if (session.busySince === busySince && session.lastActivityAt === at) continue
    sessions.set(key, { ...session, busySince, lastActivityAt: at })
    changed = true
  }
  if (changed) onSessionsChanged?.()
  if (turnStarted) onSessionTurnStarted?.(full)
  if (turnEnded) for (const fn of turnEndedListeners) fn(full)
  return matched
}

const compacting = new Map<string, number>()

export function sessionCompactingSince(sessionId: string | undefined): number | undefined {
  return sessionId ? compacting.get(sessionId) : undefined
}

/** Codex desktop threads are not in `sessions`, so an unresolved id is kept as sent. */
export function setAgentSessionCompacting(sessionId: string, on: boolean, manual: boolean): void {
  const id = sessionId.trim()
  if (!id) return
  const full = resolveSessionId(id) ?? id
  if (on) {
    setAgentSessionBusy(full, true)
    compacting.set(full, Date.now())
  } else {
    compacting.delete(full)
    // A manual /compact fires no Stop, so nothing else would end the turn.
    if (manual) setAgentSessionBusy(full, false)
  }
  onSessionsChanged?.()
}

/** Fired when a session goes from between-turns to mid-turn, i.e. the exact
 *  moment a human typed into it. Separate from `onSessionsChanged`, which fires
 *  on every field of every session and would re-run this on each tool-use ping.
 *  Only the RISING edge is a user interaction; the rest is the agent working. */
let onSessionTurnStarted: ((sessionId: string) => void) | null = null

export function setSessionTurnStartedListener(fn: ((sessionId: string) => void) | null): void {
  onSessionTurnStarted = fn
}

const turnEndedListeners = new Set<(sessionId: string) => void>()

export function addSessionTurnEndedListener(fn: (sessionId: string) => void): void {
  turnEndedListeners.add(fn)
}

let onSessionsChanged: (() => void) | null = null

export function setAgentSessionsListener(fn: (() => void) | null): void {
  onSessionsChanged = fn
}

// A web page that points its own domain at 127.0.0.1 still sends that domain as Host.
function isLoopbackHost(host: string | undefined, server: Server): boolean {
  const bound = server.address()
  const port = bound && typeof bound === 'object' ? bound.port : null
  const match = /^(127\.0\.0\.1|localhost|\[::1\])(?::(\d+))?$/i.exec(host ?? '')
  return match !== null && (match[2] === undefined || Number(match[2]) === port)
}

/** `port` is for tests only — a real run must use the port the shim hard codes,
 *  and 0 asks the OS for a free one so a test never fights the running app. */
export async function startAgentRelayMcp(
  port: number = CONFIG.AGENT_RELAY.MCP_PORT
): Promise<{ ok: true; port: number } | { ok: false; reason: string }> {
  if (httpServer) {
    const addr = httpServer.address()
    if (addr && typeof addr === 'object') return { ok: true, port: addr.port }
  }

  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      // Loopback-only by construction (bound to 127.0.0.1 below), but a
      // second belt-and-suspenders check costs nothing and matches the
      // phone-remote observer socket's own posture on a shared listener.
      const remote = req.socket.remoteAddress
      if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
        res.writeHead(403).end()
        return
      }
      if (!isLoopbackHost(req.headers.host, server)) {
        res.writeHead(403).end()
        return
      }
      if (req.url === COORDINATION.route || req.url === COORDINATION.mcpRoute) {
        try {
          void getCoordinationService().handle(req, res)
        } catch (error) {
          devLog.error('[coordination] failed to open work history', error)
          res.writeHead(503).end('Shared work is temporarily unavailable.')
        }
        return
      }
      if (handlePageReply(req, res)) return
      if (req.method === 'GET' && req.url === CONFIG.AGENT_RELAY.PRESENCE_ROUTE) {
        registerPresence(req, res)
        return
      }
      if (req.method === 'GET' && req.url === CONFIG.AGENT_RELAY.SESSIONS_ROUTE) {
        // The identity each session actually registered, which is the one thing
        // the UI cannot tell you: a row showing a raw id could mean the naming
        // hook did not run OR that the shim connected before it did, and those
        // need different fixes.
        // `handedBackAt` rides along because the phone shows it and the CLI could
        // not, so checking "what does that row say" meant re-deriving it from the
        // audit log by hand -- which got the timestamp field and its units wrong
        // twice in one sitting. The probe is the SAME resolver the app renders
        // from, injected whole rather than as a map: re-deriving the join here
        // is how the CLI ended up disagreeing with the row it was describing.
        const rows = listedAgentSessions()
        const idleFor = idleProbe?.(rows)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            sessions: rows.map((s) => ({ ...s, handedBackAt: idleFor?.(s), compactingSince: compacting.get(s.sessionId ?? '') }))
          })
        )
        return
      }
      if (req.method === 'GET' && req.url?.startsWith(CONFIG.AGENT_RELAY.ACTIVE_ROUTE)) {
        // Deliberately a GET with no body: the caller is a shell hook on the
        // hottest path in the system, and `curl -s <url>` is the cheapest thing
        // it can do. Carries no data beyond the id -- the stamp is always "now".
        const id = new URL(req.url, 'http://x').searchParams.get('session') ?? ''
        const matched = id ? setAgentSessionBusy(id, true) : false
        res.writeHead(matched ? 200 : 404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: matched }))
        return
      }
      if (req.method === 'GET' && req.url?.startsWith(CONFIG.AGENT_RELAY.COMPACT_ROUTE)) {
        const params = new URL(req.url, 'http://x').searchParams
        const id = params.get('session') ?? ''
        if (id) setAgentSessionCompacting(id, params.get('on') === '1', params.get('trigger') === 'manual')
        res.writeHead(id ? 200 : 400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: Boolean(id) }))
        return
      }
      if (req.method === 'GET' && req.url?.startsWith(CONFIG.AGENT_RELAY.SUGGEST_ROUTE)) {
        const label = new URL(req.url, 'http://x').searchParams.get('label') ?? ''
        if (!suggestProbe || !label) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: suggestProbe ? 'label required' : 'probe unavailable' }))
          return
        }
        void suggestProbe(label).then(
          (suggestions) => {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ label, suggestions }))
          },
          (err: Error) => {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: err.message }))
          }
        )
        return
      }
      if (req.method !== 'POST' || req.url !== CONFIG.AGENT_RELAY.MCP_ROUTE) {
        res.writeHead(404).end()
        return
      }
      // Stateless mode is one transport PER request: reusing one throws
      // "cannot be reused across requests" on the second call.
      void (async () => {
        // Only the npx shim sets this; an agent pointed straight at this port
        // falls back to whatever `from` it stated.
        // Must decode exactly as registerPresence does: the derived string is
        // the join key between the two sockets, and comparing a latin-1 copy
        // against a UTF-8 one silently never matched for any non-ASCII path.
        const derivedFrom = decodeHeader(req.headers[CONFIG.AGENT_RELAY.IDENTITY_HEADER])
        const cwd = decodeHeader(req.headers[CONFIG.AGENT_RELAY.CWD_HEADER])
        const origin = parseOrigin(decodeHeader(req.headers[CONFIG.AGENT_RELAY.ORIGIN_HEADER]))
        const requestSessionId = decodeHeader(req.headers[CONFIG.AGENT_RELAY.SESSION_HEADER])
        lastAgentSeen = { at: Date.now(), from: derivedFrom }
        const mcpServer = buildAgentRelayMcpServer(
          derivedFrom,
          (stated) => nameAgentSession(derivedFrom, stated, { origin, sessionId: requestSessionId }),
          cwd,
          origin,
          requestSessionId
        )
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
        res.on('close', () => {
          void transport.close()
          void mcpServer.close()
        })
        await mcpServer.connect(transport)
        await transport.handleRequest(req, res)
      })().catch((err) => {
        devLog.error('[agent-relay] MCP request failed', err)
        if (!res.headersSent) res.writeHead(500).end()
      })
    })
    server.on('error', (err) => {
      devLog.error('[agent-relay] MCP listener failed to start', err)
      httpServer = null
      // Deliberately NOT a port retry, unlike phone-remote: the phone discovers
      // its port via /whoami, but the npm shim dials 17781 blind, so binding
      // 17782 would succeed while every agent kept talking to a dead port --
      // a silent failure worse than this loud one. The port is fixed, so the
      // only useful move is naming which of the two causes it is.
      const code = (err as NodeJS.ErrnoException).code
      resolve({ ok: false, reason: code === 'EADDRINUSE' ? 'port-busy' : err.message })
    })
    server.listen(port, '127.0.0.1', () => {
      httpServer = server
      // An orphaned shim never closes its socket, so nothing else would ever
      // fire the check that removes it -- reapStale otherwise only runs when
      // some OTHER session connects or drops.
      sweep = setInterval(reapStale, SWEEP_MS)
      sweep.unref()
      const bound = server.address()
      const actual = bound && typeof bound === 'object' ? bound.port : port
      devLog.log('[agent-relay] MCP listening', { port: actual })
      resolve({ ok: true, port: actual })
    })
  })
}

export function stopAgentRelayMcp(): void {
  coordination?.close()
  coordination = null
  if (sweep) {
    clearInterval(sweep)
    sweep = null
  }
  if (!httpServer) return
  // Held-open presence sockets keep `close()` from ever completing, so they are
  // destroyed explicitly. Their own close handlers clear the session entries.
  for (const socket of sessions.keys()) {
    ;(socket as { destroy?: () => void }).destroy?.()
  }
  sessions.clear()
  httpServer.close()
  httpServer = null
  onSessionsChanged?.()
}

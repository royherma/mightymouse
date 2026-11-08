// The only verb that CAUSES a row to leave the list. Step 1 is the whole
// product: the agent finishes in its own words, so nothing unwritten is lost --
// never SIGKILL, same reason. It ends the AGENT and drops the row; the terminal
// it was running in is left open to resume in.

import { CONFIG } from '../../shared/config'
import { devLog } from '../../shared/env'
import {
  ANALYTICS_EVENT,
  type RelaySessionWrapSource
} from '../../shared/analytics-events'
import { track } from '../analytics'
import { BUSY_MAX_MS } from '../../shared/relay-status'
import { sendPaneText } from './picker-keys'
import {
  forgetAgentSession,
  listedAgentSessions,
  resolveSessionId,
  type AgentSession
} from './mcp/http-listener'

export type WrapUpOutcome =
  /** Typed, and the agent left. */
  | 'closed'
  /** Typed, but it was still running when we stopped watching. Not a failure --
   *  a long final commit outlives the wait, and the row reaps itself later. */
  | 'asked'
  /** Nothing was typed: no pane, no tty, or the transport refused. */
  | 'unreachable'
  /** No `agentPid` on the row, so a close could only signal the shim -- which
   *  would drop the row and leave the agent running headless. */
  | 'unsupported'

/** Whether this row can be wrapped up at all. A shim older than 0.2.3 sends no
 *  `agentPid`, and the `pid` it does send is the PROXY: signalling that kills
 *  the pipe and leaves `claude` burning tokens with its row gone. So absence
 *  means unavailable, never a fallback. */
export function canWrapUp(session: Pick<AgentSession, 'facts' | 'staleSince'>): boolean {
  return session.staleSince === undefined && session.facts?.agentPid !== undefined
}

/** The ONE way a surface turns a user-facing string into a session to type into.
 *
 * Cursor and VS Code set no session-id env var, so the shim derives a bare
 * `repo/branch` label -- two panes in one checkout are byte-identical. Every
 * caller used to `.find()` that, and `.find()` takes the FIRST, which
 * `listedAgentSessions()` sorts oldest-first: the reply landed reliably in the
 * wrong terminal. Refusing beats guessing here -- someone else's agent reading
 * your text is worse than being told to name the session. */
export function resolveSessionRef(ref: string): AgentSession | undefined {
  const sessions = listedAgentSessions()
  // Id first, and exactly: a real session id can never be ambiguous, so a
  // surface that has one is immune to the collision below.
  const full = resolveSessionId(ref)
  if (full) return sessions.find((s) => s.sessionId === full)
  const hits = sessions.filter((s) => s.label === ref || s.stated === ref)
  return hits.length === 1 ? hits[0] : undefined
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Signal 0 tests existence without touching the process. EPERM means it exists
 *  under another user -- alive, just not ours to signal. */
function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

/** Wait out the agent's turn so `/exit` does not land mid-thought. `busySince`
 *  has no server-side expiry -- staleness is applied at RENDER time only -- so a
 *  crashed agent's stamp claims busy forever without the same cap here. */
async function waitUntilIdle(read: () => AgentSession | undefined): Promise<void> {
  const until = Date.now() + CONFIG.AGENT_RELAY.WRAP_UP_IDLE_WAIT_MS
  while (Date.now() < until) {
    const session = read()
    if (!session) return
    const busySince = session.busySince
    if (busySince === undefined) return
    if (Date.now() - busySince >= BUSY_MAX_MS) return
    await delay(CONFIG.AGENT_RELAY.WRAP_UP_POLL_MS)
  }
}

/** Steps 2 and 3. `read` is a getter, not the session: `busySince` is written
 *  on a different socket, so a captured snapshot could never change. */
async function finishWrapUp(
  session: AgentSession,
  read: () => AgentSession | undefined
): Promise<WrapUpOutcome> {
  const agentPid = session.facts?.agentPid
  if (agentPid === undefined) return 'unsupported'

  await waitUntilIdle(read)
  if (processGone(agentPid)) return closed(session)

  // Step 2 -- clean CLI teardown: flushes history and runs Stop hooks, which is
  // where this repo's own autocommit lives.
  await sendPaneText(session.origin, '/exit', session.facts?.pid)
  await delay(CONFIG.AGENT_RELAY.WRAP_UP_EXIT_GRACE_MS)
  if (processGone(agentPid)) return closed(session)

  // Step 3 -- it had both chances. SIGTERM, never SIGKILL: an ungraceful end
  // discards exactly the unwritten work step 1 existed to save.
  try {
    process.kill(agentPid, 'SIGTERM')
  } catch (err) {
    devLog.warn('[agent-relay] wrap-up SIGTERM failed', (err as Error).message)
  }
  await delay(CONFIG.AGENT_RELAY.WRAP_UP_EXIT_GRACE_MS)
  if (!processGone(agentPid)) return 'asked'
  return closed(session)
}

/** The agent is gone; the TERMINAL is not. Wrapping ends a conversation, not a
 *  workspace -- the pane stays so the same window can `claude --resume` right
 *  where it left off. Only the row goes, immediately, because the count is the
 *  thing a wrap was called to bring down. */
function closed(session: AgentSession): WrapUpOutcome {
  if (session.sessionId) forgetAgentSession(session.sessionId)
  return 'closed'
}

export type WrapUpStart =
  /** Step 1 was typed. `done` settles when the escalation finishes, up to about
   *  80s later -- a caller that has a socket open must not await it. */
  | { ok: true; via: 'tmux' | 'tty'; done: Promise<WrapUpOutcome> }
  | { ok: false; reason: Exclude<WrapUpOutcome, 'closed' | 'asked'> }

/** One escalation per session. The phone gives no feedback for the minute in
 *  between, so a double-tap is the expected input -- and two escalations would
 *  run two independent SIGTERM timers against one pid. */
const inFlight = new Map<string, { via: 'tmux' | 'tty'; done: Promise<WrapUpOutcome> }>()

/** Every surface enters here holding a NAME, never a session object -- each one
 *  resolving that differently is how a wrap lands on the wrong terminal. */
export async function startSessionWrap(
  ref: string,
  source: RelaySessionWrapSource
): Promise<WrapUpStart> {
  const find = (): AgentSession | undefined => resolveSessionRef(ref)
  const session = find()
  // A stale row's pane may already belong to whatever the user opened next, so
  // typing into it is worse than doing nothing. Matches relaySessionReply.
  if (!session || session.staleSince !== undefined) return { ok: false, reason: 'unreachable' }
  if (!canWrapUp(session)) return { ok: false, reason: 'unsupported' }

  const already = inFlight.get(session.label)
  if (already) return { ok: true, ...already }

  const via = await sendPaneText(
    session.origin,
    CONFIG.AGENT_RELAY.WRAP_UP_PROMPT,
    session.facts?.pid
  )
  if (via === 'skipped') return { ok: false, reason: 'unreachable' }
  devLog.log('[agent-relay] wrap-up asked', { label: session.label, via })
  track(ANALYTICS_EVENT.relay_session_wrap_started, { source })
  const done = finishWrapUp(session, find)
    .then((outcome) => {
      track(ANALYTICS_EVENT.relay_session_wrap_finished, { source, outcome })
      return outcome
    })
    .finally(() => inFlight.delete(session.label))
  inFlight.set(session.label, { via, done })
  return { ok: true, via, done }
}

/** Blocks until the session is gone or has had every chance. Use this only where
 *  waiting a minute is fine -- a terminal command, or a caller that already
 *  answered its own client. */
export async function wrapUpSessionByRef(
  ref: string,
  source: RelaySessionWrapSource
): Promise<WrapUpOutcome> {
  const started = await startSessionWrap(ref, source)
  return started.ok ? started.done : started.reason
}


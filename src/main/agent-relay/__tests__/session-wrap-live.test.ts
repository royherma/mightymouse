/**
 * The refusal half of wrap-up, end to end.
 *
 * `startSessionWrap` is the only verb in the product that CAUSES a session to
 * end, so what matters is not that a good case works -- it is that every bad
 * case refuses BEFORE a key is sent. A unit test of the predicate would still
 * pass if someone moved the `canWrapUp` check below `sendPaneText`, which is
 * the one mistake here that types into a stranger's terminal.
 *
 * So this drives the REAL MCP listener and registers REAL presence sockets, the
 * same path `npx mightymouse-code` takes, and spies on the transport instead of
 * the decision: the assertion is "zero keys were typed", not "it returned the
 * string I expected".
 *
 * Binds port 0 (OS-assigned) -- NEVER 17781, which is the user's running app holding
 * 30-40 live sessions. `startAgentRelayMcp(port)` documents that parameter as
 * test-only for exactly this reason, and `beforeAll` asserts it rather than
 * trusting this comment.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { request } from 'http'
import { readFileSync } from 'fs'
import { spawnSync } from 'child_process'
import { CONFIG } from '../../../shared/config'

// sendPaneText is the ONLY thing that can reach a terminal from here. Mocked at
// the module boundary so a refusal that leaks through is observable as a call,
// not inferred from a return value -- and so no test run can type into a pane.
const sendPaneText = vi.fn(async () => 'tmux' as 'tmux' | 'tty' | 'skipped')
vi.mock('../picker-keys', () => ({ sendPaneText: (...a: unknown[]) => sendPaneText(...(a as [])) }))

// track leaves the machine, so it is mocked rather than fired at the real
// analytics client -- and mocking it makes the wrap counters assertable here
// instead of needing a second harness that re-registers live sessions.
const track = vi.fn()
vi.mock('../../analytics', () => ({ track: (...a: unknown[]) => track(...(a as [])) }))

/** Every props payload fired for `name`, in order. */
function fired(name: string): Array<Record<string, unknown>> {
  return track.mock.calls
    .filter((c) => c[0] === name)
    .map((c) => c[1] as Record<string, unknown>)
}

// resolveBinary reaches the real filesystem for tmux; nothing under test may
// find a real one. Partial, not a replacement: a barrel re-exports every name
// in here, so a bare object fails the import outright.
vi.mock('../../platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../platform')>()
  return { ...actual, resolveBinary: () => null }
})

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => '/tmp', getAppPath: () => process.cwd() }
}))

let port = 0
const openSockets: ReturnType<typeof request>[] = []

/** Registers a session the way the shim does: a held-open GET /presence whose
 *  headers carry the facts. The OPEN SOCKET is the registration, so the request
 *  is deliberately never ended. Resolves once the row exists. */
async function registerSession(headers: Record<string, string>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        path: CONFIG.AGENT_RELAY.PRESENCE_ROUTE,
        method: 'GET',
        headers
      },
      (res) => {
        res.on('data', () => resolve())
        res.on('error', () => undefined)
      }
    )
    req.on('error', reject)
    req.end()
    openSockets.push(req)
  })
}

/**
 * A pid that is guaranteed to be dead, for any row that must pass `canWrapUp`.
 *
 * NEVER `process.pid` here: an `ok` start leaves finishWrapUp running, and it
 * escalates to `process.kill(agentPid, 'SIGTERM')` 8s after `/exit`. A row
 * carrying the runner's own pid means the suite SIGTERMs vitest if it outlives
 * that window -- an earlier draft of this file did exactly that and passed only
 * because the run happened to finish first.
 *
 * A dead pid also short-circuits the escalation at its first `processGone`
 * check, so nothing is ever signalled.
 */
const DEAD_PID = (() => {
  // Claim a pid by spawning something trivial, then wait for it to exit. The
  // number is real (so it passes the > 1 parse guard) and refers to nothing.
  const proc = spawnSync('true', [])
  return proc.pid && proc.pid > 1 ? proc.pid : 2_147_483_600
})()

function facts(extra: Record<string, unknown>): string {
  // `pid` is the SHIM's, which is only ever read to find a pty to type into --
  // never signalled. `agentPid` is the one that gets SIGTERMed, so callers pass
  // DEAD_PID for it explicitly.
  return JSON.stringify({ repo: 'ShowAndTell', branch: 'dev', pid: DEAD_PID, ...extra })
}

describe('session wrap-up refusals, live listener', () => {
  let listener: typeof import('../mcp/http-listener')
  let control: typeof import('../session-control')

  beforeAll(async () => {
    vi.resetModules()
    listener = await import('../mcp/http-listener')
    control = await import('../session-control')
    // 0 = OS-assigned. The assertion below is the real guard, not this comment.
    const started = await listener.startAgentRelayMcp(0)
    expect(started.ok, 'test listener must start to prove anything').toBe(true)
    if (started.ok) port = started.port
    expect(port, 'must never bind the real MCP port').not.toBe(CONFIG.AGENT_RELAY.MCP_PORT)
    expect(port, 'must have been assigned a real port').toBeGreaterThan(0)
  }, 30_000)

  afterAll(() => {
    for (const req of openSockets) req.destroy()
    listener?.stopAgentRelayMcp()
  })

  beforeEach(() => {
    sendPaneText.mockClear()
    track.mockClear()
  })

  it('refuses an unknown ref without typing anything', async () => {
    const result = await control.startSessionWrap('no-such-session', 'agent')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('unreachable')
    // The whole point: a ref that matches nothing must not fall through to a
    // pane. `find()` returning undefined and `sendPaneText` being reached are
    // two different bugs, and only this assertion tells them apart.
    expect(sendPaneText, 'an unknown ref must never reach a terminal').not.toHaveBeenCalled()
  })

  it('refuses a session whose shim sent no agentPid', async () => {
    await registerSession({
      [CONFIG.AGENT_RELAY.IDENTITY_HEADER]: 'old-shim-session',
      [CONFIG.AGENT_RELAY.SESSION_HEADER]: 'sess-old-shim',
      // No agentPid: every shim before 0.2.3. `pid` IS present and is the shim's
      // own -- signalling it would kill the pipe and leave the agent running
      // headless with its row gone, which is why absence must never fall back.
      [CONFIG.AGENT_RELAY.FACTS_HEADER]: facts({})
    })

    const row = listener.listedAgentSessions().find((s) => s.sessionId === 'sess-old-shim')
    expect(row, 'session must have registered').toBeDefined()
    expect(row?.facts?.pid, 'the shim pid is present').toBeGreaterThan(0)
    expect(row?.facts?.agentPid, 'but the agent pid is not').toBeUndefined()

    const result = await control.startSessionWrap('sess-old-shim', 'agent')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('unsupported')
    expect(sendPaneText, 'an un-closable session must never be typed into').not.toHaveBeenCalled()
  })

  it('drops an agentPid of 0 or 1 at the parse layer, so it reads as unsupported', async () => {
    // pid 1 is launchd. The guard is in parseFacts (http-listener.ts:109-111),
    // NOT in canWrapUp -- so the row is built with agentPid undefined and the
    // refusal is indistinguishable from an old shim. Asserting the PARSED field
    // is what makes this a different test rather than the previous one twice.
    await registerSession({
      [CONFIG.AGENT_RELAY.IDENTITY_HEADER]: 'init-pid-session',
      [CONFIG.AGENT_RELAY.SESSION_HEADER]: 'sess-init-pid',
      [CONFIG.AGENT_RELAY.FACTS_HEADER]: facts({ agentPid: 1 })
    })

    const row = listener.listedAgentSessions().find((s) => s.sessionId === 'sess-init-pid')
    expect(row, 'session must have registered').toBeDefined()
    expect(row?.facts?.agentPid, 'pid 1 must be dropped, never carried').toBeUndefined()
    expect(control.canWrapUp(row!), 'and so it cannot be wrapped up').toBe(false)

    const result = await control.startSessionWrap('sess-init-pid', 'agent')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('unsupported')
    expect(sendPaneText).not.toHaveBeenCalled()
  })

  it('refuses a stale row, because its pane may already belong to something else', async () => {
    await registerSession({
      [CONFIG.AGENT_RELAY.IDENTITY_HEADER]: 'stale-session',
      [CONFIG.AGENT_RELAY.SESSION_HEADER]: 'sess-stale',
      [CONFIG.AGENT_RELAY.FACTS_HEADER]: facts({ agentPid: DEAD_PID })
    })

    // Drop the socket the way a closed terminal does. The row survives GRACE_MS
    // with staleSince set -- which is precisely the window this must refuse in,
    // since the human may have opened something else in that pane.
    const socket = openSockets.pop()
    socket?.destroy()
    await vi.waitFor(() => {
      const row = listener.listedAgentSessions().find((s) => s.sessionId === 'sess-stale')
      expect(row?.staleSince, 'row must be marked stale').toBeDefined()
    })

    const result = await control.startSessionWrap('sess-stale', 'agent')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('unreachable')
    expect(sendPaneText, 'a stale pane must never be typed into').not.toHaveBeenCalled()
  })

  it('refuses when the transport itself cannot reach a terminal', async () => {
    await registerSession({
      [CONFIG.AGENT_RELAY.IDENTITY_HEADER]: 'no-pane-session',
      [CONFIG.AGENT_RELAY.SESSION_HEADER]: 'sess-no-pane',
      [CONFIG.AGENT_RELAY.FACTS_HEADER]: facts({ agentPid: DEAD_PID })
    })
    // No tmux pane and no writable pty: sendPaneText's own refusal.
    sendPaneText.mockResolvedValueOnce('skipped')

    const result = await control.startSessionWrap('sess-no-pane', 'agent')

    expect(result.ok).toBe(false)
    // 'skipped' must surface as unreachable, never as a silent success -- the
    // caller shows a person this string.
    if (!result.ok) expect(result.reason).toBe('unreachable')
    expect(sendPaneText, 'it was attempted exactly once').toHaveBeenCalledTimes(1)
  })

  it('resolves a ref by sessionId, label, or stated name', async () => {
    await registerSession({
      [CONFIG.AGENT_RELAY.IDENTITY_HEADER]: 'label-lookup-session',
      [CONFIG.AGENT_RELAY.SESSION_HEADER]: 'sess-lookup',
      [CONFIG.AGENT_RELAY.FACTS_HEADER]: facts({ agentPid: DEAD_PID })
    })

    // Every surface (phone, Mac list, the relay CLI, the agent's own wrap_up)
    // arrives holding a NAME, never a session object. Each resolving it
    // differently is how a wrap lands on the wrong terminal, so both spellings
    // must reach the same row.
    const byId = await control.startSessionWrap('sess-lookup', 'agent')
    expect(byId.ok, 'sessionId must resolve').toBe(true)

    // A SECOND row, because a completed wrap now drops the first one from the
    // list immediately -- addressing the same session twice would be asserting
    // that a wrapped row lingers, which is the behaviour this replaced.
    await registerSession({
      [CONFIG.AGENT_RELAY.IDENTITY_HEADER]: 'label-lookup-other',
      [CONFIG.AGENT_RELAY.SESSION_HEADER]: 'sess-lookup-other',
      [CONFIG.AGENT_RELAY.FACTS_HEADER]: facts({ agentPid: DEAD_PID })
    })
    const byLabel = await control.startSessionWrap('label-lookup-other', 'agent')
    expect(byLabel.ok, 'the derived label must resolve too').toBe(true)

    // Counting calls, or indexing past the first, would be a race rather than
    // an assertion: an `ok` start leaves finishWrapUp running and its step-2
    // `/exit` interleaves on its own clock. The invariant that survives that
    // ordering is what a session is asked FIRST -- the prompt, so nothing
    // unwritten is lost. `/exit` reaching a pane before it is step 1 landing
    // out of order, which is the one failure worth failing the build for.
    expect(sendPaneText.mock.calls[0][1]).toBe(CONFIG.AGENT_RELAY.WRAP_UP_PROMPT)
  })

  it('drops the row as soon as the agent is gone, without killing the pane', async () => {
    await registerSession({
      [CONFIG.AGENT_RELAY.IDENTITY_HEADER]: 'wrapped-session',
      [CONFIG.AGENT_RELAY.SESSION_HEADER]: 'sess-wrapped',
      [CONFIG.AGENT_RELAY.FACTS_HEADER]: facts({ agentPid: DEAD_PID })
    })
    const inList = (): boolean =>
      listener.listedAgentSessions().some((s) => s.sessionId === 'sess-wrapped')
    expect(inList(), 'session must have registered').toBe(true)

    const started = await control.startSessionWrap('sess-wrapped', 'agent')
    expect(started.ok).toBe(true)
    if (started.ok) await started.done

    // The count is the whole point of wrapping: a row that lingers for the 30s
    // stale grace plus a sweep tick makes it lie about work already over.
    expect(inList(), 'a wrapped row leaves the list immediately').toBe(false)

    // And the terminal SURVIVES -- wrap-up ends a conversation, not a
    // workspace, so the same pane can resume. Asserted as "the source file
    // contains no kill-pane" because the alternative is mocking tmux and
    // proving a negative about a child process that must never be spawned.
    const source = readFileSync(new URL('../session-control.ts', import.meta.url), 'utf8')
    expect(source, 'wrap-up must never close the terminal it ran in').not.toContain('kill-pane')
  })

  it('resolves the short id that the relay CLI prints', async () => {
    await registerSession({
      [CONFIG.AGENT_RELAY.IDENTITY_HEADER]: 'prefix-lookup-session',
      [CONFIG.AGENT_RELAY.SESSION_HEADER]: 'dbce4a88-9865-4dff-9326-968f0c92cd28',
      [CONFIG.AGENT_RELAY.FACTS_HEADER]: facts({ agentPid: DEAD_PID })
    })

    // The list prints an 8-char id, so exact-match alone rejects the exact
    // string the user just read off it. Regression: this failed live.
    const byPrefix = await control.startSessionWrap('dbce4a88', 'agent')
    expect(byPrefix.ok, 'the printed short id must resolve').toBe(true)
  })

  it('refuses a label two live sessions share, but still wraps either by id', async () => {
    // Cursor and VS Code export no session-id env var, so two panes in one
    // checkout carry a byte-identical label. `.find()` takes the FIRST, and
    // the list sorts oldest-first: the wrap landed on the older agent.
    const shared = 'ShowAndTell/dev'
    for (const id of ['sess-twin-a', 'sess-twin-b']) {
      await registerSession({
        [CONFIG.AGENT_RELAY.IDENTITY_HEADER]: shared,
        [CONFIG.AGENT_RELAY.SESSION_HEADER]: id,
        // A LIVE shim pid, unlike every test above: registering the second twin
        // runs `reapStale`, and a dead `pid` sweeps the first away -- leaving
        // one row and quietly testing nothing. `agentPid` stays dead.
        [CONFIG.AGENT_RELAY.FACTS_HEADER]: JSON.stringify({
          repo: 'ShowAndTell',
          branch: 'dev',
          pid: process.pid,
          agentPid: DEAD_PID
        })
      })
    }
    const twins = listener.listedAgentSessions().filter((s) => s.label === shared)
    expect(twins.length, 'both twins must be registered under one label').toBe(2)

    const ambiguous = await control.startSessionWrap(shared, 'agent')
    expect(ambiguous.ok, 'an ambiguous label must not pick one').toBe(false)
    // The assertion that matters: not the return value, but that no key reached
    // a terminal. A refusal that still typed would be the original bug.
    expect(sendPaneText, 'nothing may be typed on an ambiguous ref').not.toHaveBeenCalled()

    // And the escape hatch works: the id is unambiguous by construction, so a
    // surface that carries one is never blocked by its twin.
    const byId = await control.startSessionWrap('sess-twin-b', 'agent')
    expect(byId.ok, 'the id must still resolve past the collision').toBe(true)
  })

  it('counts a wrap only once it is real, and never on a refusal', async () => {
    // A refusal firing the counter is the failure that matters: it would report
    // sessions closed that are still sitting in the list, and the whole reason
    // this event exists is to tell those two apart.
    await control.startSessionWrap('no-such-session', 'phone')
    expect(fired('relay_session_wrap_started'), 'a refusal is not a wrap').toEqual([])

    await registerSession({
      [CONFIG.AGENT_RELAY.IDENTITY_HEADER]: 'counted-session',
      [CONFIG.AGENT_RELAY.SESSION_HEADER]: 'sess-counted',
      [CONFIG.AGENT_RELAY.FACTS_HEADER]: facts({ agentPid: DEAD_PID })
    })

    const started = await control.startSessionWrap('sess-counted', 'phone')
    expect(started.ok).toBe(true)
    // `source` is the half that makes the number readable: an agent ending
    // itself is the feature working, a human tapping the phone is cleanup.
    expect(fired('relay_session_wrap_started')).toEqual([{ source: 'phone' }])

    if (started.ok) await started.done
    // The outcome, not just the attempt: 'started' minus 'closed' is the gap
    // where a person pressed the button and the agent outlived the wait.
    expect(fired('relay_session_wrap_finished')).toEqual([
      { source: 'phone', outcome: 'closed' }
    ])
  })
})

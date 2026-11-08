/**
 * The start-time cache that survives an app restart.
 *
 * The bug it fixes was invisible to every existing test: they all run inside one
 * process, where the in-memory reclaim already carries `since`. Only a restart --
 * which no unit test performs -- drops that reclaim, and every surviving agent
 * came back claiming it had just started. So this exercises the file directly and
 * simulates the restart by dropping the module's in-memory copy.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'fs'

// `vi.hoisted` because vi.mock is lifted above ordinary top-level consts, so the
// factory would otherwise close over an uninitialized binding. Pure string work
// only -- hoisted code runs before this file's imports resolve.
const { dir, FILE } = vi.hoisted(() => {
  const d = `/tmp/mm-session-starts-${process.pid}`
  return { dir: d, FILE: `${d}/agent-relay-session-starts.json` }
})

// Mocked rather than pointed at the real store: these tests must never touch
// ~/MightyMouse, which is the running app's live state on this machine.
vi.mock('../../../store/paths', () => ({
  PATHS: { AGENT_RELAY_SESSION_STARTS: FILE }
}))

import {
  recallSessionStart,
  rememberSessionStart,
  _resetSessionStarts
} from '../session-starts'

/** What a `make restart` does to this module: the file stays, the cache does not. */
function restart(): void {
  _resetSessionStarts()
}

beforeEach(() => {
  mkdirSync(dir, { recursive: true })
  rmSync(FILE, { force: true })
  _resetSessionStarts()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('agent-relay session starts', () => {
  it('carries a start time across a restart', () => {
    const started = Date.now() - 4 * 3_600_000
    rememberSessionStart('repo|/cwd', started)

    restart()

    expect(recallSessionStart('repo|/cwd')).toBe(started)
  })

  it('has no answer for a session it never saw', () => {
    rememberSessionStart('repo|/cwd', Date.now())
    restart()
    expect(recallSessionStart('other|/elsewhere')).toBeUndefined()
  })

  it('holds the clock steady across repeated restarts', () => {
    // The shape of the real defect: every reconnect re-runs the listener's
    // resolve-then-remember, so the start time has to survive being rewritten
    // by its own recalled value, restart after restart.
    const started = Date.now() - 4 * 3_600_000
    rememberSessionStart('repo|/cwd', started)

    for (let i = 0; i < 3; i++) {
      restart()
      // Verbatim copy of the http-listener reconnect line this module serves.
      const since = recallSessionStart('repo|/cwd') ?? Date.now()
      rememberSessionStart('repo|/cwd', since)
    }

    restart()
    expect(recallSessionStart('repo|/cwd')).toBe(started)
  })

  it('starts a NEW clock when the file has no record, not a zero or a NaN', () => {
    // The miss path is the one that runs on first launch and after the TTL, and
    // it must fall through to "now" -- a 1970 stamp would render as "56y ago".
    const before = Date.now()
    const since = recallSessionStart('repo|/cwd') ?? Date.now()
    rememberSessionStart('repo|/cwd', since)
    restart()

    const recalled = recallSessionStart('repo|/cwd')
    expect(recalled).toBeGreaterThanOrEqual(before)
    expect(recalled).toBeLessThanOrEqual(Date.now())
  })

  it('forgets a session nobody has seen for over a week', () => {
    const ancient = Date.now() - 30 * 24 * 3_600_000
    writeFileSync(FILE, JSON.stringify({ 'repo|/cwd': { since: ancient, seen: ancient } }))
    restart()
    expect(recallSessionStart('repo|/cwd')).toBeUndefined()
  })

  it('degrades to no-record on a corrupt file instead of throwing', () => {
    // A start time is a nicety; refusing to register a session over one would
    // turn a cosmetic cache into an outage.
    writeFileSync(FILE, '{ this is not json')
    restart()
    expect(() => recallSessionStart('repo|/cwd')).not.toThrow()
    expect(recallSessionStart('repo|/cwd')).toBeUndefined()
  })

  it('skips a row whose stamp is not a number, which would render as Invalid Date', () => {
    writeFileSync(FILE, JSON.stringify({ 'repo|/cwd': { since: 'yesterday', seen: Date.now() } }))
    restart()
    expect(recallSessionStart('repo|/cwd')).toBeUndefined()
  })
})

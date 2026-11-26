import { describe, it, expect } from 'vitest'
import { matchStartedSession } from '../relay-sessions'
import type { AgentRelaySessionInfo } from '../types'

const STARTED = 1_786_600_000_000

function session(label: string, extra: Partial<AgentRelaySessionInfo> = {}): AgentRelaySessionInfo {
  return { label, stated: label, sessionId: label, ...extra }
}

const start = { projectId: 'p1', projectName: 'Shop', startedAt: STARTED }

describe('matchStartedSession', () => {
  it('finds nothing before the computer confirms the start', () => {
    const sessions = [session('a', { project: { name: 'Shop' }, since: STARTED })]
    expect(matchStartedSession(null, sessions)).toBeUndefined()
    expect(matchStartedSession({ projectId: 'p1', projectName: 'Shop' }, sessions)).toBeUndefined()
  })

  it('picks the earliest session in the same project that began after the start', () => {
    const sessions = [
      session('later', { project: { name: 'Shop' }, since: STARTED + 9_000 }),
      session('mine', { project: { name: 'Shop' }, since: STARTED + 1_200 })
    ]
    expect(matchStartedSession(start, sessions)?.label).toBe('mine')
  })

  it('allows a session stamped up to 5s before the confirm, not more', () => {
    const justBefore = session('mine', { project: { name: 'Shop' }, since: STARTED - 5_000 })
    const tooOld = session('old', { project: { name: 'Shop' }, since: STARTED - 5_001 })
    expect(matchStartedSession(start, [tooOld, justBefore])?.label).toBe('mine')
    expect(matchStartedSession(start, [tooOld])).toBeUndefined()
  })

  it('skips other projects, ended sessions and sessions with no start time', () => {
    const sessions = [
      session('other', { project: { name: 'Blog' }, since: STARTED + 100 }),
      session('ended', { project: { name: 'Shop' }, since: STARTED + 200, stale: true }),
      session('undated', { project: { name: 'Shop' } }),
      session('loose', { since: STARTED + 300 })
    ]
    expect(matchStartedSession(start, sessions)).toBeUndefined()
  })

  it('matches a session with no project when the start had no project', () => {
    const sessions = [
      session('in-shop', { project: { name: 'Shop' }, since: STARTED + 100 }),
      session('loose', { since: STARTED + 300 })
    ]
    expect(matchStartedSession({ projectId: '', projectName: '', startedAt: STARTED }, sessions)?.label).toBe('loose')
  })
})

import { describe, it, expect } from 'vitest'
import { startedSession } from '../starting-agent'
import type { AgentRelaySessionInfo } from '../../../../shared/types'

const ended: AgentRelaySessionInfo = {
  label: 'ShowAndTell/dev',
  sessionId: 'b84d1cce',
  cwd: '/work/ShowAndTell',
  since: 1_000,
  stale: true,
  origin: { tmuxPane: '%43' }
}
const live: AgentRelaySessionInfo = {
  label: 'robotjobshq/main',
  sessionId: 'new',
  cwd: '/work/robotjobshq',
  since: 9_000,
  origin: { tmuxPane: '%43' }
}
const started = { pane: '%43', cwd: '/work/robotjobshq', since: 9_000 }

describe('startedSession', () => {
  it('waits for the new session when only an ended one holds the same pane id', () => {
    expect(startedSession([ended], started)).toBeUndefined()
  })

  it('picks the live session over an ended one that held the pane id before', () => {
    expect(startedSession([ended, live], started)).toBe(live)
  })
})

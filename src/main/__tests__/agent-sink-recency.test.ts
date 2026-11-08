import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentSession } from '../agent-relay/mcp/http-listener'

// The bug this pins: on a real 37-session relay, 36 sessions had no
// lastActivityAt (Stop clears it), so every between-turns agent ranked on
// `since` — the terminal's open time — and 25 of them tied at the same value.
// Ranking was flat and nothing ever aged out of the voice-routing card.

const liveAgentSessions = vi.fn<[], AgentSession[]>()
vi.mock('../agent-relay/mcp/http-listener', () => ({ liveAgentSessions }))
vi.mock('../ipc/agent-relay', () => ({ rowName: (s: AgentSession) => s.stated }))

const MIN = 60_000
const HOUR = 60 * MIN

function session(over: Partial<AgentSession> & { label: string }): AgentSession {
  return {
    since: Date.now() - 3 * HOUR,
    facts: { pid: process.pid, repo: 'ShowAndTell' },
    ...over
  } as AgentSession
}

describe('agent sink recency', () => {
  beforeEach(() => {
    vi.resetModules()
    liveAgentSessions.mockReset()
  })

  it('ranks a just-ended turn above one that ended hours ago', async () => {
    liveAgentSessions.mockReturnValue([
      session({ label: 'old', lastTurnEndedAt: Date.now() - 90 * MIN }),
      session({ label: 'fresh', lastTurnEndedAt: Date.now() - 1 * MIN })
    ])
    const { collectAgentSinks } = await import('../voice-routing/agent-sinks')
    expect(collectAgentSinks().map((s) => s.label)).toEqual(['fresh', 'old'])
  })

  it('drops an agent idle past the cutoff, and keeps it for new-agent projects', async () => {
    liveAgentSessions.mockReturnValue([
      session({ label: 'stale', lastTurnEndedAt: Date.now() - 5 * HOUR })
    ])
    const { collectAgentSinks } = await import('../voice-routing/agent-sinks')
    expect(collectAgentSinks()).toHaveLength(0)
    expect(collectAgentSinks({ includeStale: true })).toHaveLength(1)
  })

  it('never ages out a session that is mid-turn, however old the turn', async () => {
    liveAgentSessions.mockReturnValue([
      session({ label: 'grinding', busySince: Date.now() - 6 * HOUR })
    ])
    const { collectAgentSinks } = await import('../voice-routing/agent-sinks')
    expect(collectAgentSinks().map((s) => s.label)).toEqual(['grinding'])
  })

  it('never ages out a session that never reported a turn', async () => {
    liveAgentSessions.mockReturnValue([
      session({ label: 'older-shim', since: Date.now() - 20 * HOUR })
    ])
    const { collectAgentSinks } = await import('../voice-routing/agent-sinks')
    expect(collectAgentSinks().map((s) => s.label)).toEqual(['older-shim'])
  })

  it('says how long an idle agent has been idle, so Jev can rank on it', async () => {
    liveAgentSessions.mockReturnValue([
      session({ label: 'a', lastTurnEndedAt: Date.now() - 42 * MIN })
    ])
    const { collectAgentSinks } = await import('../voice-routing/agent-sinks')
    expect(collectAgentSinks()[0].activity).toBe('idle for 42m')
  })
})

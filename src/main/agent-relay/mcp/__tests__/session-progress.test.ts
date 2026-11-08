/**
 * Progress is a SESSION field, not a card field, and that is the whole point of
 * these cases. It used to be derived by scanning a session's cards, so a card the
 * detail sheet failed to match took the number down with it -- which is exactly
 * what shipped: an agent's `from` label carried ` - ` while the session's carried
 * ` . `, the join dropped all 8 cards, and a correctly-sent 43% rendered nothing.
 * Writing by sessionId cannot fail that way, so these lock the write path itself.
 *
 * Real sockets against a real listener, same harness as session-tldr.test.ts.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { connect, type Socket } from 'net'
import { CONFIG } from '../../../../shared/config'
import {
  startAgentRelayMcp,
  stopAgentRelayMcp,
  liveAgentSessions,
  setAgentSessionProgress,
  setAgentSessionsListener
} from '../http-listener'

const open: Socket[] = []

function openSession(port: number, sessionId?: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port }, () => {
      const lines = [
        `GET ${CONFIG.AGENT_RELAY.PRESENCE_ROUTE} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Connection: keep-alive',
        `${CONFIG.AGENT_RELAY.IDENTITY_HEADER}: ShowAndTell/dev`
      ]
      if (sessionId) lines.push(`${CONFIG.AGENT_RELAY.SESSION_HEADER}: ${sessionId}`)
      socket.write(lines.join('\r\n') + '\r\n\r\n')
    })
    open.push(socket)
    socket.once('data', () => resolve(socket))
    socket.once('error', reject)
  })
}

afterEach(() => {
  for (const socket of open.splice(0)) socket.destroy()
  setAgentSessionsListener(null)
  stopAgentRelayMcp()
})

async function listening(): Promise<number> {
  const started = await startAgentRelayMcp(0)
  return (started as { port: number }).port
}

function progressOf(sessionId: string): number | undefined {
  return liveAgentSessions().find((s) => s.sessionId === sessionId)?.progress
}

describe('session progress', () => {
  it('lands on the session with no card in play at all', async () => {
    const port = await listening()
    await openSession(port, 'sess-a')

    expect(setAgentSessionProgress('sess-a', 0.43)).toBe(true)
    expect(progressOf('sess-a')).toBe(0.43)
  })

  it('overwrites, because a stale number is worse than none', async () => {
    const port = await listening()
    await openSession(port, 'sess-a')

    setAgentSessionProgress('sess-a', 0.2)
    setAgentSessionProgress('sess-a', 0.9)
    expect(progressOf('sess-a')).toBe(0.9)
  })

  // undefined is the clear, not 0: a ring at 0% claims the agent has done
  // nothing, which is a different statement from "it stopped saying".
  it('clears with undefined rather than falling back to zero', async () => {
    const port = await listening()
    await openSession(port, 'sess-a')

    setAgentSessionProgress('sess-a', 0.5)
    expect(setAgentSessionProgress('sess-a', undefined)).toBe(true)
    expect(progressOf('sess-a')).toBeUndefined()
  })

  it('writes only the session it was addressed to', async () => {
    const port = await listening()
    await openSession(port, 'sess-a')
    await openSession(port, 'sess-b')

    setAgentSessionProgress('sess-a', 0.7)
    expect(progressOf('sess-a')).toBe(0.7)
    expect(progressOf('sess-b')).toBeUndefined()
  })

  it('reports false for an unknown or empty session id', async () => {
    const port = await listening()
    await openSession(port, 'sess-a')

    expect(setAgentSessionProgress('nobody', 0.5)).toBe(false)
    expect(setAgentSessionProgress(undefined, 0.5)).toBe(false)
    expect(setAgentSessionProgress('', 0.5)).toBe(false)
  })

  it('notifies the sessions listener so a live ring repaints', async () => {
    const port = await listening()
    await openSession(port, 'sess-a')

    let fired = 0
    setAgentSessionsListener(() => {
      fired++
    })
    setAgentSessionProgress('sess-a', 0.6)
    expect(fired).toBeGreaterThan(0)

    // Same value twice is not a change -- re-rendering every surface for a
    // number that did not move is how a heartbeat turns into a repaint storm.
    const settled = fired
    setAgentSessionProgress('sess-a', 0.6)
    expect(fired).toBe(settled)
  })
})

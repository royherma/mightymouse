/**
 * The TLDR is the one session field that is EXPECTED to be overwritten -- a name
 * is claimed once and defended, a subject changes every time the work does. That
 * is the opposite of nameAgentSession's rule, so it gets its own test: the bug
 * this guards against is a future refactor "fixing" the overwrite by making it
 * behave like naming, which would silently freeze every row on its first topic.
 *
 * Real sockets against a real listener, same harness as presence.test.ts: the
 * field is only true if it survives the actual header parse and the reclaim.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { connect, type Socket } from 'net'
import { CONFIG } from '../../../../shared/config'
import {
  startAgentRelayMcp,
  stopAgentRelayMcp,
  liveAgentSessions,
  setAgentSessionTldr,
  setAgentSessionsListener,
  TLDR_MAX
} from '../http-listener'

const open: Socket[] = []

function openSession(port: number, sessionId?: string, facts?: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port }, () => {
      const lines = [
        `GET ${CONFIG.AGENT_RELAY.PRESENCE_ROUTE} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Connection: keep-alive',
        `${CONFIG.AGENT_RELAY.IDENTITY_HEADER}: ShowAndTell/dev`
      ]
      if (sessionId) lines.push(`${CONFIG.AGENT_RELAY.SESSION_HEADER}: ${sessionId}`)
      if (facts) lines.push(`${CONFIG.AGENT_RELAY.FACTS_HEADER}: ${facts}`)
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

describe('session tldr', () => {
  it('overwrites on every declaration, unlike a name', async () => {
    const port = await listening()
    await openSession(port, 'sess-a')

    setAgentSessionTldr('sess-a', 'auditing the relay session model')
    expect(liveAgentSessions()[0].tldr).toBe('auditing the relay session model')

    // The whole point of the verb: the second call wins.
    setAgentSessionTldr('sess-a', 'adding a TLDR field to session rows')
    expect(liveAgentSessions()[0].tldr).toBe('adding a TLDR field to session rows')
  })

  it('clears on an empty string rather than storing a blank line', async () => {
    const port = await listening()
    await openSession(port, 'sess-a')

    setAgentSessionTldr('sess-a', 'something in particular')
    setAgentSessionTldr('sess-a', '   ')
    expect(liveAgentSessions()[0].tldr).toBeUndefined()
  })

  it('addresses ONE session, never its neighbours in the same checkout', async () => {
    const port = await listening()
    // Same derived identity, which is exactly the case `from` cannot tell apart.
    await openSession(port, 'sess-a')
    await openSession(port, 'sess-b')

    setAgentSessionTldr('sess-a', 'only mine')

    const byId = (id: string): string | undefined =>
      liveAgentSessions().find((s) => s.sessionId === id)?.tldr
    expect(byId('sess-a')).toBe('only mine')
    expect(byId('sess-b')).toBeUndefined()
  })

  it('ignores a call with no session id, since no row can be meant', async () => {
    const port = await listening()
    await openSession(port)

    setAgentSessionTldr(undefined, 'nowhere to put this')
    setAgentSessionTldr('', 'nor this')
    expect(liveAgentSessions()[0].tldr).toBeUndefined()
  })

  // Found live: `--session eb840ec2` (the short id a list prints) matched no row,
  // yet the verb answered "Noted" and wrote the file under the truncated id. A
  // silent no-op is worse than an error here -- the caller believes a row changed.
  it('reports whether a row was actually addressed', async () => {
    const port = await listening()
    await openSession(port, 'sess-a')

    expect(setAgentSessionTldr('sess-a', 'mine')).toBe(true)
    expect(setAgentSessionTldr('nobody', 'no such session')).toBe(false)
    // Already saying exactly this is still a hit: nothing changed, but the
    // caller did address a real row, which is the question being asked.
    expect(setAgentSessionTldr('sess-a', 'mine')).toBe(true)
  })

  // `mm-relay sessions` prints only the 8-char head, so the copyable string IS
  // a prefix. Ambiguity is the case that matters: resolving to the first hit
  // would retitle a bystander's row.
  it('accepts an unambiguous prefix and refuses an ambiguous one', async () => {
    const port = await listening()
    // Real UUID shape: the floor is expressed in the units a real id has.
    await openSession(port, 'aabbccdd-1111-4000-8000-000000000001')
    await openSession(port, 'aabbccdd-2222-4000-8000-000000000002')
    await openSession(port, 'ffeeddcc-3333-4000-8000-000000000003')

    const byId = (id: string): string | undefined =>
      liveAgentSessions().find((s) => s.sessionId === id)?.tldr

    // Fits two ids: nothing is touched, on either of them.
    expect(setAgentSessionTldr('aabbccdd', 'ambiguous')).toBe(false)
    expect(byId('aabbccdd-1111-4000-8000-000000000001')).toBeUndefined()
    expect(byId('aabbccdd-2222-4000-8000-000000000002')).toBeUndefined()

    // Exactly the 8 chars `mm-relay sessions` prints -- the copyable string.
    expect(setAgentSessionTldr('ffeeddcc', 'unambiguous prefix')).toBe(true)
    expect(byId('ffeeddcc-3333-4000-8000-000000000003')).toBe('unambiguous prefix')

    // Seen live: `--session 5` matched exactly one row and retitled a
    // bystander. Being unique is what made it land, so only a length floor
    // stops it -- a prefix shorter than the list prints was typed, not copied.
    expect(setAgentSessionTldr('f', 'one char, one hit')).toBe(false)
    expect(byId('ffeeddcc-3333-4000-8000-000000000003')).toBe('unambiguous prefix')

    // A full id still wins where a prefix of it would have been ambiguous.
    expect(setAgentSessionTldr('aabbccdd-1111-4000-8000-000000000001', 'exact')).toBe(true)
    expect(byId('aabbccdd-1111-4000-8000-000000000001')).toBe('exact')
    expect(byId('aabbccdd-2222-4000-8000-000000000002')).toBeUndefined()
  })

  it('caps a long line instead of letting it break the row', async () => {
    const port = await listening()
    await openSession(port, 'sess-a')

    setAgentSessionTldr('sess-a', 'x'.repeat(TLDR_MAX + 50))
    expect(liveAgentSessions()[0].tldr).toHaveLength(TLDR_MAX)
  })

  it('arrives on the facts header, so a reconnect restores it', async () => {
    const port = await listening()
    await openSession(port, 'sess-a', JSON.stringify({ tldr: 'restored after a restart' }))

    expect(liveAgentSessions()[0].tldr).toBe('restored after a restart')
  })
})

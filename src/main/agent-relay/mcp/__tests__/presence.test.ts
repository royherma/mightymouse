/**
 * Real sockets against a real listener: the count is only true if a dropped
 * socket really removes its entry. Port 0 because the relay's fixed port is
 * probably occupied by the app running on this Mac.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { connect, type Socket } from 'net'
import { CONFIG } from '../../../../shared/config'
import {
  startAgentRelayMcp,
  stopAgentRelayMcp,
  liveAgentSessions,
  listedAgentSessions,
  nameAgentSession,
  setAgentSessionsListener
} from '../http-listener'

const open: Socket[] = []

/** Resolves on the server's ack, so no sleeps are needed anywhere here. */
function openSession(
  port: number,
  identity?: string,
  cwd?: string,
  sessionId?: string,
  facts?: string,
  attempts?: string
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port }, () => {
      const lines = [
        `GET ${CONFIG.AGENT_RELAY.PRESENCE_ROUTE} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Connection: keep-alive'
      ]
      if (identity) lines.push(`${CONFIG.AGENT_RELAY.IDENTITY_HEADER}: ${identity}`)
      if (cwd) lines.push(`${CONFIG.AGENT_RELAY.CWD_HEADER}: ${cwd}`)
      if (sessionId) lines.push(`${CONFIG.AGENT_RELAY.SESSION_HEADER}: ${sessionId}`)
      if (facts) lines.push(`${CONFIG.AGENT_RELAY.FACTS_HEADER}: ${facts}`)
      if (attempts) lines.push(`${CONFIG.AGENT_RELAY.ATTEMPTS_HEADER}: ${attempts}`)
      socket.write(lines.join('\r\n') + '\r\n\r\n')
    })
    open.push(socket)
    socket.once('data', () => resolve(socket))
    socket.once('error', reject)
  })
}

/** The close event lands a tick after destroy(), so the listener is the signal. */
function nextSessionChange(): Promise<void> {
  return new Promise((resolve) => {
    setAgentSessionsListener(() => {
      setAgentSessionsListener(null)
      resolve()
    })
  })
}

afterEach(() => {
  for (const socket of open.splice(0)) socket.destroy()
  setAgentSessionsListener(null)
  stopAgentRelayMcp()
})

describe('agent session presence', () => {
  it('counts one session per held-open connection and names it', async () => {
    const started = await startAgentRelayMcp(0)
    expect(started.ok).toBe(true)
    const port = (started as { port: number }).port

    expect(liveAgentSessions()).toHaveLength(0)

    await openSession(port, 'mighty-mouse/dev')
    expect(liveAgentSessions()).toHaveLength(1)
    expect(liveAgentSessions()[0].label).toBe('mighty-mouse/dev')

    await openSession(port, 'other-repo/main')
    expect(liveAgentSessions()).toHaveLength(2)
    expect(liveAgentSessions().map((s) => s.label)).toEqual([
      'mighty-mouse/dev',
      'other-repo/main'
    ])
  })

  it('drops the session when the agent process goes away', async () => {
    const started = await startAgentRelayMcp(0)
    const port = (started as { port: number }).port

    const first = await openSession(port, 'closing-soon/dev')
    await openSession(port, 'stays-open/dev')
    expect(liveAgentSessions()).toHaveLength(2)

    const dropped = nextSessionChange()
    first.destroy()
    await dropped

    const left = liveAgentSessions()
    expect(left).toHaveLength(1)
    expect(left[0].label).toBe('stays-open/dev')
  })

  it('labels an agent that sent no identity without inventing a name', async () => {
    const started = await startAgentRelayMcp(0)
    await openSession((started as { port: number }).port)
    expect(liveAgentSessions()[0].label).toBe(CONFIG.UI_LABELS.CODE_SESSION_UNNAMED)
  })

  it('keeps two same-named sessions apart by the directory each runs in', async () => {
    const started = await startAgentRelayMcp(0)
    const port = (started as { port: number }).port

    await openSession(port, 'mm/dev', '/Users/roy/code/mm')
    await openSession(port, 'mm/dev', '/Users/roy/code/mm-hotfix')

    expect(liveAgentSessions().map((s) => s.cwd)).toEqual([
      '/Users/roy/code/mm',
      '/Users/roy/code/mm-hotfix'
    ])
  })

  it('reads a non-ASCII label as UTF-8 rather than showing mojibake', async () => {
    const started = await startAgentRelayMcp(0)
    // What Node hands us for a UTF-8 "·" on the wire, unless we re-decode it.
    await openSession((started as { port: number }).port, 'café/dev', '/Users/roy/café')

    expect(liveAgentSessions()[0].label).toBe('café/dev')
    expect(liveAgentSessions()[0].cwd).toBe('/Users/roy/café')
  })

  /**
   * A naming hook publishes a session's real name seconds AFTER the shim booted
   * and sent its identity, so the shim reconnects to report the new one. That
   * reconnect has to land on the EXISTING row: a second row, or a row that
   * blinks to unnamed on the way, is what the raw-hex session list looked like.
   */
  describe('a session renamed mid-flight', () => {
    it('relabels its own row instead of appearing twice', async () => {
      const started = await startAgentRelayMcp(0)
      const port = (started as { port: number }).port

      const first = await openSession(port, 'mm/dev - 8bf9ff45', '/Users/roy/mm', 'sess-a')
      nameAgentSession('mm/dev - 8bf9ff45', 'stated-by-a-verb')

      const dropped = nextSessionChange()
      first.destroy()
      await dropped

      // Same session id, new identity: exactly what the shim's watcher sends.
      await openSession(port, 'mm/dev - fix-the-list', '/Users/roy/mm', 'sess-a')

      const live = liveAgentSessions()
      expect(live).toHaveLength(1)
      expect(live[0].label).toBe('mm/dev - fix-the-list')
      // The verb-stated name is the thing reclaim exists to carry across the gap.
      expect(live[0].stated).toBe('stated-by-a-verb')
      // The superseded row is gone, not fading alongside the new one.
      expect(listedAgentSessions()).toHaveLength(1)
    })

    /** The row's age says how long the TERMINAL has been open, and the same
     *  stamp is the sort key for an agent that has sent no card. Re-stamping it
     *  on reconnect printed "2m" on a session open for hours. */
    it('keeps its original open time across a reconnect', async () => {
      const started = await startAgentRelayMcp(0)
      const port = (started as { port: number }).port

      const first = await openSession(port, 'mm/dev - 8bf9ff45', '/Users/roy/mm', 'sess-a')
      const since = listedAgentSessions()[0].since

      const dropped = nextSessionChange()
      first.destroy()
      await dropped

      await openSession(port, 'mm/dev - 8bf9ff45', '/Users/roy/mm', 'sess-a')
      expect(liveAgentSessions()[0].since).toBe(since)
    })

    /** An unnamed pane used to be skipped by the reclaim write entirely, since
     *  a name was the only thing it carried. Its uptime is worth the same. */
    it('keeps the open time of a session that never named itself', async () => {
      const started = await startAgentRelayMcp(0)
      const port = (started as { port: number }).port

      const first = await openSession(port, undefined, '/Users/roy/mm', 'sess-unnamed')
      const since = listedAgentSessions()[0].since

      const dropped = nextSessionChange()
      first.destroy()
      await dropped

      await openSession(port, undefined, '/Users/roy/mm', 'sess-unnamed')
      expect(liveAgentSessions()[0].since).toBe(since)
    })

    it('never leaves the list empty while the socket is being swapped', async () => {
      const started = await startAgentRelayMcp(0)
      const port = (started as { port: number }).port

      const first = await openSession(port, 'mm/dev - 8bf9ff45', '/Users/roy/mm', 'sess-a')
      const dropped = nextSessionChange()
      first.destroy()
      await dropped

      // Between the drop and the reopen the row is stale, not deleted -- which
      // is what keeps the Code tab from flickering to "no agents connected".
      expect(listedAgentSessions()).toHaveLength(1)
      expect(listedAgentSessions()[0].staleSince).toBeDefined()
    })

    it('stays live, not ended, when the reconnect lands inside the rename gap', async () => {
      const started = await startAgentRelayMcp(0)
      const port = (started as { port: number }).port

      const first = await openSession(port, 'mm/dev - dev-1034', '/Users/roy/mm', 'sess-a')
      const seenEnded: boolean[] = []
      setAgentSessionsListener(() =>
        seenEnded.push(listedAgentSessions().some((s) => s.staleSince !== undefined))
      )
      first.destroy()
      await new Promise((r) => setTimeout(r, 20))
      expect(liveAgentSessions()).toHaveLength(1)

      await openSession(port, 'mm/dev - content-creation-flow', '/Users/roy/mm', 'sess-a')
      await new Promise((r) => setTimeout(r, CONFIG.AGENT_RELAY.RENAME_GAP_MS + 100))

      expect(seenEnded).not.toContain(true)
      expect(listedAgentSessions().map((s) => s.label)).toEqual(['mm/dev - content-creation-flow'])
    })

    it('does not hand one pane the name of another in the same checkout', async () => {
      const started = await startAgentRelayMcp(0)
      const port = (started as { port: number }).port

      // Identical repo, branch AND directory: only the session id tells them
      // apart, which is why the reclaim key cannot be built from cwd alone.
      const paneA = await openSession(port, 'mm/dev - aaaaaaaa', '/Users/roy/mm', 'sess-a')
      await openSession(port, 'mm/dev - bbbbbbbb', '/Users/roy/mm', 'sess-b')
      nameAgentSession('mm/dev - aaaaaaaa', 'named-a')

      const dropped = nextSessionChange()
      paneA.destroy()
      await dropped

      await openSession(port, 'mm/dev - renamed-a', '/Users/roy/mm', 'sess-a')

      const live = liveAgentSessions()
      expect(live).toHaveLength(2)
      const renamed = live.find((s) => s.sessionId === 'sess-a')
      const untouched = live.find((s) => s.sessionId === 'sess-b')
      expect(renamed?.label).toBe('mm/dev - renamed-a')
      expect(renamed?.stated).toBe('named-a')
      // B never dropped, so nothing of A's may have leaked onto it.
      expect(untouched?.label).toBe('mm/dev - bbbbbbbb')
      expect(untouched?.stated).toBeUndefined()
    })
  })

  /** The list is only as good as what the shim can see about its own session:
   *  this process gets a stateless loopback connection and knows none of it. */
  describe('the facts a session reports about itself', () => {
    it('keeps the fields it was sent', async () => {
      const started = await startAgentRelayMcp(0)
      await openSession(
        (started as { port: number }).port,
        'mm/dev - a-name',
        '/Users/roy/mm',
        'sess-a',
        JSON.stringify({
          repo: 'ShowAndTell',
          branch: 'dev',
          pid: 21338,
          agent: 'claude-code_2-1-231_agent',
          effort: 'high',
          entrypoint: 'cli'
        })
      )

      expect(liveAgentSessions()[0].facts).toEqual({
        repo: 'ShowAndTell',
        branch: 'dev',
        pid: 21338,
        agent: 'claude-code_2-1-231_agent',
        effort: 'high',
        entrypoint: 'cli'
      })
    })

    it('renders a row plainly rather than breaking on a bad payload', async () => {
      const started = await startAgentRelayMcp(0)
      const port = (started as { port: number }).port

      // An older shim sends nothing; a broken one sends junk. Neither may cost
      // the session its row -- the list is how you find a running agent.
      await openSession(port, 'mm/dev - old-shim', '/Users/roy/a', 'sess-old')
      await openSession(port, 'mm/dev - bad-json', '/Users/roy/b', 'sess-bad', 'not json at all')
      await openSession(port, 'mm/dev - wrong-shape', '/Users/roy/c', 'sess-arr', '["nope"]')

      const live = liveAgentSessions()
      expect(live).toHaveLength(3)
      expect(live.every((s) => s.facts === undefined)).toBe(true)
      expect(live.map((s) => s.label)).toEqual([
        'mm/dev - old-shim',
        'mm/dev - bad-json',
        'mm/dev - wrong-shape'
      ])
    })

    it('ignores a pid that is not a real number', async () => {
      const started = await startAgentRelayMcp(0)
      await openSession(
        (started as { port: number }).port,
        'mm/dev - x',
        '/Users/roy/mm',
        'sess-x',
        JSON.stringify({ repo: 'mm', pid: 'twenty-one-thousand' })
      )

      const facts = liveAgentSessions()[0].facts
      expect(facts?.repo).toBe('mm')
      expect(facts?.pid).toBeUndefined()
    })
  })

  /** A shim that took 40 tries to arrive is indistinguishable from one that
   *  arrived instantly, unless it says so -- and "it took a while to show up"
   *  is otherwise unprovable from this side. */
  describe('how hard the shim had to try', () => {
    it('records the retry count a struggling session reports', async () => {
      const started = await startAgentRelayMcp(0)
      await openSession(
        (started as { port: number }).port,
        'mm/dev - slow-to-arrive',
        '/Users/roy/mm',
        'sess-slow',
        undefined,
        '40'
      )

      expect(liveAgentSessions()[0].attempts).toBe(40)
    })

    it('leaves the field empty for the ordinary first-try connection', async () => {
      const started = await startAgentRelayMcp(0)
      const port = (started as { port: number }).port

      // No header at all (every shim before this change), and the three values
      // that mean the same thing as absent: zero, junk, negative.
      await openSession(port, 'mm/dev - a', '/Users/roy/a', 'sess-a')
      await openSession(port, 'mm/dev - b', '/Users/roy/b', 'sess-b', undefined, '0')
      await openSession(port, 'mm/dev - c', '/Users/roy/c', 'sess-c', undefined, 'lots')
      await openSession(port, 'mm/dev - d', '/Users/roy/d', 'sess-d', undefined, '-3')

      expect(liveAgentSessions().every((s) => s.attempts === undefined)).toBe(true)
    })
  })

  it('reports nothing open once the relay is switched off', async () => {
    const started = await startAgentRelayMcp(0)
    await openSession((started as { port: number }).port, 'mighty-mouse/dev')
    expect(liveAgentSessions()).toHaveLength(1)

    stopAgentRelayMcp()
    expect(liveAgentSessions()).toHaveLength(0)
  })
})

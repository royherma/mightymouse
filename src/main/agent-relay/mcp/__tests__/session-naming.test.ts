import { describe, it, expect, afterEach } from 'vitest'
import {
  startAgentRelayMcp,
  stopAgentRelayMcp,
  liveAgentSessions,
  listedAgentSessions,
  nameAgentSession
} from '../http-listener'
import { CONFIG } from '../../../../shared/config'
import { connect } from 'node:net'

/** Opens a presence socket the way the shim does, and resolves once registered. */
function holdPresence(port: number, identity: string, origin?: object): Promise<() => void> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port }, () => {
      socket.write(
        `GET ${CONFIG.AGENT_RELAY.PRESENCE_ROUTE} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          `${CONFIG.AGENT_RELAY.IDENTITY_HEADER}: ${identity}\r\n` +
          (origin ? `${CONFIG.AGENT_RELAY.ORIGIN_HEADER}: ${JSON.stringify(origin)}\r\n` : '') +
          '\r\n'
      )
    })
    socket.on('error', () => {})
    socket.once('data', () => resolve(() => socket.destroy()))
  })
}

afterEach(async () => {
  await stopAgentRelayMcp()
})

describe('nameAgentSession', () => {
  it('records one stated name per session without touching the label', async () => {
    const started = await startAgentRelayMcp(0)
    expect(started.ok).toBe(true)
    const port = started.ok ? started.port : 0

    await holdPresence(port, 'ShowAndTell/dev')
    await holdPresence(port, 'ShowAndTell/dev')
    expect(liveAgentSessions().map((s) => s.label)).toEqual([
      'ShowAndTell/dev',
      'ShowAndTell/dev'
    ])

    nameAgentSession('ShowAndTell/dev', 'mm-dev-399 - ShowAndTell/dev')
    expect(liveAgentSessions().map((s) => s.stated).sort()).toEqual([
      'mm-dev-399 - ShowAndTell/dev',
      undefined
    ])

    // The second agent names itself: the still-unnamed session takes it.
    nameAgentSession('ShowAndTell/dev', 'mm-dev-400 - ShowAndTell/dev')
    expect(liveAgentSessions().map((s) => s.stated).sort()).toEqual([
      'mm-dev-399 - ShowAndTell/dev',
      'mm-dev-400 - ShowAndTell/dev'
    ])

    // A repeat call from an already-named agent must not rename a sibling.
    nameAgentSession('ShowAndTell/dev', 'mm-dev-399 - ShowAndTell/dev')
    expect(liveAgentSessions().map((s) => s.stated).sort()).toEqual([
      'mm-dev-399 - ShowAndTell/dev',
      'mm-dev-400 - ShowAndTell/dev'
    ])

    // The repo/branch stays the label throughout: a garbled dictated name can
    // never become the string the human navigates by.
    expect(liveAgentSessions().map((s) => s.label)).toEqual([
      'ShowAndTell/dev',
      'ShowAndTell/dev'
    ])
  })

  it('keeps a dropped session listed, and gives it its name back on reconnect', async () => {
    const started = await startAgentRelayMcp(0)
    const port = started.ok ? started.port : 0

    const close = await holdPresence(port, 'ShowAndTell/dev')
    nameAgentSession('ShowAndTell/dev', 'mm-dev-509 - ShowAndTell/dev')

    close()
    await new Promise((r) => setTimeout(r, CONFIG.AGENT_RELAY.RENAME_GAP_MS + 50))
    // Held for the grace window, not deleted: still listed (faded), but no
    // longer counted as live.
    expect(listedAgentSessions()).toHaveLength(1)
    expect(listedAgentSessions()[0].staleSince).toBeTypeOf('number')
    expect(liveAgentSessions()).toHaveLength(0)

    await holdPresence(port, 'ShowAndTell/dev')
    const live = liveAgentSessions()
    expect(live).toHaveLength(1)
    expect(live[0].stated).toBe('mm-dev-509 - ShowAndTell/dev')
  })

  it('ignores a name from a checkout with no live session', async () => {
    const started = await startAgentRelayMcp(0)
    const port = started.ok ? started.port : 0
    await holdPresence(port, 'ShowAndTell/dev')

    nameAgentSession('other-repo/main', 'mm-other-1 - other-repo/main')
    expect(liveAgentSessions().map((s) => s.label)).toEqual(['ShowAndTell/dev'])
  })

  it('names the row in the calling pane, not the first unnamed sibling', async () => {
    const started = await startAgentRelayMcp(0)
    const port = started.ok ? started.port : 0
    const pane = { tmuxPane: '%123', tmuxSocket: '/tmp/tmux-502/default' }
    await holdPresence(port, 'side-projects')
    await holdPresence(port, 'side-projects', pane)

    nameAgentSession('side-projects', 'x-reply-harness', { origin: pane })
    const named = liveAgentSessions().filter((s) => s.stated === 'x-reply-harness')
    expect(named).toHaveLength(1)
    expect(named[0].origin?.tmuxPane).toBe('%123')
  })
})

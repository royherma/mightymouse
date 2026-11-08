/**
 * The gap these exist for: `progress` reached the SESSION from `notify` only.
 * `ask` and `approve` declared the same field, put it on their card, and never
 * wrote it -- so an agent that asked a question mid-job showed a percentage on
 * the card and a dark ring in the list. It typechecked green three times.
 *
 * session-progress.test.ts calls setAgentSessionProgress directly, which is why
 * it never caught that: these drive the real MCP verbs instead, so a verb that
 * forgets the write fails here.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildAgentRelayMcpServer } from '../build-server'
import { relayRequestStore } from '../../store'

const { TEST_ROOT } = vi.hoisted(() => {
  const { join } = require('path')
  const { tmpdir } = require('os')
  return { TEST_ROOT: join(tmpdir(), 'mm-agent-relay-verb-progress-test') }
})

vi.mock('../../../store/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../store/paths')>()
  return {
    ...actual,
    PATHS: { ...actual.PATHS, ROOT: TEST_ROOT, AGENT_RELAY_LOG: join(TEST_ROOT, 'agent-relay-log.jsonl') }
  }
})

vi.mock('../../relay-send', () => ({
  agentRelayOffReason: () => null,
  sendRelayPush: async () => ({ ok: true, deviceLabel: 'test phone' })
}))

// The one seam under test: what the verb wrapper wrote, and for which session.
const writes: Array<{ sessionId: string | undefined; progress: number | undefined }> = []
vi.mock('../http-listener', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../http-listener')>()
  return {
    ...actual,
    setAgentSessionProgress: (sessionId: string | undefined, progress: number | undefined) => {
      writes.push({ sessionId, progress })
      return true
    }
  }
})

const SESSION = 'sess-verb-progress'

async function connectedClient(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = buildAgentRelayMcpServer(undefined, undefined, undefined, undefined, SESSION)
  await server.connect(serverTransport)
  const client = new Client({ name: 'mm-verb-progress-test', version: '0' })
  await client.connect(clientTransport)
  return client
}

describe('progress reaches the session from every verb that declares it', () => {
  beforeEach(() => {
    rmSync(TEST_ROOT, { recursive: true, force: true })
    mkdirSync(TEST_ROOT, { recursive: true })
    relayRequestStore.resetForTests()
    writes.length = 0
  })

  it('notify writes the session', async () => {
    const client = await connectedClient()
    await client.callTool({ name: 'notify', arguments: { body: 'half way', progress: 0.5 } })
    expect(writes).toEqual([{ sessionId: SESSION, progress: 0.5 }])
  })

  // ask and approve BLOCK on an answer, so the call is never awaited here --
  // the write has to happen on the way in, before anyone taps anything, or a
  // ring would only appear once the question was already resolved.
  it('ask writes the session before it blocks on an answer', async () => {
    const client = await connectedClient()
    void client.callTool({ name: 'ask', arguments: { question: 'which one?', progress: 0.25 } })
    await vi.waitFor(() => expect(writes).toEqual([{ sessionId: SESSION, progress: 0.25 }]))
  })

  it('approve writes the session before it blocks on an answer', async () => {
    const client = await connectedClient()
    void client.callTool({ name: 'approve', arguments: { action: 'deploy', progress: 0.9 } })
    await vi.waitFor(() => expect(writes).toEqual([{ sessionId: SESSION, progress: 0.9 }]))
  })

  it('a verb call with no progress writes nothing, rather than clearing the ring', async () => {
    const client = await connectedClient()
    await client.callTool({ name: 'notify', arguments: { body: 'no number here' } })
    expect(writes).toEqual([])
  })
})

/**
 * The local-tooling MCP tools (the relay CLI's whole surface), driven against a
 * REAL McpServer over an in-memory transport rather than mocks -- the tool
 * NAMES are the contract the CLI hardcodes, so a rename has to fail here.
 *
 * Also locks the seam that matters: relay_resolve goes through the store's own
 * first-answer-wins path, so a terminal answer and a phone answer cannot
 * diverge, and a second answer to the same request is refused, not overwritten.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildAgentRelayMcpServer } from '../build-server'
import { relayRequestStore } from '../../store'

// build-server is a real (unmocked) static import that reaches store.ts -> paths.ts
// during module hoisting, before a plain top-level const would run -- vi.hoisted
// lifts TEST_ROOT's initialization above vi.mock's own hoist point so it's ready.
const { TEST_ROOT } = vi.hoisted(() => {
  const { join } = require('path')
  const { tmpdir } = require('os')
  return { TEST_ROOT: join(tmpdir(), 'mm-agent-relay-tooling-tools-test') }
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

async function connectedClient(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = buildAgentRelayMcpServer()
  await server.connect(serverTransport)
  const client = new Client({ name: 'mm-relay-test', version: '0' })
  await client.connect(clientTransport)
  return client
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> }).content ?? []
  return content.map((c) => c.text ?? '').join('')
}

describe('agent-relay local tooling tools', () => {
  beforeEach(() => {
    rmSync(TEST_ROOT, { recursive: true, force: true })
    mkdirSync(TEST_ROOT, { recursive: true })
    relayRequestStore.resetForTests()
  })

  it('registers the four verbs, the session verbs, and the three tooling tools the relay CLI calls', async () => {
    const client = await connectedClient()
    const names = (await client.listTools()).tools.map((t) => t.name).sort()
    expect(names).toEqual([
      'approve',
      'ask',
      'browser_attach',
      'browser_fill',
      'browser_open',
      'browser_press',
      'browser_read',
      'browser_type',
      // Hook-driven, not agent-driven: the mid-turn flag behind "Responding…".
      'busy',
      'notify',
      'publish_site',
      // Neither a request nor local tooling: it writes one line onto the
      // session's own row and mints nothing. Its own map, SESSION_HANDLERS.
      'recap',
      'relay_deck',
      'relay_dismiss',
      'relay_pending',
      'relay_resolve',
      'show',
      // Addresses the session, like recap and busy -- the only one that ENDS it.
      'wrap_up'
    ])
  })

  it('relay_pending returns a minted request with the id the CLI answers by', async () => {
    const client = await connectedClient()
    const minted = relayRequestStore.mint('ask', { question: 'Which db?' })

    const rows = JSON.parse(textOf(await client.callTool({ name: 'relay_pending', arguments: {} })))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: minted.id, verb: 'ask', params: { question: 'Which db?' } })
  })

  it('relay_pending omits a request once it has been answered', async () => {
    const client = await connectedClient()
    const minted = relayRequestStore.mint('ask', { question: 'Which db?' })
    relayRequestStore.resolve(minted.id, { answer: 'postgres' }, null, 'typed')

    expect(JSON.parse(textOf(await client.callTool({ name: 'relay_pending', arguments: {} })))).toEqual([])
  })

  it('relay_resolve answers a pending ask through the store', async () => {
    const client = await connectedClient()
    const minted = relayRequestStore.mint('ask', { question: 'Which db?' })

    const result = await client.callTool({
      name: 'relay_resolve',
      arguments: { requestId: minted.id, answer: 'postgres' }
    })

    expect(result.isError).toBeFalsy()
    const stored = relayRequestStore.get(minted.id)
    expect(stored?.status).toBe('resolved')
    expect(stored?.response?.answer).toBe('postgres')
  })

  it('refuses a second answer instead of overwriting the first', async () => {
    const client = await connectedClient()
    const minted = relayRequestStore.mint('approve', { action: 'drop table' })
    relayRequestStore.resolve(minted.id, { approved: true }, 'phone-device', 'chip')

    const result = await client.callTool({
      name: 'relay_resolve',
      arguments: { requestId: minted.id, approved: false }
    })

    expect(result.isError).toBe(true)
    expect(relayRequestStore.get(minted.id)?.response?.approved).toBe(true)
  })

  it('reports an unknown id rather than silently succeeding', async () => {
    const client = await connectedClient()
    const result = await client.callTool({
      name: 'relay_resolve',
      arguments: { requestId: 'no-such-id', answer: 'x' }
    })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('no-such-id')
  })
})

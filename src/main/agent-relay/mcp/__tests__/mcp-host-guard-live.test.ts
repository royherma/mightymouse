import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { request } from 'http'
import { CONFIG } from '../../../../shared/config'

vi.mock('../../../analytics', () => ({ track: () => undefined }))
vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => '/tmp', getAppPath: () => process.cwd() }
}))

let port = 0
let listener: typeof import('../http-listener')

function call(
  method: string,
  path: string,
  host: string,
  body?: string
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          Host: host,
          ...(body ? { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' } : {})
        }
      },
      (res) => {
        let text = ''
        res.on('data', (c) => (text += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
      }
    )
    req.on('error', reject)
    req.end(body)
  })
}

const listTools = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })

describe('agent relay MCP listener Host guard', () => {
  beforeAll(async () => {
    vi.resetModules()
    listener = await import('../http-listener')
    const started = await listener.startAgentRelayMcp(0)
    expect(started.ok).toBe(true)
    if (started.ok) port = started.port
    expect(port).not.toBe(CONFIG.AGENT_RELAY.MCP_PORT)
    expect(port).toBeGreaterThan(0)
  }, 30_000)

  afterAll(() => listener.stopAgentRelayMcp())

  it('answers a tool list for a loopback Host', async () => {
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
      const res = await call('POST', CONFIG.AGENT_RELAY.MCP_ROUTE, host, listTools)
      expect(res.status).toBe(200)
      expect(res.text).toContain('relay_resolve')
    }
  })

  it('refuses a DNS-rebound page whose Host is its own domain', async () => {
    const res = await call('POST', CONFIG.AGENT_RELAY.MCP_ROUTE, `evil.example:${port}`, listTools)
    expect(res.status).toBe(403)
    expect(res.text).not.toContain('relay_resolve')
  })

  it('refuses a rebound read of the session list', async () => {
    const res = await call('GET', CONFIG.AGENT_RELAY.SESSIONS_ROUTE, `evil.example:${port}`)
    expect(res.status).toBe(403)
  })
})

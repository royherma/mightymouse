import { request } from 'http'
import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ queued: [] as string[] }))

vi.mock('electron', () => ({ screen: {}, shell: {}, app: { getPath: () => '/tmp', isPackaged: false } }))
vi.mock('../../../side-browser', () => ({ queueAgentUrl: (u: string) => h.queued.push(u), endAgentDriving: () => {} }))
vi.mock('../../../mighty/mighty-window', () => ({ getMightyWindow: () => null, showMightyWindow: () => {} }))
vi.mock('../../../../shared/config', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../../shared/config')>()
  return { ...real, CONFIG: { ...real.CONFIG, MIGHTY: { ...real.CONFIG.MIGHTY, BROWSER_TOOLS_PORT: 0 } } }
})

const { chatBrowserTools } = await import('../browser-tools')

async function doorUrl(): Promise<URL> {
  const config = await chatBrowserTools()
  if (!config) throw new Error('the chat browser door did not open')
  const servers = (JSON.parse(config) as { mcpServers: Record<string, { url: string }> }).mcpServers
  return new URL(Object.values(servers)[0].url)
}

function post(url: URL, headers: Record<string, string>, body: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: url.port, path: url.pathname, method: 'POST', headers }, (res) => {
      let text = ''
      res.on('data', (c) => (text += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

const openCall = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser_open', arguments: { url: 'https://attacker.example/phish' } } })

describe('chat browser tool door', () => {
  it('answers the local chat agent', async () => {
    const url = await doorUrl()
    expect(url.hostname).toBe('127.0.0.1')
    expect(url.port).not.toBe('17783')
    const res = await post(
      url,
      { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    )
    expect(res.status).toBe(200)
    expect(res.text).toContain('browser_open')
  })

  it('refuses a request whose Host is not the loopback address it listens on', async () => {
    const url = await doorUrl()
    const res = await post(url, { Host: `evil.example:${url.port}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, openCall)
    expect(res.status).toBe(403)
    expect(h.queued).toEqual([])
  })

  it('a tool call from the local agent reaches the browser', async () => {
    h.queued.length = 0
    const res = await post(await doorUrl(), { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, openCall)
    expect(res.status).toBe(200)
    expect(h.queued).toEqual(['https://attacker.example/phish'])
  })

  it('a web page cannot drive the browser: its no-preflight POST and its preflight are both refused', async () => {
    h.queued.length = 0
    const url = await doorUrl()
    const simple = await post(
      url,
      { Origin: 'https://attacker.example', 'Content-Type': 'text/plain; x=application/json', Accept: 'application/json, text/event-stream' },
      openCall
    )
    expect(simple.status).toBeGreaterThanOrEqual(400)
    const preflight = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: url.port, path: url.pathname, method: 'OPTIONS', headers: { Origin: 'https://attacker.example', 'Access-Control-Request-Method': 'POST' } },
        (res) => (res.resume(), resolve(res.statusCode ?? 0))
      )
      req.on('error', reject)
      req.end()
    })
    expect(preflight).toBe(403)
    expect(h.queued).toEqual([])
  })
})

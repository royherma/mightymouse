import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
import type { IncomingMessage, ServerResponse } from 'http'

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => '/tmp', getAppPath: () => process.cwd() },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../cloudflare-tunnel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../cloudflare-tunnel')>()
  return { ...actual, getTunnelHostname: () => 'mm-abc123def456.tunnel.example' }
})
vi.mock('../device-credentials', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../device-credentials')>()
  return { ...actual, isDeviceCredentialValid: (c: unknown) => c === 'good', deviceIdFor: () => 'device-1' }
})

const http = await import('../http-handlers')
const relay = await import('../relay-http')

type Handler = (req: IncomingMessage, res: ServerResponse) => unknown

async function call(handler: Handler, method: string, url: string, body?: Record<string, unknown>): Promise<number> {
  let status = 0
  const req = Object.assign(new EventEmitter(), {
    method,
    url,
    headers: { host: 'mm-abc123def456.tunnel.example' },
    socket: { remoteAddress: '127.0.0.1' },
    destroy: () => undefined
  })
  const done = new Promise<void>((resolve) => {
    const res = {
      headersSent: false,
      writeHead: (s: number) => {
        status = s
      },
      end: () => resolve()
    }
    void handler(req as unknown as IncomingMessage, res as unknown as ServerResponse)
  })
  if (method === 'POST') {
    req.emit('data', JSON.stringify(body ?? {}))
    req.emit('end')
  }
  await Promise.race([done, new Promise((r) => setTimeout(r, 200))])
  return status
}

const ROUTES: Array<[string, Handler, 'GET' | 'POST', (cred: string) => string, (cred: string) => Record<string, unknown>]> = [
  ['relay-request', relay.handleRelayRequest, 'GET', (c) => `/relay-request?credential=${c}&requestId=nope`, () => ({})],
  ['relay-avatar', relay.handleRelayAvatar, 'GET', (c) => `/relay-avatar?credential=${c}&requestId=nope`, () => ({})],
  ['relay-image', relay.handleRelayImage, 'GET', (c) => `/relay-image?credential=${c}&requestId=nope`, () => ({})],
  ['chat-media', relay.handleChatMedia, 'GET', (c) => `/chat-media?credential=${c}`, () => ({})],
  ['relay-respond', relay.handleRelayRespond, 'POST', () => '/relay-respond', (c) => ({ credential: c })],
  ['session-wrap', relay.handleSessionWrap, 'POST', () => '/session-wrap', (c) => ({ credential: c })],
  ['push-token', http.handlePushToken, 'POST', () => '/push-token', (c) => ({ credential: c, deviceToken: 'x' })],
  ['share', http.handleShare, 'POST', () => '/share', (c) => ({ credential: c })],
  ['intent', http.handleIntent, 'POST', () => '/intent', (c) => ({ credential: c })]
]

describe('credentialed routes over the shared tunnel IP', () => {
  it.each(ROUTES)('%s: a stranger spending the budget does not lock out the paired phone', async (_name, handler, method, url, body) => {
    const strangers: number[] = []
    for (let i = 0; i < 8; i++) strangers.push(await call(handler, method, url('bad'), body('bad')))
    expect(strangers[0]).toBe(401)
    expect(strangers.at(-1)).toBe(429)

    const phone = await call(handler, method, url('good'), body('good'))
    expect(phone).not.toBe(429)
    expect(phone).not.toBe(401)
  })
})

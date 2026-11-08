import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'
import type { IncomingMessage, ServerResponse } from 'http'

const h = vi.hoisted(() => ({
  sendPaneText: vi.fn(async () => 'tmux' as 'tmux' | 'tty' | 'skipped'),
  get: vi.fn(),
  resolve: vi.fn(() => 'resolved'),
  dismiss: vi.fn(() => 'dismissed')
}))

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => '/tmp', getAppPath: () => process.cwd() },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../../agent-relay/picker-keys', () => ({ sendPaneText: h.sendPaneText }))
vi.mock('../../agent-relay/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../agent-relay/store')>()
  return {
    ...actual,
    relayRequestStore: { ...actual.relayRequestStore, get: h.get, resolve: h.resolve, dismiss: h.dismiss }
  }
})
vi.mock('../device-credentials', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../device-credentials')>()
  return { ...actual, isDeviceCredentialValid: (c: unknown) => c === 'good', deviceIdFor: () => 'device-1' }
})

const { handleRelayRespond } = await import('../relay-http')

const STORED_ORIGIN = { app: 'tmux', pane: '%7' }

let nextIp = 0
async function post(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const out = { status: 0, body: {} as Record<string, unknown> }
  const req = Object.assign(new EventEmitter(), {
    method: 'POST',
    headers: {},
    socket: { remoteAddress: `10.7.0.${++nextIp}` },
    destroy: () => undefined
  })
  const done = new Promise<void>((resolve) => {
    const res = {
      writeHead: (s: number) => {
        out.status = s
      },
      end: (chunk?: string) => {
        out.body = chunk ? JSON.parse(chunk) : {}
        resolve()
      }
    }
    handleRelayRespond(req as unknown as IncomingMessage, res as unknown as ServerResponse)
  })
  req.emit('data', JSON.stringify(body))
  req.emit('end')
  await done
  return out
}

beforeEach(() => {
  h.sendPaneText.mockClear()
  h.resolve.mockClear()
  h.dismiss.mockClear()
  h.get.mockReset()
  h.get.mockImplementation((id: string) => (id === 'req-1' ? { id, params: { origin: STORED_ORIGIN } } : null))
})

describe('POST /relay-respond', () => {
  it('refuses a missing or unknown credential before touching the store', async () => {
    expect((await post({ requestId: 'req-1', reply: 'hi' })).status).toBe(401)
    expect((await post({ credential: 'bad', requestId: 'req-1', answer: 'Yes' })).status).toBe(401)
    expect(h.sendPaneText).not.toHaveBeenCalled()
    expect(h.resolve).not.toHaveBeenCalled()
  })

  it('types a reply into the pane stored with the request, ignoring any pane on the wire', async () => {
    const res = await post({ credential: 'good', requestId: 'req-1', reply: '  ship it  ', origin: { app: 'tmux', pane: '%99' } })
    expect(res.status).toBe(200)
    expect(h.sendPaneText).toHaveBeenCalledTimes(1)
    expect(h.sendPaneText).toHaveBeenCalledWith(STORED_ORIGIN, 'ship it')
  })

  it('answers 409 for a reply to a request the Mac no longer holds', async () => {
    const res = await post({ credential: 'good', requestId: 'gone', reply: 'hello' })
    expect(res.status).toBe(409)
    expect(h.sendPaneText).not.toHaveBeenCalled()
  })

  it('a dismiss never also answers the card', async () => {
    const res = await post({ credential: 'good', requestId: 'req-1', dismissed: true, answer: 'Yes', approved: true })
    expect(res.status).toBe(200)
    expect(h.dismiss).toHaveBeenCalledWith('req-1', 'device-1')
    expect(h.resolve).not.toHaveBeenCalled()
  })

  it('drops non-integer picks and question indexes instead of passing them on', async () => {
    await post({ credential: 'good', requestId: 'req-1', picks: [0, 'x'], questionIndex: 1.5, approved: 'yes' })
    const [, response] = h.resolve.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(response.picks).toBeUndefined()
    expect(response.questionIndex).toBeUndefined()
    expect(response.approved).toBeUndefined()
  })

  it('refuses a body over the size ceiling', async () => {
    const res = await post({ credential: 'good', requestId: 'req-1', note: 'x'.repeat(5000) })
    expect(res.status).toBe(413)
    expect(h.resolve).not.toHaveBeenCalled()
  })
})

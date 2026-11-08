import { EventEmitter } from 'events'
import { describe, it, expect, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'http'
import type { WebSocket } from 'ws'

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => '/tmp', getAppPath: () => process.cwd() },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../connection-journal', () => ({ recordJournal: vi.fn() }))

import { handleIntent, handleShare } from '../http-handlers'
import { handleRelayRespond, handleSessionWrap } from '../relay-http'
import { admitWebClient } from '../web-client'

function postNull(handler: (req: IncomingMessage, res: ServerResponse) => void): number | undefined {
  const req = Object.assign(new EventEmitter(), {
    method: 'POST',
    url: '/',
    headers: {},
    socket: { remoteAddress: '10.0.0.9' },
    destroy: vi.fn()
  })
  const res = { writeHead: vi.fn(), end: vi.fn() }
  handler(req as unknown as IncomingMessage, res as unknown as ServerResponse)
  req.emit('data', 'null')
  req.emit('end')
  return res.writeHead.mock.calls[0]?.[0] as number | undefined
}

describe('a JSON `null` body from an unauthenticated peer', () => {
  it.each([
    ['share', handleShare],
    ['intent', handleIntent],
    ['relay respond', handleRelayRespond],
    ['session wrap', handleSessionWrap]
  ])('%s answers 401 instead of throwing in the end listener', (_name, handler) => {
    expect(postNull(handler)).toBe(401)
  })

  it('a `null` web-tab frame is refused instead of throwing in the message listener', () => {
    const ws = Object.assign(new EventEmitter(), { send: vi.fn(), close: vi.fn(), ping: vi.fn(), readyState: 1 })
    const req = { socket: { remoteAddress: '10.0.0.9' }, headers: {} }
    admitWebClient(ws as unknown as WebSocket, req as unknown as IncomingMessage, {} as never, new Map())
    ws.emit('message', Buffer.from('null'), false)
    ws.emit('close')
    expect(ws.close).toHaveBeenCalledWith(4401, 'auth-first')
  })
})

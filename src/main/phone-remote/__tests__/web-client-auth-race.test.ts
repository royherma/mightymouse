import { EventEmitter } from 'events'
import { describe, it, expect, vi } from 'vitest'
import type { IncomingMessage } from 'http'
import type { WebSocket } from 'ws'

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => '/tmp', getAppPath: () => process.cwd() },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../connection-journal', () => ({ recordJournal: vi.fn() }))
vi.mock('../../auth', () => ({ withTimeout: (p: Promise<unknown>) => p }))
vi.mock('../../store/prefs', () => ({ PREFS: { getIncognito: () => false } }))
vi.mock('../../store/settings', () => ({ SETTINGS: { get: () => ({}) } }))
vi.mock('../../supabase', () => {
  const user = { id: 'user-1' }
  return {
    getSupabase: () => ({
      auth: {
        getSession: () => Promise.resolve({ data: { session: { user } } }),
        getUser: () => new Promise((r) => setTimeout(() => r({ data: { user } }), 20))
      }
    })
  }
})

import { admitWebClient, webClients } from '../web-client'

function fakeSocket(): EventEmitter & { readyState: number; send: () => void; close: () => void; ping: () => void } {
  return Object.assign(new EventEmitter(), { readyState: 1, send: vi.fn(), close: vi.fn(), ping: vi.fn() })
}

describe('web tab that closes while its token is being checked', () => {
  it('is not admitted and starts no keepalive once auth resolves', async () => {
    const ws = fakeSocket()
    const req = { socket: { remoteAddress: '10.0.0.9' }, headers: {} }
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')

    admitWebClient(ws as unknown as WebSocket, req as unknown as IncomingMessage, {} as never, new Map())
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'webAuth', token: 'x'.repeat(40) })), false)
    ws.readyState = 3
    ws.emit('close')
    await new Promise((r) => setTimeout(r, 60))

    const keepalives = setIntervalSpy.mock.results.map((r) => r.value as ReturnType<typeof setInterval>)
    setIntervalSpy.mockRestore()
    for (const t of keepalives) clearInterval(t)
    expect(webClients().has(ws as unknown as WebSocket)).toBe(false)
    expect(keepalives).toHaveLength(0)
  })
})

import { EventEmitter } from 'events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IncomingMessage } from 'http'
import type { WebSocket } from 'ws'

const state = vi.hoisted(() => ({
  incognito: false,
  webAccess: true as boolean | undefined,
  macUser: 'user-1' as string | null,
  tokenUser: 'user-1' as string | null
}))

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => '/tmp', getAppPath: () => process.cwd() },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../connection-journal', () => ({ recordJournal: vi.fn() }))
vi.mock('../../auth', () => ({ withTimeout: (p: Promise<unknown>) => p }))
vi.mock('../../store/prefs', () => ({ PREFS: { getIncognito: () => state.incognito } }))
vi.mock('../../store/settings', () => ({ SETTINGS: { get: () => ({ webAccess: state.webAccess }) } }))
vi.mock('../../supabase', () => ({
  getSupabase: () => ({
    auth: {
      getSession: async () => ({ data: { session: state.macUser ? { user: { id: state.macUser } } : null } }),
      getUser: async () => ({ data: { user: state.tokenUser ? { id: state.tokenUser } : null } })
    }
  })
}))

import { admitWebClient, sendToWebClients, verifyWebToken } from '../web-client'

const TOKEN = 't'.repeat(40)

beforeEach(() => {
  Object.assign(state, { incognito: false, webAccess: true, macUser: 'user-1', tokenUser: 'user-1' })
})

describe('verifyWebToken', () => {
  it('accepts a token for the account the Mac is signed into', async () => {
    expect(await verifyWebToken(TOKEN)).toBe('ok')
  })

  it.each([
    ['web access switched off', { webAccess: false }, 'off'],
    ['incognito', { incognito: true }, 'off'],
    ['Mac signed out', { macUser: null }, 'mac-signed-out'],
    ['token for no user', { tokenUser: null }, 'bad-token'],
    ['token for another account', { tokenUser: 'user-2' }, 'other-account']
  ])('%s → %s', async (_name, patch, verdict) => {
    Object.assign(state, patch)
    expect(await verifyWebToken(TOKEN)).toBe(verdict)
  })

  it.each([undefined, 42, 'short', 'x'.repeat(8193)])('rejects a malformed token %#', async (token) => {
    expect(await verifyWebToken(token)).toBe('bad-token')
  })
})

function fakeSocket() {
  return Object.assign(new EventEmitter(), { readyState: 1, send: vi.fn(), close: vi.fn(), ping: vi.fn() })
}

async function admitted() {
  const ws = fakeSocket()
  const onMessage = vi.fn()
  const req = { socket: { remoteAddress: '10.0.0.9' }, headers: {} }
  admitWebClient(ws as unknown as WebSocket, req as unknown as IncomingMessage, { onMessage } as never, new Map())
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'webAuth', token: TOKEN })), false)
  await vi.waitFor(() => expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'webAuth', ok: true })))
  return { ws, onMessage }
}

describe('an admitted web tab', () => {
  it('reaches the relay handlers but never trackpad or keyboard input', async () => {
    const { ws, onMessage } = await admitted()
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'pressKey', key: 'enter' })), false)
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'relaySessionPeek' })), false)
    expect(onMessage.mock.calls.map((c) => (c[0] as { type: string }).type)).toEqual(['relaySessionPeek'])
    expect(onMessage.mock.calls[0][1]).toBe('web/browser')
    ws.emit('close')
  })

  it('is closed on its next message once web access is switched off', async () => {
    const { ws, onMessage } = await admitted()
    state.webAccess = false
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'relaySessionPeek' })), false)
    expect(ws.close).toHaveBeenCalledWith(4403, 'off')
    expect(onMessage).not.toHaveBeenCalled()
    ws.emit('close')
  })

  it('receives relay events and pulse state, nothing else the phone gets', async () => {
    const { ws } = await admitted()
    ws.send.mockClear()
    sendToWebClients({ type: 'hostStatus' } as never, 'host')
    sendToWebClients({ type: 'relayPending' } as never, 'relay')
    sendToWebClients({ type: 'pulseState' } as never, 'pulse')
    expect(ws.send.mock.calls.map((c) => c[0])).toEqual(['relay', 'pulse'])
    ws.emit('close')
  })
})

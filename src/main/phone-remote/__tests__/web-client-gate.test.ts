import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'
import type { IncomingMessage } from 'http'
import type { WebSocket } from 'ws'

const h = vi.hoisted(() => ({
  macUser: 'user-roy' as string | null,
  tokenUsers: { 'roy-token-xxxxxxxxxxxxxxxx': 'user-roy', 'other-token-xxxxxxxxxxxxxx': 'user-other' } as Record<string, string>,
  incognito: false,
  webAccess: true as boolean | undefined
}))

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => '/tmp', getAppPath: () => process.cwd() },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../../supabase', () => ({
  getSupabase: () => ({
    auth: {
      getSession: async () => ({ data: { session: h.macUser ? { user: { id: h.macUser } } : null } }),
      getUser: async (token: string) => ({ data: { user: h.tokenUsers[token] ? { id: h.tokenUsers[token] } : null } })
    }
  })
}))
vi.mock('../../auth', () => ({ withTimeout: (p: Promise<unknown>) => p }))
vi.mock('../../store/prefs', () => ({ PREFS: { getIncognito: () => h.incognito } }))
vi.mock('../../store/settings', () => ({ SETTINGS: { get: () => ({ webAccess: h.webAccess }) } }))
vi.mock('../connection-journal', () => ({ recordJournal: () => undefined }))

const { verifyWebToken, admitWebClient, webClients } = await import('../web-client')
const { rateLimitBucket } = await import('../rate-limit')

const ROY = 'roy-token-xxxxxxxxxxxxxxxx'
const OTHER = 'other-token-xxxxxxxxxxxxxx'

beforeEach(() => {
  h.macUser = 'user-roy'
  h.incognito = false
  h.webAccess = true
})

describe('verifyWebToken', () => {
  it('admits only a token for the account the Mac is signed into', async () => {
    expect(await verifyWebToken(ROY)).toBe('ok')
    expect(await verifyWebToken(OTHER)).toBe('other-account')
    expect(await verifyWebToken('unknown-token-xxxxxxxxxxx')).toBe('bad-token')
  })

  it('refuses malformed tokens without asking Supabase', async () => {
    expect(await verifyWebToken(undefined)).toBe('bad-token')
    expect(await verifyWebToken('short')).toBe('bad-token')
    expect(await verifyWebToken('x'.repeat(8193))).toBe('bad-token')
  })

  it('refuses everything while the Mac is signed out, incognito, or has web access off', async () => {
    h.macUser = null
    expect(await verifyWebToken(ROY)).toBe('mac-signed-out')
    h.macUser = 'user-roy'
    h.incognito = true
    expect(await verifyWebToken(ROY)).toBe('off')
    h.incognito = false
    h.webAccess = false
    expect(await verifyWebToken(ROY)).toBe('off')
  })
})

class FakeSocket extends EventEmitter {
  readyState = 1
  sent: unknown[] = []
  closed: { code: number; reason: string } | null = null
  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason }
    this.emit('close')
  }
  ping(): void {}
}

function admit(): { ws: FakeSocket; onMessage: ReturnType<typeof vi.fn>; onAudio: ReturnType<typeof vi.fn> } {
  const ws = new FakeSocket()
  const onMessage = vi.fn()
  const onAudio = vi.fn()
  const req = { socket: { remoteAddress: '10.1.2.3' }, headers: {}, url: '/?web=1' } as unknown as IncomingMessage
  admitWebClient(ws as unknown as WebSocket, req, { onMessage, onAudio }, rateLimitBucket())
  return { ws, onMessage, onAudio }
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 10))

describe('admitWebClient', () => {
  it('closes a socket whose first message is not webAuth', () => {
    const { ws, onMessage } = admit()
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'relayProjects' })), false)
    expect(ws.closed).toEqual({ code: 4401, reason: 'auth-first' })
    expect(onMessage).not.toHaveBeenCalled()
  })

  it('ignores binary frames before auth', () => {
    const { ws, onAudio } = admit()
    ws.emit('message', Buffer.from([1, 2, 3]), true)
    expect(onAudio).not.toHaveBeenCalled()
    expect(ws.closed).toBeNull()
  })

  it('refuses a token from another account', async () => {
    const { ws } = admit()
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'webAuth', token: OTHER })), false)
    await settle()
    expect(ws.closed).toEqual({ code: 4401, reason: 'other-account' })
    expect(webClients().has(ws as unknown as WebSocket)).toBe(false)
  })

  it('after auth, passes relay messages and drops anything that drives the Mac', async () => {
    const { ws, onMessage } = admit()
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'webAuth', token: ROY })), false)
    await settle()
    expect(ws.sent).toContainEqual({ type: 'webAuth', ok: true })

    for (const type of ['typeText', 'click', 'pressKey', 'move', 'unpairSelf', 'approvalVerdict', 'setEnv']) {
      ws.emit('message', Buffer.from(JSON.stringify({ type, text: 'rm -rf ~' })), false)
    }
    expect(onMessage).not.toHaveBeenCalled()

    ws.emit('message', Buffer.from(JSON.stringify({ type: 'relayProjects' })), false)
    expect(onMessage).toHaveBeenCalledTimes(1)
    expect(onMessage.mock.calls[0][0]).toEqual({ type: 'relayProjects' })
    ws.close(1000, 'done')
  })

  it('closes an authed tab the moment web access is switched off', async () => {
    const { ws, onMessage } = admit()
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'webAuth', token: ROY })), false)
    await settle()
    h.webAccess = false
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'relayProjects' })), false)
    expect(ws.closed).toEqual({ code: 4403, reason: 'off' })
    expect(onMessage).not.toHaveBeenCalled()
  })
})

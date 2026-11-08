/**
 * Does a relay card get the sender's PROJECT picture, resolved from the stored
 * request's cwd -- never off the query string, or this route becomes a
 * render-anything oracle?
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'http'

const projectAvatarPng = vi.fn()
const relayProject = vi.fn()
const storeGet = vi.fn()

vi.mock('../../agent-relay/project-avatar-png', () => ({ projectAvatarPng, relayProject }))
// Spread the REAL module rather than replacing it: relay-http and
// server-runtime import each other, and a bare factory here leaves relay-http
// half-initialized, so every call dies on a TDZ error for its rate-limit
// bucket rather than on anything this test is about.
vi.mock('../../agent-relay/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../agent-relay/store')>()
  return { ...actual, relayRequestStore: { ...actual.relayRequestStore, get: storeGet } }
})
vi.mock('../device-credentials', () => ({
  isDeviceCredentialValid: (c: unknown) => c === 'good',
  deviceIdFor: () => 'device-1'
}))
vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => '/tmp', getAppPath: () => process.cwd() },
  safeStorage: { isEncryptionAvailable: () => false }
}))

interface Captured {
  status: number
  headers: Record<string, string>
  body: Buffer
}

const { handleRelayAvatar } = await import('../relay-http')

async function call(url: string): Promise<Captured> {
  const captured: Captured = { status: 0, headers: {}, body: Buffer.alloc(0) }
  const res = {
    writeHead: (status: number, headers: Record<string, string>) => {
      captured.status = status
      captured.headers = headers
    },
    end: (body?: Buffer | string) => {
      if (body) captured.body = Buffer.isBuffer(body) ? body : Buffer.from(body)
    }
  } as unknown as ServerResponse
  const req = {
    method: 'GET',
    url,
    headers: {},
    socket: { remoteAddress: '127.0.0.1' }
  } as unknown as IncomingMessage
  await handleRelayAvatar(req, res)
  return captured
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const PROJECT = { id: 'p1', name: 'ShowAndTell', repoFolder: '/repo', imagePath: '/img/logo.svg' }

describe('GET /relay-avatar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    projectAvatarPng.mockResolvedValue(PNG)
    relayProject.mockReturnValue(PROJECT)
  })

  it("serves the sender's project picture as PNG bytes", async () => {
    const params = { from: 'mm-dev-298', cwd: '/repo/src' }
    storeGet.mockReturnValue({ verb: 'ask', params })
    const res = await call('/relay-avatar?requestId=r1&credential=good')
    expect(res.status).toBe(200)
    expect(res.headers['Content-Type']).toBe('image/png')
    expect(res.body.equals(PNG)).toBe(true)
    expect(relayProject).toHaveBeenCalledWith(params)
    expect(projectAvatarPng).toHaveBeenCalledWith(PROJECT)
  })

  it('never takes the project off the query string', async () => {
    storeGet.mockReturnValue(null)
    const res = await call('/relay-avatar?requestId=r1&credential=good&cwd=/etc')
    expect(res.status).toBe(404)
    expect(relayProject).not.toHaveBeenCalled()
  })

  it('404s when the project has no picture, so the phone draws its icon', async () => {
    storeGet.mockReturnValue({ verb: 'ask', params: { cwd: '/repo' } })
    projectAvatarPng.mockResolvedValue(undefined)
    expect((await call('/relay-avatar?requestId=r1&credential=good')).status).toBe(404)
  })

  it('rejects a bad credential before it ever touches the store', async () => {
    const res = await call('/relay-avatar?requestId=r1&credential=nope')
    expect(res.status).toBe(401)
    expect(storeGet).not.toHaveBeenCalled()
  })
})

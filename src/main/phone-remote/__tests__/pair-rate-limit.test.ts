import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
import type { IncomingMessage, ServerResponse } from 'http'

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => '/tmp' },
  safeStorage: { isEncryptionAvailable: () => false }
}))

vi.mock('../../store/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/paths')>()
  const { join: j } = await import('path')
  const { tmpdir: t } = await import('os')
  const { sandboxPaths } = await import('./sandbox-paths')
  return { ...actual, PATHS: sandboxPaths(actual.PATHS, actual.PATHS.ROOT, j(t(), 'mm-pair-rate-limit-test')) }
})

const { handlePair, issuePairingCode } = await import('../pairing')

type Pending = { req: EventEmitter; result: { status: number | null; body: Record<string, unknown> | null } }

function open(ip: string): Pending {
  const result: Pending['result'] = { status: null, body: null }
  const req = Object.assign(new EventEmitter(), {
    method: 'POST',
    headers: {},
    socket: { remoteAddress: ip },
    destroy: () => undefined
  })
  const res = {
    writeHead: (status: number) => {
      result.status = status
    },
    end: (chunk?: string) => {
      result.body = chunk ? (JSON.parse(chunk) as Record<string, unknown>) : null
    }
  }
  handlePair(req as unknown as IncomingMessage, res as unknown as ServerResponse)
  return { req, result }
}

function finish(p: Pending, code: string): void {
  p.req.emit('data', JSON.stringify({ code }))
  p.req.emit('end')
}

describe('/pair rate limit under concurrency', () => {
  it('refuses guesses whose headers arrived before the limit tripped', () => {
    const code = issuePairingCode()
    const wrong = code === '000000' ? '111111' : '000000'
    const ip = '10.66.0.1'
    const inFlight = Array.from({ length: 50 }, () => open(ip))
    const winner = open(ip)
    for (const p of inFlight) finish(p, wrong)
    finish(winner, code)

    const checked = inFlight.filter((p) => p.result.status === 401).length
    expect(checked).toBeLessThanOrEqual(5)
    expect(winner.result.status).toBe(429)
    expect(winner.result.body?.credential).toBeUndefined()
  })
})

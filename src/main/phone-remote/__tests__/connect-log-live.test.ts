/**
 * POST /connect-log must land in the journal without a successful WS.
 *
 * The 12:22 pairing screen was `rejected no-credential` on the Mac and silence
 * from the phone: CONNECTLOG only flushed on onopen. A phone that can be
 * refused can POST to the same origin.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { request } from 'https'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdirSync, rmSync, readFileSync, existsSync } from 'fs'
import { CONFIG } from '../../../shared/config'
import { formatAttempt, type ConnectAttempt } from '../../../shared/phone-connect-log'
import { PATHS } from '../../store/paths'
import type { JournalEntry } from '../connection-journal'

const TEST_ROOT = join(tmpdir(), 'mm-connect-log-test')
let activePort = 0

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => '/tmp', getAppPath: () => process.cwd() },
  safeStorage: { isEncryptionAvailable: () => false }
}))

vi.mock('../../../shared/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/config')>()
  return {
    ...actual,
    CONFIG: {
      ...actual.CONFIG,
      PHONE_REMOTE: { ...actual.CONFIG.PHONE_REMOTE, PORT: 41891 }
    }
  }
})

vi.mock('../../store/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/paths')>()
  const { join: j } = await import('path')
  const { tmpdir: t } = await import('os')
  const { sandboxPaths } = await import('./sandbox-paths')
  const root = j(t(), 'mm-connect-log-test')
  return { ...actual, PATHS: sandboxPaths(actual.PATHS, actual.PATHS.ROOT, root) }
})

const SAMPLE: ConnectAttempt = {
  at: 1_700_000_000_000,
  outcome: 'rejected',
  detail: 'no-credential',
  host: 'example.getmightymouse.com',
  hadCredential: false,
  attempt: 1,
  opened: false
}

interface Reply {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

function call(
  method: string,
  opts: { headers?: Record<string, string>; body?: string } = {}
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = opts.body ?? ''
    const req = request(
      {
        hostname: '127.0.0.1',
        port: activePort,
        path: CONFIG.PHONE_REMOTE.CONNECT_LOG_PATH,
        method,
        rejectUnauthorized: false,
        agent: false,
        headers: {
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) }
            : {}),
          ...opts.headers
        }
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data })
        )
      }
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

function journal(): JournalEntry[] {
  if (!existsSync(PATHS.PHONE_REMOTE_JOURNAL)) return []
  return JSON.parse(readFileSync(PATHS.PHONE_REMOTE_JOURNAL, 'utf8')) as JournalEntry[]
}

describe('POST /connect-log', () => {
  let mod: typeof import('../server')

  beforeAll(async () => {
    mkdirSync(TEST_ROOT, { recursive: true })
    vi.resetModules()
    mod = await import('../server')
    const started = await mod.startPhoneRemoteServer({
      getLayoutPrefs: () => ({ layout: 'pro', skin: 'pro' }) as never
    })
    expect(started.ok, 'test server must start to prove anything').toBe(true)
    if (started.ok) activePort = started.port
    expect(activePort, 'must never bind the real phone-remote port').not.toBe(17771)
  }, 60_000)

  afterAll(() => {
    mod?.stopPhoneRemoteServer()
    rmSync(TEST_ROOT, { recursive: true, force: true })
  })

  it('answers the CORS preflight so a tunnel-origin page can POST to LAN', async () => {
    const res = await call('OPTIONS', {
      headers: {
        Origin: 'https://example.getmightymouse.com',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type'
      }
    })
    expect(res.status).toBe(204)
    expect(res.headers['access-control-allow-origin']).toBe('*')
    expect(String(res.headers['access-control-allow-methods'])).toContain('POST')
  })

  it('refuses GET', async () => {
    expect((await call('GET')).status).toBe(405)
  })

  it('writes phone-attempt rows without a WebSocket', async () => {
    const before = journal().length
    const res = await call('POST', { body: JSON.stringify({ entries: [SAMPLE] }) })
    expect(res.status).toBe(200)
    const rows = journal().slice(before)
    expect(rows.some((e) => e.event === 'phone-attempt' && e.detail === formatAttempt(SAMPLE))).toBe(
      true
    )
  })

  it('rejects a body that carries a credential field', async () => {
    const before = journal().length
    const res = await call('POST', {
      body: JSON.stringify({ entries: [{ ...SAMPLE, credential: 'secret' }] })
    })
    expect(res.status).toBe(400)
    expect(journal()).toHaveLength(before)
  })
})

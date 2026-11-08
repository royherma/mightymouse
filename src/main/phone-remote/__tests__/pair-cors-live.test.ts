/**
 * POST /pair must survive a CORS preflight.
 *
 * Scanning the tunnel QR from a LAN-origin page makes the pair call
 * cross-origin, so Safari sends OPTIONS first. The server answered 405, the
 * browser blocked the POST before sending it, and the thrown fetch surfaced
 * to the user as "can't reach your Mac" while the Mac was serving fine.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { request } from 'https'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdirSync, rmSync } from 'fs'
import { CONFIG } from '../../../shared/config'

const TEST_ROOT = join(tmpdir(), 'mm-pair-cors-test')
let activePort = 0

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => '/tmp', getAppPath: () => process.cwd() },
  safeStorage: { isEncryptionAvailable: () => false }
}))

// The server binds CONFIG's port, so overriding it here is what actually keeps
// this off 17771. A local `const TEST_PORT` would not: the header on
// observer-live.test.ts claims a test-only port while binding the real one.
vi.mock('../../../shared/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/config')>()
  return {
    ...actual,
    CONFIG: {
      ...actual.CONFIG,
      PHONE_REMOTE: { ...actual.CONFIG.PHONE_REMOTE, PORT: 41883 }
    }
  }
})

vi.mock('../../store/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/paths')>()
  const { join: j } = await import('path')
  const { tmpdir: t } = await import('os')
  const { sandboxPaths } = await import('./sandbox-paths')
  const root = j(t(), 'mm-pair-cors-test')
  return { ...actual, PATHS: sandboxPaths(actual.PATHS, actual.PATHS.ROOT, root) }
})

interface Reply {
  status: number
  headers: Record<string, string | string[] | undefined>
}

/** Plain `https.request`, not fetch: the cert is self-signed. */
function call(method: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port: activePort,
        path: CONFIG.PHONE_REMOTE.PAIR_CODE_PATH,
        method,
        rejectUnauthorized: false,
        agent: false,
        headers
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }))
      }
    )
    req.on('error', reject)
    req.end()
  })
}

describe('POST /pair CORS preflight', () => {
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
    // Belt and braces: if the port mock ever stops applying, fail loudly here
    // rather than firing requests at Roy's live phone session.
    expect(activePort, 'must never bind the real phone-remote port').not.toBe(17771)
  }, 60_000)

  afterAll(() => {
    mod?.stopPhoneRemoteServer()
    rmSync(TEST_ROOT, { recursive: true, force: true })
  })

  it('answers the preflight instead of 405, so the browser sends the POST', async () => {
    const res = await call('OPTIONS', {
      Origin: 'https://192.168.1.42:17771',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type'
    })
    expect(res.status).toBe(204)
    expect(res.headers['access-control-allow-origin']).toBe('*')
    expect(String(res.headers['access-control-allow-methods'])).toContain('POST')
    expect(String(res.headers['access-control-allow-headers']).toLowerCase()).toContain(
      'content-type'
    )
  })

  it('still refuses methods that are neither POST nor the preflight', async () => {
    expect((await call('GET')).status).toBe(405)
    expect((await call('DELETE')).status).toBe(405)
  })
})

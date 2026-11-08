/**
 * POST /push-token, end to end. Drives a REAL server
 * on a test-only port -- copies the observer-live.test.ts harness -- because
 * the property that matters is the whole authed-route contract (OPTIONS
 * preflight, method guard, rate limit, body cap, credential check, persistence
 * into DeviceRecord), not the validator function in isolation.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { request } from 'https'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdirSync, rmSync } from 'fs'
import { CONFIG } from '../../../shared/config'

const TEST_ROOT = join(tmpdir(), 'mm-push-token-live-test')
let activePort = 41972

vi.mock('../../../shared/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/config')>()
  return {
    ...actual,
    CONFIG: {
      ...actual.CONFIG,
      PHONE_REMOTE: { ...actual.CONFIG.PHONE_REMOTE, PORT: 41972 }
    }
  }
})

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => '/tmp', getAppPath: () => process.cwd() },
  safeStorage: { isEncryptionAvailable: () => false }
}))

vi.mock('../../store/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/paths')>()
  const { join: j } = await import('path')
  const { tmpdir: t } = await import('os')
  const { sandboxPaths } = await import('./sandbox-paths')
  const root = j(t(), 'mm-push-token-live-test')
  return { ...actual, PATHS: sandboxPaths(actual.PATHS, actual.PATHS.ROOT, root) }
})

const VALID_TOKEN = 'a1'.repeat(32) // 64 hex chars, the classic APNs length

function post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port: activePort,
        path,
        method: 'POST',
        rejectUnauthorized: false,
        agent: false,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, json: JSON.parse(data) })
          } catch (err) {
            reject(err)
          }
        })
      }
    )
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

async function pairDevice(mod: typeof import('../server')): Promise<string> {
  const code = mod.issuePairingCode()
  const { json } = await post(CONFIG.PHONE_REMOTE.PAIR_CODE_PATH, { code })
  return (json as { credential: string }).credential
}

describe('POST /push-token, live server', () => {
  let mod: typeof import('../server')
  let credential: string

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
    credential = await pairDevice(mod)
  }, 60_000)

  afterAll(() => {
    mod?.stopPhoneRemoteServer()
    rmSync(TEST_ROOT, { recursive: true, force: true })
  })

  it('persists a valid token against the paired credential', async () => {
    const { status, json } = await post(CONFIG.PHONE_REMOTE.PUSH_TOKEN_PATH, {
      credential,
      deviceToken: VALID_TOKEN
    })
    expect(status).toBe(200)
    expect(json).toEqual({ ok: true })

    const devices = mod.listPairedDevices()
    expect(devices).toHaveLength(1)
  })

  it('rejects an unknown credential', async () => {
    const { status, json } = await post(CONFIG.PHONE_REMOTE.PUSH_TOKEN_PATH, {
      credential: 'not-a-real-credential',
      deviceToken: VALID_TOKEN
    })
    expect(status).toBe(401)
    expect(json).toEqual({ error: 'invalid-credential' })
  })

  it('rejects a malformed token shape', async () => {
    const { status, json } = await post(CONFIG.PHONE_REMOTE.PUSH_TOKEN_PATH, {
      credential,
      deviceToken: 'not-hex'
    })
    expect(status).toBe(400)
    expect(json).toEqual({ error: 'invalid-token' })
  })

  it('rejects a non-POST method', async () => {
    const result = await new Promise<{ status: number }>((resolve, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port: activePort,
          path: CONFIG.PHONE_REMOTE.PUSH_TOKEN_PATH,
          method: 'GET',
          rejectUnauthorized: false,
          agent: false
        },
        (res) => resolve({ status: res.statusCode ?? 0 })
      )
      req.on('error', reject)
      req.end()
    })
    expect(result.status).toBe(405)
  })
})

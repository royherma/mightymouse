/**
 * The full device lifecycle over a REAL server: pair → connect → revoke →
 * re-pair → reconnect.
 *
 * `ws-auth-gate.test.ts` proves each refusal in isolation; this locks the
 * RECOVERY loop end to end, because it once starved itself: a revoked phone's
 * retries tripped the per-IP limiter that also guarded POST /pair — the one
 * call that could fix it (memory `one-limiter-bucket-starves-recovery`).
 * A native app is stranded for good if this path regresses.
 *
 * Binds a test-only port, never 17771 — enforced by the CONFIG mock + the
 * beforeAll assertion, same as observer-live.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { WebSocket } from 'ws'
import { request } from 'https'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdirSync, rmSync } from 'fs'
import { CONFIG } from '../../../shared/config'

const TEST_ROOT = join(tmpdir(), 'mm-connect-lifecycle-test')
let activePort = 41977

vi.mock('../../../shared/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/config')>()
  return {
    ...actual,
    CONFIG: {
      ...actual.CONFIG,
      PHONE_REMOTE: { ...actual.CONFIG.PHONE_REMOTE, PORT: 41977 }
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
  const root = j(t(), 'mm-connect-lifecycle-test')
  return { ...actual, PATHS: sandboxPaths(actual.PATHS, actual.PATHS.ROOT, root) }
})

async function pairDevice(mod: typeof import('../server')): Promise<string> {
  const code = mod.issuePairingCode()
  const body = JSON.stringify({ code })
  return new Promise<string>((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port: activePort,
        path: CONFIG.PHONE_REMOTE.PAIR_CODE_PATH,
        method: 'POST',
        rejectUnauthorized: false,
        agent: false,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => {
          try {
            resolve((JSON.parse(data) as { credential: string }).credential)
          } catch (err) {
            reject(err)
          }
        })
      }
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

async function openAndSettle(credential: string): Promise<WebSocket> {
  const ws = new WebSocket(
    `wss://127.0.0.1:${activePort}/?${CONFIG.PHONE_REMOTE.DEVICE_CREDENTIAL_PARAM}=${credential}`,
    { rejectUnauthorized: false }
  )
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve())
    ws.on('error', reject)
  })
  await new Promise((r) => setTimeout(r, 250))
  return ws
}

describe('device lifecycle: pair → connect → revoke → re-pair', () => {
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

  it('survives the whole loop, stating the revoke reason the client reads verbatim', async () => {
    const credential = await pairDevice(mod)
    const phone = await openAndSettle(credential)
    expect(phone.readyState, 'paired credential must connect').toBe(WebSocket.OPEN)

    // Revoke from the MAC side (Settings → X): the close must STATE the
    // reason — the client dispatches on event.reason with no inference step
    // (see CLAUDE.md, "A revoked phone must not retry"). Note
    // revokeActiveDevice() is the PHONE-initiated unpair and deliberately
    // closes nothing; revokePairedDevice() is the path under test.
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      phone.on('close', (code, reason) => resolve({ code, reason: reason.toString() }))
    })
    const devices = mod.listPairedDevices()
    expect(devices.length, 'the paired device must be listed').toBe(1)
    expect(mod.revokePairedDevice(devices[0].id), 'revoke must find the device').toBe(true)
    const { code, reason } = await closed
    expect(code, 'revoke closes 4401, never a bare close').toBe(4401)
    expect(reason).toBe(CONFIG.PHONE_REMOTE.CLOSE_REASON_REVOKED)

    // The dead credential must be refused with the same stated reason.
    const stale = new WebSocket(
      `wss://127.0.0.1:${activePort}/?${CONFIG.PHONE_REMOTE.DEVICE_CREDENTIAL_PARAM}=${credential}`,
      { rejectUnauthorized: false }
    )
    const staleClose = await new Promise<{ code: number; reason: string }>((resolve) => {
      stale.on('close', (c, r) => resolve({ code: c, reason: r.toString() }))
      stale.on('error', () => {})
    })
    expect(staleClose.code).toBe(4401)
    expect(staleClose.reason).toBe(CONFIG.PHONE_REMOTE.CLOSE_REASON_REVOKED)

    // Recovery: a fresh pair must still work — POST /pair must not have been
    // starved by the revoked attempts sharing its limiter bucket.
    const fresh = await pairDevice(mod)
    expect(fresh, 'a fresh pairing code must mint a new credential').toBeTruthy()
    expect(fresh).not.toBe(credential)

    const rejoined = await openAndSettle(fresh)
    expect(rejoined.readyState, 're-paired device must reconnect').toBe(WebSocket.OPEN)
    rejoined.close()
  }, 30_000)
})

/**
 * Does a pending relay request actually REACH a connected phone?
 *
 * The Code sheet renders straight off the `relayPending` WS snapshot, so an
 * empty "Needs you" list has two completely different causes: the store held
 * nothing, or the store held cards and the snapshot never arrived. Reading
 * either side alone cannot tell them apart -- `sendToPhone` is a silent no-op
 * when no socket is open, which is exactly what an empty list looks like.
 *
 * Binds a high test-only port -- never 17771 -- so this cannot touch Roy's live
 * phone session (see CLAUDE.local.md). Enforced by the CONFIG mock plus the
 * assertion in `beforeAll`, same protocol as `observer-live.test.ts`.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { WebSocket } from 'ws'
import { request } from 'https'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdirSync, rmSync } from 'fs'
import { CONFIG } from '../../../shared/config'

const TEST_ROOT = join(tmpdir(), 'mm-relay-snapshot-live-test')
let activePort = 41973

vi.mock('../../../shared/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/config')>()
  return {
    ...actual,
    CONFIG: {
      ...actual.CONFIG,
      PHONE_REMOTE: { ...actual.CONFIG.PHONE_REMOTE, PORT: 41973 }
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
  const root = j(t(), 'mm-relay-snapshot-live-test')
  return { ...actual, PATHS: sandboxPaths(actual.PATHS, actual.PATHS.ROOT, root) }
})

vi.mock('../../../shared/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/env')>()
  return { ...actual, IS_DEV: true }
})

async function pairDevice(mod: typeof import('../server')): Promise<string> {
  const code = mod.issuePairingCode()
  const body = JSON.stringify({ code })
  return await new Promise<string>((resolve, reject) => {
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

describe('relay snapshot reaches a connected phone', () => {
  let mod: typeof import('../server')
  let store: typeof import('../../agent-relay/store')
  let wire: typeof import('../../agent-relay/wire')
  let credential: string

  beforeAll(async () => {
    mkdirSync(TEST_ROOT, { recursive: true })
    vi.resetModules()
    mod = await import('../server')
    store = await import('../../agent-relay/store')
    wire = await import('../../agent-relay/wire')
    const started = await mod.startPhoneRemoteServer({
      getLayoutPrefs: () => ({ layout: 'pro', skin: 'pro' }) as never
    })
    expect(started.ok, 'test server must start to prove anything').toBe(true)
    if (started.ok) activePort = started.port
    expect(activePort, 'must never bind the real phone-remote port').not.toBe(17771)
    credential = await pairDevice(mod)
  }, 60_000)

  afterAll(() => {
    store?.relayRequestStore.resetForTests()
    mod?.stopPhoneRemoteServer()
    rmSync(TEST_ROOT, { recursive: true, force: true })
  })

  /** The snapshot the Mac would push right now, straight off the store. This is
   *  the same function `sendRelayPending` calls, so a mismatch between this and
   *  what the socket receives isolates the failure to the transport. */
  it('a pending ask is present in the snapshot the Mac would send', () => {
    store.relayRequestStore.resetForTests()
    const before = wire.relaySnapshot().pending.length
    expect(before, 'store starts clean').toBe(0)

    store.relayRequestStore.mint('ask', { question: 'live snapshot probe?' })

    const after = wire.relaySnapshot()
    expect(after.pending.length, 'a minted ask must be pending in the snapshot').toBe(1)
    expect(after.pending[0].verb).toBe('ask')
  })

  it('delivers that snapshot over the real socket to a connected phone', async () => {
    store.relayRequestStore.resetForTests()
    store.relayRequestStore.mint('ask', { question: 'does this reach the phone?' })

    const ws = new WebSocket(
      `wss://127.0.0.1:${activePort}/?${CONFIG.PHONE_REMOTE.DEVICE_CREDENTIAL_PARAM}=${credential}`,
      { rejectUnauthorized: false }
    )
    const received: unknown[] = []
    ws.on('message', (d) => received.push(JSON.parse(d.toString())))
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', reject)
    })

    // The snapshot is pushed by ipc/phone-remote's onConnect, which this test
    // does not run -- so send it the way the Mac does, through the same export.
    mod.sendToPhone({ type: 'relayPending', ...wire.relaySnapshot() })
    await new Promise((r) => setTimeout(r, 300))

    const snapshot = received.find(
      (m): m is { type: string; pending: unknown[] } =>
        typeof m === 'object' && m !== null && (m as { type?: string }).type === 'relayPending'
    )
    expect(snapshot, 'phone must receive a relayPending event').toBeDefined()
    expect(snapshot!.pending.length, 'the pending ask must survive the wire').toBe(1)

    ws.close()
  }, 30_000)
})

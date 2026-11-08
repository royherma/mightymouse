/**
 * A viewer RECONNECT must not blank the controller's zoom ring.
 *
 * The reported sequence: the ring showed while the cursorless headset was
 * reconnecting, then went dark ~20s later while the picture was plainly still
 * running. `receiving` was keyed on `mirrorPeerSocket === viewerSocket`, and a
 * reconnect gives the viewer a NEW socket -- so the pointer compare read false
 * for a mirror that never stopped. Only an explicit stop ends the picture.
 *
 * Binds a high test-only port -- never 17771 -- so this cannot touch a real
 * phone session (see CLAUDE.local.md). Enforced by the CONFIG mock below plus
 * the assertion in `beforeAll`, not by this comment.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { WebSocket } from 'ws'
import { request } from 'https'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdirSync, rmSync } from 'fs'
import { CONFIG } from '../../../shared/config'

const TEST_ROOT = join(tmpdir(), 'mm-viewer-reconnect-ring-test')
let activePort = 41987

vi.mock('../../../shared/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/config')>()
  return {
    ...actual,
    CONFIG: {
      ...actual.CONFIG,
      PHONE_REMOTE: { ...actual.CONFIG.PHONE_REMOTE, PORT: 41987 }
    }
  }
})

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => '/tmp', getAppPath: () => process.cwd() },
  safeStorage: { isEncryptionAvailable: () => false },
  screen: {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 } })
  }
}))

vi.mock('../../store/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/paths')>()
  const { join: j } = await import('path')
  const { tmpdir: t } = await import('os')
  const { sandboxPaths } = await import('./sandbox-paths')
  const root = j(t(), 'mm-viewer-reconnect-ring-test')
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

interface Party {
  ws: WebSocket
  /** The last `viewer` event. This IS the ring's gate. */
  viewer: 'none' | 'connected' | 'receiving' | null
}

describe('viewer reconnect keeps the ring lit', () => {
  let mod: typeof import('../server')
  let controllerCredential: string
  let viewerCredential: string

  async function openAndSettle(credential: string, extra = ''): Promise<Party> {
    const url = `wss://127.0.0.1:${activePort}/?${CONFIG.PHONE_REMOTE.DEVICE_CREDENTIAL_PARAM}=${credential}${extra}`
    const ws = new WebSocket(url, { rejectUnauthorized: false })
    const party: Party = { ws, viewer: null }
    ws.on('message', (d) => {
      const msg = JSON.parse(d.toString())
      if (msg.type === 'viewer') party.viewer = msg.viewer
    })
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', reject)
    })
    await new Promise((r) => setTimeout(r, 250))
    return party
  }

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
    controllerCredential = await pairDevice(mod)
    viewerCredential = await pairDevice(mod)
  }, 60_000)

  afterAll(() => {
    mod?.stopPhoneRemoteServer()
    rmSync(TEST_ROOT, { recursive: true, force: true })
  })

  it('stays receiving when the viewer socket drops and comes back', async () => {
    const phone = await openAndSettle(controllerCredential)
    const glasses = await openAndSettle(
      viewerCredential,
      `&${CONFIG.PHONE_REMOTE.CURSORLESS_PARAM}=1`
    )
    glasses.ws.send(JSON.stringify({ type: 'mirrorStart' }))
    await new Promise((r) => setTimeout(r, 300))
    expect(phone.viewer, 'the ring must light once the mirror starts').toBe('receiving')

    // The reconnect. The WebRTC peer survives this -- only signalling drops.
    glasses.ws.close()
    await new Promise((r) => setTimeout(r, 300))
    const glasses2 = await openAndSettle(
      viewerCredential,
      `&${CONFIG.PHONE_REMOTE.CURSORLESS_PARAM}=1`
    )
    await new Promise((r) => setTimeout(r, 300))

    // The bug: this read 'connected', so the ring went dark for the whole
    // window between the reconnect and the next mirrorStart.
    expect(phone.viewer, 'a reconnect must not blank the ring').toBe('receiving')

    glasses2.ws.close()
    phone.ws.close()
    await new Promise((r) => setTimeout(r, 200))
  }, 30_000)

  it('goes dark on an explicit stop, so the flag is not simply stuck on', async () => {
    const phone = await openAndSettle(controllerCredential)
    const glasses = await openAndSettle(
      viewerCredential,
      `&${CONFIG.PHONE_REMOTE.CURSORLESS_PARAM}=1`
    )
    glasses.ws.send(JSON.stringify({ type: 'mirrorStart' }))
    await new Promise((r) => setTimeout(r, 300))
    expect(phone.viewer, 'lit first').toBe('receiving')

    glasses.ws.send(JSON.stringify({ type: 'mirrorStop' }))
    await new Promise((r) => setTimeout(r, 300))
    expect(phone.viewer, 'an explicit stop DOES end the picture').toBe('connected')

    glasses.ws.close()
    phone.ws.close()
    await new Promise((r) => setTimeout(r, 200))
  }, 30_000)
})

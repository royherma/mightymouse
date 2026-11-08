/**
 * Role assignment must not depend on WHICH DEVICE DIALLED FIRST.
 *
 * Connecting the glasses before the phone used to hand them `activeSocket`,
 * which left the phone as the viewer -- so `relayViewerZoom` dropped every zoom
 * and the ring's track never painted. Both orders are asserted here because
 * only one of them was ever covered, and it was the one that worked.
 *
 * Binds a high test-only port -- never 17771 -- so this cannot touch a real
 * phone session. Enforced by the CONFIG mock below plus
 * the assertion in `beforeAll`, not by this comment.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { WebSocket } from 'ws'
import { request } from 'https'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdirSync, rmSync } from 'fs'
import { CONFIG } from '../../../shared/config'

const TEST_ROOT = join(tmpdir(), 'mm-glasses-first-test')
let activePort = 41979

// startPhoneRemoteServer() walks CONFIG.PHONE_REMOTE.PORT upward, so the real
// 17771 is what it binds unless the config itself says otherwise.
vi.mock('../../../shared/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/config')>()
  return {
    ...actual,
    CONFIG: {
      ...actual.CONFIG,
      PHONE_REMOTE: { ...actual.CONFIG.PHONE_REMOTE, PORT: 41979 }
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
  const root = j(t(), 'mm-glasses-first-test')
  return { ...actual, PATHS: sandboxPaths(actual.PATHS, actual.PATHS.ROOT, root) }
})

vi.mock('../../../shared/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/env')>()
  return { ...actual, IS_DEV: true }
})

/** Called TWICE: identity derives from the credential, so two sockets sharing
 *  one would read as the same phone reconnecting and evict rather than attach. */
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
  /** Every `mirrorViewerZoom` scale this socket received, in order. */
  zooms: number[]
  /** The last `viewer` event, which is how the controller learns the track
   *  should light at all. */
  viewer: 'none' | 'connected' | 'receiving' | null
}

describe('ring zoom relay, live server', () => {
  let mod: typeof import('../server')
  let controllerCredential: string
  let viewerCredential: string

  /** Resolves once the socket has PROVEN it survived the gate. Waiting only for
   *  'open' hands back a socket the server may already be closing. */
  async function openAndSettle(credential: string, extra = ''): Promise<Party> {
    const url = `wss://127.0.0.1:${activePort}/?${CONFIG.PHONE_REMOTE.DEVICE_CREDENTIAL_PARAM}=${credential}${extra}`
    const ws = new WebSocket(url, { rejectUnauthorized: false })
    const party: Party = { ws, zooms: [], viewer: null }
    ws.on('message', (d) => {
      const msg = JSON.parse(d.toString())
      if (msg.type === 'mirrorViewerZoom') party.zooms.push(msg.scale)
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

  /** The GLASSES first -- the order that used to hand them the session. */
  async function pairGlassesFirst(): Promise<{ glasses: Party; phone: Party }> {
    const glasses = await openAndSettle(
      viewerCredential,
      `&${CONFIG.PHONE_REMOTE.CURSORLESS_PARAM}=1`
    )
    const phone = await openAndSettle(controllerCredential)
    expect(glasses.ws.readyState, 'glasses must stay connected').toBe(WebSocket.OPEN)
    expect(phone.ws.readyState, 'phone must be admitted alongside them').toBe(WebSocket.OPEN)
    return { glasses, phone }
  }

  it('gives the phone control even though the glasses arrived first', async () => {
    const { glasses, phone } = await pairGlassesFirst()
    // Only the controller is sent `viewer`, so receiving it IS the proof of
    // which role this socket holds.
    expect(phone.viewer, 'the phone must be the controller').not.toBe('none')
    expect(glasses.viewer, 'the glasses must NOT hold the session').toBeNull()
    glasses.ws.close()
    phone.ws.close()
    await new Promise((r) => setTimeout(r, 200))
  }, 30_000)

  it("relays the phone's zoom to the glasses in this order too", async () => {
    const { glasses, phone } = await pairGlassesFirst()
    phone.ws.send(JSON.stringify({ type: 'mirrorViewerZoom', scale: 2.5 }))
    await new Promise((r) => setTimeout(r, 300))

    // The reported bug, inverted into the guarantee: order must not matter.
    expect(glasses.zooms, 'the thumb must reach the picture').toEqual([2.5])
    expect(phone.zooms, 'and never echo back to the phone').toEqual([])
    glasses.ws.close()
    phone.ws.close()
    await new Promise((r) => setTimeout(r, 200))
  }, 30_000)

  it('still works phone-first, so the fix did not just swap the broken order', async () => {
    const phone = await openAndSettle(controllerCredential)
    const glasses = await openAndSettle(
      viewerCredential,
      `&${CONFIG.PHONE_REMOTE.CURSORLESS_PARAM}=1`
    )
    phone.ws.send(JSON.stringify({ type: 'mirrorViewerZoom', scale: 3 }))
    await new Promise((r) => setTimeout(r, 300))

    expect(phone.viewer, 'the phone keeps control').not.toBe('none')
    expect(glasses.zooms, 'and the zoom still lands').toEqual([3])
    glasses.ws.close()
    phone.ws.close()
    await new Promise((r) => setTimeout(r, 200))
  }, 30_000)

})

/**
 * The ring zoom relay on a REAL server, BOTH directions: the command
 * (controller -> viewer) and the report (viewer -> controller). The echo loop
 * is the property worth locking -- only a test holding both sockets sees it.
 *
 * The clamp cannot be unit-tested: `relayViewerZoom` is module-private and its
 * whole decision is WHICH SOCKET asked, which only exists once two sockets are
 * really attached. The properties that matter are all server-side, because the
 * phone is not the only thing that can send this once the tunnel is on:
 *   - a hostile scale is clamped before it reaches the glasses (a NaN would
 *     paint `matrix(NaN)` -- a blank panel with no error anywhere)
 *   - only the controller may drive it
 *   - the controller never receives its own message back
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

const TEST_ROOT = join(tmpdir(), 'mm-viewer-zoom-live-test')
let activePort = 41973

// startPhoneRemoteServer() walks CONFIG.PHONE_REMOTE.PORT upward, so the real
// 17771 is what it binds unless the config itself says otherwise.
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
  const root = j(t(), 'mm-viewer-zoom-live-test')
  return { ...actual, PATHS: sandboxPaths(actual.PATHS, actual.PATHS.ROOT, root) }
})

vi.mock('../../../shared/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/env')>()
  return { ...actual, IS_DEV: true }
})

/** Mints a code and exchanges it over POST /pair, the same path a real phone
 *  takes. Called TWICE here: the viewer branch keys on the candidate being a
 *  DIFFERENT device, and device identity is derived from the credential, so
 *  two sockets on one credential would read as the same phone reconnecting
 *  and evict rather than attach. */
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
  /** Every `mirrorViewerZoomChanged` scale received -- the report travelling
   *  the other way. Kept separate from `zooms` so a test can prove a report
   *  did not come back out as a command, which is the echo loop. */
  changed: number[]
  /** How many attach questions reached this socket. */
  requests: number
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
    const party: Party = { ws, zooms: [], changed: [], requests: 0, viewer: null }
    ws.on('message', (d) => {
      const msg = JSON.parse(d.toString())
      if (msg.type === 'mirrorViewerZoom') party.zooms.push(msg.scale)
      if (msg.type === 'mirrorViewerZoomChanged') party.changed.push(msg.scale)
      if (msg.type === 'mirrorViewerZoomRequest') party.requests += 1
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

  /** A controller plus a viewer, in that order -- the second device attaches as
   *  a viewer precisely because it asks for no takeover. */
  async function pair(): Promise<{ controller: Party; viewer: Party }> {
    const controller = await openAndSettle(controllerCredential)
    const viewer = await openAndSettle(viewerCredential)
    expect(controller.ws.readyState, 'controller must keep the session').toBe(WebSocket.OPEN)
    expect(viewer.ws.readyState, 'viewer must be admitted alongside it').toBe(WebSocket.OPEN)
    return { controller, viewer }
  }

  it('tells the controller a viewer attached, so the track can light', async () => {
    const { controller, viewer } = await pair()
    // The controller cannot infer this from `role`: a lone phone and a phone
    // driving glasses both read `controller`.
    expect(controller.viewer, 'controller must learn a viewer exists').not.toBe('none')
    controller.ws.close()
    viewer.ws.close()
    await new Promise((r) => setTimeout(r, 200))
  }, 30_000)

  it('relays the controller thumb to the viewer, and never back to itself', async () => {
    const { controller, viewer } = await pair()
    controller.ws.send(JSON.stringify({ type: 'mirrorViewerZoom', scale: 2.5 }))
    await new Promise((r) => setTimeout(r, 300))

    expect(viewer.zooms, 'the device with the picture must get the scale').toEqual([2.5])
    // A phone driving its own zoom locally would fight itself for one value.
    expect(controller.zooms, 'the controller must never hear its own zoom').toEqual([])
    controller.ws.close()
    viewer.ws.close()
    await new Promise((r) => setTimeout(r, 200))
  }, 30_000)

  it('clamps a hostile scale into range instead of forwarding it', async () => {
    const { controller, viewer } = await pair()
    controller.ws.send(JSON.stringify({ type: 'mirrorViewerZoom', scale: 9999 }))
    controller.ws.send(JSON.stringify({ type: 'mirrorViewerZoom', scale: -50 }))
    await new Promise((r) => setTimeout(r, 300))

    expect(viewer.zooms).toEqual([
      CONFIG.PHONE_REMOTE.MIRROR_ZOOM_MAX,
      CONFIG.PHONE_REMOTE.MIRROR_ZOOM_MIN
    ])
    controller.ws.close()
    viewer.ws.close()
    await new Promise((r) => setTimeout(r, 200))
  }, 30_000)

  it('drops a scale that is not a finite number', async () => {
    const { controller, viewer } = await pair()
    // NaN/Infinity cannot survive JSON, so the wire shapes that actually reach
    // the Mac are null, a string, and a missing field -- each of which would
    // reach the transform as NaN if it were forwarded.
    controller.ws.send(JSON.stringify({ type: 'mirrorViewerZoom', scale: null }))
    controller.ws.send(JSON.stringify({ type: 'mirrorViewerZoom', scale: '3' }))
    controller.ws.send(JSON.stringify({ type: 'mirrorViewerZoom' }))
    await new Promise((r) => setTimeout(r, 300))

    expect(viewer.zooms, 'a non-number must never reach the glasses').toEqual([])
    controller.ws.close()
    viewer.ws.close()
    await new Promise((r) => setTimeout(r, 200))
  }, 30_000)

  it('ignores a zoom sent BY the viewer, which owns its own scale locally', async () => {
    const { controller, viewer } = await pair()
    viewer.ws.send(JSON.stringify({ type: 'mirrorViewerZoom', scale: 3 }))
    await new Promise((r) => setTimeout(r, 300))

    // Still ignored even though the dial is shared: this is the COMMAND, and a
    // viewer commanding a zoom would be a second writer. Its own zoom travels
    // as mirrorViewerZoomChanged, a report, covered below.
    expect(viewer.zooms, 'the viewer must not be echoed its own scale').toEqual([])
    expect(controller.zooms, 'and it must not reach the controller either').toEqual([])
    controller.ws.close()
    viewer.ws.close()
    await new Promise((r) => setTimeout(r, 200))
  }, 30_000)

  it('reports the viewer OWN zoom back to the controller, so one dial drives both', async () => {
    const { controller, viewer } = await pair()
    viewer.ws.send(JSON.stringify({ type: 'mirrorViewerZoomChanged', scale: 2.25 }))
    await new Promise((r) => setTimeout(r, 300))

    expect(controller.changed, 'the knob must learn what the glasses show').toEqual([2.25])
    expect(viewer.zooms, 'a report must never return as a command').toEqual([])
    expect(viewer.changed, 'and must not be echoed to its own sender').toEqual([])
    controller.ws.close()
    viewer.ws.close()
    await new Promise((r) => setTimeout(r, 200))
  }, 30_000)

  it('ignores a zoom REPORT sent by the controller, which has no picture to report', async () => {
    const { controller, viewer } = await pair()
    controller.ws.send(JSON.stringify({ type: 'mirrorViewerZoomChanged', scale: 3 }))
    await new Promise((r) => setTimeout(r, 300))

    expect(controller.changed, 'the controller must not hear its own report').toEqual([])
    expect(viewer.changed, 'and it must not reach the viewer either').toEqual([])
    controller.ws.close()
    viewer.ws.close()
    await new Promise((r) => setTimeout(r, 200))
  }, 30_000)

  it('asks the viewer for its zoom on attach, and sends no scale of its own', async () => {
    const { controller, viewer } = await pair()
    controller.ws.send(JSON.stringify({ type: 'mirrorViewerZoomRequest' }))
    await new Promise((r) => setTimeout(r, 300))

    expect(viewer.requests, 'the glasses must be asked what they are at').toBe(1)
    // The regression this replaced: attach used to PUSH the knob value, so a
    // fresh phone (knob at the base) reset glasses already sitting at 3x.
    expect(viewer.zooms, 'attach must never command a scale').toEqual([])
    controller.ws.close()
    viewer.ws.close()
    await new Promise((r) => setTimeout(r, 200))
  }, 30_000)

  it('clamps and drops a hostile report, exactly as the command path does', async () => {
    const { controller, viewer } = await pair()
    // A NaN here poisons the ring track's CSS, as it would the glasses' transform.
    viewer.ws.send(JSON.stringify({ type: 'mirrorViewerZoomChanged', scale: 9999 }))
    viewer.ws.send(JSON.stringify({ type: 'mirrorViewerZoomChanged', scale: null }))
    viewer.ws.send(JSON.stringify({ type: 'mirrorViewerZoomChanged', scale: '3' }))
    await new Promise((r) => setTimeout(r, 300))

    expect(controller.changed).toEqual([CONFIG.PHONE_REMOTE.MIRROR_ZOOM_MAX])
    controller.ws.close()
    viewer.ws.close()
    await new Promise((r) => setTimeout(r, 200))
  }, 30_000)
})

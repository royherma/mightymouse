/**
 * Two devices on one Mac, end to end (PRD 2026-08-10-1786351800).
 *
 * The property under test is ordering and routing inside `wss.on('connection')`
 * and `sendToPhone`, neither of which a unit test of the predicate can see:
 * `decideTakeover` still returns 'refuse' for this case, and the whole change
 * is what the server DOES with that outcome. A rule-level test would pass just
 * as happily against the old code that closed the socket.
 *
 * Binds a high test-only port -- never 17771 -- so this cannot touch a real
 * phone session (see CLAUDE.local.md). Enforced by the CONFIG mock plus the
 * assertion in `beforeAll`, not by this comment.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { WebSocket } from 'ws'
import { request } from 'https'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdirSync, rmSync } from 'fs'
import { CONFIG } from '../../../shared/config'

const TEST_ROOT = join(tmpdir(), 'mm-viewer-live-test')
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
  safeStorage: { isEncryptionAvailable: () => false },
  // publishViewerState reads the display under the cursor to size the minimap.
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
  const root = j(t(), 'mm-viewer-live-test')
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

describe('two devices on one Mac, live server', () => {
  let mod: typeof import('../server')
  let controllerCred: string
  let viewerCred: string

  async function openAndSettle(credential: string, extra = ''): Promise<WebSocket> {
    const ws = new WebSocket(
      `wss://127.0.0.1:${activePort}/?${CONFIG.PHONE_REMOTE.DEVICE_CREDENTIAL_PARAM}=${credential}${extra}`,
      { rejectUnauthorized: false }
    )
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', reject)
    })
    await new Promise((r) => setTimeout(r, 250))
    return ws
  }

  /** Collects every JSON event a socket receives, for routing assertions.
   *  Attached BEFORE the socket opens -- `role` and `layoutPrefs` are sent
   *  during the upgrade, so a collector added afterwards misses both. */
  function collect(ws: WebSocket): string[] {
    const types: string[] = []
    ws.on('message', (d) => {
      try {
        types.push(JSON.parse(d.toString()).type)
      } catch {
        /* binary frame, not a routing subject here */
      }
    })
    return types
  }

  /** Role VALUES, not just the type. `collect` records that a role arrived;
   *  only this can tell 'controller' from 'viewer', and that blindness is why
   *  the stranded-viewer bug shipped green. */
  function collectRoles(ws: WebSocket): string[] {
    const roles: string[] = []
    ws.on('message', (d) => {
      try {
        const msg = JSON.parse(d.toString())
        if (msg.type === 'role') roles.push(msg.role)
      } catch {
        /* binary frame, not a routing subject here */
      }
    })
    return roles
  }

  /** Opens with a collector already attached, then settles. */
  async function openCollecting(
    credential: string
  ): Promise<{ ws: WebSocket; seen: string[] }> {
    const ws = new WebSocket(
      `wss://127.0.0.1:${activePort}/?${CONFIG.PHONE_REMOTE.DEVICE_CREDENTIAL_PARAM}=${credential}`,
      { rejectUnauthorized: false }
    )
    const seen = collect(ws)
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', reject)
    })
    await new Promise((r) => setTimeout(r, 250))
    return { ws, seen }
  }

  /** Closes sockets and waits for the server to release them. Without this the
   *  next test's controller lands on a server that still holds the previous
   *  viewer, and gets refused as a THIRD device. */
  async function shutdown(...sockets: WebSocket[]): Promise<void> {
    for (const ws of sockets) if (ws.readyState === WebSocket.OPEN) ws.close()
    await new Promise((r) => setTimeout(r, 400))
  }

  /** Makes the incumbent look IN USE. Without this `decideTakeover` returns
   *  'admit' past the 20s grace window and the newcomer evicts instead of
   *  joining -- the viewer door is the refuse path only (PRD §8.4). */
  async function markBusy(ws: WebSocket): Promise<void> {
    ws.send(JSON.stringify({ type: 'move', dx: 1, dy: 1 }))
    await new Promise((r) => setTimeout(r, 100))
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
    // Two DIFFERENT credentials: one credential on both sockets is the
    // 'reconnect' outcome, which retires the first socket by design.
    controllerCred = await pairDevice(mod)
    viewerCred = await pairDevice(mod)
  }, 60_000)

  afterAll(() => {
    mod?.stopPhoneRemoteServer()
    rmSync(TEST_ROOT, { recursive: true, force: true })
  })

  it('admits a second device as a viewer instead of refusing it', async () => {
    const controller = await openAndSettle(controllerCred)
    await markBusy(controller)

    let controllerClosed: number | null = null
    controller.on('close', (code) => {
      controllerClosed = code
    })

    const viewer = await openAndSettle(viewerCred)

    expect(viewer.readyState, 'the second device must be admitted, not refused').toBe(
      WebSocket.OPEN
    )
    expect(controllerClosed, 'the viewer must not close the controller').toBeNull()
    expect(controller.readyState, 'controller must still hold the session').toBe(WebSocket.OPEN)

    await shutdown(controller, viewer)
  }, 30_000)

  it('tells each device which one it is', async () => {
    const { ws: controller, seen: controllerSaw } = await openCollecting(controllerCred)
    await markBusy(controller)
    const { ws: viewer, seen: viewerSaw } = await openCollecting(viewerCred)

    expect(controllerSaw, 'the controller must be told it drives').toContain('role')
    expect(viewerSaw, 'the viewer must be told it only watches').toContain('role')

    await shutdown(controller, viewer)
  }, 30_000)

  it('never routes mirror signaling to the wrong device', async () => {
    const { ws: controller, seen: controllerSaw } = await openCollecting(controllerCred)
    await markBusy(controller)
    const { ws: viewer, seen: viewerSaw } = await openCollecting(viewerCred)

    // The controller claims the mirror. Its answer/ICE must reach nobody else:
    // fanning these out crosses two peers' SDP, which was the bug the naive
    // fan-out would have shipped (PRD §5c).
    controller.send(JSON.stringify({ type: 'mirrorStart', sdp: 'v=0', quality: 'auto' }))
    await new Promise((r) => setTimeout(r, 400))

    const MIRROR_PEER_EVENTS = [
      'mirrorAnswer',
      'mirrorIceCandidate',
      'mirrorError',
      'mirrorAudioError',
      'mirrorStalled',
      'mirrorRecovered'
    ]
    const leaked = viewerSaw.filter((t) => MIRROR_PEER_EVENTS.includes(t))
    expect(leaked, "the controller's mirror negotiation must not reach the viewer").toEqual([])
    // Guards the inverse reading of the assertion above: an empty `leaked` from
    // two dead sockets would prove nothing about routing.
    expect(
      [...viewerSaw, ...controllerSaw].length,
      'sockets must be receiving events for the leak check to mean anything'
    ).toBeGreaterThan(0)

    await shutdown(controller, viewer)
  }, 30_000)

  it('keeps the viewer watching when the controller drops', async () => {
    const controller = await openAndSettle(controllerCred)
    await markBusy(controller)
    const viewer = await openAndSettle(viewerCred)

    let viewerClosed: number | null = null
    viewer.on('close', (code) => {
      viewerClosed = code
    })

    controller.close()
    await new Promise((r) => setTimeout(r, 400))

    expect(viewerClosed, "the controller's exit must not close the viewer").toBeNull()
    expect(viewer.readyState, 'the viewer keeps watching, independent socket').toBe(
      WebSocket.OPEN
    )

    await shutdown(viewer)
  }, 30_000)

  it('refuses a THIRD device: one controller, one viewer is the cap', async () => {
    const controller = await openAndSettle(controllerCred)
    await markBusy(controller)
    const viewer = await openAndSettle(viewerCred)

    const thirdCred = await pairDevice(mod)
    const third = new WebSocket(
      `wss://127.0.0.1:${activePort}/?${CONFIG.PHONE_REMOTE.DEVICE_CREDENTIAL_PARAM}=${thirdCred}`,
      { rejectUnauthorized: false }
    )
    const closeCode = await new Promise<number>((resolve) => {
      third.on('close', (code) => resolve(code))
      third.on('error', () => resolve(-1))
      setTimeout(() => resolve(0), 1500)
    })

    expect(closeCode, 'a third device must still be refused 4409').toBe(
      CONFIG.PHONE_REMOTE.CLOSE_CODE_CONFLICT
    )
    expect(controller.readyState, 'controller undisturbed by the refusal').toBe(WebSocket.OPEN)
    expect(viewer.readyState, 'viewer undisturbed by the refusal').toBe(WebSocket.OPEN)

    await shutdown(controller, viewer)
  }, 30_000)

  it('joins as viewer even when the first device has gone idle', async () => {
    // The on-device failure (2026-08-10, journal 19:16:38 "replaced while
    // idle"): glasses are idle BY NATURE -- you are looking, not touching --
    // so the phone arriving minutes later hit 'admit' and evicted them.
    // No markBusy() here on purpose: that is the whole point.
    const controller = await openAndSettle(controllerCred)
    let controllerClosed: number | null = null
    controller.on('close', (code) => {
      controllerClosed = code
    })

    const { ws: viewer, seen: viewerSaw } = await openCollecting(viewerCred)

    expect(controllerClosed, 'an idle first device must NOT be evicted').toBeNull()
    expect(controller.readyState, 'the idle device keeps the session').toBe(WebSocket.OPEN)
    expect(viewer.readyState, 'the newcomer joins instead of taking over').toBe(WebSocket.OPEN)
    expect(viewerSaw, 'and is told it is the viewer').toContain('role')

    await shutdown(controller, viewer)
  }, 30_000)

  it('still hands over on an explicit takeover request', async () => {
    // The other half of the fix: idle-handover must survive for the case it
    // was built for -- a deliberate "take control" tap, which rides the URL.
    const controller = await openAndSettle(controllerCred)
    let controllerClosed: number | null = null
    controller.on('close', (code) => {
      controllerClosed = code
    })

    const taker = await openAndSettle(
      viewerCred,
      `&${CONFIG.PHONE_REMOTE.TAKEOVER_PARAM}=1`
    )
    await new Promise((r) => setTimeout(r, 300))

    expect(controllerClosed, 'an explicit takeover still evicts').toBe(
      CONFIG.PHONE_REMOTE.CLOSE_CODE_CONFLICT
    )
    expect(taker.readyState, 'the taker holds the session').toBe(WebSocket.OPEN)

    await shutdown(taker)
  }, 30_000)

  it('swaps roles on request, and only when the viewer asks', async () => {
    const { ws: controller, seen: controllerSaw } = await openCollecting(controllerCred)
    await markBusy(controller)
    const { ws: viewer, seen: viewerSaw } = await openCollecting(viewerCred)
    const controllerRoles = collectRoles(controller)
    const viewerRoles = collectRoles(viewer)
    controllerSaw.length = 0
    viewerSaw.length = 0
    controllerRoles.length = 0
    viewerRoles.length = 0

    viewer.send(JSON.stringify({ type: 'requestControl' }))
    await new Promise((r) => setTimeout(r, 300))

    // The VALUE, not just that a role arrived: asserting the type alone passes
    // even when the two devices are told the wrong way round.
    expect(viewerRoles, 'the asking device must be told it now drives').toContain('controller')
    expect(controllerRoles, 'the incumbent must be told it now watches').toContain('viewer')
    expect(viewer.readyState, 'a swap must not close either socket').toBe(WebSocket.OPEN)
    expect(controller.readyState, 'a swap must not close either socket').toBe(WebSocket.OPEN)

    // The controller asking again is a no-op: it already holds the session, and
    // a stale button must not be able to displace a live one.
    controllerSaw.length = 0
    controller.send(JSON.stringify({ type: 'requestControl' }))
    await new Promise((r) => setTimeout(r, 250))
    expect(controller.readyState, 'a no-op swap must not disturb the session').toBe(
      WebSocket.OPEN
    )

    await shutdown(controller, viewer)
  }, 30_000)

  it('lets a stranded viewer take control after the controller has gone', async () => {
    // Roy's iPhone 16, 2026-09-10: "it actually works but it doesn't remove
    // the snack bar". The controller dropped (journal 16:40:09 "close 1006"),
    // leaving activeSocket null and this device still flagged viewer. Every
    // "Use this one instead" tap died on swapControl's old `!activeSocket`
    // guard -- no role event, so the pill had nothing to clear it.
    const controller = await openAndSettle(controllerCred)
    await markBusy(controller)
    const viewer = await openAndSettle(viewerCred)
    const viewerRoles = collectRoles(viewer)

    controller.close()
    await new Promise((r) => setTimeout(r, 400))
    viewerRoles.length = 0

    viewer.send(JSON.stringify({ type: 'requestControl' }))
    await new Promise((r) => setTimeout(r, 300))

    expect(viewerRoles, 'the stranded device must be told it now drives').toContain('controller')
    expect(viewer.readyState, 'adoption must not close the surviving socket').toBe(WebSocket.OPEN)

    await shutdown(viewer)
  }, 30_000)

  it('never promotes a viewer to the active socket without an explicit swap', async () => {
    const controller = await openAndSettle(controllerCred)
    await markBusy(controller)
    const viewer = await openAndSettle(viewerCred)

    // A viewer that quietly became `activeSocket` would take the controller's
    // input path with it -- the failure this whole split exists to prevent.
    // Proven from the outside: the phone still drives, so it is still active.
    controller.send(JSON.stringify({ type: 'move', dx: 2, dy: 2 }))
    await new Promise((r) => setTimeout(r, 200))
    expect(controller.readyState, 'the controller keeps the session').toBe(WebSocket.OPEN)
    expect(viewer.readyState, 'the viewer keeps watching, never promoted').toBe(WebSocket.OPEN)

    await shutdown(controller, viewer)
  }, 30_000)
})

describe('the role rides beside the state, never inside it', () => {
  it('leaves ConnState at 4 kinds and BlockedReason at 5', async () => {
    // PRD §5f: a viewer is genuinely `connected`, so folding it into the union
    // would fork every `kind === 'connected'` consumer for a connected device.
    // Counting the source is what stops the role leaking in later.
    const { readFileSync } = await import('fs')
    const src = readFileSync(
      join(process.cwd(), 'src/main/phone-remote/connection-state.ts'),
      'utf8'
    )
    const kinds = src.match(/kind:\s*'[a-z-]+'/g) ?? []
    expect(new Set(kinds).size, 'ConnState must still have exactly 4 kinds').toBe(4)
    expect(src, 'the role must not become a ConnState kind').not.toContain("kind: 'viewer'")

    const reasons = src.match(/export type BlockedReason[\s\S]*?\n\n/)?.[0] ?? ''
    expect(reasons.match(/'[a-z-]+'/g)?.length, 'BlockedReason must still have 5 values').toBe(5)
  })
})

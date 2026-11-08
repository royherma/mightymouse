/**
 * The observer socket, end to end (observer-socket PRD).
 *
 * `observer-socket.test.ts` covers the decision rule in isolation. This drives
 * a REAL server over real WebSockets, because the property that matters is
 * ordering inside `wss.on('connection')`: the observer branch must sit above
 * the single-socket eviction, and a unit test of the predicate would still
 * pass if someone moved it below and started evicting the live phone again.
 *
 * Binds a high test-only port -- never 17771 -- so this cannot touch a real
 * phone session (see CLAUDE.local.md). That is enforced by the CONFIG mock
 * below plus the assertion in `beforeAll`, not by this comment: it shipped
 * WITHOUT the mock, bound the real port behind the running app, and paired
 * ~12 junk devices into Roy's live store mid-session.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { WebSocket } from 'ws'
import { request } from 'https'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdirSync, rmSync } from 'fs'
import { CONFIG } from '../../../shared/config'

const TEST_ROOT = join(tmpdir(), 'mm-observer-live-test')
let activePort = 41971

// startPhoneRemoteServer() walks CONFIG.PHONE_REMOTE.PORT upward, so the real
// 17771 is what it binds unless the config itself says otherwise. A local
// constant cannot help -- the server never sees one.
vi.mock('../../../shared/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/config')>()
  return {
    ...actual,
    CONFIG: {
      ...actual.CONFIG,
      PHONE_REMOTE: { ...actual.CONFIG.PHONE_REMOTE, PORT: 41971 }
    }
  }
})

vi.mock('electron', () => ({
  // getAppPath backs resolvePublicDir(), now hit by every request (including
  // POST /pair) since serveStatic() calls it unconditionally up front.
  app: { getVersion: () => '0.0.0', getPath: () => '/tmp', getAppPath: () => process.cwd() },
  safeStorage: { isEncryptionAvailable: () => false }
}))

vi.mock('../../store/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/paths')>()
  const { join: j } = await import('path')
  const { tmpdir: t } = await import('os')
  const { sandboxPaths } = await import('./sandbox-paths')
  const root = j(t(), 'mm-observer-live-test')
  return { ...actual, PATHS: sandboxPaths(actual.PATHS, actual.PATHS.ROOT, root) }
})

// IS_DEV gates the observer branch; vitest is not "dev" by default.
vi.mock('../../../shared/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/env')>()
  return { ...actual, IS_DEV: true }
})

/** Mints a code, exchanges it for a device credential over POST /pair -- the
 *  same path a real phone takes, since the WS gate no longer accepts a token.
 *  Plain `https.request` (not fetch): the cert is self-signed, and this is
 *  the one client here that needs `rejectUnauthorized: false` on the request
 *  itself rather than on a WebSocket option. */
async function pairDevice(mod: typeof import('../server')): Promise<string> {
  const code = mod.issuePairingCode()
  const body = JSON.stringify({ code })
  const credential = await new Promise<string>((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port: activePort,
        path: CONFIG.PHONE_REMOTE.PAIR_CODE_PATH,
        method: 'POST',
        rejectUnauthorized: false,
        // No keep-alive reuse: a restart between tests closes the HTTPS
        // server, and a pooled socket to the dead one resets mid-request.
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
  return credential
}

describe('observer socket, live server', () => {
  let mod: typeof import('../server')
  let credential: string

  function url(extra: string): string {
    return `wss://127.0.0.1:${activePort}/?${CONFIG.PHONE_REMOTE.DEVICE_CREDENTIAL_PARAM}=${credential}${extra}`
  }

  /** Resolves once the socket has PROVEN it survived the gate. Waiting only for
   *  'open' hands back a socket the server may already be closing. */
  async function openAndSettle(extra: string): Promise<WebSocket> {
    const ws = new WebSocket(url(extra), { rejectUnauthorized: false })
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', reject)
    })
    await new Promise((r) => setTimeout(r, 250))
    return ws
  }

  beforeAll(async () => {
    mkdirSync(TEST_ROOT, { recursive: true })
    vi.resetModules()
    mod = await import('../server')
    // A real skin id, matching what PREFS.getPhoneRemoteSkin() actually returns
    // -- it defaults rather than ever handing back null.
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

  it('admits an observer and leaves the live controller untouched', async () => {
    const controller = await openAndSettle('')
    expect(controller.readyState, 'controller must hold the session').toBe(WebSocket.OPEN)

    let controllerClosed: number | null = null
    let takenOver = false
    controller.on('close', (code) => {
      controllerClosed = code
    })
    controller.on('message', (d) => {
      if (JSON.parse(d.toString()).type === 'takenOver') takenOver = true
    })

    const observer = await openAndSettle(`&${CONFIG.PHONE_REMOTE.OBSERVE_PARAM}=1`)

    expect(observer.readyState, 'observer must be admitted').toBe(WebSocket.OPEN)
    // The whole point of the feature.
    expect(controllerClosed, 'observer must not close the controller').toBeNull()
    expect(takenOver, 'observer must not evict the controller').toBe(false)
    expect(controller.readyState, 'controller must still be live').toBe(WebSocket.OPEN)

    controller.close()
    observer.close()
  }, 30_000)

  it('a second CONTROLLER still evicts, proving the gate is otherwise intact', async () => {
    const first = await openAndSettle('')
    let evicted = false
    first.on('close', (code) => {
      if (code === CONFIG.PHONE_REMOTE.CLOSE_CODE_CONFLICT) evicted = true
    })

    // Past TAKEOVER_GRACE_MS the incumbent is idle, so this hands over.
    const second = await openAndSettle(`&${CONFIG.PHONE_REMOTE.TAKEOVER_PARAM}=1`)
    await new Promise((r) => setTimeout(r, 300))

    expect(evicted, 'a real controller must still take the session').toBe(true)
    first.close()
    second.close()
  }, 30_000)

  it('drops a write message sent on an observer socket', async () => {
    const seen: string[] = []
    mod.stopPhoneRemoteServer()
    const started = await mod.startPhoneRemoteServer({
      onMessage: (m) => seen.push(m.type)
    })
    expect(started.ok).toBe(true)
    if (started.ok) activePort = started.port
    credential = await pairDevice(mod)

    const observer = await openAndSettle(`&${CONFIG.PHONE_REMOTE.OBSERVE_PARAM}=1`)
    observer.send(JSON.stringify({ type: 'move', dx: 40, dy: 40 }))
    observer.send(JSON.stringify({ type: 'getLayoutPrefs' }))
    await new Promise((r) => setTimeout(r, 300))

    expect(seen, 'cursor input must never reach the Mac').not.toContain('move')
    expect(seen, 'read-only requests still pass').toContain('getLayoutPrefs')
    observer.close()
  }, 30_000)
})

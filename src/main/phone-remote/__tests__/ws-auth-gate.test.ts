/**
 * The WS authentication gate (security-hardening PRD, Fix A + Fix B).
 *
 * This is the one boundary standing between "a device on the network" and
 * full keystroke injection, clipboard writes, screen mirror, and agentic Act
 * runs on the Mac. It was previously verified by code read only -- the shipped
 * PRD flagged exactly this: "nothing asserts *unauthenticated WS upgrade is
 * rejected* or *the legit session survives a concurrent unauthenticated
 * connect*", which are its two ship-gate clauses.
 *
 * These drive a REAL server over a real WebSocket rather than testing an
 * extracted copy of the predicate, because the property that matters is
 * ordering inside `wss.on('connection')`: the auth check (server.ts:1240)
 * must sit ABOVE the single-socket eviction (server.ts:1256). A unit test of
 * the credential check alone would still pass if someone moved the eviction
 * above it and reopened the original hijack.
 *
 * The server binds a high test-only port -- never 17771 -- so this can never
 * touch a real phone session (see CLAUDE.local.md).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { WebSocket } from 'ws'
import { request } from 'https'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { CONFIG as REAL_CONFIG } from '../../../shared/config'
import type { BlockedReason } from '../connection-state'

const TEST_ROOT = join(tmpdir(), 'mm-ws-auth-test')
/** Deliberately far from CONFIG.PHONE_REMOTE.PORT (17771) so a developer
 *  running MightyMouse while the suite runs never has their phone evicted. */
const TEST_PORT = 41771

/** The port the server ACTUALLY bound, which is not always TEST_PORT.
 *
 *  `httpServer.close()` stops accepting new connections but does not release
 *  the port synchronously, so a restart inside one test file commonly finds
 *  41771 still held and walks to 41772 via PORT_RANGE_SIZE. Connecting to a
 *  hardcoded TEST_PORT then reaches the DRAINING old server -- whose token was
 *  already cleared to null -- and every assertion inverts: the first draft of
 *  this file read that as "the gate accepts an invalid token", which would
 *  have been a false alarm about a working security boundary. Always dial the
 *  reported port. */
let activePort = TEST_PORT

vi.mock('electron', () => ({
  // getAppPath backs resolvePublicDir(), hit by every request (including
  // POST /pair) since serveStatic() calls it unconditionally up front.
  app: { getVersion: () => '0.0.0', getPath: () => '/tmp', getAppPath: () => process.cwd() },
  safeStorage: { isEncryptionAvailable: () => false }
}))

vi.mock('../../store/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/paths')>()
  const { join: j } = await import('path')
  const { tmpdir: t } = await import('os')
  const { sandboxPaths } = await import('./sandbox-paths')
  const root = j(t(), 'mm-ws-auth-test')
  return { ...actual, PATHS: sandboxPaths(actual.PATHS, actual.PATHS.ROOT, root) }
})

// Bind the test port instead of the real one. PORT_RANGE_SIZE stays >1 so a
// busy test port still finds a neighbour rather than failing the suite.
vi.mock('../../../shared/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/config')>()
  return {
    ...actual,
    CONFIG: {
      ...actual.CONFIG,
      PHONE_REMOTE: { ...actual.CONFIG.PHONE_REMOTE, PORT: 41771 }
    }
  }
})

/** Open a WS to the test server and resolve how it ended: 'open' when the
 *  server accepted it, or the close code it was rejected with. The cert is
 *  self-signed by design (it satisfies getUserMedia's secure-context rule and
 *  is documented as NOT a security boundary), so verification is off here for
 *  the same reason cloudflared uses noTLSVerify against this origin.
 *
 *  Two traps this signature exists to avoid, both hit while writing it:
 *
 *  1. **`'open'` does not mean "accepted".** The gate runs in the server's
 *     `connection` handler, which fires AFTER the WS handshake completes, so
 *     a rejected socket still opens client-side and is closed a beat later.
 *     Resolving on the `open` event read every rejection as an acceptance --
 *     i.e. it reported a working security boundary as broken. Acceptance is
 *     only provable by the socket STAYING open, so this waits for a close and
 *     treats survival past `settleMs` as 'open'.
 *  2. **Never call `ws.close()` on a socket under test.** Closing from this
 *     side reports 1005 ("no status received") and masks the server's real
 *     code. Callers close sockets they deliberately keep. */
function connect(query: string, port = activePort, settleMs = 250): Promise<'open' | number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`wss://127.0.0.1:${port}/${query}`, {
      rejectUnauthorized: false
    })
    const timer = setTimeout(() => {
      // Still connected well after the handler would have run -> authorized.
      ws.removeAllListeners('close')
      ws.close()
      resolve('open')
    }, settleMs)
    ws.on('close', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
    // A transport-level failure is not a pass: the gate must CLOSE the socket
    // with a code, not error out ambiguously.
    ws.on('error', () => {
      clearTimeout(timer)
      resolve(-1)
    })
  })
}

/** Same as connect(), but also captures the close REASON string -- the wire
 *  form of BlockedReason. Assertions on the reason must not accept a socket
 *  that's still open, so this rejects rather than resolving 'open'. */
function connectExpectingClose(
  query: string,
  port = activePort,
  settleMs = 250
): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://127.0.0.1:${port}/${query}`, {
      rejectUnauthorized: false
    })
    const timer = setTimeout(() => {
      ws.removeAllListeners('close')
      ws.close()
      reject(new Error('expected the gate to close this socket, it stayed open'))
    }, settleMs)
    ws.on('close', (code, reasonBuf) => {
      clearTimeout(timer)
      resolve({ code, reason: reasonBuf.toString('utf8') })
    })
    ws.on('error', reject)
  })
}

describe('phone-remote WS auth gate', () => {
  let mod: typeof import('../server')
  let credential: string

  /** Mints a code, exchanges it for a device credential over POST /pair --
   *  the same path a real phone takes, since the WS gate no longer accepts a
   *  token. No keep-alive reuse: a restart between tests closes the HTTPS
   *  server, and a pooled socket to the dead one resets mid-request. */
  async function pairDevice(): Promise<string> {
    const code = mod.issuePairingCode()
    const body = JSON.stringify({ code })
    return new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port: activePort,
          path: REAL_CONFIG.PHONE_REMOTE.PAIR_CODE_PATH,
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

  /** Clear the per-IP rate-limit budget between cases.
   *
   *  Every test here connects from 127.0.0.1, so they share one bucket: five
   *  rejected attempts and the SIXTH is refused with 4429 before the auth
   *  check ever runs. That is the limiter working (Fix C) -- but it silently
   *  converts later assertions from "the gate rejected this" into "the limiter
   *  did", which is a strictly weaker claim and exactly the masked-signal
   *  trap. Restarting resets the in-memory buckets. Paired-device credentials
   *  persist across a restart (they're file-backed, not session state), so
   *  each case still pairs a fresh device to keep its own credential. */
  async function resetGateState(): Promise<string> {
    mod.stopPhoneRemoteServer()
    const started = await mod.startPhoneRemoteServer({})
    expect(started.ok, 'test server must restart between cases').toBe(true)
    if (started.ok) activePort = started.port
    return pairDevice()
  }

  /** An authenticated socket that has PROVEN it survived the gate.
   *
   *  Waiting only for 'open' would hand back a socket the server is already
   *  closing (see connect()'s note), making the eviction test assert against a
   *  corpse. This settles first, then verifies it is still OPEN. */
  async function openLegit(): Promise<WebSocket> {
    const ws = new WebSocket(
      `wss://127.0.0.1:${activePort}/?${REAL_CONFIG.PHONE_REMOTE.DEVICE_CREDENTIAL_PARAM}=${credential}`,
      { rejectUnauthorized: false }
    )
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', reject)
    })
    await new Promise((r) => setTimeout(r, 250))
    expect(ws.readyState, 'authorized socket must survive the gate').toBe(WebSocket.OPEN)
    return ws
  }

  beforeAll(async () => {
    mkdirSync(TEST_ROOT, { recursive: true })
    vi.resetModules()
    mod = await import('../server')
    const started = await mod.startPhoneRemoteServer({})
    // A machine with no LAN address can't run this feature at all; fail loudly
    // rather than silently passing a security test that never ran.
    expect(started.ok, 'test server must start to prove anything').toBe(true)
    if (started.ok) activePort = started.port
    credential = await pairDevice()
    // 60s, not 20s: starting the server generates a self-signed cert on a cold
    // temp root, which is a 2048-bit RSA keygen -- seconds of solid CPU. Under
    // full-suite parallelism it competes with every other worker for a core, so
    // a budget sized for an idle machine times out on a loaded one. The failure
    // is badly disguised: the hook dies, later cases connect to a half-built or
    // draining server, and the assertion that surfaces is `expected 'open' to be
    // 4401` -- indistinguishable at a glance from the auth gate accepting a
    // stale token. Diagnosing it cost a full round; the tell is that this file
    // passes 11/11 in isolation. Fix the budget rather than the assertion.
  }, 60_000)

  it('revokes a paired device on restart-with-forget, invalidating its credential', async () => {
    // Toggle-off/toggle-on ("forget paired devices") must not leave a stale
    // credential usable -- the token equivalent of the old "fresh token" test.
    const stale = credential
    mod.forgetPairedDevices()
    const fresh = await resetGateState()
    expect(fresh).not.toBe(stale)
    await expect(
      connect(`?${REAL_CONFIG.PHONE_REMOTE.DEVICE_CREDENTIAL_PARAM}=${stale}`)
    ).resolves.toBe(4401)
  })

  // Fresh credential AND a fresh rate-limit budget per case, so every
  // assertion below is about the auth gate rather than about the limiter
  // that fires once a shared 127.0.0.1 bucket runs dry.
  beforeEach(async () => {
    credential = await resetGateState()
  })

  it('an unreadable device file refuses without telling the phone it was revoked', async () => {
    // `credential-revoked` is the reason that makes the phone DELETE its
    // credential (useConnection.ts:370) -- an unreadable file must never
    // produce it, or one transient fault unpairs every device.
    const stale = credential
    mod.stopPhoneRemoteServer()
    writeFileSync(join(TEST_ROOT, 'phone-remote-devices.json'), 'not-json-at-all')
    // Fresh module, not just a restart: the credential map is a module-level
    // cache nothing invalidates, so a restarted server never re-reads the file.
    vi.resetModules()
    const fresh = await import('../server')
    const started = await fresh.startPhoneRemoteServer({})
    expect(started.ok, 'server must restart to serve the corrupt file').toBe(true)
    if (started.ok) activePort = started.port

    const { code, reason } = await connectExpectingClose(
      `?${REAL_CONFIG.PHONE_REMOTE.DEVICE_CREDENTIAL_PARAM}=${stale}`
    )

    fresh.stopPhoneRemoteServer()

    expect(code, 'the gate must still refuse a credential it cannot verify').toBe(4401)
    // The whole point: refuse, but never with the reason that wipes the phone.
    expect(reason, 'an unreadable store must not read as a deliberate revoke').not.toBe(
      'credential-revoked' satisfies BlockedReason
    )
    expect(reason, 'the honest answer is that the Mac cannot tell right now').toBe(
      'mac-unreachable' satisfies BlockedReason
    )
  })

  afterAll(() => {
    mod?.stopPhoneRemoteServer()
    rmSync(TEST_ROOT, { recursive: true, force: true })
  })

  // ── Positive control ──────────────────────────────────────────────────────
  // Without this, every rejection below could be "the server refuses all
  // connections" -- which would pass the negatives while the feature is
  // wholly broken. This is the same control that made the two-user IDOR
  // results meaningful.
  it('accepts a connection carrying a paired device credential', async () => {
    await expect(
      connect(`?${REAL_CONFIG.PHONE_REMOTE.DEVICE_CREDENTIAL_PARAM}=${credential}`)
    ).resolves.toBe('open')
  })

  // ── The ship-gate clause: unauthenticated upgrade is rejected ─────────────
  it.each([
    ['no credential at all', ''],
    ['an empty device credential', `?${REAL_CONFIG.PHONE_REMOTE.DEVICE_CREDENTIAL_PARAM}=`],
    ['a wrong device credential', `?${REAL_CONFIG.PHONE_REMOTE.DEVICE_CREDENTIAL_PARAM}=not-a-real-credential`],
    // The pairing token param is gone as a WS authorizer -- a value there
    // must be treated as absent, not smuggled through as a credential.
    ['a token-shaped value under the deleted ?t= param', '?t=AAAAAAAAAAAAAAAAAAAAAAAA']
  ])('rejects a connection with %s', async (_label, query) => {
    await expect(connect(query)).resolves.toBe(4401)
  })

  // ── §1.3 item 3: every close states WHY, as the one BlockedReason vocabulary ──
  it('states no-credential when nothing is presented', async () => {
    const { code, reason } = await connectExpectingClose('')
    expect(code).toBe(4401)
    expect(reason satisfies string).toBe('no-credential' satisfies BlockedReason)
  })

  it('states credential-revoked for an unrecognised device credential', async () => {
    // Covers both a guessed value and the §6 migration case: an old-format
    // credential the server no longer recognises must read the same as a
    // revoked one -- the pair screen, not a blank screen or a retry loop.
    const { code, reason } = await connectExpectingClose(
      `?${REAL_CONFIG.PHONE_REMOTE.DEVICE_CREDENTIAL_PARAM}=not-a-real-credential`
    )
    expect(code).toBe(4401)
    expect(reason).toBe('credential-revoked' satisfies BlockedReason)
  })

  it('states rate-limited once the per-IP budget is spent', async () => {
    // The pairing code is 6 digits, so the limiter is what makes online
    // guessing infeasible -- constant-time comparison alone would not.
    for (let i = 0; i < 5; i++) {
      await connect(`?${REAL_CONFIG.PHONE_REMOTE.DEVICE_CREDENTIAL_PARAM}=wrong`)
    }
    const { code, reason } = await connectExpectingClose(
      `?${REAL_CONFIG.PHONE_REMOTE.DEVICE_CREDENTIAL_PARAM}=wrong`
    )
    expect(code).toBe(4429)
    expect(reason).toBe('rate-limited' satisfies BlockedReason)
  })

  it('a stranger spending the shared budget does not lock out a paired phone', async () => {
    for (let i = 0; i < 6; i++) {
      await connect(`?${REAL_CONFIG.PHONE_REMOTE.DEVICE_CREDENTIAL_PARAM}=wrong`)
    }
    const legit = await openLegit()
    legit.close()
  })

  // ── Fix B: the eviction must sit BELOW the auth check ─────────────────────
  it('does not let an unauthenticated connect evict the authenticated session', async () => {
    // The original vulnerability in one test: whoever connected last won, so
    // an attacker joining mid-session silently inherited the phone's control.
    const legit = await openLegit()

    let legitClosed = false
    legit.on('close', () => {
      legitClosed = true
    })

    // An attacker with no credential hammers the socket. A bad credential is
    // still closed outright; a MISSING one now parks awaiting the phone's
    // verdict, so it stays 'open' -- either way it must not touch the session,
    // which is what this test is named for.
    mod.closeApprovalWindow()
    await expect(
      connect(`?${REAL_CONFIG.PHONE_REMOTE.DEVICE_CREDENTIAL_PARAM}=wrong`)
    ).resolves.toBe(4401)
    await expect(connect('')).resolves.toBe(4401)

    // Give any eviction a chance to land before asserting it didn't.
    await new Promise((r) => setTimeout(r, 150))
    expect(legitClosed, 'legit session was evicted by an unauthenticated connect').toBe(false)
    expect(legit.readyState).toBe(WebSocket.OPEN)
    legit.close()
  })

  // ── Revocation is immediate, not next-reconnect ───────────────────────────
  it('forgetPairedDevices drops the live session with credential-revoked', async () => {
    const live = await openLegit()
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      live.on('close', (code, reasonBuf) => resolve({ code, reason: reasonBuf.toString('utf8') }))
    )

    mod.forgetPairedDevices()

    // "Forget" that left the current phone connected would look like it did
    // nothing until the next reconnect. PR #27's regression: a phone with a
    // valid credential must never be told anything OTHER than this reason.
    const { code, reason } = await closed
    expect(code).toBe(4401)
    expect(reason).toBe('credential-revoked' satisfies BlockedReason)
  })

  // ── An approval prompt must be SOLICITED, never raised by a stranger ──────
  it('does not raise an approval prompt outside the add-a-device window', async () => {
    // The one-tap "let your glasses watch" path parks an uncredentialed socket
    // and asks the paired phone to vouch for it. Ungated, that hands anyone who
    // has the tunnel URL a button that buzzes the user's phone on demand -- and
    // the per-IP limiter does not cover it, because the FIRST attempt is
    // already on screen before any budget is spent.
    //
    // So the window is opened only by the user asking to add a device (which is
    // what showing a pairing code means). Outside it, a credential-less arrival
    // must be closed exactly as it was before this feature existed.
    const legit = await openLegit()
    const prompts: string[] = []
    legit.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.type === 'approvalRequest') prompts.push(msg.id)
    })

    // pairDevice() in the shared setup reads a code, which opens the window --
    // close it by hand so this asserts the unsolicited case it is named for.
    mod.closeApprovalWindow()

    expect(await connect('')).toBe(4401)
    await new Promise((r) => setTimeout(r, 150))
    expect(prompts, 'an unsolicited arrival must never reach the phone').toEqual([])

    legit.close()
  })

  // ── ...but a phone in the user's hand IS the solicitation ────────────────
  it('raises the prompt when the controller was active, with no pairing code shown', async () => {
    // The point of one-tap approval: connect the glasses, answer on the phone
    // already in your hand. Requiring a pairing code on the Mac first put the
    // Mac back in a loop the feature exists to remove -- observed on-device as
    // the glasses still asking to "connect to your Mac" (journal 11:25:26,
    // 'rejected / no-credential'), because nothing had opened the window.
    const legit = await openLegit()
    const prompts: { label: string }[] = []
    legit.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.type === 'approvalRequest') prompts.push(msg)
    })

    // Deliberately NOT calling openApprovalWindow(): a controller that just
    // connected is recent input, which is the whole claim under test.
    // `cl=1` marks a cursorless host -- the glasses.
    const ws = new WebSocket(
      `wss://127.0.0.1:${activePort}/?${REAL_CONFIG.PHONE_REMOTE.CURSORLESS_PARAM}=1`,
      { rejectUnauthorized: false }
    )
    const pending: number[] = []
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.type === 'approvalPending') pending.push(msg.expiresAt)
    })
    await new Promise((r) => setTimeout(r, 250))

    expect(prompts, 'an active phone must be asked to vouch').toHaveLength(1)
    // The Display sends an Android UA with no 'mobile' token, so the UA sniff
    // called it an "Android tablet" -- naming a device that is not the one the
    // user is wearing (Roy, on-device). A declared cursorless host outranks it.
    expect(prompts[0].label, 'the glasses must not be labelled by UA sniffing').toBe('your glasses')
    // ...and the WAITING device must know it is waiting, or it falls through to
    // the pairing-code form and looks refused while being approved.
    expect(pending, 'the parked device must be told it is awaiting approval').toHaveLength(1)

    ws.close()
    legit.close()
  })

  it('does not let a tunnel stranger ride the active-phone window, even claiming to be glasses', async () => {
    const legit = await openLegit()
    const prompts: string[] = []
    legit.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.type === 'approvalRequest') prompts.push(msg.label)
    })
    mod.closeApprovalWindow()
    legit.send(JSON.stringify({ type: 'move', dx: 1, dy: 1 }))
    await new Promise((r) => setTimeout(r, 50))

    const code = await new Promise<number | 'parked'>((resolve) => {
      const ws = new WebSocket(
        `wss://127.0.0.1:${activePort}/?${REAL_CONFIG.PHONE_REMOTE.CURSORLESS_PARAM}=1`,
        { rejectUnauthorized: false, headers: { Host: 'mm-abc123def456.tunnel.example' } }
      )
      const timer = setTimeout(() => {
        ws.removeAllListeners('close')
        ws.close()
        resolve('parked')
      }, 250)
      ws.on('close', (c) => (clearTimeout(timer), resolve(c)))
      ws.on('error', () => (clearTimeout(timer), resolve(-1)))
    })
    expect(code).toBe(4401)
    expect(prompts, 'a tunnel arrival needs the Mac to be showing a pairing code').toEqual([])

    mod.currentPairingCode()
    const parked = new WebSocket(
      `wss://127.0.0.1:${activePort}/?${REAL_CONFIG.PHONE_REMOTE.CURSORLESS_PARAM}=1`,
      { rejectUnauthorized: false, headers: { Host: 'mm-abc123def456.tunnel.example' } }
    )
    await new Promise((r) => setTimeout(r, 250))
    expect(prompts, 'an explicit add-a-device window still admits a tunnel arrival').toHaveLength(1)

    parked.close()
    legit.close()
  })

  async function parkForApproval(legit: WebSocket): Promise<{ id: string; parked: WebSocket; events: Array<Record<string, unknown>>; closed: Promise<{ code: number; reason: string }> }> {
    const ids: string[] = []
    legit.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.type === 'approvalRequest') ids.push(msg.id)
    })
    mod.currentPairingCode()
    const parked = new WebSocket(`wss://127.0.0.1:${activePort}/`, { rejectUnauthorized: false })
    const events: Array<Record<string, unknown>> = []
    parked.on('message', (data) => events.push(JSON.parse(data.toString())))
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      parked.on('close', (code, reason) => resolve({ code, reason: reason.toString() }))
    )
    await new Promise((r) => setTimeout(r, 250))
    expect(ids, 'the paired phone must be asked').toHaveLength(1)
    return { id: ids[0], parked, events, closed }
  }

  it('a verdict for any id but the live request admits nobody, and a denial closes the parked device', async () => {
    const legit = await openLegit()
    const { id, parked, events, closed } = await parkForApproval(legit)

    mod.resolveApproval(`${id}-stale`, true)
    await new Promise((r) => setTimeout(r, 50))
    expect(events.some((e) => e.type === 'approved')).toBe(false)
    expect(parked.readyState).toBe(WebSocket.OPEN)

    mod.resolveApproval(id, false)
    expect(await closed).toEqual({ code: 4401, reason: 'no-credential' satisfies BlockedReason })
    expect(events.some((e) => e.type === 'approved')).toBe(false)
    legit.close()
  })

  it('an allowed device receives a credential the gate then accepts', async () => {
    const legit = await openLegit()
    const { id, parked, events } = await parkForApproval(legit)
    mod.resolveApproval(id, true)
    await new Promise((r) => setTimeout(r, 50))
    const approved = events.find((e) => e.type === 'approved') as { credential: string } | undefined
    expect(approved?.credential).toMatch(/^[A-Za-z0-9_-]{43}$/)
    parked.close()
    legit.close()
    expect(await connect(`?${REAL_CONFIG.PHONE_REMOTE.DEVICE_CREDENTIAL_PARAM}=${approved!.credential}`)).toBe('open')
  })

  // ── Fix C: brute-force costs a cooldown, not just an instant retry ────────
  it('rate-limits an IP that keeps failing the gate', async () => {
    // The first attempts are rejected by the gate (4401); once the per-IP
    // budget is spent the connection is refused earlier, with 4429.
    const codes: number[] = []
    for (let i = 0; i < 8; i++) {
      codes.push((await connect(`?${REAL_CONFIG.PHONE_REMOTE.DEVICE_CREDENTIAL_PARAM}=wrong`)) as number)
    }

    expect(codes[0], 'first failure must reach the auth gate').toBe(4401)
    expect(codes.at(-1), 'a sustained guesser must end up rate-limited').toBe(4429)
  })
})

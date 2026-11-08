// Widget offline-queue wire contract, driven against a REAL server: one clip
// at a time, meta then blob, never interleaved (server.ts:1240 resets pending
// meta before onAudio runs). Test-only high port, never 17771.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { WebSocket } from 'ws'
import { request } from 'https'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdirSync, rmSync } from 'fs'
import { CONFIG } from '../../../shared/config'
import { PHONE_AUDIO_TO } from '../../../shared/types'

const TEST_ROOT = join(tmpdir(), 'mm-queued-clip-flush-test')
let activePort = 41881

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => '/tmp', getAppPath: () => process.cwd() },
  safeStorage: { isEncryptionAvailable: () => false }
}))

vi.mock('../../store/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/paths')>()
  const { join: j } = await import('path')
  const { tmpdir: t } = await import('os')
  const { sandboxPaths } = await import('./sandbox-paths')
  const root = j(t(), 'mm-queued-clip-flush-test')
  return { ...actual, PATHS: sandboxPaths(actual.PATHS, actual.PATHS.ROOT, root) }
})

vi.mock('../../../shared/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/env')>()
  return { ...actual, IS_DEV: true }
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

describe('queued-clip flush, live server', () => {
  let mod: typeof import('../server')
  let credential: string
  let received: Array<{ buf: Buffer; durationMs: number; to: string; clipId: string }>

  function url(): string {
    return `wss://127.0.0.1:${activePort}/?${CONFIG.PHONE_REMOTE.DEVICE_CREDENTIAL_PARAM}=${credential}`
  }

  async function openAndSettle(): Promise<WebSocket> {
    const ws = new WebSocket(url(), { rejectUnauthorized: false })
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', reject)
    })
    await new Promise((r) => setTimeout(r, 250))
    return ws
  }

  /** Mirrors exactly what `RecordingModel.sendAndAwaitDelivery` (Swift) and
   *  `sendQueuedClip` (App.tsx) put on the wire: meta frame, then one binary
   *  frame, for one clip at a time. */
  function sendClip(ws: WebSocket, clipId: string, to: string, audio: Buffer): void {
    ws.send(JSON.stringify({ type: 'audioMeta', durationMs: 1200, to, id: clipId }))
    ws.send(audio)
  }

  beforeAll(async () => {
    mkdirSync(TEST_ROOT, { recursive: true })
    vi.resetModules()
    mod = await import('../server')
    received = []
    const started = await mod.startPhoneRemoteServer({
      getLayoutPrefs: () => ({ layout: 'pro', skin: 'pro' }) as never,
      onAudio: (buf, durationMs, to, clipId) => {
        received.push({ buf, durationMs, to, clipId })
      }
    })
    expect(started.ok, 'test server must start to prove anything').toBe(true)
    if (started.ok) activePort = started.port
    credential = await pairDevice(mod)
  }, 60_000)

  afterAll(() => {
    mod?.stopPhoneRemoteServer()
    rmSync(TEST_ROOT, { recursive: true, force: true })
  })

  it('flushes two queued clips one at a time without their meta interleaving', async () => {
    const ws = await openAndSettle()
    received.length = 0

    const clipA = Buffer.from('clip-a-audio-bytes')
    const clipB = Buffer.from('clip-b-audio-bytes')
    sendClip(ws, 'clip-a', PHONE_AUDIO_TO.paste, clipA)
    await new Promise((r) => setTimeout(r, 150))
    sendClip(ws, 'clip-b', PHONE_AUDIO_TO.chat, clipB)
    await new Promise((r) => setTimeout(r, 150))

    expect(received).toHaveLength(2)
    expect(received[0]).toMatchObject({ clipId: 'clip-a', to: PHONE_AUDIO_TO.paste })
    expect(received[0].buf.toString()).toBe('clip-a-audio-bytes')
    expect(received[1]).toMatchObject({ clipId: 'clip-b', to: PHONE_AUDIO_TO.chat })
    expect(received[1].buf.toString()).toBe('clip-b-audio-bytes')

    ws.close()
  }, 30_000)

  it('a blob with no preceding meta falls back to PHONE_AUDIO_TO.paste', async () => {
    const ws = await openAndSettle()
    received.length = 0

    ws.send(Buffer.from('orphan-blob'))
    await new Promise((r) => setTimeout(r, 200))

    expect(received).toHaveLength(1)
    expect(received[0].to).toBe(PHONE_AUDIO_TO.paste)
    expect(received[0].clipId).toBe('')

    ws.close()
  }, 30_000)

  it('rejects a clip over MAX_AUDIO_BYTES with a transcribeFailed reply, never onAudio', async () => {
    const ws = await openAndSettle()
    received.length = 0
    const failures: Array<{ id: string; reason: string }> = []
    ws.on('message', (d) => {
      const msg = JSON.parse(d.toString())
      if (msg.type === 'transcribeFailed') failures.push({ id: msg.id, reason: msg.reason })
    })

    const oversize = Buffer.alloc(CONFIG.PHONE_REMOTE.MAX_AUDIO_BYTES + 1)
    sendClip(ws, 'clip-oversize', PHONE_AUDIO_TO.paste, oversize)
    // Poll, don't sleep-and-check-once: a fixed wait was flaky under the full
    // suite's parallel load (50MB local roundtrip can take >300ms there).
    for (let i = 0; i < 100 && failures.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50))
    }

    expect(received, 'oversize clip must never reach onAudio').toHaveLength(0)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ id: 'clip-oversize' })

    ws.close()
  }, 30_000)
})

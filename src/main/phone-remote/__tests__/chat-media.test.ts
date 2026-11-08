/**
 * Does /chat-media actually hand the phone the bytes of the file a turn carries?
 *
 * The UI harness proves layout only -- it swaps in its own file URLs through
 * `window.__chatMediaSrc`, so nothing there touches this route. Everything the
 * phone sees therefore rests on the two things pinned here: that a position on
 * the wire (sessionId + turn + item) resolves to the SAME file `turnMedia`
 * ordered for the sender, and that a path on the query string never resolves to
 * anything at all. The second is the whole security model of this route -- the
 * store decides which file a credential may read -- and a regression in it is
 * invisible on the glass, because a working image looks identical either way.
 *
 * Range matters for its own reason: Safari will not scrub a <video> that cannot
 * answer one, so a 200-only route silently ships un-seekable video.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'http'
import { Writable } from 'stream'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const getSession = vi.fn()

// Spread the REAL module rather than replacing it: relay-http and
// server-runtime import each other, so a bare factory leaves relay-http
// half-initialized and every call dies on a TDZ error for its rate-limit
// bucket rather than on anything this test is about.
vi.mock('../../store/mighty', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/mighty')>()
  return { ...actual, MIGHTY: { ...actual.MIGHTY, getSession } }
})
vi.mock('../device-credentials', () => ({
  isDeviceCredentialValid: (c: unknown) => c === 'good',
  deviceIdFor: () => 'device-1'
}))
vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => '/tmp', getAppPath: () => process.cwd() },
  safeStorage: { isEncryptionAvailable: () => false }
}))

interface Captured {
  status: number
  headers: Record<string, string>
  body: Buffer
}

const { handleChatMedia } = await import('../relay-http')

/** The route pipes a read stream at the response, so a plain object with
 *  writeHead/end is not enough -- it has to be a real writable or the pipe
 *  never completes and every byte assertion reads empty. */
async function call(url: string, headers: Record<string, string> = {}): Promise<Captured> {
  const captured: Captured = { status: 0, headers: {}, body: Buffer.alloc(0) }
  const chunks: Buffer[] = []
  const done = new Promise<void>((resolve) => {
    const res = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(Buffer.from(chunk))
        cb()
      }
    }) as unknown as ServerResponse & { writeHead: unknown }
    ;(res as unknown as { writeHead: unknown }).writeHead = (
      status: number,
      h: Record<string, string>
    ): void => {
      captured.status = status
      captured.headers = h ?? {}
    }
    res.on('finish', () => {
      captured.body = Buffer.concat(chunks)
      resolve()
    })
    const req = {
      method: 'GET',
      url,
      headers,
      socket: { remoteAddress: '127.0.0.1' }
    } as unknown as IncomingMessage
    handleChatMedia(req, res as unknown as ServerResponse)
  })
  await done
  return captured
}

// A real 1x1 PNG: the route stats and streams the file, so a stub string would
// pass the existence gate and then prove nothing about the bytes.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

let dir = ''
let shot = ''
let photo = ''

describe('GET /chat-media', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    dir = mkdtempSync(join(tmpdir(), 'mm-chat-media-'))
    photo = join(dir, 'photo.png')
    shot = join(dir, 'shot.png')
    writeFileSync(photo, PNG)
    writeFileSync(shot, PNG)
    getSession.mockReturnValue({
      id: 's1',
      turns: [{ q: 'a', a: 'b', sources: [photo], artifacts: [shot] }]
    })
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('serves the bytes of the file at that position', async () => {
    const res = await call('/chat-media?sessionId=s1&turn=0&item=0&credential=good')
    expect(res.status).toBe(200)
    expect(res.headers['Content-Type']).toBe('image/png')
    expect(res.body.equals(PNG)).toBe(true)
  })

  it('orders sources before artifacts, so item 1 is what the sender numbered 1', async () => {
    // The phone ships a position and never a name, so this ordering IS the
    // addressing scheme: if the route ordered the two arrays differently from
    // `turnMedia`, every bubble would fetch its neighbour's picture.
    const res = await call('/chat-media?sessionId=s1&turn=0&item=1&credential=good')
    expect(res.status).toBe(200)
    expect(res.body.equals(PNG)).toBe(true)
  })

  it('answers a Range request, without which Safari will not scrub a video', async () => {
    const res = await call('/chat-media?sessionId=s1&turn=0&item=0&credential=good', {
      range: 'bytes=0-9'
    })
    expect(res.status).toBe(206)
    expect(res.headers['Content-Range']).toBe(`bytes 0-9/${PNG.length}`)
    expect(res.headers['Accept-Ranges']).toBe('bytes')
    expect(res.body.length).toBe(10)
  })

  it('rejects a bad credential before it ever touches the store', async () => {
    const res = await call('/chat-media?sessionId=s1&turn=0&item=0&credential=nope')
    expect(res.status).toBe(401)
    expect(getSession).not.toHaveBeenCalled()
  })

  it('404s a position the session does not have', async () => {
    expect(
      (await call('/chat-media?sessionId=s1&turn=0&item=9&credential=good')).status
    ).toBe(404)
    expect((await call('/chat-media?sessionId=s1&turn=7&item=0&credential=good')).status).toBe(404)
  })

  it('never takes the file off the query string', async () => {
    // The turn carries no media at all, so the only path present is the
    // attacker-supplied one -- a 200 here would make this route read any file
    // on the Mac that Safari can be pointed at.
    getSession.mockReturnValue({ id: 's1', turns: [{ q: 'a', a: 'b' }] })
    const res = await call(
      `/chat-media?sessionId=s1&turn=0&item=0&credential=good&path=${encodeURIComponent(photo)}`
    )
    expect(res.status).toBe(404)
  })

  it('404s a stored path whose file is gone, rather than throwing', async () => {
    getSession.mockReturnValue({
      id: 's1',
      turns: [{ q: 'a', a: 'b', sources: [join(dir, 'deleted.png')] }]
    })
    expect(
      (await call('/chat-media?sessionId=s1&turn=0&item=0&credential=good')).status
    ).toBe(404)
  })
})

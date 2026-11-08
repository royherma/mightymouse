import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'
import type { IncomingMessage, ServerResponse } from 'http'

const h = vi.hoisted(() => ({
  onText: vi.fn(),
  onImage: vi.fn(),
  runIntentAction: vi.fn(async () => ({ ok: true, spoken: 'done', meta: {} })),
  routeSpokenIntent: vi.fn(async () => ({ ok: true, spoken: 'routed', meta: {} }))
}))

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => '/tmp', getAppPath: () => process.cwd() },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../device-credentials', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../device-credentials')>()
  return { ...actual, isDeviceCredentialValid: (c: unknown) => c === 'good' }
})
vi.mock('../server-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server-runtime')>()
  return { ...actual, getShareTextListener: () => h.onText, getShareImageListener: () => h.onImage }
})
vi.mock('../../intent-actions', () => ({
  runIntentAction: h.runIntentAction,
  describeFailure: (reason: string) => `failed: ${reason}`
}))
vi.mock('../../intent-router', () => ({ routeSpokenIntent: h.routeSpokenIntent }))

const { handleShare, handleIntent } = await import('../http-handlers')

let nextIp = 0
async function post(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  body: Record<string, unknown>
): Promise<{ status: number; body: Record<string, unknown> }> {
  const out = { status: 0, body: {} as Record<string, unknown> }
  const req = Object.assign(new EventEmitter(), {
    method: 'POST',
    headers: {},
    socket: { remoteAddress: `10.8.0.${++nextIp}` },
    destroy: () => undefined
  })
  const done = new Promise<void>((resolve) => {
    const res = {
      headersSent: false,
      writeHead: (s: number) => {
        out.status = s
      },
      end: (chunk?: string) => {
        out.body = chunk ? JSON.parse(chunk) : {}
        resolve()
      }
    }
    handler(req as unknown as IncomingMessage, res as unknown as ServerResponse)
  })
  req.emit('data', JSON.stringify(body))
  req.emit('end')
  await done
  return out
}

beforeEach(() => {
  h.onText.mockClear()
  h.onImage.mockClear()
  h.runIntentAction.mockClear()
  h.routeSpokenIntent.mockClear()
})

describe('POST /share', () => {
  it('never hands text or an image to the Mac without a valid credential', async () => {
    expect((await post(handleShare, { text: 'hello' })).status).toBe(401)
    expect((await post(handleShare, { credential: 'bad', text: 'hello', submit: true })).status).toBe(401)
    expect((await post(handleShare, { credential: 'bad', image: 'aGk=', mime: 'image/png' })).status).toBe(401)
    expect(h.onText).not.toHaveBeenCalled()
    expect(h.onImage).not.toHaveBeenCalled()
  })

  it('passes shared text and the submit flag through', async () => {
    expect((await post(handleShare, { credential: 'good', text: 'note to self', submit: true })).status).toBe(200)
    expect(h.onText).toHaveBeenCalledWith('note to self', true)
  })

  it('refuses an image type outside the allowlist and an undecodable body', async () => {
    expect((await post(handleShare, { credential: 'good', image: 'aGk=', mime: 'text/html' })).status).toBe(415)
    expect((await post(handleShare, { credential: 'good', image: '', mime: 'image/png' })).status).toBe(400)
    expect(h.onImage).not.toHaveBeenCalled()
  })
})

describe('POST /intent', () => {
  it('runs nothing without a valid credential', async () => {
    expect((await post(handleIntent, { action: 'lock' })).status).toBe(401)
    expect((await post(handleIntent, { credential: 'bad', action: 'say', text: 'open terminal' })).status).toBe(401)
    expect(h.runIntentAction).not.toHaveBeenCalled()
    expect(h.routeSpokenIntent).not.toHaveBeenCalled()
  })

  it('looks a named action up in the closed table and routes free text through the router', async () => {
    expect((await post(handleIntent, { credential: 'good', action: 'lock' })).body.ok).toBe(true)
    expect(h.runIntentAction).toHaveBeenCalledWith('lock')
    await post(handleIntent, { credential: 'good', action: 'say', text: 'pause the music' })
    expect(h.routeSpokenIntent).toHaveBeenCalledWith('pause the music')
  })

  it('answers ok:false instead of hanging when the action throws', async () => {
    h.runIntentAction.mockRejectedValueOnce(new Error('boom'))
    const res = await post(handleIntent, { credential: 'good', action: 'lock' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(false)
  })
})

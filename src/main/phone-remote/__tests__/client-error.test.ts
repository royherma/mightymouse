import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import type { IncomingMessage, ServerResponse } from 'http'

const trackError = vi.fn()

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => '/tmp', getAppPath: () => process.cwd() },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../../analytics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../analytics')>()
  return { ...actual, trackError }
})

const { handleClientError } = await import('../http-handlers')

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1'
const BODY_LIMIT_BYTES = 16_384
const ALLOWED_PER_MINUTE = 20

let nextIp = 0
const freshIp = (): string => `10.9.${Math.floor(nextIp / 250)}.${(nextIp++ % 250) + 1}`

type Sent = { status: number | null; destroyed: boolean }

function send(opts: { method?: string; ip?: string; ua?: string; raw?: string; chunks?: string[] }): Sent {
  const sent: Sent = { status: null, destroyed: false }
  const req = Object.assign(new EventEmitter(), {
    method: opts.method ?? 'POST',
    headers: opts.ua === undefined ? {} : { 'user-agent': opts.ua },
    socket: { remoteAddress: opts.ip ?? freshIp() },
    destroy: () => {
      sent.destroyed = true
    }
  })
  const res = {
    writeHead: (status: number) => {
      sent.status = status
    },
    end: () => undefined
  }
  handleClientError(req as unknown as IncomingMessage, res as unknown as ServerResponse)
  for (const chunk of opts.chunks ?? [opts.raw ?? '']) req.emit('data', chunk)
  req.emit('end')
  return sent
}

const post = (body: unknown, opts: { ip?: string; ua?: string } = {}): Sent => send({ ...opts, raw: JSON.stringify(body) })

describe('handleClientError', () => {
  beforeEach(() => trackError.mockReset())

  it('records a phone error with where it came from', () => {
    const sent = post(
      { kind: 'react.render', message: 'x is undefined', stack: 'at Deck (deck.js:1)', shell: 'native' },
      { ua: IPHONE_UA }
    )
    expect(sent.status).toBe(204)
    expect(trackError).toHaveBeenCalledTimes(1)
    const report = trackError.mock.calls[0][0]
    expect(report).toMatchObject({
      kind: 'react.render',
      message: 'x is undefined',
      stack: 'at Deck (deck.js:1)',
      source: 'phone-remote'
    })
    expect(report.props.shell).toBe('native')
    expect(report.props.device).toContain('iPhone')
  })

  it.each(['window.onerror', 'window.unhandledrejection', 'react.render'])('accepts kind %s', (kind) => {
    expect(post({ kind, message: 'boom' }).status).toBe(204)
    expect(trackError).toHaveBeenCalledTimes(1)
  })

  it('refuses a GET', () => {
    expect(send({ method: 'GET' }).status).toBe(405)
    expect(trackError).not.toHaveBeenCalled()
  })

  it.each([
    ['a kind the phone never sends', { kind: 'app.crash', message: 'boom' }],
    ['a missing kind', { message: 'boom' }],
    ['an empty message', { kind: 'react.render', message: '' }],
    ['a message that is not text', { kind: 'react.render', message: { toString: 'boom' } }],
    ['a body of null', null],
    ['a body that is a list', [{ kind: 'react.render', message: 'boom' }]]
  ])('refuses %s', (_name, body) => {
    expect(post(body).status).toBe(400)
    expect(trackError).not.toHaveBeenCalled()
  })

  it('refuses a body that is not JSON', () => {
    expect(send({ raw: 'kind=react.render&message=boom' }).status).toBe(400)
    expect(trackError).not.toHaveBeenCalled()
  })

  it('falls back to safari for a shell it does not know', () => {
    post({ kind: 'window.onerror', message: 'boom', shell: 'electron' })
    expect(trackError.mock.calls[0][0].props.shell).toBe('safari')
  })

  it('falls back to safari when no shell is sent', () => {
    post({ kind: 'window.onerror', message: 'boom' })
    expect(trackError.mock.calls[0][0].props.shell).toBe('safari')
  })

  it('drops a stack that is not text', () => {
    post({ kind: 'window.onerror', message: 'boom', stack: { frames: 3 } })
    expect(trackError.mock.calls[0][0].stack).toBeNull()
  })

  it('cuts off a body over the size limit and records nothing', () => {
    const half = 'a'.repeat(BODY_LIMIT_BYTES / 2 + 1)
    const sent = send({ chunks: [half, half, half] })
    expect(sent.status).toBe(413)
    expect(sent.destroyed).toBe(true)
    expect(trackError).not.toHaveBeenCalled()
  })

  it('accepts a body right at the size limit', () => {
    const shell = JSON.stringify({ kind: 'window.onerror', message: '' })
    const body = JSON.stringify({ kind: 'window.onerror', message: 'a'.repeat(BODY_LIMIT_BYTES - shell.length) })
    expect(body.length).toBe(BODY_LIMIT_BYTES)
    expect(send({ raw: body }).status).toBe(204)
  })

  it('stops one phone after 20 reports in a minute, without blocking another phone', () => {
    const ip = freshIp()
    const body = { kind: 'window.onerror', message: 'boom' }
    for (let i = 0; i < ALLOWED_PER_MINUTE; i++) expect(post(body, { ip }).status).toBe(204)
    expect(post(body, { ip }).status).toBe(429)
    expect(trackError).toHaveBeenCalledTimes(ALLOWED_PER_MINUTE)
    expect(post(body).status).toBe(204)
  })
})

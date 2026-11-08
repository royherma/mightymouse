import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import type { IncomingMessage, ServerResponse } from 'http'
import { CONFIG } from '@shared/config'

const { trackError, preview } = vi.hoisted(() => ({ trackError: vi.fn(), preview: { on: false } }))

vi.mock('../hooks/use-mirror', () => ({
  get PREVIEW_MODE() {
    return preview.on
  }
}))
vi.mock('../host-capabilities', () => ({ capabilities: { shell: 'pwa' } }))
vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => '/tmp', getAppPath: () => process.cwd() },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../../../analytics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../analytics')>()
  return { ...actual, trackError }
})

const REPORTS_PER_PAGE_LOAD = 5

type Sent = { url: string; method?: string; body: string }
type Listener = (e: Record<string, unknown>) => void

let sent: Sent[] = []
let network: () => Promise<Response>
const listeners = new Map<string, Listener>()

// The per-page-load counter lives in the module, so each test loads it fresh.
async function load(): Promise<typeof import('../DeckBoundary') & typeof import('../../http-handlers')> {
  vi.resetModules()
  return { ...(await import('../DeckBoundary')), ...(await import('../../http-handlers')) }
}

function deliver(handle: (req: IncomingMessage, res: ServerResponse) => void, body: string): number | null {
  let status: number | null = null
  const req = Object.assign(new EventEmitter(), {
    method: 'POST',
    headers: {},
    socket: { remoteAddress: '10.8.0.1' },
    destroy: () => undefined
  })
  const res = { writeHead: (s: number) => void (status = s), end: () => undefined }
  handle(req as unknown as IncomingMessage, res as unknown as ServerResponse)
  req.emit('data', body)
  req.emit('end')
  return status
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  sent = []
  listeners.clear()
  preview.on = false
  trackError.mockReset()
  network = async () => new Response(null, { status: 204 })
  vi.stubGlobal('fetch', (url: unknown, init: { method?: string; body?: string } = {}) => {
    sent.push({ url: String(url), method: init.method, body: init.body ?? '' })
    return network()
  })
  vi.stubGlobal('window', { addEventListener: (type: string, fn: Listener) => void listeners.set(type, fn) })
  vi.stubGlobal('document', { getElementById: () => null })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('phone error report, sent by the phone and read by the Mac', () => {
  it('posts to the path the Mac listens on, and the Mac records it', async () => {
    const { reportClientError, handleClientError } = await load()
    reportClientError('react.render', 'x is undefined', 'at Deck (deck.js:1)')
    expect(sent).toHaveLength(1)
    expect(sent[0].url).toBe(CONFIG.PHONE_REMOTE.CLIENT_ERROR_PATH)
    expect(sent[0].method).toBe('POST')
    expect(deliver(handleClientError, sent[0].body)).toBe(204)
    expect(trackError).toHaveBeenCalledTimes(1)
    expect(trackError.mock.calls[0][0]).toMatchObject({
      kind: 'react.render',
      message: 'x is undefined',
      stack: 'at Deck (deck.js:1)',
      source: 'phone-remote'
    })
    expect(trackError.mock.calls[0][0].props.shell).toBe('pwa')
  })

  it('the Mac accepts an uncaught error from the page', async () => {
    const { installClientErrorHooks, handleClientError } = await load()
    installClientErrorHooks()
    listeners.get('error')?.({ message: 'x is not a function', error: { stack: 'at tap (deck.js:4)' } })
    expect(deliver(handleClientError, sent[0].body)).toBe(204)
    expect(trackError.mock.calls[0][0]).toMatchObject({ kind: 'window.onerror', message: 'x is not a function', stack: 'at tap (deck.js:4)' })
  })

  it('the Mac accepts a rejected promise', async () => {
    const { installClientErrorHooks, handleClientError } = await load()
    installClientErrorHooks()
    listeners.get('unhandledrejection')?.({ reason: { message: 'socket closed', stack: 'at send (ws.js:2)' } })
    expect(deliver(handleClientError, sent[0].body)).toBe(204)
    expect(trackError.mock.calls[0][0]).toMatchObject({ kind: 'window.unhandledrejection', message: 'socket closed', stack: 'at send (ws.js:2)' })
  })

  it('the Mac accepts a screen that failed to draw', async () => {
    const { DeckBoundary, handleClientError } = await load()
    const error = new Error('kaboom')
    new DeckBoundary({ children: null }).componentDidCatch(error, { componentStack: '\n    at Deck' })
    expect(deliver(handleClientError, sent[0].body)).toBe(204)
    expect(trackError.mock.calls[0][0]).toMatchObject({ kind: 'react.render', message: 'kaboom', stack: `${error.stack}\n\n    at Deck` })
  })

  it.each([
    ['plain text', 'timed out', 'timed out'],
    ['nothing', undefined, 'undefined'],
    ['an error with no message', {}, '[object Object]']
  ])('a promise rejected with %s still reaches the Mac', async (_name, reason, message) => {
    const { installClientErrorHooks, handleClientError } = await load()
    installClientErrorHooks()
    listeners.get('unhandledrejection')?.({ reason })
    expect(deliver(handleClientError, sent[0].body)).toBe(204)
    expect(trackError.mock.calls[0][0]).toMatchObject({ kind: 'window.unhandledrejection', message, stack: null })
  })

  it('an error with an empty message is sent as "unknown" instead of being refused', async () => {
    const { reportClientError, handleClientError } = await load()
    reportClientError('window.onerror', '')
    expect(deliver(handleClientError, sent[0].body)).toBe(204)
    expect(trackError.mock.calls[0][0].message).toBe('unknown')
  })

  it('the longest report the phone sends is under the size the Mac refuses', async () => {
    const { reportClientError, handleClientError } = await load()
    const frame = '    at Component (http://192.168.1.20:17771/assets/deck-4f2a9c.js:123:4567)\n'
    reportClientError('react.render', 'm'.repeat(5000), frame.repeat(Math.ceil(9000 / frame.length)))
    expect(deliver(handleClientError, sent[0].body)).toBe(204)
    expect(trackError.mock.calls[0][0].message).toHaveLength(4000)
    expect(trackError.mock.calls[0][0].stack).toHaveLength(8000)
  })

  it('stops after 5 reports in one page load', async () => {
    const { reportClientError } = await load()
    for (let i = 0; i < REPORTS_PER_PAGE_LOAD + 3; i++) reportClientError('window.onerror', `boom ${i}`)
    expect(sent).toHaveLength(REPORTS_PER_PAGE_LOAD)
    expect(JSON.parse(sent.at(-1)?.body ?? '{}').message).toBe(`boom ${REPORTS_PER_PAGE_LOAD - 1}`)
  })

  it('sends nothing from the preview page', async () => {
    preview.on = true
    const { reportClientError } = await load()
    reportClientError('window.onerror', 'boom')
    expect(sent).toHaveLength(0)
  })

  it('a report that cannot be sent does not raise a second error', async () => {
    network = async () => {
      throw new Error('Mac unreachable')
    }
    const { reportClientError } = await load()
    expect(() => reportClientError('window.onerror', 'boom')).not.toThrow()
    await flush()
    expect(sent).toHaveLength(1)
  })
})

import { describe, it, expect, vi, afterEach } from 'vitest'

const trackError = vi.fn()

vi.mock('electron', () => ({
  app: { on: vi.fn() },
  shell: { openExternal: vi.fn() },
  Notification: Object.assign(vi.fn(), { isSupported: () => false })
}))
vi.mock('../analytics', () => ({ trackError: (...a: unknown[]) => trackError(...a) }))
vi.mock('../../shared/config', () => ({ CONFIG: { BRAND_NAME: 'MM', APP_NAME: 'MM', APP_VERSION: '0', SUPPORT_EMAIL: 'x@y' } }))
vi.mock('../../shared/env', () => ({ devLog: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

type Handler = (err: Error) => void

async function installAndGrab(event: 'uncaughtException' | 'unhandledRejection' = 'uncaughtException'): Promise<Handler> {
  const before = {
    uncaughtException: new Set(process.listeners('uncaughtException')),
    unhandledRejection: new Set(process.listeners('unhandledRejection'))
  }
  const { installCrashHandlers } = await import('../crash')
  installCrashHandlers()
  const added = process.listeners('uncaughtException').filter((l) => !before.uncaughtException.has(l))
  const addedRejection = process.listeners('unhandledRejection').filter((l) => !before.unhandledRejection.has(l))
  expect(added).toHaveLength(1)
  installed.push(added[0])
  rejectionHandlers.push(...addedRejection)
  return (event === 'uncaughtException' ? added[0] : addedRejection[0]) as unknown as Handler
}

const installed: Array<(...a: unknown[]) => void> = []
const rejectionHandlers: Array<(...a: unknown[]) => void> = []

afterEach(() => {
  vi.resetModules()
  for (const l of installed.splice(0)) process.removeListener('uncaughtException', l)
  for (const l of rejectionHandlers.splice(0)) process.removeListener('unhandledRejection', l)
  trackError.mockClear()
})

describe('uncaughtException handler', () => {
  it('reports a second, different uncaught exception instead of going silent after the first', async () => {
    const handler = await installAndGrab()
    const nextTick = vi.spyOn(process, 'nextTick')

    handler(new Error('boom-1'))
    handler(new Error('boom-2'))

    const thrownLater = nextTick.mock.calls.length
    nextTick.mockRestore()
    expect(thrownLater).toBe(0)
    expect(trackError.mock.calls.map((c) => (c[0] as { message: string }).message)).toEqual(['boom-1', 'boom-2'])
  })

  it('reports a repeating exception once, not once per occurrence', async () => {
    const handler = await installAndGrab()
    for (let i = 0; i < 50; i++) handler(new Error('same listener keeps throwing'))
    expect(trackError).toHaveBeenCalledTimes(1)
  })
})

const offline = (message: string, hostname: string): Error =>
  Object.assign(new Error(message), { cause: { hostname } })

describe('what counts as a crash', () => {
  it('drops a Supabase token refresh that hit a network blip', async () => {
    const onRejection = await installAndGrab('unhandledRejection')
    onRejection(offline('fetch failed', 'czylhdjjfsxyltvgnnyh.supabase.co'))
    onRejection(offline('getaddrinfo ENOTFOUND x.supabase.co', 'x.supabase.co'))
    expect(trackError).not.toHaveBeenCalled()
  })

  it('still reports a network failure against any other host', async () => {
    const onRejection = await installAndGrab('unhandledRejection')
    onRejection(offline('fetch failed', 'api.example.com'))
    expect(trackError).toHaveBeenCalledTimes(1)
  })

  it('drops the declined screen-capture rejections the mirror already handles', async () => {
    const onRejection = await installAndGrab('unhandledRejection')
    onRejection(new Error('Video was requested, but no video stream was provided'))
    onRejection(new Error('One-time callback was called more than once'))
    expect(trackError).not.toHaveBeenCalled()
  })

  it('reports a rejection with a non-Error reason', async () => {
    const onRejection = await installAndGrab('unhandledRejection')
    onRejection('plain string reason' as unknown as Error)
    expect(trackError.mock.calls[0][0]).toMatchObject({ kind: 'unhandledRejection', message: 'plain string reason' })
  })
})

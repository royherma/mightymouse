import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { drainAttempts, flushAttemptsToHost, readAttempts, recordAttempt } from './connect-log'

const values = new Map<string, string>()

beforeEach(() => {
  values.clear()
  globalThis.localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
    key: () => null,
    length: 0
  } as Storage
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('connect-log buffer', () => {
  it('drains once so a later reconnect cannot replay the same rows', () => {
    recordAttempt('rejected', { detail: 'no-credential', host: 'mac.local:17771', hadCredential: false })
    expect(drainAttempts()).toHaveLength(1)
    expect(drainAttempts()).toEqual([])
  })

  it('restores the buffer when POST /connect-log fails', async () => {
    recordAttempt('no-stored-credential', { host: 'mac.local:17771', hadCredential: false })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      })
    )
    expect(await flushAttemptsToHost('mac.local:17771')).toBe(false)
    expect(readAttempts()).toHaveLength(1)
    expect(readAttempts()[0]?.outcome).toBe('no-stored-credential')
  })

  it('empties the buffer when the Mac accepts the POST', async () => {
    recordAttempt('rejected', {
      detail: 'no-credential',
      host: 'mac.local:17771',
      hadCredential: false,
      opened: false
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    expect(await flushAttemptsToHost('mac.local:17771')).toBe(true)
    expect(readAttempts()).toEqual([])
  })
})

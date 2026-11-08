import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { PasskeyRequest, PasskeyResult } from '../../shared/types'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn) },
  app: { isPackaged: false, getAppPath: () => '/nonexistent-app-path' },
  BrowserWindow: { fromWebContents: () => ({ getNativeWindowHandle: () => Buffer.alloc(8) }) }
}))

import { CHANNELS } from '../../shared/ipc'
import { registerSideBrowserPasskeyHandlers } from '../side-browser-passkeys'

type Passkey = (origin: string, rpId: string | undefined, opts?: { subframe?: boolean }) => Promise<PasskeyResult>
let passkey: Passkey

beforeAll(() => {
  registerSideBrowserPasskeyHandlers()
  const handle = handlers.get(CHANNELS.sideBrowserPasskey)!
  passkey = (origin, rpId, opts = {}) =>
    handle(
      { senderFrame: { origin, parent: opts.subframe ? {} : null }, sender: {} },
      { kind: 'get', publicKey: { rpId, challenge: new Uint8Array([1, 2, 3]) } } as PasskeyRequest
    ) as Promise<PasskeyResult>
})

// The rpId gate is the only check before the native bridge; past it the addon is
// missing under test, so an allowed request surfaces as 'not-entitled'.
const PASSED_GATE = 'not-entitled'

describe('side-browser passkey rpId gate', () => {
  it('lets a page ask for its own domain or a parent domain', async () => {
    expect((await passkey('https://google.com', 'google.com')).errorCode).toBe(PASSED_GATE)
    expect((await passkey('https://accounts.google.com', 'google.com')).errorCode).toBe(PASSED_GATE)
    expect((await passkey('https://accounts.google.com', undefined)).errorCode).toBe(PASSED_GATE)
  })

  it('refuses a page asking for another site\'s passkey', async () => {
    expect((await passkey('https://evil.com', 'google.com')).errorCode).toBe('invalid-rp-id')
    expect((await passkey('https://evilgoogle.com', 'google.com')).errorCode).toBe('invalid-rp-id')
    expect((await passkey('https://google.com.evil.com', 'google.com')).errorCode).toBe('invalid-rp-id')
    expect((await passkey('https://google.com', 'accounts.google.com')).errorCode).toBe('invalid-rp-id')
  })

  it('refuses opaque origins and an empty rpId', async () => {
    expect((await passkey('null', undefined)).errorCode).toBe('invalid-rp-id')
    expect((await passkey('https://google.com', '')).errorCode).toBe('invalid-rp-id')
    expect((await passkey('null', '')).errorCode).toBe('invalid-rp-id')
  })

  it('refuses any request from a subframe, even same-site', async () => {
    expect((await passkey('https://google.com', 'google.com', { subframe: true })).errorCode).toBe('not-top-frame')
  })

  it('refuses a plain-http page, as WebAuthn requires a secure context', async () => {
    expect((await passkey('http://accounts.google.com', 'google.com')).errorCode).toBe('invalid-rp-id')
  })
})

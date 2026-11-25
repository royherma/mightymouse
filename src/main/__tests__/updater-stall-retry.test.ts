import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const handlers: Record<string, (...a: unknown[]) => void> = {}
  const tokens: { cancel: ReturnType<typeof vi.fn> }[] = []
  const autoUpdater = {
    on: (event: string, cb: (...a: unknown[]) => void) => {
      handlers[event] = cb
    },
    checkForUpdates: vi.fn(async () => {
      let reject!: (e: Error) => void
      const downloadPromise = new Promise<string[]>((_, r) => {
        reject = r
      })
      const cancellationToken = { cancel: vi.fn(() => reject(new Error('cancelled'))) }
      tokens.push(cancellationToken)
      return { downloadPromise, cancellationToken }
    })
  }
  return { handlers, tokens, autoUpdater, trackError: vi.fn() }
})

vi.mock('electron', () => ({
  app: { isPackaged: true, isInApplicationsFolder: () => true, getPath: () => '/tmp', getName: () => 'MightyMouse' },
  BrowserWindow: { getAllWindows: () => [] },
  shell: {}
}))
vi.mock('electron-updater', () => ({ autoUpdater: h.autoUpdater }))
vi.mock('node:fs/promises', () => ({ rm: async () => {} }))
vi.mock('../analytics', () => ({ track: () => {}, trackError: h.trackError }))
vi.mock('../store/prefs', () => ({
  PREFS: { getLastSeenVersion: () => '0.0.0', setLastSeenVersion: () => {} }
}))
vi.mock('../../shared/config', () => ({ CONFIG: { IS_STAGING: false, APP_VERSION: '0.0.0' } }))

import { setupAutoUpdater } from '../updater'

const FIVE_MIN = 5 * 60 * 1000
const realPlatform = process.platform

describe('update download stall', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    Object.defineProperty(process, 'platform', { value: 'darwin' })
  })
  afterEach(() => {
    vi.useRealTimers()
    Object.defineProperty(process, 'platform', { value: realPlatform })
  })

  it('cancels the hung download and starts a fresh one before reporting a stall', async () => {
    setupAutoUpdater()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)

    h.handlers['download-progress']({ percent: 40 })
    await vi.advanceTimersByTimeAsync(FIVE_MIN)

    expect(h.tokens[0].cancel).toHaveBeenCalled()
    expect(h.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2)
    expect(h.trackError).not.toHaveBeenCalled()

    h.handlers['download-progress']({ percent: 10 })
    await vi.advanceTimersByTimeAsync(FIVE_MIN)

    expect(h.tokens[1].cancel).toHaveBeenCalled()
    expect(h.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2)
    expect(h.trackError).toHaveBeenCalledWith(expect.objectContaining({ kind: 'update_stalled' }))
  })
})

import { describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../../store/prefs', () => ({ PREFS: { getIncognito: () => false } }))
vi.mock('../uiohook-manager', () => ({
  isAvailable: () => true,
  acquire: () => () => {},
  on: () => () => {}
}))

import { startEventLogging, stopEventLogging } from '../event-logger'

describe('recording into a capture folder that is gone', () => {
  it('logs the failed writes instead of raising an uncaught stream error', async () => {
    const uncaught: unknown[] = []
    const onUncaught = (err: unknown): void => void uncaught.push(err)
    process.prependListener('uncaughtException', onUncaught)
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(startEventLogging(join(tmpdir(), `mm-gone-${process.pid}`, 'capture'))).toBe(true)
    await new Promise((r) => setTimeout(r, 100))
    stopEventLogging()

    process.removeListener('uncaughtException', onUncaught)
    expect(uncaught).toEqual([])
    expect(errorLog).toHaveBeenCalled()
    errorLog.mockRestore()
  })
})

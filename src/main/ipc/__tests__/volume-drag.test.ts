import { describe, expect, it, vi } from 'vitest'

const writes: number[] = []
const finishers: Array<() => void> = []
const spawnSync = vi.fn(() => {
  throw new Error('blocking osascript on the volume path')
})
const execFile = vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (e: null, o: string, s: string) => void) =>
  cb(null, '', '')
)

vi.mock('child_process', () => ({ spawnSync: () => spawnSync(), execFile: (...a: unknown[]) => execFile(...(a as Parameters<typeof execFile>)) }))
vi.mock('../../store/prefs', () => ({ PREFS: {} }))
vi.mock('../../cursor-window', () => ({ setCursorCompanion: vi.fn() }))
vi.mock('../../phone-remote/server', () => ({ sendToPhone: vi.fn() }))
vi.mock('../../analytics', () => ({ track: vi.fn() }))
vi.mock('../phone-first-steps', () => ({ sendFirstStepsToPhone: vi.fn() }))
vi.mock('../../platform', async () => {
  const { clampVolume } = await import('../../platform/macos/system-volume')
  return {
    PERMISSIONS: {},
    input: {},
    clampVolume,
    system: {
      setSystemVolume: (v: number) =>
        new Promise<void>((resolve) => {
          writes.push(v)
          finishers.push(resolve)
        })
    }
  }
})

describe('phone volume drag', () => {
  it('setSystemVolume does not block the main process', async () => {
    const { setSystemVolume } = await import('../../platform/macos/system-volume')
    await setSystemVolume(40)
    expect(spawnSync).not.toHaveBeenCalled()
    expect(execFile).toHaveBeenCalledTimes(1)
  })

  it('keeps one write in flight during a drag and lands on the last value', async () => {
    vi.useFakeTimers()
    const { queueSystemVolume } = await import('../phone-remote-prefs')

    queueSystemVolume(10)
    for (let v = 11; v <= 30; v++) {
      queueSystemVolume(v)
      await vi.advanceTimersByTimeAsync(10)
    }
    expect(writes).toEqual([10])

    finishers.shift()?.()
    await vi.advanceTimersByTimeAsync(200)
    expect(writes).toEqual([10, 30])
    vi.useRealTimers()
  })
})

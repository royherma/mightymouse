import { describe, expect, it, vi } from 'vitest'
import { spawn } from 'child_process'

vi.mock('../../platform', () => ({ captureContext: vi.fn() }))
vi.mock('../../store/prefs', () => ({ PREFS: {} }))

import { waitForExit } from '../capture-utils'

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('stopping a recorder whose ffmpeg ignores SIGINT', () => {
  it('kills it after the wait instead of leaving it holding the device', async () => {
    const proc = spawn('sh', ['-c', 'trap "" INT; exec sleep 33.9'])
    await new Promise((r) => setTimeout(r, 100))
    proc.kill('SIGINT')

    await waitForExit(proc, 300)
    await new Promise((r) => setTimeout(r, 200))

    const stillAlive = alive(proc.pid!)
    if (stillAlive) proc.kill('SIGKILL')
    expect(stillAlive).toBe(false)
  })
})

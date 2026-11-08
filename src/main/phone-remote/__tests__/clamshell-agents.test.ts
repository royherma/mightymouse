import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let machineSleepDisabled = false

vi.mock('child_process', () => ({
  exec: vi.fn((cmd: string, _opts: unknown, cb: (e: Error | null, out: string, err: string) => void) => {
    if (cmd.trim() === 'pmset -g' || cmd.includes('pmset -g ')) {
      cb(null, ['System-wide power settings:', ` SleepDisabled\t\t${machineSleepDisabled ? 1 : 0}`, ' Sleep On Power Button 1', ''].join('\n'), '')
      return
    }
    if (cmd.includes('osascript')) {
      if (cmd.includes('disablesleep 1')) machineSleepDisabled = true
      if (cmd.includes('disablesleep 0')) machineSleepDisabled = false
    }
    cb(null, '', '')
  })
}))
vi.mock('../../../shared/env', () => ({ devLog: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../../../shared/config', () => ({
  CONFIG: { PHONE_REMOTE: { CLAMSHELL_REVERT_MS: 1000, CLAMSHELL_AGENT_RECHECK_MS: 500 } }
}))

describe('clamshell revert waits for working agents', () => {
  beforeEach(() => {
    machineSleepDisabled = false
    vi.resetModules()
    vi.useFakeTimers()
  })
  afterEach(() => vi.useRealTimers())

  it('keeps a closed Mac awake past the grace window while an agent works, then reverts once it stops', async () => {
    const { enableClamshell, armIdleRevert, setClamshellAgentProbe } = await import('../clamshell')
    let working = true
    setClamshellAgentProbe(() => working)
    await enableClamshell()
    armIdleRevert()
    await vi.advanceTimersByTimeAsync(1000 + 500 * 4)
    expect(machineSleepDisabled).toBe(true)
    working = false
    await vi.advanceTimersByTimeAsync(500)
    expect(machineSleepDisabled).toBe(false)
  })

  it('the phone coming back during the agent wait still stands the revert down', async () => {
    const { enableClamshell, armIdleRevert, cancelIdleRevert, setClamshellAgentProbe } = await import('../clamshell')
    let working = true
    setClamshellAgentProbe(() => working)
    await enableClamshell()
    armIdleRevert()
    await vi.advanceTimersByTimeAsync(1600)
    cancelIdleRevert()
    working = false
    await vi.advanceTimersByTimeAsync(5000)
    expect(machineSleepDisabled).toBe(true)
  })

  it('with no probe set it reverts on the grace window as before', async () => {
    const { enableClamshell, armIdleRevert } = await import('../clamshell')
    await enableClamshell()
    armIdleRevert()
    await vi.advanceTimersByTimeAsync(1001)
    expect(machineSleepDisabled).toBe(false)
  })
})

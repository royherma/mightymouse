import { describe, it, expect } from 'vitest'
import { spawn, execSync } from 'child_process'

// Real (non-mocked) behavioral check for the detached + group-kill fix in runner.ts:
// spawn a shell that backgrounds a grandchild (mirrors what an `act`-mode CLI does),
// group-kill it via process.kill(-pid, 'SIGKILL'), and assert via pgrep that NOTHING
// in the process group survives — not just the immediate shell wrapper.
describe('detached spawn + process-group kill (real OS process, no mocks)', () => {
  it('kills the shell AND its backgrounded grandchild with zero survivors', async () => {
    // Real OS process + two real sleeps (300ms + 500ms). Under full-suite CPU
    // contention (56 files) the default 5000ms can be too tight even though the
    // logic itself is fast in isolation — give it headroom instead of flaking.
    const child = spawn('/bin/zsh', ['-c', 'sleep 30 & sleep 30'], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore']
    })
    const pid = child.pid
    expect(pid).toBeDefined()

    // Give the shell a moment to fork its backgrounded grandchild.
    await new Promise((r) => setTimeout(r, 300))

    const before = execSync(`pgrep -g ${pid} || true`).toString().trim().split('\n').filter(Boolean)
    expect(before.length).toBeGreaterThanOrEqual(2) // the zsh wrapper + its backgrounded sleep

    process.kill(-pid!, 'SIGKILL')
    await new Promise((r) => setTimeout(r, 500))

    const survivors = execSync(`pgrep -g ${pid} || true`).toString().trim().split('\n').filter(Boolean)
    expect(survivors).toEqual([])
  }, 15000)
})

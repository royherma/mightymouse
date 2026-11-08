import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'

// A fake child process that NEVER emits 'close' — simulates a hung CLI. The
// wall-clock timer in runBackend is the only thing that can resolve this run.
// pid is set because killProcessGroup no-ops without one (see runner.ts) —
// real spawned children always have a pid, so this mirrors production.
class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  killed = false
  pid = 4242
  kill = vi.fn(() => { this.killed = true; return true })
}

let fakeChild: FakeChild

vi.mock('child_process', () => ({
  spawn: vi.fn(() => fakeChild)
}))

// Avoid touching the real filesystem / Supabase from the runner's imports.
// existsSync/readFileSync are read by PREFS.getIncognito() (runner consults it to
// gate per-run logging); unlinkSync is the incognito tmp-scrub. Stub them so the
// runner's import-time + run-time PREFS reads never hit the real disk.
vi.mock('fs', () => ({
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  appendFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => '')
}))
vi.mock('../../supabase', () => ({ getSupabase: vi.fn() }))

// Make the claude binary "resolve" so buildCommand succeeds and we reach spawn
// (otherwise BinaryNotFoundError short-circuits to exit -1 before the timer arms).
// adapters.ts resolves binaries via the platform barrel, so mock that.
vi.mock('../../platform', () => ({
  resolveBinary: vi.fn(() => '/usr/local/bin/claude'),
  resolveClaude: vi.fn(() => '/usr/local/bin/claude'),
  resolveCodex: vi.fn(() => '/usr/local/bin/codex'),
  clearBinaryCache: vi.fn(),
  shell: {
    bin: '/bin/zsh',
    quote: (s: string) => `'${s.replace(/'/g, `'\\''`)}'`,
    spawnArgs: (cmd: string) => ['-c', cmd],
    fileText: (path: string) => `"$(cat '${path}')"`,
    env: () => ({ ...process.env })
  }
}))

import { runBackend, EXIT_TIMEOUT } from '../runner'

describe('runBackend wall-clock timeout', () => {
  let processKillSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    fakeChild = new FakeChild()
    // killProcessGroup's primary path is process.kill(-pid, ...) — spy so we can
    // assert the group-kill without actually signaling a real process group.
    processKillSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    processKillSpy.mockRestore()
  })

  it('kills a hung run and reports EXIT_TIMEOUT (-3) after timeoutMs', () => {
    const onDone = vi.fn()

    runBackend({
      backend: 'claude',
      runId: 'test-run',
      systemPrompt: 'sys',
      userPrompt: 'hi',
      runDir: '/tmp',
      timeoutMs: 1000,
      onPhase: () => {},
      onDone
    })

    // Nothing fired yet — the child is "running".
    expect(onDone).not.toHaveBeenCalled()
    expect(fakeChild.killed).toBe(false)

    // Advance past the timeout: the run should be killed and reported as -3.
    vi.advanceTimersByTime(1000)

    // Whole process GROUP is killed (negative pid), not just the shell wrapper —
    // this is what lets an `act`-mode CLI's grandchildren die with it.
    expect(processKillSpy).toHaveBeenCalledWith(-fakeChild.pid, 'SIGKILL')
    expect(fakeChild.kill).not.toHaveBeenCalled() // group-kill succeeded, no fallback needed
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onDone.mock.calls[0][1]).toBe(EXIT_TIMEOUT)
  })

  it('falls back to child.kill() if the process-group kill throws (e.g. ESRCH race)', () => {
    processKillSpy.mockImplementation(() => { throw new Error('ESRCH') })
    const onDone = vi.fn()

    runBackend({
      backend: 'claude',
      runId: 'test-run',
      systemPrompt: 'sys',
      userPrompt: 'hi',
      runDir: '/tmp',
      timeoutMs: 1000,
      onPhase: () => {},
      onDone
    })

    vi.advanceTimersByTime(1000)

    expect(processKillSpy).toHaveBeenCalledWith(-fakeChild.pid, 'SIGKILL')
    expect(fakeChild.kill).toHaveBeenCalledWith('SIGKILL')
    expect(onDone.mock.calls[0][1]).toBe(EXIT_TIMEOUT)
  })

  it('does NOT double-report if the child closes after the timeout kill', () => {
    const onDone = vi.fn()
    runBackend({
      backend: 'claude',
      runId: 'test-run',
      systemPrompt: '',
      userPrompt: 'hi',
      runDir: '/tmp',
      timeoutMs: 1000,
      onPhase: () => {},
      onDone
    })

    vi.advanceTimersByTime(1000)
    // The SIGKILL triggers a real 'close' event — must not fire onDone again.
    fakeChild.emit('close', 137)

    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onDone.mock.calls[0][1]).toBe(EXIT_TIMEOUT)
  })

  it('reports the real exit code when the run finishes before the timeout', () => {
    const onDone = vi.fn()
    runBackend({
      backend: 'claude',
      runId: 'test-run',
      systemPrompt: '',
      userPrompt: 'hi',
      runDir: '/tmp',
      timeoutMs: 10_000,
      onPhase: () => {},
      onDone
    })

    // Finish cleanly well before the ceiling.
    vi.advanceTimersByTime(500)
    fakeChild.emit('close', 0)

    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onDone.mock.calls[0][1]).toBe(0)
    expect(fakeChild.kill).not.toHaveBeenCalled()
  })
})

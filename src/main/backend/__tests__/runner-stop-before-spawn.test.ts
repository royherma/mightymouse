import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'

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

vi.mock('fs', () => ({
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  appendFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => '')
}))
vi.mock('../../supabase', () => ({ getSupabase: vi.fn() }))

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

import { runBackend, abortRun, EXIT_STOPPED } from '../runner'

describe('stop that lands before the CLI spawns', () => {
  let processKillSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fakeChild = new FakeChild()
    processKillSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
  })
  afterEach(() => {
    vi.clearAllMocks()
    processKillSpy.mockRestore()
  })

  function start(runId: string, onDone: (...a: unknown[]) => void): void {
    runBackend({ backend: 'claude', runId, systemPrompt: '', userPrompt: 'hi', runDir: '/tmp', timeoutMs: 60_000, onPhase: () => {}, onDone })
  }

  it('kills the run the moment it spawns and reports it as stopped', () => {
    const onDone = vi.fn()
    expect(abortRun('early-run')).toBe(false)

    start('early-run', onDone)

    expect(processKillSpy).toHaveBeenCalledWith(-fakeChild.pid, 'SIGKILL')
    fakeChild.emit('close', 137)
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onDone.mock.calls[0][1]).toBe(EXIT_STOPPED)
  })

  it('leaves a run that was never stopped alone', () => {
    const onDone = vi.fn()
    abortRun('some-other-run')

    start('normal-run', onDone)

    expect(processKillSpy).not.toHaveBeenCalled()
    fakeChild.emit('close', 0)
    expect(onDone.mock.calls[0][1]).toBe(0)
  })
})

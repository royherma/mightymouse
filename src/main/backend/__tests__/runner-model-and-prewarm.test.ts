import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'

const h = vi.hoisted(() => ({ spawned: [] as string[] }))

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  pid = 4242
  kill = vi.fn(() => true)
}

vi.mock('child_process', () => ({
  spawn: vi.fn((_bin: string, args: string[]) => {
    h.spawned.push(args[args.length - 1])
    return new FakeChild()
  })
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
  resolveBinary: vi.fn((name: string) => `/usr/local/bin/${name}`),
  resolveClaude: vi.fn(() => '/usr/local/bin/claude'),
  resolveCodex: vi.fn(() => '/usr/local/bin/codex'),
  resolveOpencode: vi.fn(() => '/usr/local/bin/opencode'),
  clearBinaryCache: vi.fn(),
  shell: {
    bin: '/bin/zsh',
    quote: (s: string) => `'${s.replace(/'/g, `'\\''`)}'`,
    spawnArgs: (cmd: string) => ['-c', cmd],
    fileText: (path: string) => `"$(cat '${path}')"`,
    env: () => ({ ...process.env })
  }
}))

import { prewarmAllShellBackends, prewarmLLM, resolveModelChain, runBackend } from '../runner'
import { PREFS } from '../../store/prefs'

afterEach(() => {
  h.spawned.length = 0
})

describe('prewarm never spends money', () => {
  it('opencode is never warmed: its warm-up prompt is a billed call', () => {
    prewarmLLM('opencode')
    expect(h.spawned).toEqual([])
  })

  it('warming every shell backend spawns claude and codex but not opencode', () => {
    prewarmAllShellBackends()
    expect(h.spawned.some((c) => c.includes('/usr/local/bin/claude'))).toBe(true)
    expect(h.spawned.some((c) => c.includes('/usr/local/bin/codex'))).toBe(true)
    expect(h.spawned.filter((c) => c.includes('opencode'))).toEqual([])
  })
})

describe('a caller-picked model wins on the first attempt only', () => {
  function run(model: string | undefined, modelAttempt: number): { resolved: string[] } {
    const resolved: string[] = []
    runBackend({
      backend: 'claude',
      runId: `r-${model}-${modelAttempt}`,
      systemPrompt: 'sys',
      userPrompt: 'hi',
      runDir: '/tmp',
      model,
      modelAttempt,
      onModelResolved: (m) => resolved.push(m),
      onPhase: () => {},
      onDone: () => {}
    })
    return { resolved }
  }

  it('attempt 0 runs the picked model', async () => {
    const r = run('claude-haiku-9', 0)
    await vi.waitFor(() => expect(r.resolved).toEqual(['claude-haiku-9']))
    expect(h.spawned.at(-1)).toContain('claude-haiku-9')
  })

  it('a retry after the pick was refused walks the normal fallback chain instead', async () => {
    const chain = resolveModelChain('claude', undefined)
    expect(chain.length).toBeGreaterThan(1)
    const r = run('claude-haiku-9', 1)
    await vi.waitFor(() => expect(r.resolved).toEqual([chain[1]]))
    expect(h.spawned.at(-1)).not.toContain('claude-haiku-9')
  })

  it('no pick leaves the first attempt on the adapter default', async () => {
    const r = run(undefined, 0)
    await vi.waitFor(() => expect(h.spawned.length).toBe(1))
    expect(r.resolved).toEqual([])
  })
})

describe('the model picked in the chat picker drives claude and codex runs', () => {
  const picked: Record<string, string> = { claude: 'claude-sonnet-picked', codex: 'gpt-picked' }
  let n = 0
  function spawnFor(backend: 'claude' | 'codex', opts: { model?: string; fast?: boolean; modelAttempt?: number } = {}): Promise<string> {
    const spy = vi.spyOn(PREFS, 'getChatModel').mockImplementation((b) => picked[b] ?? '')
    const before = h.spawned.length
    runBackend({
      backend,
      runId: `pick-${backend}-${++n}`,
      systemPrompt: 'sys',
      userPrompt: 'hi',
      runDir: '/tmp',
      onPhase: () => {},
      onDone: () => {},
      ...opts
    })
    return vi.waitFor(() => {
      expect(h.spawned.length).toBe(before + 1)
      return h.spawned.at(-1) as string
    }).finally(() => spy.mockRestore())
  }

  it('a plain run uses the saved pick', async () => {
    expect(await spawnFor('claude')).toContain('claude-sonnet-picked')
    expect(await spawnFor('codex')).toContain("-m 'gpt-picked'")
  })

  it('a model the caller names still wins over the saved pick', async () => {
    const cmd = await spawnFor('claude', { model: 'claude-haiku-9' })
    expect(cmd).toContain('claude-haiku-9')
    expect(cmd).not.toContain('claude-sonnet-picked')
  })

  it('a fast run and a fallback retry ignore the saved pick', async () => {
    expect(await spawnFor('claude', { fast: true })).not.toContain('claude-sonnet-picked')
    const retry = await spawnFor('claude', { modelAttempt: 1 })
    expect(retry).not.toContain('claude-sonnet-picked')
    expect(retry).toContain(resolveModelChain('claude', undefined)[1])
  })
})

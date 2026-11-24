import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  home: '',
  harnesses: [] as string[],
  out: {} as Record<string, string>,
  calls: [] as string[],
  running: true,
  startOk: true,
  starts: 0,
  installed: [] as string[],
  ensured: [] as string[]
}))

vi.mock('os', async (orig) => ({ ...(await orig<typeof import('os')>()), homedir: () => h.home }))
vi.mock('child_process', async (orig) => ({
  ...(await orig<typeof import('child_process')>()),
  execFile: (bin: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
    h.calls.push(bin)
    cb(null, h.out[bin] ?? '')
  }
}))
vi.mock('../../store/paths', () => ({ PATHS: { CODEX_CATALOG_FILE: '/nonexistent/catalog.json' } }))
vi.mock('../../platform', () => ({ clearBinaryCache: () => undefined, resolveBinary: (name: string) => `/bin/${name}` }))
vi.mock('../new-agent-sink', () => ({ availableHarnesses: () => h.harnesses, defaultCodeUiHarness: () => 'claude' }))
vi.mock('../../capture/binaries', () => ({ installCliPackage: async () => undefined }))
vi.mock('../../backend/local-models', () => ({
  isOllamaRunning: async () => h.running,
  listCodingModels: async () => h.installed,
  ensureAgentModel: async (model: string) => {
    h.ensured.push(model)
    return model === 'broken:1b' ? { error: 'pull failed' } : { model: `${model}-agent` }
  },
  pullOllamaModel: async () => true
}))
vi.mock('../../backend/local-setup', () => ({
  setUpLocalBackend: async () => {
    h.starts++
    if (h.startOk) h.running = true
    return { ok: h.startOk }
  }
}))
vi.mock('../../backend/openrouter', () => ({
  hasOpenRouterKey: async () => false,
  listOpenRouterModels: async () => [],
  openRouterThinks: () => false,
  openRouterMeta: () => undefined
}))

const { clearAntigravityModelCache, listAgentModels, ollamaLaunch } = await import('../agent-models')

const NOW = 1_800_000_000_000
const CURSOR_OUT = 'Available models\n\ngpt-6 - GPT-6 (current)\nsonnet-5 - Claude Sonnet 5\n'
const AGY_OUT = 'gemini-3-pro\tGemini 3 Pro\n'
const models = async (harness: string): Promise<string[]> =>
  (await listAgentModels()).filter((o) => o.harness === harness && o.model).map((o) => `${o.model}=${o.label}`)

beforeEach(() => {
  h.home = mkdtempSync(join(tmpdir(), 'mm-agent-lists-'))
  h.calls = []
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(h.home, { recursive: true, force: true })
})

describe('model lists: one shared 5-minute expiring cache', () => {
  it('Cursor: reuses the list inside 5 minutes, asks the CLI again after', async () => {
    h.harnesses = ['cursor']
    h.out['/bin/cursor-agent'] = CURSOR_OUT
    expect(await models('cursor')).toEqual(['gpt-6=GPT-6', 'sonnet-5=Claude Sonnet 5'])
    vi.setSystemTime(NOW + 4 * 60_000)
    h.out['/bin/cursor-agent'] = 'gpt-7 - GPT-7\n'
    expect(await models('cursor')).toEqual(['gpt-6=GPT-6', 'sonnet-5=Claude Sonnet 5'])
    vi.setSystemTime(NOW + 5 * 60_000 + 1)
    expect(await models('cursor')).toEqual(['gpt-7=GPT-7'])
    expect(h.calls.filter((c) => c === '/bin/cursor-agent')).toHaveLength(2)
  })

  it('an empty answer is not kept, so the next look asks again', async () => {
    h.harnesses = ['opencode']
    vi.setSystemTime(NOW + 3_600_000)
    h.out['/bin/opencode'] = ''
    expect(await models('opencode')).toEqual([])
    h.out['/bin/opencode'] = 'opencode/grok-code\nnot a model line\n'
    expect((await models('opencode')).map((m) => m.split('=')[0])).toEqual(['opencode/grok-code'])
    expect(h.calls.filter((c) => c === '/bin/opencode')).toHaveLength(2)
  })

  it('Antigravity: a plan change clears the list right away', async () => {
    h.harnesses = ['antigravity']
    vi.setSystemTime(NOW + 7_200_000)
    h.out['/bin/agy'] = AGY_OUT
    expect(await models('antigravity')).toEqual(['gemini-3-pro=Gemini 3 Pro'])
    h.out['/bin/agy'] = 'gemini-3-ultra\tGemini 3 Ultra\n'
    expect(await models('antigravity')).toEqual(['gemini-3-pro=Gemini 3 Pro'])
    clearAntigravityModelCache()
    expect(await models('antigravity')).toEqual(['gemini-3-ultra=Gemini 3 Ultra'])
  })
})

describe('ollamaLaunch', () => {
  beforeEach(() => {
    h.running = true
    h.startOk = true
    h.starts = 0
    h.installed = []
    h.ensured = []
  })

  it('starts Ollama when it is off, then runs the model asked for', async () => {
    h.running = false
    const got = await ollamaLaunch('qwen3-coder:30b')
    expect(h.starts).toBe(1)
    expect(got).toMatchObject({ model: 'qwen3-coder:30b-agent', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434', ANTHROPIC_DEFAULT_OPUS_MODEL: 'qwen3-coder:30b-agent', MM_AGENT_MODEL: 'Qwen3-coder 30B' } })
  })

  it('does not try to start Ollama when it is already running', async () => {
    await ollamaLaunch('qwen3-coder:30b')
    expect(h.starts).toBe(0)
  })

  it('says so when Ollama cannot be started, without picking a model', async () => {
    h.running = false
    h.startOk = false
    expect(await ollamaLaunch('qwen3-coder:30b')).toEqual({ error: "Ollama isn't running and couldn't be started." })
    expect(h.ensured).toEqual([])
  })

  it('picks the first installed model when none is named', async () => {
    h.installed = ['gpt-oss:20b', 'qwen3-coder:30b']
    expect(await ollamaLaunch('')).toMatchObject({ model: 'gpt-oss:20b-agent' })
  })

  it('no model named and none installed points to Settings', async () => {
    expect(await ollamaLaunch('')).toEqual({ error: 'No local model is downloaded yet. Pick one in Settings.' })
  })

  it("passes the model setup's error through", async () => {
    expect(await ollamaLaunch('broken:1b')).toEqual({ error: 'pull failed' })
  })
})

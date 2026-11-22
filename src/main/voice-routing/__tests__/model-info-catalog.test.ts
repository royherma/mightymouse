import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ home: '', harnesses: [] as string[], openrouter: {} as Record<string, unknown> }))

vi.mock('os', async (orig) => ({ ...(await orig<typeof import('os')>()), homedir: () => h.home }))
vi.mock('../../store/paths', () => ({
  PATHS: {
    get CODEX_CATALOG_FILE() {
      return join(h.home, 'mm-data', 'codex-model-catalog.json')
    }
  }
}))
vi.mock('../../platform', () => ({ clearBinaryCache: () => undefined, resolveBinary: () => '' }))
vi.mock('../new-agent-sink', () => ({ availableHarnesses: () => h.harnesses, defaultCodeUiHarness: () => 'claude' }))
vi.mock('../../capture/binaries', () => ({ installCliPackage: async () => undefined }))
vi.mock('../../backend/local-models', () => ({ listCodingModels: async () => [] }))
vi.mock('../../backend/local-setup', () => ({}))
vi.mock('../../backend/openrouter', () => ({
  hasOpenRouterKey: () => false,
  listOpenRouterModels: async () => Object.keys(h.openrouter),
  openRouterThinks: () => false,
  openRouterMeta: (id: string) => h.openrouter[id]
}))

const CATALOG = {
  anthropic: { name: 'Anthropic', models: { 'claude-opus-5': { name: 'Claude Opus 5', release_date: '2026-08-01', limit: { context: 1_000_000 }, cost: { input: 5, output: 25 }, modalities: { input: ['text', 'image', 'pdf'] } } } },
  openai: { name: 'OpenAI', models: { 'gpt-6': { name: 'GPT-6', release_date: '2026-09-01', cost: { input: 2, output: 8 }, modalities: { input: ['text'] } } } },
  moonshotai: { name: 'Moonshot AI (China)', models: { 'kimi-k3': { name: 'Kimi K3', cost: { input: 0.6, output: 2.5 } } } },
  zai: { name: 'Z.AI', models: {} },
  openrouter: {
    name: 'OpenRouter',
    models: {
      'z-ai/glm-5': { name: 'GLM 5', release_date: '2026-07-01', cost: { input: 0.5, output: 2 } },
      'anthropic/claude-opus-5': { name: 'Claude Opus 5', cost: { input: 5, output: 25 } }
    }
  },
  'opencode-go': { name: 'OpenCode Go', models: { 'kimi-k3': { name: 'Kimi K3', cost: { input: 0.6, output: 2.5 } } } },
  fireworks: { name: 'Fireworks', models: {} }
}

async function load(): Promise<typeof import('../agent-models')> {
  vi.resetModules()
  return import('../agent-models')
}

beforeEach(() => {
  h.home = mkdtempSync(join(tmpdir(), 'mm-model-info-'))
  mkdirSync(join(h.home, '.codex'))
  mkdirSync(join(h.home, 'mm-data'))
  mkdirSync(join(h.home, '.cache', 'opencode'), { recursive: true })
  writeFileSync(join(h.home, '.cache', 'opencode', 'models.json'), JSON.stringify(CATALOG))
  vi.stubEnv('XDG_CACHE_HOME', '')
  h.harnesses = []
  h.openrouter = {
    'inkling/inkling-2-mini': {
      name: 'Inkling: Inkling 2 Mini',
      created: 1_795_000_000,
      description: 'A small fast model. Good at code.',
      context_length: 200_000,
      pricing: { prompt: '0.0000004', completion: '0.0000016' },
      architecture: { input_modalities: ['text', 'image', 'file'] }
    }
  }
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(h.home, { recursive: true, force: true })
})

describe('chatModelInfo: the hover card for chat models', () => {
  it('shows per-token prices for an OpenRouter model, with the maker read from the model id', async () => {
    const { chatModelInfo } = await load()
    const out = await chatModelInfo(['openrouter:z-ai/glm-5'])
    expect(out['openrouter:z-ai/glm-5']).toEqual({ name: 'GLM 5', maker: 'Z.AI', released: '2026-07-01', description: undefined, context: undefined, price: { input: 0.5, output: 2 }, reads: undefined })
  })

  it('hides the price for MightyMouse models, which run on the plan and not per token', async () => {
    const { chatModelInfo } = await load()
    const out = await chatModelInfo(['mightymouse:anthropic/claude-opus-5'])
    expect(out['mightymouse:anthropic/claude-opus-5']).toMatchObject({ name: 'Claude Opus 5', maker: 'Anthropic' })
    expect(out['mightymouse:anthropic/claude-opus-5'].price).toBeUndefined()
  })

  it('hides the price for an OpenCode Go subscription model', async () => {
    const { chatModelInfo } = await load()
    const out = await chatModelInfo(['opencode:opencode-go/kimi-k3'])
    expect(out['opencode:opencode-go/kimi-k3']).toMatchObject({ name: 'Kimi K3' })
    expect(out['opencode:opencode-go/kimi-k3'].price).toBeUndefined()
  })

  it("falls back to the model maker's own catalog entry and drops the region from its name", async () => {
    const { chatModelInfo } = await load()
    const out = await chatModelInfo(['opencode:fireworks/kimi-k3'])
    expect(out['opencode:fireworks/kimi-k3']).toMatchObject({ name: 'Kimi K3', maker: 'Moonshot AI', price: { input: 0.6, output: 2.5 } })
  })

  it('reads an OpenRouter model newer than the catalog from OpenRouter itself, priced per million tokens', async () => {
    const { chatModelInfo } = await load()
    const info = (await chatModelInfo(['opencode:openrouter/inkling/inkling-2-mini']))['opencode:openrouter/inkling/inkling-2-mini']
    expect(info).toMatchObject({
      name: 'Inkling 2 Mini',
      maker: 'Inkling',
      released: new Date(1_795_000_000 * 1000).toISOString().slice(0, 10),
      description: 'A small fast model.',
      context: 200_000,
      reads: ['image']
    })
    expect(info.price?.input).toBeCloseTo(0.4)
    expect(info.price?.output).toBeCloseTo(1.6)
  })

  it('leaves out models nobody has details for and sources with no catalog', async () => {
    const { chatModelInfo } = await load()
    expect(await chatModelInfo(['openrouter:nobody/unknown', 'ollama:llama3', 'opencode:opencode/'])).toEqual({})
  })

  it('shows no price when OpenRouter lists a model without pricing', async () => {
    h.openrouter = { 'inkling/inkling-2-mini': { name: 'Inkling 2 Mini' } }
    const { chatModelInfo } = await load()
    const info = (await chatModelInfo(['opencode:openrouter/inkling/inkling-2-mini']))['opencode:openrouter/inkling/inkling-2-mini']
    expect(info).toMatchObject({ name: 'Inkling 2 Mini' })
    expect(info.price).toBeUndefined()
  })
})

describe('listAgentModels: plan harnesses never show a per-token price', () => {
  it('a Codex model gets its catalog details but no price', async () => {
    h.harnesses = ['codex']
    writeFileSync(join(h.home, '.codex', 'models_cache.json'), JSON.stringify({ client_version: '0.130.0', models: [{ slug: 'gpt-6', display_name: 'GPT-6', visibility: 'list', priority: 1 }] }))
    const { listAgentModels } = await load()
    const gpt = (await listAgentModels()).find((o) => o.model === 'gpt-6')
    expect(gpt?.info).toMatchObject({ name: 'GPT-6', maker: 'OpenAI', released: '2026-09-01' })
    expect(gpt?.info?.price).toBeUndefined()
  })
})

describe('opencodeModelConfig: OpenCode is told about OpenRouter models its catalog lacks', () => {
  it('names a model the catalog does not have yet', async () => {
    const { opencodeModelConfig } = await load()
    expect(await opencodeModelConfig('openrouter/inkling/inkling-2-mini')).toEqual({
      provider: { openrouter: { models: { 'inkling/inkling-2-mini': { name: 'Inkling 2 Mini' } } } }
    })
  })

  it('adds nothing for a model the catalog already has, or a non-OpenRouter model', async () => {
    const { opencodeModelConfig } = await load()
    expect(await opencodeModelConfig('openrouter/z-ai/glm-5')).toEqual({})
    expect(await opencodeModelConfig('anthropic/claude-opus-5')).toEqual({})
  })

  it('the launch config keeps the mightymouse-code server next to the new model', async () => {
    const { opencodeModelConfig } = await load()
    const { opencodeRelayEnv } = await import('../../agent-relay/mcp-clients')
    const config = JSON.parse(opencodeRelayEnv(await opencodeModelConfig('openrouter/inkling/inkling-2-mini')).OPENCODE_CONFIG_CONTENT)
    expect(config.provider.openrouter.models['inkling/inkling-2-mini'].name).toBe('Inkling 2 Mini')
    expect(config.mcp['mightymouse-code']).toMatchObject({ type: 'local', enabled: true })
  })
})

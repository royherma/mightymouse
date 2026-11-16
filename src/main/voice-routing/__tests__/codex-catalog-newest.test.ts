import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ home: '' }))

vi.mock('os', async (orig) => ({ ...(await orig<typeof import('os')>()), homedir: () => h.home }))
vi.mock('../../store/paths', () => ({
  PATHS: {
    get CODEX_CATALOG_FILE() {
      return join(h.home, 'mm-data', 'codex-model-catalog.json')
    }
  }
}))
vi.mock('../../platform', () => ({ clearBinaryCache: () => undefined, resolveBinary: () => '' }))
vi.mock('../new-agent-sink', () => ({ availableHarnesses: () => [], defaultCodeUiHarness: () => 'claude' }))
vi.mock('../../capture/binaries', () => ({ installCliPackage: async () => undefined }))
vi.mock('../../backend/local-models', () => ({}))
vi.mock('../../backend/local-setup', () => ({}))
vi.mock('../../backend/openrouter', () => ({ hasOpenRouterKey: () => false, listOpenRouterModels: async () => [], openRouterThinks: () => false }))

const model = (slug: string, efforts: string[]): Record<string, unknown> => ({
  slug,
  display_name: slug.toUpperCase(),
  visibility: 'list',
  priority: 1,
  supported_reasoning_levels: efforts.map((effort) => ({ effort }))
})

function codexWrites(clientVersion: string | undefined, models: Array<Record<string, unknown>>): void {
  writeFileSync(join(h.home, '.codex', 'models_cache.json'), JSON.stringify({ client_version: clientVersion, models }))
}

async function efforts(slug: string): Promise<string[]> {
  const { agentReasoningEfforts } = await import('../agent-models')
  return agentReasoningEfforts('codex', slug)
}

async function restart(): Promise<void> {
  vi.resetModules()
}

beforeEach(async () => {
  h.home = mkdtempSync(join(tmpdir(), 'mm-codex-catalog-'))
  mkdirSync(join(h.home, '.codex'))
  mkdirSync(join(h.home, 'mm-data'))
  await restart()
})

afterEach(() => {
  rmSync(h.home, { recursive: true, force: true })
})

describe('the Codex model list keeps the newest catalog any Codex on the computer wrote', () => {
  it('an older Codex rewriting the shared file does not take away the newer models', async () => {
    codexWrites('0.130.0', [model('gpt-6.1-codex', ['low', 'high'])])
    expect(await efforts('gpt-6.1-codex')).toEqual(['low', 'high'])

    codexWrites('0.128.2', [model('gpt-5.9-codex', ['medium'])])
    expect(await efforts('gpt-6.1-codex')).toEqual(['low', 'high'])
    expect(await efforts('gpt-5.9-codex')).toEqual([])
  })

  it('versions compare as numbers: 0.130 is newer than 0.99', async () => {
    codexWrites('0.130.0', [model('gpt-6.1-codex', ['low'])])
    expect(await efforts('gpt-6.1-codex')).toEqual(['low'])
    codexWrites('0.99.0', [model('gpt-old', ['low'])])
    expect(await efforts('gpt-6.1-codex')).toEqual(['low'])
    expect(await efforts('gpt-old')).toEqual([])
  })

  it('a newer Codex, or the same version with a changed list, replaces it', async () => {
    codexWrites('0.130.0', [model('gpt-6.1-codex', ['low'])])
    expect(await efforts('gpt-6.1-codex')).toEqual(['low'])
    codexWrites('0.130.0', [model('gpt-6.1-codex', ['low', 'xhigh'])])
    expect(await efforts('gpt-6.1-codex')).toEqual(['low', 'xhigh'])
    codexWrites('0.131.0-alpha.2', [model('gpt-6.2-codex', ['medium'])])
    expect(await efforts('gpt-6.2-codex')).toEqual(['medium'])
    expect(await efforts('gpt-6.1-codex')).toEqual([])
  })

  it('the newest list survives an app restart even when the older Codex wrote the file last', async () => {
    codexWrites('0.130.0', [model('gpt-6.1-codex', ['high'])])
    expect(await efforts('gpt-6.1-codex')).toEqual(['high'])
    expect(existsSync(join(h.home, 'mm-data', 'codex-model-catalog.json'))).toBe(true)

    codexWrites('0.128.0', [model('gpt-5.9-codex', ['medium'])])
    await restart()
    expect(await efforts('gpt-6.1-codex')).toEqual(['high'])
    expect(JSON.parse(readFileSync(join(h.home, 'mm-data', 'codex-model-catalog.json'), 'utf8')).version).toEqual([0, 130, 0])
  })

  it('an empty or broken cache never wipes the kept list', async () => {
    codexWrites('0.130.0', [model('gpt-6.1-codex', ['high'])])
    expect(await efforts('gpt-6.1-codex')).toEqual(['high'])
    codexWrites('0.140.0', [])
    expect(await efforts('gpt-6.1-codex')).toEqual(['high'])
    writeFileSync(join(h.home, '.codex', 'models_cache.json'), '{"models": [')
    expect(await efforts('gpt-6.1-codex')).toEqual(['high'])
  })
})

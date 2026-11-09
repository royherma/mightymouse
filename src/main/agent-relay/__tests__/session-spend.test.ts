import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const cacheFile = vi.hoisted(() => ({ path: '' }))

vi.mock('../../store/paths', () => ({
  PATHS: {
    get AGENT_SPEND_CACHE() {
      return cacheFile.path
    }
  }
}))

const costLine = (usd: unknown, models: Record<string, Record<string, unknown>>): string =>
  JSON.stringify({ type: 'cost-state', totalCostUSD: usd, modelUsage: models })

function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'mm-spend-'))
  mkdirSync(join(home, '.claude', 'projects'), { recursive: true })
  cacheFile.path = join(home, 'agent-spend-cache.json')
  return home
}

function transcript(home: string, project: string, name: string, lines: string[], root = '.claude'): string {
  const dir = join(home, root, 'projects', project)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, lines.join('\n') + '\n')
  return path
}

async function load(): Promise<typeof import('../session-spend')> {
  vi.resetModules()
  return import('../session-spend')
}

describe('readAgentSpend', () => {
  it('takes the last running total and sums tokens across every model', async () => {
    const home = newHome()
    const path = transcript(home, '-Users-ada-app', 'a.jsonl', [
      '{"type":"user","message":"hi"}',
      costLine(0.5, { 'claude-opus-5-5': { inputTokens: 1, outputTokens: 1 } }),
      '{"type":"assistant","message":"ok"}',
      costLine(1.25, {
        'claude-opus-5-5': { inputTokens: 100, outputTokens: 40, cacheReadInputTokens: 900, cacheCreationInputTokens: 50 },
        'claude-haiku-4-5': { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 5 }
      }),
      '{"type":"assistant","message":"after the total"}'
    ])
    const { readAgentSpend } = await load()
    expect(await readAgentSpend(home)).toEqual([
      { at: statSync(path).mtimeMs, usd: 1.25, input: 110, output: 42, cacheRead: 900, cacheWrite: 55 }
    ])
  })

  it('skips transcripts with no total or a broken total line', async () => {
    const home = newHome()
    transcript(home, 'p', 'plain.jsonl', ['{"type":"user","message":"hi"}'])
    transcript(home, 'p', 'broken.jsonl', ['{"type":"cost-state","totalCostUSD":1.5,"modelUsage":{'])
    transcript(home, 'p', 'notes.txt', [costLine(9, {})])
    const { readAgentSpend } = await load()
    expect(await readAgentSpend(home)).toEqual([])
  })

  it('reads a non-number cost or token field as zero, never NaN', async () => {
    const home = newHome()
    transcript(home, 'p', 'a.jsonl', [costLine('1.5', { m: { inputTokens: null, outputTokens: 7, cacheReadInputTokens: 'x' } })])
    const { readAgentSpend } = await load()
    const [row] = await readAgentSpend(home)
    expect(row).toMatchObject({ usd: 0, input: 0, output: 7, cacheRead: 0, cacheWrite: 0 })
  })

  it('counts transcripts under a second Claude account folder', async () => {
    const home = newHome()
    transcript(home, 'p', 'a.jsonl', [costLine(1, {})])
    transcript(home, 'p', 'b.jsonl', [costLine(2, {})], '.claude-work')
    writeFileSync(join(home, '.claude', 'projects', 'stray.jsonl'), costLine(99, {}))
    const { readAgentSpend } = await load()
    const usd = (await readAgentSpend(home)).map((r) => r.usd).sort()
    expect(usd).toEqual([1, 2])
  })

  it('reuses the saved row for an unchanged file and rereads a changed one', async () => {
    const home = newHome()
    const path = transcript(home, 'p', 'a.jsonl', [costLine(1, {})])
    const pinned = 1_700_000_000
    utimesSync(path, pinned, pinned)
    const first = await load()
    expect((await first.readAgentSpend(home)).map((r) => r.usd)).toEqual([1])
    expect(JSON.parse(readFileSync(cacheFile.path, 'utf-8'))).toHaveLength(1)

    writeFileSync(path, costLine(7, {}) + '\n')
    utimesSync(path, pinned, pinned)
    const second = await load()
    expect((await second.readAgentSpend(home)).map((r) => r.usd)).toEqual([1])

    writeFileSync(path, costLine(8.5, {}) + '\n')
    const third = await load()
    expect((await third.readAgentSpend(home)).map((r) => r.usd)).toEqual([8.5])
  })
})

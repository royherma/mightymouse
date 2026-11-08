import { beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'

vi.mock('../../store/paths', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const dir = mkdtempSync(path.join(tmpdir(), 'mm-resource-history-'))
  return { PATHS: { RESOURCE_HISTORY: path.join(dir, 'resource-history.jsonl') } }
})
vi.mock('../../store/prefs', () => ({ PREFS: { getIncognito: () => false } }))

import { PATHS } from '../../store/paths'
import { pruneCoarseHistory } from '../history'

const DAY = 24 * 60 * 60 * 1000
const FILE = PATHS.RESOURCE_HISTORY
const row = (ageMs: number, totalCores = 8): string =>
  JSON.stringify({ ts: new Date(Date.now() - ageMs).toISOString(), totalCores, top: [] })
const lines = (): string[] => readFileSync(FILE, 'utf-8').split('\n').filter(Boolean)

beforeEach(() => {
  rmSync(FILE, { force: true })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('pruneCoarseHistory', () => {
  it('drops rows older than a week and keeps the newer ones byte for byte, in order', async () => {
    const fresh = [row(6 * DAY), row(DAY), row(1000)]
    writeFileSync(FILE, [row(30 * DAY), row(8 * DAY), ...fresh].join('\n') + '\n')
    await pruneCoarseHistory()
    expect(lines()).toEqual(fresh)
    expect(readFileSync(FILE, 'utf-8').endsWith('\n')).toBe(true)
  })

  it('honours a custom age limit', async () => {
    const recent = row(1000)
    writeFileSync(FILE, [row(2 * DAY), recent].join('\n') + '\n')
    await pruneCoarseHistory(DAY)
    expect(lines()).toEqual([recent])
  })

  it('reads the time of a row whose keys are in another order', async () => {
    const reordered = JSON.stringify({ totalCores: 8, top: [], ts: new Date(Date.now() - 1000).toISOString() })
    const reorderedOld = JSON.stringify({ totalCores: 8, top: [], ts: new Date(Date.now() - 9 * DAY).toISOString() })
    writeFileSync(FILE, [reorderedOld, reordered].join('\n') + '\n')
    await pruneCoarseHistory()
    expect(lines()).toEqual([reordered])
  })

  it('drops rows it cannot read: broken JSON, a bad time, a half-written line', async () => {
    const good = row(1000)
    writeFileSync(FILE, ['not json', '{"ts":"yesterday-ish","totalCores":8}', good, '{"ts":"2026-'].join('\n') + '\n')
    await pruneCoarseHistory()
    expect(lines()).toEqual([good])
  })

  it('leaves the file untouched when nothing is old', async () => {
    writeFileSync(FILE, [row(DAY), row(1000)].join('\n') + '\n')
    const longAgo = new Date(Date.now() - 60_000)
    utimesSync(FILE, longAgo, longAgo)
    const before = statSync(FILE).mtimeMs
    await pruneCoarseHistory()
    expect(statSync(FILE).mtimeMs).toBe(before)
  })

  it('empties the file when every row is old, and does not create one that was never there', async () => {
    writeFileSync(FILE, [row(9 * DAY), row(10 * DAY)].join('\n') + '\n')
    await pruneCoarseHistory()
    expect(readFileSync(FILE, 'utf-8')).toBe('')
    rmSync(FILE)
    await pruneCoarseHistory()
    expect(existsSync(FILE)).toBe(false)
  })
})

import { appendFileSync } from 'fs'
import { readFile, writeFile } from 'fs/promises'
import { PATHS } from '../store/paths'
import { PREFS } from '../store/prefs'
import type { ResourceRow, ResourceTrendPoint } from '../../shared/types'

const FINE_TIER_SAMPLES = 120
const COARSE_INTERVAL_MS = 30_000
const COARSE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const COARSE_TOP_N = 10

interface FineSample {
  at: number
  byId: Map<string, number>
  memById: Map<string, number>
}

const fineSamples: FineSample[] = []

function sumValues(map: Map<string, number>): number {
  let n = 0
  for (const v of map.values()) n += v
  return n
}

export function recordFineSample(rows: ResourceRow[]): void {
  const byId = new Map<string, number>()
  const memById = new Map<string, number>()
  for (const row of rows) {
    byId.set(row.id, row.cores)
    memById.set(row.id, row.memBytes)
  }
  fineSamples.push({ at: Date.now(), byId, memById })
  if (fineSamples.length > FINE_TIER_SAMPLES) fineSamples.shift()
}

export function sparkFor(id: string): { cores: number[]; mem: number[] } {
  return {
    cores: fineSamples.map((s) => s.byId.get(id) ?? 0),
    mem: fineSamples.map((s) => s.memById.get(id) ?? 0)
  }
}

export function getTrend(): ResourceTrendPoint[] {
  return fineSamples.map((s) => ({
    at: s.at,
    usedCores: sumValues(s.byId),
    usedMemBytes: sumValues(s.memById),
    byId: Object.fromEntries(s.byId),
    memById: Object.fromEntries(s.memById)
  }))
}

interface CoarseRow {
  ts: string
  totalCores: number
  top: Array<{ id: string; cores: number; memBytes: number }>
}

function appendCoarseRow(rows: ResourceRow[], totalCores: number): void {
  if (PREFS.getIncognito()) return
  try {
    const top = [...rows]
      .sort((a, b) => b.cores - a.cores)
      .slice(0, COARSE_TOP_N)
      .map((r) => ({ id: r.id, cores: r.cores, memBytes: r.memBytes }))
    const row: CoarseRow = { ts: new Date().toISOString(), totalCores, top }
    appendFileSync(PATHS.RESOURCE_HISTORY, JSON.stringify(row) + '\n', 'utf-8')
  } catch (err) {
    console.error('Failed to append resource history:', err)
  }
}

const TS_PREFIX = '{"ts":"'

function coarseRowTime(line: string): number {
  if (line.startsWith(TS_PREFIX))
    return Date.parse(line.slice(TS_PREFIX.length, line.indexOf('"', TS_PREFIX.length)))
  try {
    return new Date((JSON.parse(line) as CoarseRow).ts).getTime()
  } catch {
    return NaN
  }
}

export async function pruneCoarseHistory(maxAgeMs = COARSE_MAX_AGE_MS): Promise<void> {
  try {
    const text = await readFile(PATHS.RESOURCE_HISTORY, 'utf-8').catch(() => null)
    if (text === null) return
    const cutoff = Date.now() - maxAgeMs
    const lines = text.split('\n').filter((line) => line.trim())
    const kept = lines.filter((line) => coarseRowTime(line.trim()) >= cutoff)
    if (kept.length === lines.length) return
    await writeFile(PATHS.RESOURCE_HISTORY, kept.length ? kept.join('\n') + '\n' : '', 'utf-8')
  } catch (err) {
    console.error('Failed to prune resource history:', err)
  }
}

let coarseStarted = false

export function startResourceHistory(getLatest: () => { rows: ResourceRow[]; totalCores: number } | null): void {
  if (coarseStarted) return
  coarseStarted = true
  // The first append must wait for the prune: its rewrite would drop a row appended mid-way.
  void pruneCoarseHistory().then(() => {
    setInterval(() => {
      const latest = getLatest()
      if (!latest) return
      appendCoarseRow(latest.rows, latest.totalCores)
    }, COARSE_INTERVAL_MS)
  })
}

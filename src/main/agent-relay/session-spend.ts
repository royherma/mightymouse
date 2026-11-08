import { existsSync, readFileSync, writeFileSync } from 'fs'
import { open, readdir, stat } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { PATHS } from '../store/paths'
import { claudeConfigRoots } from './session-transcript'

export interface AgentSpendRow {
  at: number
  usd: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

interface CacheEntry {
  size: number
  mtimeMs: number
  row: AgentSpendRow | null
}

// Claude appends its running session total as the last line; 64KB clears the odd trailing blob line.
const TAIL_BYTES = 64 * 1024
const READ_CONCURRENCY = 64
const COST_MARKER = '{"type":"cost-state"'

let cache: Map<string, CacheEntry> | null = null
let inflight: Promise<AgentSpendRow[]> | null = null

function loadCache(): Map<string, CacheEntry> {
  if (cache) return cache
  cache = new Map()
  if (!existsSync(PATHS.AGENT_SPEND_CACHE)) return cache
  try {
    for (const [path, entry] of JSON.parse(readFileSync(PATHS.AGENT_SPEND_CACHE, 'utf-8')) as [string, CacheEntry][]) {
      cache.set(path, entry)
    }
  } catch {
    cache.clear()
  }
  return cache
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function parseCostState(tail: string, at: number): AgentSpendRow | null {
  const start = tail.lastIndexOf(COST_MARKER)
  if (start < 0) return null
  const end = tail.indexOf('\n', start)
  let state: { totalCostUSD?: unknown; modelUsage?: Record<string, Record<string, unknown>> }
  try {
    state = JSON.parse(tail.slice(start, end < 0 ? undefined : end))
  } catch {
    return null
  }
  const row: AgentSpendRow = { at, usd: num(state.totalCostUSD), input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  for (const m of Object.values(state.modelUsage ?? {})) {
    row.input += num(m.inputTokens)
    row.output += num(m.outputTokens)
    row.cacheRead += num(m.cacheReadInputTokens)
    row.cacheWrite += num(m.cacheCreationInputTokens)
  }
  return row
}

async function readTail(path: string, size: number): Promise<string> {
  const len = Math.min(TAIL_BYTES, size)
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, size - len)
    return buf.toString('utf8')
  } finally {
    await fh.close()
  }
}

async function transcriptFiles(home: string): Promise<string[]> {
  const files: string[] = []
  for (const root of claudeConfigRoots(home)) {
    const projects = join(root, 'projects')
    let dirs: string[]
    try {
      dirs = await readdir(projects)
    } catch {
      continue
    }
    await Promise.all(
      dirs.map(async (dir) => {
        try {
          for (const name of await readdir(join(projects, dir))) {
            if (name.endsWith('.jsonl')) files.push(join(projects, dir, name))
          }
        } catch {
          // A stray file at the projects level, not a project dir.
        }
      })
    )
  }
  return files
}

async function scan(home: string): Promise<AgentSpendRow[]> {
  const known = loadCache()
  const files = await transcriptFiles(home)
  const next = new Map<string, CacheEntry>()
  let changed = files.length !== known.size
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < files.length) {
      const path = files[cursor++]
      try {
        const s = await stat(path)
        const prev = known.get(path)
        if (prev && prev.size === s.size && prev.mtimeMs === s.mtimeMs) {
          next.set(path, prev)
          continue
        }
        changed = true
        next.set(path, { size: s.size, mtimeMs: s.mtimeMs, row: parseCostState(await readTail(path, s.size), s.mtimeMs) })
      } catch {
        // Deleted between readdir and stat.
      }
    }
  }
  await Promise.all(Array.from({ length: READ_CONCURRENCY }, worker))
  cache = next
  if (changed) {
    try {
      writeFileSync(PATHS.AGENT_SPEND_CACHE, JSON.stringify([...next]), 'utf-8')
    } catch (err) {
      console.error('Failed to write agent spend cache:', err)
    }
  }
  const rows: AgentSpendRow[] = []
  for (const entry of next.values()) if (entry.row) rows.push(entry.row)
  return rows
}

export function readAgentSpend(home = homedir()): Promise<AgentSpendRow[]> {
  inflight ??= scan(home).finally(() => {
    inflight = null
  })
  return inflight
}

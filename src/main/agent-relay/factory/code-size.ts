import { spawn } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { resolveBinary } from '../../platform'
import { PATHS } from '../../store/paths'
import type { CodeSize, CodeSizePoint } from '../../../shared/factory'

const CACHE_FILE = join(PATHS.ROOT, 'factory-code-size.json')
const EMPTY_SHA = /^0+$/
const CODE_EXT = new Set(
  'ts tsx js jsx mjs cjs mts cts py swift go rs rb java kt kts scala c h cc cpp hpp m mm cs php css scss less html vue svelte sql sh zsh bash lua dart ex exs erl clj hs ml r jl zig'.split(
    ' '
  )
)
const SKIP_DIR = /(^|\/)(node_modules|dist|build|out|vendor|Pods|\.next|coverage)\//

type CacheEntry = CodeSize & { head: string }

const inFlight = new Map<string, Promise<CodeSize>>()

export function isCodeFile(path: string): boolean {
  if (SKIP_DIR.test(path) || /\.min\.[a-z]+$/.test(path)) return false
  const dot = path.lastIndexOf('.')
  return dot > path.lastIndexOf('/') && CODE_EXT.has(path.slice(dot + 1).toLowerCase())
}

function readCache(): Record<string, CacheEntry> {
  try {
    return existsSync(CACHE_FILE) ? JSON.parse(readFileSync(CACHE_FILE, 'utf8')) : {}
  } catch {
    return {}
  }
}

function run(bin: string, cwd: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd })
    const out: Buffer[] = []
    let err = ''
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve(Buffer.concat(out).toString('utf8')) : reject(new Error(err.trim()))
    )
    if (input !== undefined) child.stdin.end(input)
  })
}

type Change = { at: number; lines: number; files: number; oldSha: string; newSha: string }

function parseLog(text: string): Change[] {
  const changes: Change[] = []
  const pending = new Map<string, Change>()
  let at = 0
  for (const line of text.split('\n')) {
    if (line.startsWith('@')) {
      at = Number(line.slice(1)) * 1000
      pending.clear()
    } else if (line.startsWith(':')) {
      const [meta, path] = line.split('\t')
      if (!path || !isCodeFile(path)) continue
      const [, , oldSha, newSha, status] = meta.split(' ')
      const files = status === 'A' ? 1 : status === 'D' ? -1 : 0
      const change = { at, lines: 0, files, oldSha, newSha }
      pending.set(path, change)
      changes.push(change)
    } else if (line) {
      const [added, removed, path] = line.split('\t')
      const change = path ? pending.get(path) : undefined
      if (change && added !== '-') change.lines = Number(added) - Number(removed)
    }
  }
  return changes
}

async function blobSizes(
  bin: string,
  cwd: string,
  changes: Change[]
): Promise<Map<string, number>> {
  const shas = new Set<string>()
  for (const change of changes) {
    if (!EMPTY_SHA.test(change.oldSha)) shas.add(change.oldSha)
    if (!EMPTY_SHA.test(change.newSha)) shas.add(change.newSha)
  }
  const sizes = new Map<string, number>()
  if (shas.size === 0) return sizes
  const text = await run(
    bin,
    cwd,
    ['cat-file', '--batch-check=%(objectname) %(objectsize)'],
    [...shas].join('\n') + '\n'
  )
  for (const line of text.split('\n')) {
    const [sha, size] = line.split(' ')
    if (sha && size && /^\d+$/.test(size)) sizes.set(sha, Number(size))
  }
  return sizes
}

function startOfDay(ms: number): number {
  const day = new Date(ms)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

async function measure(repoRoot: string, ref: string): Promise<CodeSize> {
  const bin = resolveBinary('git')
  if (!bin) throw new Error('git is not on this Mac.')
  const head = (await run(bin, repoRoot, ['rev-parse', ref || 'HEAD'])).trim()
  const cache = readCache()
  const prior = cache[repoRoot]
  if (prior?.head === head) return prior

  let base: CacheEntry = { head: '', lines: 0, files: 0, bytes: 0, points: [] }
  let range = head
  if (prior?.head) {
    const extends_ = await run(bin, repoRoot, ['merge-base', '--is-ancestor', prior.head, head])
      .then(() => true)
      .catch(() => false)
    if (extends_) {
      base = prior
      range = `${prior.head}..${head}`
    }
  }

  const log = await run(bin, repoRoot, [
    'log',
    range,
    '--first-parent',
    '--diff-merges=first-parent',
    '--no-renames',
    '--raw',
    '--numstat',
    '--no-abbrev',
    '--format=@%ct'
  ])
  const changes = parseLog(log).reverse()
  const sizes = await blobSizes(bin, repoRoot, changes)
  const points: CodeSizePoint[] = base.points.slice()
  let { lines, files, bytes } = base
  for (const change of changes) {
    lines += change.lines
    files += change.files
    bytes += (sizes.get(change.newSha) ?? 0) - (sizes.get(change.oldSha) ?? 0)
    const day = startOfDay(change.at)
    const last = points[points.length - 1]
    if (last?.at === day) Object.assign(last, { lines, files, bytes })
    else points.push({ at: day, lines, files, bytes })
  }

  const next: CacheEntry = { head, lines, files, bytes, points }
  cache[repoRoot] = next
  writeFileSync(CACHE_FILE, JSON.stringify(cache))
  return next
}

export function factoryCodeSize(repoRoot: string, ref: string): Promise<CodeSize> {
  const key = `${repoRoot}\0${ref}`
  const running = inFlight.get(key)
  if (running) return running
  const job = measure(repoRoot, ref).finally(() => inFlight.delete(key))
  inFlight.set(key, job)
  return job
}

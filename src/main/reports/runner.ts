import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import {
  REPORT_CARD_TIMEOUT_MS,
  REPORT_STALE_MS,
  REPORTS_CONFIG_PATH,
  parseReportConfig,
  parseReportOutput,
  withGoal,
  type ProjectReport,
  type ReportCard,
  type ReportCardResult,
  type ReportOutput,
  type ReportRange
} from '../../shared/reports'
import { MIGHTY } from '../store/mighty'
import { PATHS } from '../store/paths'
import { KEYS } from '../keys/store'
import { parseEnvFile } from '../keys/scan-pure'
import { shell } from '../platform'
import { projectBrief, projectBusiness } from '../agent-relay/factory/execution'

const MAX_OUTPUT_BYTES = 512 * 1024
const PROJECT_ENV_FILES = ['.env', '.env.local', '.dev.vars']

interface CachedRange {
  results: Record<string, ReportCardResult>
  refreshedAt?: string
}
type Cache = Record<string, CachedRange>

const inFlight = new Map<string, Promise<ProjectReport>>()

function cachePath(projectId: string): string {
  return join(PATHS.ROOT, 'reports', `${projectId.replace(/[^a-z0-9-_]/gi, '_')}.json`)
}

async function readCache(projectId: string): Promise<Cache> {
  try {
    return JSON.parse(await readFile(cachePath(projectId), 'utf-8')) as Cache
  } catch {
    return {}
  }
}

async function writeCache(projectId: string, cache: Cache): Promise<void> {
  await mkdir(join(PATHS.ROOT, 'reports'), { recursive: true })
  await writeFile(cachePath(projectId), JSON.stringify(cache))
}

function readyKeyNames(projectId: string): string[] {
  const names = KEYS.list()
    .filter(
      (k) => (k.scope === projectId || k.scope === 'global') && k.status !== 'broken' && !k.hidden
    )
    .map((k) => k.name)
  return [...new Set(names)].sort()
}

async function projectEnv(folder: string): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  for (const file of PROJECT_ENV_FILES) {
    const text = await readFile(join(folder, file), 'utf-8').catch(() => null)
    if (text)
      for (const line of parseEnvFile(text))
        if (!found.has(line.name) && line.value) found.set(line.name, line.value)
  }
  return found
}

type KeyLookup = (name: string) => Promise<string | null>

function onceEach(): KeyLookup {
  const asked = new Map<string, Promise<string | null>>()
  return (name) => asked.get(name) ?? asked.set(name, KEYS.getValue(name)).get(name)!
}

async function resolveKeys(
  card: ReportCard,
  folder: string,
  saved: KeyLookup
): Promise<{ env: Record<string, string>; missing?: string }> {
  const env: Record<string, string> = {}
  let fileEnv: Map<string, string> | null = null
  for (const name of card.keys) {
    const value =
      (await saved(name)) ?? (fileEnv ??= await projectEnv(folder)).get(name) ?? null
    if (!value) return { env, missing: name }
    env[name] = value
  }
  return { env }
}

function redact(line: string, secrets: string[]): string {
  return secrets.reduce((s, v) => (v.length >= 6 ? s.split(v).join('•••') : s), line)
}

function lastLine(text: string): string {
  return (
    text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .pop() ?? ''
  )
}

function runCommand(
  cmd: string,
  cwd: string,
  env: Record<string, string>
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(shell.bin, shell.spawnArgs(cmd), {
      cwd,
      env: { ...shell.env(), ...env },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const kill = (): void => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
    const timer = setTimeout(() => ((timedOut = true), kill()), REPORT_CARD_TIMEOUT_MS)
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString()
      if (stdout.length > MAX_OUTPUT_BYTES) {
        stdout = stdout.slice(-MAX_OUTPUT_BYTES / 2)
        kill()
      }
    })
    child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-8192)))
    child.on('error', (e) => {
      stderr += e.message
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    })
  })
}

async function runCard(
  card: ReportCard,
  folder: string,
  vars: Record<string, string>,
  saved: KeyLookup,
  previous?: ReportCardResult
): Promise<ReportCardResult> {
  const started = Date.now()
  const done = (
    r: { ok: true; output: ReportOutput } | { ok: false; error: string; missingKey?: string }
  ): ReportCardResult => {
    const base = { ranAt: new Date().toISOString(), ms: Date.now() - started }
    if (r.ok) return { ...r, ...base }
    const lastGood = previous?.ok
      ? { output: previous.output, ranAt: previous.ranAt }
      : previous?.ok === false
        ? previous.lastGood
        : undefined
    return { ...r, ...base, lastGood }
  }
  const keys = await resolveKeys(card, folder, saved)
  if (keys.missing)
    return done({
      ok: false,
      error: `${keys.missing} is not saved in Keys.`,
      missingKey: keys.missing
    })

  const res = await runCommand(card.run, folder, { ...keys.env, ...vars })
  const secrets = Object.values(keys.env)
  if (res.timedOut)
    return done({ ok: false, error: `Took longer than ${REPORT_CARD_TIMEOUT_MS / 1000}s.` })
  if (res.code !== 0) {
    const why = redact(lastLine(res.stderr) || lastLine(res.stdout), secrets).slice(0, 200)
    return done({ ok: false, error: why || `The script stopped with exit code ${res.code}.` })
  }
  const output = parseReportOutput(res.stdout)
  return typeof output === 'string'
    ? done({ ok: false, error: output })
    : done({ ok: true, output })
}

async function loadConfig(
  projectId: string,
  env?: string
): Promise<
  Pick<ProjectReport, 'state' | 'problems' | 'cards' | 'envs' | 'env'> & { folder?: string }
> {
  const folder = MIGHTY.getProject(projectId)?.repoFolder || undefined
  if (!folder || !existsSync(folder))
    return { state: 'no-folder', problems: [], cards: [], envs: [] }
  const raw = await readFile(join(folder, REPORTS_CONFIG_PATH), 'utf-8').catch(() => null)
  if (raw === null) return { state: 'none', problems: [], cards: [], envs: [], folder }
  const parsed = parseReportConfig(raw, env)
  const { problems, envs } = parsed
  const cards = withGoal(parsed.cards, projectBrief(folder))
  const active = env && envs.includes(env) ? env : envs[0]
  return { state: cards.length ? 'ready' : 'invalid', problems, cards, envs, env: active, folder }
}

function slot(range: ReportRange, env?: string): string {
  return env ? `${env}:${range}` : String(range)
}

export async function getReport(
  projectId: string,
  range: ReportRange,
  env?: string
): Promise<ProjectReport> {
  const config = await loadConfig(projectId, env)
  const cached = (await readCache(projectId))[slot(range, config.env)]
  const ids = new Set(config.cards.map((c) => c.id))
  const results = Object.fromEntries(
    Object.entries(cached?.results ?? {}).filter(([id]) => ids.has(id))
  )
  return {
    projectId,
    state: config.state,
    problems: config.problems,
    cards: config.cards,
    results,
    range,
    envs: config.envs,
    env: config.env,
    refreshedAt: cached?.refreshedAt,
    running: inFlight.has(`${projectId}:${slot(range, config.env)}`),
    keyNames: readyKeyNames(projectId),
    business: config.folder ? projectBusiness(config.folder) : [],
    brief: config.folder ? projectBrief(config.folder) : undefined
  }
}

export function isStale(report: ProjectReport): boolean {
  if (report.state !== 'ready') return false
  if (report.cards.some((c) => !report.results[c.id])) return true
  return !report.refreshedAt || Date.now() - Date.parse(report.refreshedAt) > REPORT_STALE_MS
}

export async function refreshReport(
  projectId: string,
  range: ReportRange,
  env: string | undefined,
  onStart?: (r: ProjectReport) => void
): Promise<ProjectReport> {
  const config = await loadConfig(projectId, env)
  const key = slot(range, config.env)
  const running = inFlight.get(`${projectId}:${key}`)
  if (running) return running
  const job = (async () => {
    if (config.state !== 'ready' || !config.folder) return
    const folder = config.folder
    const cache = await readCache(projectId)
    const before = cache[key]?.results ?? {}
    const vars = { REPORT_DAYS: String(range), ...(config.env ? { REPORT_ENV: config.env } : {}) }
    onStart?.({ ...(await getReport(projectId, range, config.env)), running: true })
    const saved = onceEach()
    const results = await Promise.all(
      config.cards.map(
        async (c) => [c.id, await runCard(c, folder, vars, saved, before[c.id])] as const
      )
    )
    const fresh = await readCache(projectId)
    fresh[key] = { results: Object.fromEntries(results), refreshedAt: new Date().toISOString() }
    await writeCache(projectId, fresh)
  })()
    .finally(() => inFlight.delete(`${projectId}:${key}`))
    .then(() => getReport(projectId, range, config.env))
  inFlight.set(`${projectId}:${key}`, job)
  return job
}

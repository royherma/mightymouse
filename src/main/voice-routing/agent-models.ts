import { execFile } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { open, readdir, readFile, stat } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { PATHS } from '../store/paths'
import { clearBinaryCache, resolveBinary } from '../platform'
import { availableHarnesses, defaultCodeUiHarness } from './new-agent-sink'
import { installCliPackage } from '../capture/binaries'
import { ensureAgentModel, isOllamaRunning, listCodingModels, pullOllamaModel } from '../backend/local-models'
import { setUpLocalBackend } from '../backend/local-setup'
import { CONFIG } from '../../shared/config'
import { opencodeProblem } from '../backend/opencode-errors'
import { claudeModelLabel, prettyOllamaModel } from '../../shared/model-label'
import { CLAUDE_REASONING_EFFORTS, isReasoningEffort, opencodeSourceModels, showsOn, type ReasoningEffort, type SourceModel } from '../../shared/model-sources'
import { hasOpenRouterKey, listOpenRouterModels, openRouterMeta, openRouterThinks } from '../backend/openrouter'
import type { AgentModelChoice, AgentModelOption, AgentModelsState, AgentSetupProgress, ModelInfo } from '../../shared/types'

const CLAUDE_MODELS: ReadonlyArray<{ model: string; label: string }> = [
  { model: 'fable', label: 'Fable' },
  { model: 'opus', label: 'Opus' },
  { model: 'sonnet', label: 'Sonnet' },
  { model: 'haiku', label: 'Haiku' }
]

const CODEX_MODELS_CACHE = join(homedir(), '.codex', 'models_cache.json')

const CLAUDE_TRANSCRIPTS = join(homedir(), '.claude', 'projects')
const CLAUDE_SEEN_FILES = 300
const CLAUDE_SEEN_TAIL_BYTES = 256 * 1024
const CLAUDE_SEEN_TTL_MS = 30 * 60 * 1000
let claudeSeen: { at: number; ids: Promise<Map<string, string>> } | null = null

// The aliases (opus, fable…) carry no version, so read what they resolved to in the CLI's own recent transcripts.
async function scanClaudeVersions(): Promise<Map<string, string>> {
  const best = new Map<string, { id: string; rank: number }>()
  const dirs = await readdir(CLAUDE_TRANSCRIPTS).catch(() => [] as string[])
  const files: Array<{ path: string; mtime: number }> = []
  await Promise.all(dirs.map(async (d) => {
    const names = await readdir(join(CLAUDE_TRANSCRIPTS, d)).catch(() => [] as string[])
    await Promise.all(names.filter((n) => n.endsWith('.jsonl')).map(async (n) => {
      const path = join(CLAUDE_TRANSCRIPTS, d, n)
      const st = await stat(path).catch(() => null)
      if (st) files.push({ path, mtime: st.mtimeMs })
    }))
  }))
  files.sort((a, b) => b.mtime - a.mtime)
  for (const f of files.slice(0, CLAUDE_SEEN_FILES)) {
    const fh = await open(f.path, 'r').catch(() => null)
    if (!fh) continue
    try {
      const size = (await fh.stat()).size
      const len = Math.min(size, CLAUDE_SEEN_TAIL_BYTES)
      const buf = Buffer.alloc(len)
      await fh.read(buf, 0, len, size - len)
      for (const m of buf.toString('utf8').matchAll(/"model":"(claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?)"/g)) {
        const rank = Number(m[3]) * 100 + Number(m[4] ?? 0)
        if ((best.get(m[2])?.rank ?? -1) < rank) best.set(m[2], { id: m[1], rank })
      }
    } finally {
      await fh.close()
    }
  }
  return new Map([...best].map(([family, v]) => [family, claudeModelLabel(v.id)]))
}

function claudeVersionLabels(): Promise<Map<string, string>> {
  if (!claudeSeen || Date.now() - claudeSeen.at > CLAUDE_SEEN_TTL_MS) {
    claudeSeen = { at: Date.now(), ids: scanClaudeVersions().catch(() => new Map()) }
  }
  return claudeSeen.ids
}

interface CodexCachedModel {
  slug?: unknown
  display_name?: unknown
  visibility?: unknown
  priority?: unknown
  supported_reasoning_levels?: unknown
}

type CodexModel = { model: string; label: string; reasoningEfforts: ReasoningEffort[] }
type CodexCatalog = { version: number[]; models: CodexModel[] }
let newestCodexCatalog: CodexCatalog | null = null

function savedCodexCatalog(): CodexCatalog {
  try {
    const saved = JSON.parse(readFileSync(PATHS.CODEX_CATALOG_FILE, 'utf-8')) as CodexCatalog
    return Array.isArray(saved.version) && Array.isArray(saved.models) ? saved : { version: [], models: [] }
  } catch {
    return { version: [], models: [] }
  }
}

function isOlder(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0)
  }
  return false
}

// Every Codex on the computer (CLI, ChatGPT app) rewrites this one file with its own catalog, so keep the newest.
function codexModels(): CodexModel[] {
  newestCodexCatalog ??= savedCodexCatalog()
  const read = readCodexModels()
  if (read.models.length > 0 && !isOlder(read.version, newestCodexCatalog.version)) {
    if (JSON.stringify(read) !== JSON.stringify(newestCodexCatalog)) {
      try { writeFileSync(PATHS.CODEX_CATALOG_FILE, JSON.stringify(read), 'utf-8') } catch { /* read-only data dir keeps the in-memory copy */ }
    }
    newestCodexCatalog = read
  }
  return newestCodexCatalog.models
}

function readCodexModels(): CodexCatalog {
  try {
    const raw = JSON.parse(readFileSync(CODEX_MODELS_CACHE, 'utf-8')) as { models?: unknown; client_version?: unknown }
    if (!Array.isArray(raw.models)) return { version: [], models: [] }
    const version = String(raw.client_version ?? '').split(/[.-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0)
    const models = (raw.models as CodexCachedModel[])
      .filter((m) => m.visibility === 'list' && typeof m.slug === 'string' && m.slug !== '')
      .sort((a, b) => Number(a.priority ?? 0) - Number(b.priority ?? 0))
      .map((m) => ({
        model: m.slug as string,
        label: typeof m.display_name === 'string' ? m.display_name : (m.slug as string),
        reasoningEfforts: Array.isArray(m.supported_reasoning_levels)
          ? m.supported_reasoning_levels.flatMap((level) =>
              isReasoningEffort(level?.effort) ? [level.effort] : []
            )
          : []
      }))
    return { version, models }
  } catch {
    return { version: [], models: [] }
  }
}

export function agentReasoningEfforts(harness: string, model: string): ReasoningEffort[] {
  if (harness === 'codex') return codexModels().find((m) => m.model === model)?.reasoningEfforts ?? []
  if (harness === 'claude' && ['fable', 'opus', 'sonnet'].includes(model)) return CLAUDE_REASONING_EFFORTS
  return []
}

const MODEL_LIST_TTL_MS = 5 * 60_000

function expiringList<T>(load: () => Promise<T[]>): { get: () => Promise<T[]>; clear: () => void } {
  let cached: Promise<T[]> | null = null
  let cachedAt = 0
  return {
    get() {
      if (Date.now() - cachedAt > MODEL_LIST_TTL_MS) cached = null
      if (!cached) {
        cachedAt = Date.now()
        const pending: Promise<T[]> = load().then((models) => {
          if (models.length === 0 && cached === pending) cached = null
          return models
        })
        cached = pending
      }
      return cached
    },
    clear() {
      cached = null
    }
  }
}

const OPENCODE_LIST_TIMEOUT_MS = 15000

const opencodeList = expiringList<string>((): Promise<string[]> => {
  const bin = resolveBinary('opencode')
  if (!bin) return Promise.resolve([])
  return new Promise((resolve) => {
    execFile(
      bin,
      ['models'],
      { timeout: OPENCODE_LIST_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        resolve(
          err
            ? []
            : stdout
                .split('\n')
                .map((l) => l.trim())
                .filter((l) => /^[\w.-]+\/\S+$/.test(l))
        )
      }
    )
  })
})

const opencodeModels = opencodeList.get

const CURSOR_LIST_TIMEOUT_MS = 15000

const cursorList = expiringList<{ model: string; label: string }>(() => {
  const bin = resolveBinary('cursor-agent')
  if (!bin) return Promise.resolve([])
  return new Promise((resolve) => {
    execFile(bin, ['--list-models'], { timeout: CURSOR_LIST_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      resolve(
        err
          ? []
          : stdout.split('\n').flatMap((line) => {
              const m = /^\s*([\w.-]+)\s+-\s+(.+?)\s*$/.exec(line)
              return m ? [{ model: m[1], label: m[2].replace(/\s*\((current|default)\)$/i, '') }] : []
            })
      )
    })
  })
})

const cursorModels = cursorList.get

const AGY_LIST_TIMEOUT_MS = 20000

const agyList = expiringList<{ model: string; label: string }>(() => {
  const bin = resolveBinary('agy')
  if (!bin) return Promise.resolve([])
  return new Promise((resolve) => {
    execFile(bin, ['models'], { timeout: AGY_LIST_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      resolve(
        err
          ? []
          : stdout.split('\n').flatMap((line) => {
              const m = /^([\w.-]+)\t(.+?)\s*$/.exec(line)
              return m ? [{ model: m[1], label: m[2] }] : []
            })
      )
    })
  })
})

export function clearAntigravityModelCache(): void {
  agyList.clear()
}

const antigravityModels = agyList.get

// OpenCode keeps the models.dev catalog here: release dates, makers, context and prices for every provider.
const MODELS_DEV_CACHE = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'opencode', 'models.json')
const LABS = ['anthropic', 'openai', 'google', 'xai', 'deepseek', 'moonshotai', 'zai', 'alibaba', 'mistral', 'minimax', 'meta']
const MAKER_ALIAS: Record<string, string> = { 'z-ai': 'zai', 'x-ai': 'xai', 'meta-llama': 'meta', mistralai: 'mistral', qwen: 'alibaba' }

interface DevModel {
  name?: string
  description?: string
  release_date?: string
  limit?: { context?: number }
  cost?: { input?: number; output?: number }
  modalities?: { input?: string[] }
}
type DevCatalog = Record<string, { name?: string; models?: Record<string, DevModel> }>
let devCatalog: { mtime: number; data: Promise<DevCatalog> } | null = null

async function modelsDev(): Promise<DevCatalog> {
  const mtime = (await stat(MODELS_DEV_CACHE).catch(() => null))?.mtimeMs ?? 0
  if (!devCatalog || devCatalog.mtime !== mtime) {
    devCatalog = { mtime, data: readFile(MODELS_DEV_CACHE, 'utf8').then((t) => JSON.parse(t) as DevCatalog).catch(() => ({})) }
  }
  return devCatalog.data
}

const providerName = (db: DevCatalog, id: string): string =>
  db[id]?.name?.replace(/\s*\(.*\)$/, '') ?? id.charAt(0).toUpperCase() + id.slice(1)

function devLookup(db: DevCatalog, provider: string | undefined, key: string): ModelInfo | undefined {
  const lab = (id: string): boolean => !!db[id]?.models?.[key]
  const home = provider && db[provider]?.models?.[key] ? provider : LABS.find(lab)
  const m = home ? db[home]?.models?.[key] : undefined
  if (!home || !m) return undefined
  const makerId = key.includes('/') ? key.split('/')[0].replace(/^~/, '') : LABS.includes(home) ? home : LABS.find(lab)
  const reads = (m.modalities?.input ?? []).filter((x) => x !== 'text')
  return {
    name: m.name ?? key,
    maker: makerId ? providerName(db, MAKER_ALIAS[makerId] ?? makerId) : undefined,
    released: m.release_date,
    description: m.description,
    context: m.limit?.context,
    price: m.cost && typeof m.cost.input === 'number' && typeof m.cost.output === 'number' ? { input: m.cost.input, output: m.cost.output } : undefined,
    reads: reads.length > 0 ? reads : undefined
  }
}

const PLAN_PRICED = new Set(['claude', 'codex', 'cursor', 'antigravity'])

function openRouterInfo(db: DevCatalog, key: string): ModelInfo | undefined {
  const m = openRouterMeta(key)
  if (!m) return undefined
  const perM = (x?: string): number => Number(x ?? NaN) * 1e6
  const price = { input: perM(m.pricing?.prompt), output: perM(m.pricing?.completion) }
  const makerId = key.split('/')[0].replace(/^~/, '')
  const reads = (m.architecture?.input_modalities ?? []).filter((x) => x !== 'text' && x !== 'file')
  return {
    name: m.name?.replace(/^[^:]+:\s*/, '') ?? key,
    maker: providerName(db, MAKER_ALIAS[makerId] ?? makerId),
    released: m.created ? new Date(m.created * 1000).toISOString().slice(0, 10) : undefined,
    description: m.description?.split(/(?<=\.)\s/)[0],
    context: m.context_length,
    price: Number.isFinite(price.input) && Number.isFinite(price.output) ? price : undefined,
    reads: reads.length > 0 ? reads : undefined
  }
}

// OpenRouter ships models days before models.dev (OpenCode's catalog) lists them; OpenCode runs them once its config names them.
async function newerOpenRouterModels(listed: string[]): Promise<string[]> {
  if (!listed.some((m) => m.startsWith('openrouter/'))) return []
  const known = (await modelsDev()).openrouter?.models ?? {}
  const have = new Set(listed)
  return (await listOpenRouterModels()).filter((id) => !id.includes(':') && !known[id] && !have.has(`openrouter/${id}`))
}

export async function opencodeModelConfig(model: string): Promise<Record<string, unknown>> {
  if (!model.startsWith('openrouter/')) return {}
  const key = model.slice('openrouter/'.length)
  if ((await modelsDev()).openrouter?.models?.[key]) return {}
  await listOpenRouterModels()
  const name = openRouterMeta(key)?.name?.replace(/^[^:]+:\s*/, '') ?? key
  return { provider: { openrouter: { models: { [key]: { name } } } } }
}

function modelInfo(db: DevCatalog, o: AgentModelOption): ModelInfo | undefined {
  if (o.model === '' || o.harness === 'ollama') return undefined
  let info: ModelInfo | undefined
  if (o.harness === 'opencode') {
    const [provider, ...rest] = o.model.split('/')
    info = devLookup(db, provider, rest.join('/')) ?? (provider === 'openrouter' ? openRouterInfo(db, rest.join('/')) : undefined)
    if (info && provider === 'opencode-go') info.price = undefined
  } else if (o.harness === 'claude') {
    const m = /^(\w+) (\d+)(?:\.(\d+))?$/.exec(o.label)
    info = m ? devLookup(db, 'anthropic', `claude-${m[1].toLowerCase()}-${m[2]}${m[3] ? `-${m[3]}` : ''}`) : undefined
  } else {
    info = devLookup(db, o.harness === 'codex' ? 'openai' : undefined, o.model)
  }
  if (info && PLAN_PRICED.has(o.harness)) info.price = undefined
  return info
}

export async function chatModelInfo(ids: string[]): Promise<Record<string, ModelInfo>> {
  const db = await modelsDev()
  const out: Record<string, ModelInfo> = {}
  for (const id of ids) {
    const [source, ...rest] = id.split(':')
    const model = rest.join(':')
    const info = source === 'opencode' ? modelInfo(db, { harness: 'opencode', model, label: model })
      : source === 'openrouter' || source === 'mightymouse' ? devLookup(db, 'openrouter', model)
      : undefined
    if (!info) continue
    if (source === 'mightymouse') info.price = undefined
    out[id] = info
  }
  return out
}

export function isModelHarness(value: unknown): value is AgentModelChoice['harness'] {
  return value === 'claude' || value === 'codex' || value === 'opencode' || value === 'cursor' || value === 'antigravity' || value === 'ollama'
}

export async function listAgentModels(): Promise<AgentModelOption[]> {
  const installed = availableHarnesses()
  const options: AgentModelOption[] = []
  if (installed.includes('claude') && showsOn('claude', 'code')) {
    options.push({ harness: 'claude', model: '', label: 'Default' })
    const versions = await claudeVersionLabels()
    for (const m of CLAUDE_MODELS)
      options.push({ harness: 'claude', model: m.model, label: versions.get(m.model) ?? m.label, reasoningEfforts: agentReasoningEfforts('claude', m.model) })
  }
  if (installed.includes('codex') && showsOn('codex', 'code')) {
    options.push({ harness: 'codex', model: '', label: 'Default' })
    for (const m of codexModels()) options.push({ harness: 'codex', ...m })
  }
  if (installed.includes('opencode') && showsOn('opencode', 'code')) {
    options.push({ harness: 'opencode', model: '', label: 'Default' })
    const listed = await opencodeModels()
    const newer = (await newerOpenRouterModels(listed)).map((id) => `openrouter/${id}`)
    for (const m of opencodeSourceModels([...listed, ...newer], 'code'))
      options.push({ harness: 'opencode', model: m.model, label: m.label })
  }
  if (installed.includes('cursor') && showsOn('cursor', 'code')) {
    options.push({ harness: 'cursor', model: '', label: 'Default' })
    for (const m of await cursorModels()) options.push({ harness: 'cursor', ...m })
  }
  if (installed.includes('antigravity') && showsOn('antigravity', 'code')) {
    options.push({ harness: 'antigravity', model: '', label: 'Default' })
    for (const m of await antigravityModels()) options.push({ harness: 'antigravity', ...m })
  }
  if (installed.includes('claude') && showsOn('ollama', 'code')) {
    for (const model of await listCodingModels()) options.push({ harness: 'ollama', model, label: prettyOllamaModel(model) })
  }
  const db = await modelsDev()
  return options.map((o) => {
    const info = modelInfo(db, o)
    return info ? { ...o, info } : o
  })
}

export async function listChatSourceModels(): Promise<SourceModel[]> {
  const out: SourceModel[] = []
  if (showsOn('openrouter', 'chat') && (await hasOpenRouterKey())) {
    for (const model of await listOpenRouterModels()) {
      out.push({ source: 'openrouter', model, label: claudeModelLabel(model), thinks: openRouterThinks(model) })
    }
  }
  if (showsOn('opencode', 'chat') && availableHarnesses().includes('opencode')) {
    out.push(...opencodeSourceModels(await opencodeModels(), 'chat'))
  }
  return out
}

const SETUP_ORDER: ReadonlyArray<AgentModelChoice['harness']> = ['ollama', 'claude', 'codex', 'opencode']

export async function agentModelsState(): Promise<AgentModelsState> {
  const options = await listAgentModels()
  const needsSetup = SETUP_ORDER.filter((h) => !options.some((o) => o.harness === h))
  return { options, selected: await getAgentModel(options), needsSetup }
}

export async function setUpAgentProvider(
  harness: AgentModelChoice['harness'],
  onProgress: (p: AgentSetupProgress) => void
): Promise<{ ok: boolean }> {
  const copy = CONFIG.CODE_PROVIDER_SETUP_COPY
  const tell = (message: string, percent: number | null = null): void =>
    onProgress({ harness, message, percent })
  const cli = harness === 'ollama' ? 'claude' : harness
  if (!availableHarnesses().includes(cli)) {
    if (cli === 'cursor' || cli === 'antigravity') return { ok: false }
    tell(copy.installing)
    const res = await installCliPackage(CONFIG.CODE_PROVIDER_NPM[cli])
    clearBinaryCache()
    if (!res.ok || !availableHarnesses().includes(cli)) return { ok: false }
  }
  if (harness !== 'ollama') return { ok: true }
  if (!(await isOllamaRunning())) {
    const res = await setUpLocalBackend('local', (t) =>
      tell(t.phase === 'installing' ? copy.installing : copy.starting, t.percent)
    )
    if (!res.ok) return { ok: false }
  }
  if ((await listCodingModels()).length > 0) return { ok: true }
  tell(copy.downloading, 0)
  const pulled = await pullOllamaModel(CONFIG.OLLAMA_STARTER_MODEL, (pct) => tell(copy.downloading, pct))
  if (pulled) writeFileSync(PATHS.CODE_AGENT_MODEL_FILE, `ollama:${CONFIG.OLLAMA_STARTER_MODEL}`, 'utf-8')
  return { ok: pulled }
}

export async function ollamaLaunch(asked: string): Promise<{ model: string; env: Record<string, string> } | { error: string }> {
  if (!(await isOllamaRunning()) && !(await setUpLocalBackend('local', () => undefined)).ok) {
    return { error: "Ollama isn't running and couldn't be started." }
  }
  const model = asked || (await listCodingModels())[0] || ''
  if (!model) return { error: 'No local model is downloaded yet. Pick one in Settings.' }
  const agent = await ensureAgentModel(model)
  if ('error' in agent) return agent
  return {
    model: agent.model,
    env: {
      ANTHROPIC_BASE_URL: CONFIG.OLLAMA_BASE_URL,
      ANTHROPIC_AUTH_TOKEN: 'ollama',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_DEFAULT_OPUS_MODEL: agent.model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: agent.model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: agent.model,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      MM_AGENT_MODEL: prettyOllamaModel(model)
    }
  }
}

function isOffered(choice: AgentModelChoice, options: AgentModelOption[]): boolean {
  return options.some((o) => o.harness === choice.harness && o.model === choice.model)
}

function readSaved(): AgentModelChoice | null {
  if (!existsSync(PATHS.CODE_AGENT_MODEL_FILE)) return null
  try {
    const [harness, ...rest] = readFileSync(PATHS.CODE_AGENT_MODEL_FILE, 'utf-8').trim().split(':')
    return isModelHarness(harness) ? { harness, model: rest.join(':') } : null
  } catch {
    return null
  }
}

export async function getAgentModel(options?: AgentModelOption[]): Promise<AgentModelChoice | null> {
  const saved = readSaved()
  if (saved && isOffered(saved, options ?? (await listAgentModels()))) return saved
  const fallback = defaultCodeUiHarness()
  return isModelHarness(fallback) ? { harness: fallback, model: '' } : null
}

export async function setAgentModel(choice: AgentModelChoice): Promise<boolean> {
  if (!isOffered(choice, await listAgentModels())) return false
  writeFileSync(PATHS.CODE_AGENT_MODEL_FILE, `${choice.harness}:${choice.model}`, 'utf-8')
  return true
}

const OPENCODE_CHECK_TIMEOUT_MS = 30000
export const OPENCODE_QUIET_ENV = { OPENCODE_DISABLE_AUTOUPDATE: '1' }
const workingOpencodeModels = new Set<string>()

export async function checkOpencodeModel(model: string): Promise<string | null> {
  if (model === '' || workingOpencodeModels.has(model)) return null
  const bin = resolveBinary('opencode')
  if (!bin) return 'OpenCode is not installed.'
  const config = await opencodeModelConfig(model)
  const extraEnv: Record<string, string> = Object.keys(config).length > 0 ? { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) } : {}
  return new Promise((resolve) => {
    const child = execFile(
      bin,
      ['run', '-m', model, 'Reply with the single word OK.'],
      { cwd: homedir(), timeout: OPENCODE_CHECK_TIMEOUT_MS, env: { ...process.env, ...OPENCODE_QUIET_ENV, ...extraEnv } },
      (err, stdout, stderr) => {
        const out = `${stdout}\n${stderr}`.replace(/\x1b\[[0-9;]*m/g, '')
        const error = out.match(/Error:\s*(.+)/)?.[1]?.trim()
        if (error) return resolve(opencodeProblem(model, error))
        // OpenCode's own startup alone takes 10-35s on a busy Mac, so a timeout is not a model error.
        if (err?.killed) return resolve(null)
        workingOpencodeModels.add(model)
        resolve(null)
      }
    )
    child.stdin?.end()
  })
}

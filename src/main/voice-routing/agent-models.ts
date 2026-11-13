import { execFile } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { open, readdir, stat } from 'fs/promises'
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
import { hasOpenRouterKey, listOpenRouterModels, openRouterThinks } from '../backend/openrouter'
import type { AgentModelChoice, AgentModelOption, AgentModelsState, AgentSetupProgress } from '../../shared/types'

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

const OPENCODE_LIST_TIMEOUT_MS = 15000
let opencodeCache: Promise<string[]> | null = null

function opencodeModels(): Promise<string[]> {
  const bin = resolveBinary('opencode')
  if (!bin) return Promise.resolve([])
  opencodeCache ??= new Promise<string[]>((resolve) => {
    execFile(
      bin,
      ['models'],
      { timeout: OPENCODE_LIST_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        const models = err
          ? []
          : stdout
              .split('\n')
              .map((l) => l.trim())
              .filter((l) => /^[\w.-]+\/\S+$/.test(l))
        if (models.length === 0) opencodeCache = null
        resolve(models)
      }
    )
  })
  return opencodeCache
}

const CURSOR_LIST_TIMEOUT_MS = 15000
let cursorCache: Promise<Array<{ model: string; label: string }>> | null = null

function cursorModels(): Promise<Array<{ model: string; label: string }>> {
  const bin = resolveBinary('cursor-agent')
  if (!bin) return Promise.resolve([])
  cursorCache ??= new Promise((resolve) => {
    execFile(bin, ['--list-models'], { timeout: CURSOR_LIST_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      const models = err
        ? []
        : stdout.split('\n').flatMap((line) => {
            const m = /^\s*([\w.-]+)\s+-\s+(.+?)\s*$/.exec(line)
            return m ? [{ model: m[1], label: m[2].replace(/\s*\((current|default)\)$/i, '') }] : []
          })
      if (models.length === 0) cursorCache = null
      resolve(models)
    })
  })
  return cursorCache
}

export function isModelHarness(value: unknown): value is AgentModelChoice['harness'] {
  return value === 'claude' || value === 'codex' || value === 'opencode' || value === 'cursor' || value === 'ollama'
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
    for (const m of opencodeSourceModels(await opencodeModels(), 'code'))
      options.push({ harness: 'opencode', model: m.model, label: m.label })
  }
  if (installed.includes('cursor') && showsOn('cursor', 'code')) {
    options.push({ harness: 'cursor', model: '', label: 'Default' })
    for (const m of await cursorModels()) options.push({ harness: 'cursor', ...m })
  }
  if (installed.includes('claude') && showsOn('ollama', 'code')) {
    for (const model of await listCodingModels()) options.push({ harness: 'ollama', model, label: prettyOllamaModel(model) })
  }
  return options
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
    if (cli === 'cursor') return { ok: false }
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

export async function ollamaLaunch(model: string): Promise<{ model: string; env: Record<string, string> } | { error: string }> {
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
  return new Promise((resolve) => {
    const child = execFile(
      bin,
      ['run', '-m', model, 'Reply with the single word OK.'],
      { cwd: homedir(), timeout: OPENCODE_CHECK_TIMEOUT_MS, env: { ...process.env, ...OPENCODE_QUIET_ENV } },
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

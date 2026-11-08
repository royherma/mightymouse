/**
 * Backend adapters — one object per LLM provider CLI (or HTTP proxy).
 *
 * Everything provider-specific (binary path, how the run command is built, how
 * output is parsed, how a health-check reads version + auth) lives in an adapter.
 * Call sites do `BACKENDS[id].buildCommand(...)` etc. with NO `if (backend === ...)`
 * branches. Adding a provider = append one adapter to BACKENDS; nothing else changes.
 *
 * `BackendId` is DERIVED from the registry keys, so the union has exactly one
 * source of truth (this file). Importers should use `BackendId`, never a bare
 * `'claude' | 'codex'` literal.
 *
 * Transport discriminator: adapters declare `transport: 'shell' | 'http'`. Shell
 * adapters use `buildCommand` + the spawn path in runner.ts. HTTP adapters implement
 * `runHttp` instead. The runner branches ONCE on this field — never on adapter id.
 */
import { CONFIG } from '../../shared/config'
import type { AppMode, MediaAttachment, RunEvent } from '../../shared/types'
import { RUN_EVENT } from '../../shared/types'
import { parseClaudeJsonOutput } from './parse'
import { resolveClaude, resolveCodex, resolveOpencode, resolveGemini } from '../platform'
import { loadImagesForVision, isImagePath } from './image-vision'
import { splitAttachments, inlineFilesForPrompt, loadDocumentsForHttp } from './attachments'
import { getLocalModelCapabilities, getOllamaContextLength } from './local-models'
import { getMlxModelCapabilities } from './mlx-models'
import { opencodeErrorEvent, opencodeProblem } from './opencode-errors'
import { runOllamaToolLoop, hasConfiguredMcpServers } from './ollama-tools'
import { openrouter } from './openrouter'

const CLI_ENV = {
  BASE_URL: 'ANTHROPIC_BASE_URL',
  AUTH_TOKEN: 'ANTHROPIC_AUTH_TOKEN',
  API_KEY: 'ANTHROPIC_API_KEY',
  CACHE_5M: 'FORCE_PROMPT_CACHING_5M'
} as const

/** Thrown when a backend's CLI can't be found on PATH or via override. */
export class BinaryNotFoundError extends Error {
  constructor(public readonly binary: string) {
    super(`${binary} CLI not found. Install it or set its path in Settings.`)
    this.name = 'BinaryNotFoundError'
  }
}

/** Inputs the run-command builder needs (paths already resolved by the runner). */
export interface BuildCommandCtx {
  runDir: string
  workDir?: string
  promptFile: string
  outFile: string
  addDirs: string[]
  attachments: MediaAttachment[]
  /** Single-quote a shell arg. Provided by the runner so quoting stays consistent. */
  shellQuote: (s: string) => string
  /** Expand a file's CONTENTS into one argument. Provided by the runner for the
   *  same reason as shellQuote: `"$(cat …)"` is zsh-only, and PowerShell reads a
   *  file with an entirely different expression. */
  shellFileText: (path: string) => string
  /** Prefer a lighter/faster model for this run when the adapter has one (e.g. a
   *  suggestion prediction, where speed beats depth). Adapters WITHOUT a fast tier
   *  ignore it and use their normal model — never a hard dependency. */
  fast?: boolean
  /** No MCP servers, hooks, settings or skills: a pure text answer with ~10s less spawn. */
  lean?: boolean
  noTools?: boolean
  mcpConfig?: string
  stdinPrompt?: boolean
  unattended?: boolean
  modelOverride?: string
}

export interface BuildEnvCtx {
  /** Current Supabase JWT (empty string when signed out). */
  jwt: string
  /** Base URL of our Edge functions (the CLI talks to us, not OpenRouter directly). */
  edgeBaseUrl: string
}

/** Result of reading a provider's auth/login status. */
export interface AuthStatus {
  loggedIn: boolean
  /** Short human label: "dev@example.com (max)", "Logged in using ChatGPT", or the error. */
  detail: string
}

/** A friendly progress update derived from one streamed event. */
export interface Phase {
  /** Short headline: "Reading your selection", "Looking at your screen", "Writing". */
  phase: string
  /** Optional sub-detail. */
  detail: string
}

export interface StreamStep {
  /** Stable id for this tool call within the run (pairs start↔end). */
  id: string
  /** 'start' when the tool call begins, 'end' when it finishes. */
  edge: 'start' | 'end'
  /** Tool kind, e.g. 'command_execution', 'Bash', 'Read', 'file_change'. */
  kind: string
  /** Short command/target text (truncated). Empty when not applicable. */
  cmd: string
  /** Process exit code on 'end' edges, when the stream reports one. */
  exit?: number
}

/** Discriminates shell-spawn adapters from HTTP-fetch adapters. runner.ts branches once on this. */
export type AdapterTransport = 'shell' | 'http'

export type TransportFor = AdapterTransport | ((feature: AppMode | undefined) => AdapterTransport)

export interface PriorMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface HttpRunCtx {
  runId: string
  systemPrompt: string
  userPrompt: string
  // Only local/mlx read this; other http adapters rely on userPrompt's flattened form.
  priorMessages: PriorMessage[]
  addDirs: string[]
  /** Wall-clock ceiling in ms. On expiry the fetch is aborted → exitCode -3. */
  timeoutMs?: number
  /** App feature behind this run (rewrite | ask | act) — recorded on the usage row. */
  feature?: AppMode
  /** Normalized user media (images + files; audio already transcribed away upstream).
   *  The http adapter translates this itself: images → downscaled-JPEG data URLs,
   *  files → base64 `document` blocks. Same single-input contract as the shell path. */
  attachments: MediaAttachment[]
  json?: boolean
  ollamaModel: string
  /** The user's PREFS-selected Rapid-MLX model alias (e.g. "qwen3-0.6b-4bit"),
   *  resolved by runner.ts before dispatch — same no-import-cycle bridge as
   *  ollamaModel. Empty string for every adapter except `mlx`, the only reader. */
  mlxModel: string
  /** The user's global "think before answering" pref. Read by `openrouter` and `local` (see resolveThinking). */
  thinkingEnabled: boolean
  selectedModel: string
  /** Returns the current Supabase JWT. Empty string = not logged in. */
  getJwt: () => Promise<string>
  /** Signal a live progress phase to the UI. */
  onPhase: (phase: string, detail: string) => void
  onEvent?: (event: RunEvent) => void
  onModelResolved?: (model: string) => void
  /** Report whether this run actually reasoned before answering. Fired by the
   *  `local` adapter once the three gates in resolveThinking have been applied,
   *  so the logged value is what was SENT — not what the pref said. */
  onThinkingResolved?: (thinking: boolean) => void
  /** Signal completion — same signature as RunOptions.onDone in runner.ts. */
  onDone: (
    result: string | null,
    exitCode: number,
    stdOut: string,
    stdErr: string,
    durationSec: number,
    promptFile: string,
    outFile: string
  ) => void
}

export interface BackendCapabilities {
  vision: boolean
  fileAttachments: boolean
  toolCalls: boolean
  deniableTools: boolean
  /** Model can reason before answering. Only the `local` backend ever reports true,
   *  and only per-model — sending `think: true` without it is a hard API error. */
  thinking: boolean
}

export interface BackendAdapter {
  /** Stable id persisted in PREFS and sent over IPC. */
  id: string
  /** Display name for the UI + progress labels. */
  label: string
  /** What this backend supports. Every adapter declares one — no more silent
   *  best-effort degrading. `local`'s varies by model; see getCapabilities. */
  capabilities: BackendCapabilities
  /** Which run path runner.ts uses. Shell adapters spawn a process; http adapters call runHttp.
   *  May be a function of the call's feature (see TransportFor) — MightyMouse routes
   *  `act` to shell (real CLI agent) and rewrite/ask to http (chat completions). */
  transport: TransportFor
  /** Model name recorded in history (CLI's own default if the provider has no fixed model). */
  modelName: string
  /** Lighter/faster model used when a run sets `fast` (suggestions). Absent = the
   *  adapter has no fast tier and always runs `modelName`. The single source of
   *  truth for both the command builder AND the audit log, so they never disagree. */
  fastModelName?: string
  /** Whether parseOutput strips a wrapping envelope (claude JSON) vs passes through (codex). */
  hasEnvelope: boolean

  // ── Shell-only fields (present on transport:'shell', absent on transport:'http') ──

  /** Absolute path to the CLI binary. Optional because HTTP adapters have no binary. */
  binPath?: string
  buildCommand?(ctx: BuildCommandCtx): string
  /** Prompt arrives on stdin, so the runner can hand the run a process started ahead of time. */
  pooledSpawn?: boolean
  buildEnv?(ctx: BuildEnvCtx): Record<string, string>
  /** Args for the "is the binary installed / runnable" probe, e.g. ['--version']. */
  versionArgs?: string[]
  /** Args for the "is the user authenticated" probe, e.g. ['auth','status']. */
  authArgs?: string[]
  logoutArgs?: string[]
  /** Read auth status from the authArgs command's combined stdout/stderr + exit ok. */
  parseAuth?(out: string, ok: boolean): AuthStatus
  /** What to tell the user when not logged in. */
  loginAdvice?: string

  /**
   * How this backend gets installed, if we can do it ourselves.
   *
   * Two shapes because the two routes have nothing in common: `npm` is a package
   * we install into our own prefix, `brew` is a system service that outlives us.
   * The discriminant is which key is present — a backend declaring neither is
   * one we genuinely cannot install (Gemini's formula is deprecated), and that
   * is a meaningful third state, not an oversight.
   */
  install?: { npm: string } | { brew: string }


  runHttp?(ctx: HttpRunCtx): Promise<void>

  // ── Common fields ──

  /** Extract the final answer string from the full captured stdout (JSONL stream). */
  parseOutput(stdout: string): string
  explainFailure?(stdout: string): string | null
  parsePhase(line: string): Phase | null
  parseStep?(line: string): StreamStep | null
  parseEvent?(line: string): RunEvent[]
}

const CHARS_PER_TOKEN = 4 // no tokenizer at this layer; cheap estimate to bound the prompt
export const PRIOR_MESSAGES_TOKEN_BUDGET = 4000

export function trimToTokenBudget(messages: PriorMessage[], budgetTokens: number): PriorMessage[] {
  const budgetChars = budgetTokens * CHARS_PER_TOKEN
  const kept: PriorMessage[] = []
  let used = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    used += m.content.length
    if (used > budgetChars && kept.length > 0) break
    kept.push(m)
  }
  return kept.reverse()
}

function shortCmd(s: string | undefined, max = 160): string {
  let t = (s ?? '').trim()
  // Unwrap a leading shell invocation: /bin/zsh -lc "CMD" | sh -c 'CMD' | bash -c CMD
  const m = t.match(/^(?:\S*\/)?(?:zsh|bash|sh)\s+-[a-z]*c\s+(['"])([\s\S]*)\1\s*$/i)
  if (m) t = m[2]
  t = t.trim().replace(/\s+/g, ' ')
  return t.length > max ? t.slice(0, max) + '…' : t
}

function plainToolName(name: string | undefined): string | undefined {
  const verb = name?.match(/^mcp__.+__(browser_\w+)$/)?.[1]
  return (verb && CONFIG.MIGHTY.BROWSER_STEP_NAMES[verb]) || name
}

/** Friendly label for a Read tool call, based on the file it targets. */
function describeRead(filePath: string): Phase {
  if (/\.png$|\.jpe?g$|\.webp$/i.test(filePath)) return { phase: 'Looking at your screen', detail: '' }
  if (/-sel\.txt$|rewrite-.*\.txt$/i.test(filePath)) return { phase: 'Reading your selection', detail: '' }
  const name = filePath.split('/').pop() || filePath
  return { phase: 'Reading', detail: name.slice(0, 40) }
}

function buildClaudeCommand({ promptFile, addDirs, attachments, shellQuote, shellFileText, fast, lean, noTools, mcpConfig, stdinPrompt, unattended, modelOverride }: BuildCommandCtx): string {
  const bin = resolveClaude()
  if (!bin) throw new BinaryNotFoundError('claude')
  const model = modelOverride ?? (fast && CONFIG.CLAUDE_FAST_MODEL !== '' ? CONFIG.CLAUDE_FAST_MODEL : CONFIG.CLAUDE_MODEL)
  const grantPaths = [...addDirs, ...attachments.map((a) => a.path)]
  let addDirFlags = ''
  const seen = new Set<string>()
  for (const d of grantPaths) {
    const lastIndex = d.lastIndexOf('/')
    const parent = lastIndex !== -1 ? d.substring(0, lastIndex) : d
    if (parent !== '' && !seen.has(parent)) {
      seen.add(parent)
      addDirFlags += ` --add-dir ${shellQuote(parent)}`
    }
  }
  const leanFlags = lean
    ? ` --strict-mcp-config${mcpConfig ? ` --mcp-config ${shellQuote(mcpConfig)}` : ''} --setting-sources '' --disable-slash-commands --tools ${noTools ? "''" : shellQuote(CONFIG.MIGHTY.LEAN_TOOLS.join(','))}`
    : ''
  const deniedTools = unattended
    ? [...CONFIG.MIGHTY.SYSTEMIC_DENIED_TOOLS, ...CONFIG.MIGHTY.UNATTENDED_ONLY_DENIED_TOOLS]
    : CONFIG.MIGHTY.SYSTEMIC_DENIED_TOOLS
  const denyFlag = ` --disallowedTools ${deniedTools.map(shellQuote).join(' ')}`
  // stream-json + --verbose emits one JSON event per line to stdout; the
  // runner captures stdout, shows progress, and parseOutput pulls .result.
  return `${shellQuote(bin)} -p ${stdinPrompt ? '--input-format stream-json' : shellFileText(promptFile)} --model ${shellQuote(model)} --permission-mode bypassPermissions${addDirFlags}${denyFlag}${leanFlags} --output-format stream-json --verbose`
}

const claude: BackendAdapter = {
  id: 'claude',
  label: CONFIG.BACKEND_META.claude.label,
  // deniableTools: --disallowedTools takes command-scoped patterns ("Bash(rm *)").
  capabilities: { vision: true, fileAttachments: true, toolCalls: true, deniableTools: true, thinking: false },
  transport: 'shell',
  get binPath() {
    return resolveClaude() ?? ''
  },
  modelName: CONFIG.CLAUDE_MODEL,
  // Empty CLAUDE_FAST_MODEL → undefined → no fast tier → suggestions fall back to
  // the flagship. Never an empty model string (which would break --model).
  fastModelName: CONFIG.CLAUDE_FAST_MODEL || undefined,
  hasEnvelope: true,

  buildCommand: buildClaudeCommand,
  pooledSpawn: true,

  parseOutput(stdout) {
    // parseClaudeJsonOutput already walks NDJSON for the final {type:'result'} event.
    const extracted = parseClaudeJsonOutput(stdout)
    return extracted !== null ? extracted : stdout
  },

  parsePhase(line) {
    let e: {
      type?: string
      message?: {
        content?: Array<{
          type?: string
          name?: string
          input?: { file_path?: string; command?: string; description?: string; skill?: string }
        }>
      }
    }
    try {
      e = JSON.parse(line)
    } catch {
      return null
    }
    if (e.type === 'system') return { phase: 'Starting', detail: '' }
    if (e.type === 'assistant') {
      for (const b of e.message?.content ?? []) {
        if (b.type === 'tool_use') {
          if (b.name === 'Read' && b.input?.file_path) return describeRead(b.input.file_path)
          // Bash: prefer the model-written description over the raw command
          if (b.name === 'Bash') {
            if (b.input?.description) return { phase: b.input.description, detail: '' }
            const cmd = b.input?.command?.trim() ?? ''
            const short = cmd.length > 48 ? cmd.slice(0, 48) + '…' : cmd
            return { phase: 'Running command', detail: short }
          }
          // Skill: show the skill name
          if (b.name === 'Skill' || b.name === 'SlashCommand') {
            const skillName = b.input?.skill ?? b.input?.command ?? ''
            return { phase: skillName ? `Running /${skillName}` : 'Running skill', detail: '' }
          }
          const plain = plainToolName(b.name)
          if (plain && plain !== b.name) return { phase: plain, detail: '' }
          return { phase: b.name ? `Running ${b.name}` : 'Working', detail: '' }
        }
        if (b.type === 'text') return { phase: 'Writing', detail: '' }
      }
    }
    return null
  },

  parseStep(line) {
    let e: {
      type?: string
      message?: {
        content?: Array<{
          type?: string
          id?: string
          name?: string
          tool_use_id?: string
          is_error?: boolean
          input?: { command?: string; file_path?: string }
        }>
      }
    }
    try {
      e = JSON.parse(line)
    } catch {
      return null
    }
    // tool_use (start) rides in assistant messages; tool_result (end) in user messages.
    if (e.type === 'assistant') {
      for (const b of e.message?.content ?? []) {
        if (b.type === 'tool_use') {
          return {
            id: b.id ?? '',
            edge: 'start',
            kind: plainToolName(b.name) ?? 'tool',
            cmd: shortCmd(b.input?.command ?? b.input?.file_path)
          }
        }
      }
    } else if (e.type === 'user') {
      for (const b of e.message?.content ?? []) {
        if (b.type === 'tool_result') {
          return {
            id: b.tool_use_id ?? '',
            edge: 'end',
            kind: 'tool',
            cmd: '',
            exit: b.is_error ? 1 : 0
          }
        }
      }
    }
    return null
  },

  parseEvent(line) {
    let e: {
      type?: string
      message?: {
        content?: Array<{
          type?: string
          id?: string
          name?: string
          input?: unknown
          text?: string
          thinking?: string
          tool_use_id?: string
          is_error?: boolean
          content?: unknown
        }>
      }
      // terminal result event
      usage?: {
        input_tokens?: number
        output_tokens?: number
        cache_read_input_tokens?: number
        cache_creation_input_tokens?: number
      }
      total_cost_usd?: number
      modelUsage?: Record<string, { outputTokens?: number }>
      num_turns?: number
      duration_ms?: number
    }
    try {
      e = JSON.parse(line)
    } catch {
      return []
    }
    const out: RunEvent[] = []
    // tool_use (start) + text + thinking ride in assistant messages.
    if (e.type === 'assistant') {
      for (const b of e.message?.content ?? []) {
        if (b.type === 'tool_use') {
          out.push({
            kind: RUN_EVENT.tool_start,
            id: b.id ?? '',
            name: plainToolName(b.name) ?? 'tool',
            input: b.input ?? {}
          })
        } else if (b.type === 'text' && typeof b.text === 'string' && b.text !== '') {
          out.push({ kind: RUN_EVENT.text, text: b.text })
        } else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking !== '') {
          out.push({ kind: RUN_EVENT.thinking, text: b.thinking })
        }
      }
    } else if (e.type === 'user') {
      // tool_result (end) rides in user messages.
      for (const b of e.message?.content ?? []) {
        if (b.type === 'tool_result') {
          out.push({
            kind: RUN_EVENT.tool_end,
            id: b.tool_use_id ?? '',
            output: b.content ?? '',
            isError: b.is_error === true
          })
        }
      }
    } else if (e.type === 'result') {
      // Terminal event: token usage + cost. One per run.
      const u = e.usage ?? {}
      out.push({
        kind: RUN_EVENT.usage,
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens,
        cacheCreationTokens: u.cache_creation_input_tokens,
        costUsd: e.total_cost_usd,
        turns: e.num_turns,
        durationMs: e.duration_ms,
        model: mainModel(e.modelUsage)
      })
    }
    return out
  },

  versionArgs: ['--version'],
  authArgs: ['auth', 'status'],
  logoutArgs: ['auth', 'logout'],

  parseAuth(out, _ok) {
    const jsonMatch = out.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      try {
        const j = JSON.parse(jsonMatch[0]) as {
          loggedIn?: boolean
          email?: string
          subscriptionType?: string
          authMethod?: string
        }
        // Explicit false → not logged in. true OR absent-but-parseable → treat as ok.
        const loggedIn = j.loggedIn !== false
        return {
          loggedIn,
          detail: loggedIn
            ? `${j.email || 'logged in'} (${j.subscriptionType || j.authMethod || 'ok'})`
            : 'Not logged in'
        }
      } catch {
        /* fall through to text */
      }
    }
    // No parseable JSON. Only declare logged-out on an EXPLICIT logged-out marker
    // ("/login", invalid/expired key). Otherwise stay tolerant: assume logged-in and
    // let a real run surface a hard auth error with advice.
    const clearlyLoggedOut = /\/login|invalid api key|not (?:logged|signed) in|expired/i.test(out)
    const loggedIn = !clearlyLoggedOut
    return {
      loggedIn,
      detail: loggedIn
        ? 'Logged in'
        : out.split('\n').find((l) => l.trim())?.slice(0, 80) || 'Not logged in'
    }
  },

  loginAdvice: 'Not logged in. Run `claude /login` in a terminal (or set ANTHROPIC_API_KEY).',

  // Verified 2026-07-23 via `npm view`: @anthropic-ai/claude-code @ 2.1.218.
  install: { npm: '@anthropic-ai/claude-code' }
}

const codex: BackendAdapter = {
  id: 'codex',
  label: CONFIG.BACKEND_META.codex.label,
  capabilities: { vision: true, fileAttachments: true, toolCalls: true, deniableTools: false, thinking: false },
  transport: 'shell',
  get binPath() {
    return resolveCodex() ?? ''
  },
  modelName: CONFIG.CODEX_MODEL !== '' ? CONFIG.CODEX_MODEL : CONFIG.CODEX_MODEL_FALLBACK,
  hasEnvelope: false,

  buildCommand({ runDir, workDir, promptFile, attachments, shellQuote, shellFileText, modelOverride }) {
    const bin = resolveCodex()
    if (!bin) throw new BinaryNotFoundError('codex')
    const model = modelOverride ?? CONFIG.CODEX_MODEL
    const modelFlag = model !== '' ? ` -m ${shellQuote(model)}` : ''
    // Cap reasoning effort so a quick Ask doesn't sit in multi-second silent
    // "thinking". `-c key=value` overrides ~/.codex/config.toml; empty = CLI default.
    const effortFlag =
      CONFIG.CODEX_REASONING_EFFORT !== ''
        ? ` -c model_reasoning_effort=${shellQuote(CONFIG.CODEX_REASONING_EFFORT)}`
        : ''
    const { images, files } = splitAttachments(attachments)
    // Images: attach by path via `-i` (repeatable). codex opens the file directly —
    // unlike claude (Read off an --add-dir grant), not base64 like the http path.
    const imageFlags = images
      .filter((a) => isImagePath(a.path))
      .map((a) => ` -i ${shellQuote(a.path)}`)
      .join('')
    const fileInline = inlineFilesForPrompt(files)
    const promptArg = fileInline
      ? `${shellFileText(promptFile)}${shellQuote(fileInline)}`
      : shellFileText(promptFile)
    return `${shellQuote(bin)} exec --dangerously-bypass-approvals-and-sandbox${modelFlag}${effortFlag}${imageFlags} --json -C ${shellQuote(workDir ?? runDir)} ${promptArg}`
  },

  parseOutput(stdout) {
    // Walk the JSONL for the last completed agent_message item.
    let answer = ''
    for (const line of stdout.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        const e = JSON.parse(t) as { type?: string; item?: { type?: string; text?: string } }
        if (e.type === 'item.completed' && e.item?.type === 'agent_message' && typeof e.item.text === 'string') {
          answer = e.item.text
        }
      } catch {
        /* ignore non-JSON lines */
      }
    }
    return answer || stdout
  },

  parsePhase(line) {
    let e: { type?: string; item?: { type?: string; command?: string } }
    try {
      e = JSON.parse(line)
    } catch {
      return null
    }
    switch (e.type) {
      case 'thread.started':
      case 'turn.started':
        return { phase: 'Starting', detail: '' }
      case 'item.started':
      case 'item.completed':
        if (e.item?.type === 'agent_message') return { phase: 'Writing', detail: '' }
        if (e.item?.type === 'command_execution') {
          const cmd = shortCmd(e.item?.command)
          return { phase: 'Running command', detail: cmd }
        }
        if (e.item?.type === 'file_change') return { phase: 'Editing files', detail: '' }
        return { phase: 'Working', detail: e.item?.type || '' }
      default:
        return null
    }
  },

  parseStep(line) {
    let e: {
      type?: string
      item?: { id?: string; type?: string; command?: string; exit_code?: number }
    }
    try {
      e = JSON.parse(line)
    } catch {
      return null
    }
    if (e.type !== 'item.started' && e.type !== 'item.completed') return null
    const kind = e.item?.type
    // Only time the tool-call items (skip the agent_message text item).
    if (kind !== 'command_execution' && kind !== 'file_change') return null
    return {
      id: e.item?.id ?? '',
      edge: e.type === 'item.started' ? 'start' : 'end',
      kind,
      cmd: shortCmd(e.item?.command),
      exit: e.item?.exit_code
    }
  },

  versionArgs: ['--version'],
  authArgs: ['login', 'status'],
  logoutArgs: ['logout'],

  parseAuth(out, ok) {
    // `codex login status` → exit 0 + "Logged in using ChatGPT". TOLERANT (see the
    // claude adapter's parseAuth): only red on an EXPLICIT logged-out marker, so
    // output drift / a wrong binary doesn't produce a false "Not logged in".
    const clearlyLoggedOut = /not (?:logged|signed) in|please (?:run )?.*login|no (?:credentials|api key)/i.test(out)
    const loggedIn = !clearlyLoggedOut && (ok || /logged ?in/i.test(out))
    return {
      loggedIn,
      detail: loggedIn
        ? out.split('\n').find((l) => l.trim())?.slice(0, 80) || 'Logged in'
        : 'Not logged in'
    }
  },

  loginAdvice: 'Not logged in. Run `codex login` in a terminal.',

  // Verified 2026-07-23 via `npm view`: @openai/codex @ 0.145.0.
  install: { npm: '@openai/codex' }
}

let lastOpencodeModel = ''

const opencode: BackendAdapter = {
  id: 'opencode',
  label: CONFIG.BACKEND_META.opencode.label,
  // deniableTools: false — runs bash headlessly with zero prompt and exposes no
  // per-command deny flag.
  capabilities: { vision: true, fileAttachments: true, toolCalls: true, deniableTools: false, thinking: false },
  transport: 'shell',
  get binPath() {
    return resolveOpencode() ?? ''
  },
  modelName: CONFIG.OPENCODE_MODEL,
  fastModelName: CONFIG.OPENCODE_FAST_MODEL || undefined,
  hasEnvelope: false,

  buildCommand({ promptFile, attachments, shellQuote, shellFileText, fast, modelOverride }) {
    const bin = resolveOpencode()
    if (!bin) throw new BinaryNotFoundError('opencode')
    const model =
      modelOverride ?? (fast && CONFIG.OPENCODE_FAST_MODEL !== '' ? CONFIG.OPENCODE_FAST_MODEL : CONFIG.OPENCODE_MODEL)
    lastOpencodeModel = model
    const fileFlags = attachments.map((a) => ` -f ${shellQuote(a.path)}`).join('')
    return `${shellQuote(bin)} run ${shellFileText(promptFile)} --format json -m ${shellQuote(model)}${fileFlags}`
  },

  parseOutput(stdout) {
    // Walk the NDJSON for the last `type:"text"` part — that's the assistant's
    // final prose answer (tool_use/step_start/step_finish carry no answer text).
    let answer = ''
    for (const line of stdout.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        const e = JSON.parse(t) as { type?: string; part?: { type?: string; text?: string } }
        if (e.type === 'text' && e.part?.type === 'text' && typeof e.part.text === 'string') {
          answer = e.part.text
        }
      } catch {
        /* ignore non-JSON lines */
      }
    }
    return answer || stdout
  },

  explainFailure(stdout) {
    const error = opencodeErrorEvent(stdout)
    return error ? opencodeProblem(lastOpencodeModel, error) : null
  },

  parsePhase(line) {
    let e: {
      type?: string
      part?: {
        type?: string
        tool?: string
        state?: { input?: { command?: string; description?: string } }
      }
    }
    try {
      e = JSON.parse(line)
    } catch {
      return null
    }
    if (e.type === 'step_start') return { phase: 'Starting', detail: '' }
    if (e.type === 'text') return { phase: 'Writing', detail: '' }
    if (e.type === 'tool_use') {
      const tool = e.part?.tool ?? ''
      if (tool === 'bash') {
        const desc = e.part?.state?.input?.description
        if (desc) return { phase: desc, detail: '' }
        const cmd = (e.part?.state?.input?.command ?? '').trim()
        return { phase: 'Running command', detail: cmd.length > 48 ? cmd.slice(0, 48) + '…' : cmd }
      }
      if (tool === 'read') return { phase: 'Reading', detail: '' }
      return { phase: tool ? `Running ${tool}` : 'Working', detail: '' }
    }
    return null
  },

  parseStep(line) {
    let e: {
      type?: string
      part?: {
        callID?: string
        tool?: string
        state?: { status?: string; input?: { command?: string }; metadata?: { exit?: number } }
      }
    }
    try {
      e = JSON.parse(line)
    } catch {
      return null
    }
    if (e.type !== 'tool_use') return null
    const status = e.part?.state?.status
    return {
      id: e.part?.callID ?? '',
      edge: status === 'completed' || status === 'error' ? 'end' : 'start',
      kind: e.part?.tool ?? 'tool',
      cmd: shortCmd(e.part?.state?.input?.command),
      exit: status === 'error' ? 1 : status === 'completed' ? 0 : undefined
    }
  },

  versionArgs: ['--version'],
  authArgs: ['models'],

  parseAuth(out, ok) {
    const clearlyLoggedOut = /no (?:providers|credentials|models) (?:configured|found)|not (?:logged|signed) in/i.test(
      out
    )
    const loggedIn = !clearlyLoggedOut && (ok || out.trim().length > 0)
    return {
      loggedIn,
      detail: loggedIn ? 'Configured' : 'No provider configured'
    }
  },

  loginAdvice:
    'No provider configured. Run `opencode auth login` in a terminal, or set OPENROUTER_API_KEY.'
}

const gemini: BackendAdapter = {
  id: 'gemini',
  label: CONFIG.BACKEND_META.gemini.label,
  // Images/files aren't wired into buildCommand yet (see comment below) — declare
  // it honestly so the UI can gate the attach button instead of silently dropping.
  // deniableTools: false — runs with -y (auto-approve) and no per-command deny.
  capabilities: { vision: false, fileAttachments: false, toolCalls: true, deniableTools: false, thinking: false },
  transport: 'shell',
  get binPath() {
    return resolveGemini() ?? ''
  },
  modelName: CONFIG.GEMINI_MODEL,
  fastModelName: CONFIG.GEMINI_FAST_MODEL || undefined,
  hasEnvelope: false,

  // GEMINI_CLI_TRUST_WORKSPACE=true + -y is the verified-working combo — `--skip-trust`
  // alone left tool calls hanging indefinitely in testing. gemini has no file-attach
  // flag; images/files aren't wired in this first cut.
  buildCommand({ promptFile, shellQuote, shellFileText, fast }) {
    const bin = resolveGemini()
    if (!bin) throw new BinaryNotFoundError('gemini')
    // gemini's own "auto" model selection was unreliable/slow-to-hang in headless
    // testing — always pass an explicit -m, never omit it.
    const model = fast && CONFIG.GEMINI_FAST_MODEL !== '' ? CONFIG.GEMINI_FAST_MODEL : CONFIG.GEMINI_MODEL
    return `GEMINI_CLI_TRUST_WORKSPACE=true ${shellQuote(bin)} -p ${shellFileText(promptFile)} -o stream-json -m ${shellQuote(model)} -y`
  },

  parseOutput(stdout) {
    // Walk the NDJSON, concatenating assistant message deltas; the terminal
    // `type:"result"` event carries no text, only stats, so we accumulate as we go.
    let answer = ''
    for (const line of stdout.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        const e = JSON.parse(t) as { type?: string; role?: string; content?: string }
        if (e.type === 'message' && e.role === 'assistant' && typeof e.content === 'string') {
          answer += e.content
        }
      } catch {
        /* ignore non-JSON lines (e.g. skill-conflict warnings on stdout) */
      }
    }
    return answer || stdout
  },

  parsePhase(line) {
    let e: { type?: string; role?: string; tool_name?: string; parameters?: { command?: string } }
    try {
      e = JSON.parse(line)
    } catch {
      return null
    }
    if (e.type === 'init') return { phase: 'Starting', detail: '' }
    if (e.type === 'message' && e.role === 'assistant') return { phase: 'Writing', detail: '' }
    if (e.type === 'tool_use') {
      const tool = e.tool_name ?? ''
      if (tool === 'run_shell_command') {
        const cmd = (e.parameters?.command ?? '').trim()
        return { phase: 'Running command', detail: cmd.length > 48 ? cmd.slice(0, 48) + '…' : cmd }
      }
      if (tool === 'read_file' || tool === 'list_directory') return { phase: 'Reading', detail: '' }
      return { phase: tool ? `Running ${tool}` : 'Working', detail: '' }
    }
    return null
  },

  parseStep(line) {
    let e: {
      type?: string
      tool_id?: string
      tool_name?: string
      status?: string
      parameters?: { command?: string }
    }
    try {
      e = JSON.parse(line)
    } catch {
      return null
    }
    if (e.type === 'tool_use') {
      return { id: e.tool_id ?? '', edge: 'start', kind: e.tool_name ?? 'tool', cmd: shortCmd(e.parameters?.command) }
    }
    if (e.type === 'tool_result') {
      return {
        id: e.tool_id ?? '',
        edge: 'end',
        kind: 'tool',
        cmd: '',
        exit: e.status === 'error' ? 1 : 0
      }
    }
    return null
  },

  versionArgs: ['--version'],
  authArgs: ['--version'],

  parseAuth(_out, ok) {
    // gemini's CLI has no distinct `auth status` subcommand in --help. TOLERANT
    return { loggedIn: ok, detail: ok ? 'Logged in' : 'Not logged in' }
  },

  loginAdvice: 'Not logged in. Run `gemini` interactively once to log in, or set GEMINI_API_KEY.'
}

const mightymouse: BackendAdapter = {
  id: 'mightymouse',
  label: CONFIG.BACKEND_META.mightymouse.label,
  // deniableTools: true — act routes to buildClaudeCommand, so it inherits
  // --disallowedTools. (rewrite/ask go over http and never run tools at all.)
  capabilities: { vision: true, fileAttachments: true, toolCalls: true, deniableTools: true, thinking: false },
  // act → real CLI agent (shell); everything else → metered chat (http).
  transport: (feature) => (feature === 'act' ? 'shell' : 'http'),
  modelName: CONFIG.CLAUDE_MODEL,
  hasEnvelope: false,

  // act path: spawn the same `claude` CLI the BYO adapter uses — same agent loop,
  // same stream-json output, so parsePhase/parseOutput below reuse claude's parsers.
  buildCommand: buildClaudeCommand,

  buildEnv({ jwt, edgeBaseUrl }) {
    return {
      [CLI_ENV.BASE_URL]: `${edgeBaseUrl}/${CONFIG.BILLING.CLI_PROXY_FN}`,
      [CLI_ENV.AUTH_TOKEN]: jwt,
      [CLI_ENV.API_KEY]: '',
      // 1h cache writes bill 2x input vs 1.25x for 5m: measured $0.038 vs $0.024 per voice request.
      [CLI_ENV.CACHE_5M]: '1'
    }
  },

  parseOutput(stdout) {
    return claude.parseOutput(stdout)
  },

  parseStep(line) {
    return claude.parseStep!(line)
  },

  parsePhase(line) {
    const claudePhase = claude.parsePhase(line)
    if (claudePhase) return claudePhase
    let e: { type?: string }
    try {
      e = JSON.parse(line)
    } catch {
      return null
    }
    switch (e.type) {
      case 'message_start':
        return { phase: 'Starting', detail: '' }
      case 'content_block_start':
      case 'content_block_delta':
        return { phase: 'Writing', detail: '' }
      default:
        return null
    }
  },

  async runHttp(ctx: HttpRunCtx): Promise<void> {
    const { runId, systemPrompt, userPrompt, feature, attachments, json, selectedModel, onPhase, onDone, onModelResolved } = ctx
    const startedAt = Date.now()

    // Translate normalized attachments to the http wire forms here in the adapter:
    //  • images → downscaled-JPEG data URLs (a chat endpoint can't open disk paths).
    //  • files  → base64 `document` blocks (PDFs go native to Claude; text too).
    const { images: imageAtt, files: fileAtt } = splitAttachments(attachments)
    const images = loadImagesForVision(imageAtt.map((a) => a.path))
    const documents = loadDocumentsForHttp(fileAtt)

    let jwt: string
    try {
      jwt = await ctx.getJwt()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to get auth token'
      onDone(null, -1, '', msg, 0, '', '')
      return
    }

    onPhase('Calling MightyMouse', 'connecting')

    // Wall-clock timeout: abort a hung connection (no first byte) or a stalled
    // stream so the panel never freezes forever. -3 is the timeout sentinel.
    const abort = new AbortController()
    const killTimer =
      ctx.timeoutMs && ctx.timeoutMs > 0 ? setTimeout(() => abort.abort(), ctx.timeoutMs) : null
    const clearKillTimer = (): void => { if (killTimer) clearTimeout(killTimer) }
    const isAbort = (err: unknown): boolean =>
      err instanceof Error && (err.name === 'AbortError' || abort.signal.aborted)

    let resp: Response
    try {
      resp = await fetch(`${CONFIG.BILLING.EDGE_FUNCTION_URL}/llm-proxy`, {
        method: 'POST',
        signal: abort.signal,
        headers: {
          'Content-Type': 'application/json',
          // JWT is the only secret the client ever sends — Anthropic key stays server-side.
          'Authorization': `Bearer ${jwt}`
        },
        body: JSON.stringify({
          runId,
          system: systemPrompt,
          userPrompt,
          // Feature tag for per-feature billing visibility. The proxy clamps it to
          // the known set server-side; sending it is best-effort metadata only.
          feature,
          // Inline downscaled-JPEG data URLs. The proxy folds them into multimodal
          // user content and forces a vision model. Omit the key when there are none.
          ...(images.length > 0 ? { images } : {}),
          // Base64 document blocks (PDF/text). The proxy maps these to Anthropic
          // `document` content blocks. Omit the key when there are none.
          ...(documents.length > 0 ? { documents } : {}),
          // Ask the proxy for response_format json_object on JSON-parsed calls only.
          // Omit the key entirely otherwise so prose answers are never JSON-clamped.
          ...(json ? { json: true } : {}),
          ...(selectedModel ? { model: selectedModel } : {})
        })
      })
    } catch (err) {
      clearKillTimer()
      const duration = (Date.now() - startedAt) / 1000
      if (isAbort(err)) {
        onDone(null, -3, '', 'timed_out', duration, '', '')
        return
      }
      const msg = err instanceof Error ? err.message : 'Network error'
      onDone(null, -1, '', msg, duration, '', '')
      return
    }

    const duration = (): number => (Date.now() - startedAt) / 1000

    if (resp.status === 402) {
      // Server confirmed balance is zero — signal panel to show top-up UI.
      // exit-code -2 is the out-of-credits sentinel; runner.ts propagates it to the panel.
      clearKillTimer()
      onDone(null, -2, '', 'out_of_credits', duration(), '', '')
      return
    }

    if (!resp.ok) {
      clearKillTimer()
      let errText = ''
      try { errText = await resp.text() } catch {}
      onDone(null, resp.status, '', errText, duration(), '', '')
      return
    }

    // Stream the NDJSON body: drive onPhase per line, capture the terminal mm_result line.
    const body = resp.body
    if (!body) {
      clearKillTimer()
      onDone(null, -1, '', 'Empty response body', duration(), '', '')
      return
    }

    const reader = body.getReader()
    const decoder = new TextDecoder()
    let lineBuf = ''
    let result: string | null = null

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        lineBuf += decoder.decode(value, { stream: true })
        let nl: number
        while ((nl = lineBuf.indexOf('\n')) !== -1) {
          const line = lineBuf.slice(0, nl).trim()
          lineBuf = lineBuf.slice(nl + 1)
          if (!line) continue

          // Drive progress UI via the adapter's own parsePhase so the mapping is colocated.
          const ph = this.parsePhase(line)
          if (ph) onPhase(ph.phase, ph.detail)

          // The proxy appends a terminal NDJSON line with the assembled result + updated balance.
          try {
            const e = JSON.parse(line) as { type?: string; result?: string; model?: string }
            if (e.type === 'mm_result' && typeof e.result === 'string') {
              result = e.result
              // The server's routed model — the only way the client learns it.
              // Absent on an older proxy build; the caller then keeps its own guess.
              if (typeof e.model === 'string' && e.model !== '') onModelResolved?.(e.model)
            }
          } catch {
            /* non-JSON lines are fine — they're raw SSE pass-through */
          }
        }
      }
      // Flush any partial line at stream end.
      if (lineBuf.trim()) {
        const ph = this.parsePhase(lineBuf.trim())
        if (ph) onPhase(ph.phase, ph.detail)
        try {
          const e = JSON.parse(lineBuf.trim()) as { type?: string; result?: string; model?: string }
          if (e.type === 'mm_result' && typeof e.result === 'string') {
            result = e.result
            if (typeof e.model === 'string' && e.model !== '') onModelResolved?.(e.model)
          }
        } catch {}
      }
    } catch (err) {
      clearKillTimer()
      if (isAbort(err)) {
        onDone(null, -3, '', 'timed_out', duration(), '', '')
        return
      }
      const msg = err instanceof Error ? err.message : 'Stream read error'
      onDone(null, -1, '', msg, duration(), '', '')
      return
    }

    clearKillTimer()
    onDone(result, result !== null ? 0 : -1, '', '', duration(), '', '')
  }
}

/**
 * Should this Ollama run reason before answering? Three conditions, all required:
 *
 *  1. The user turned it on. Default off — measured on qwen3.5:9b, thinking was
 *     6.4x slower (439s vs 68s over 5 tasks) and scored WORSE (0.75 vs 0.87).
 *     A one-sentence rewrite cost 3.4k chars of internal monologue.
 *  2. Chat only. `rewrite` is short-form where off is near-certainly right, and
 *     `act` runs unattended for up to an hour — per-turn reasoning there is
 *     completely unbenchmarked, so it stays off regardless of the pref.
 *  3. The model declares "thinking" in /api/show. NOT decoration: /api/chat
 *     hard-errors `"<model>" does not support thinking` on a model without it
 *     (verified against qwen2.5:0.5b). Sending it blind would break every run
 *     on an incapable model.
 */
async function resolveThinking(ctx: HttpRunCtx): Promise<boolean> {
  if (!ctx.thinkingEnabled || ctx.feature !== 'ask') return false
  return (await getLocalModelCapabilities(ctx.ollamaModel)).thinking
}

const local: BackendAdapter = {
  id: 'local',
  label: CONFIG.BACKEND_META.local.label,
  // Static fallback; the live answer comes from getCapabilities (varies by model).
  capabilities: { vision: false, fileAttachments: false, toolCalls: false, deniableTools: false, thinking: false },
  // act → real claude CLI agent over Ollama's Anthropic-compat endpoint; rewrite/ask → http.
  transport: (feature) => (feature === 'act' ? 'shell' : 'http'),
  modelName: CONFIG.OLLAMA_MODEL,
  hasEnvelope: false,

  install: { brew: 'ollama' },

  buildCommand: buildClaudeCommand,

  buildEnv() {
    return {
      [CLI_ENV.BASE_URL]: CONFIG.OLLAMA_BASE_URL,
      [CLI_ENV.AUTH_TOKEN]: 'ollama',
      [CLI_ENV.API_KEY]: ''
    }
  },

  parseOutput(stdout) {
    return claude.parseOutput(stdout)
  },

  parsePhase(line) {
    const claudePhase = claude.parsePhase(line)
    if (claudePhase) return claudePhase
    let e: { message?: { content?: string }; done?: boolean }
    try {
      e = JSON.parse(line)
    } catch {
      return null
    }
    if (e.done) return null
    return typeof e.message?.content === 'string' && e.message.content !== ''
      ? { phase: 'Writing', detail: '' }
      : { phase: 'Starting', detail: '' }
  },

  parseStep(line) {
    return claude.parseStep!(line)
  },

  parseEvent(line) {
    return claude.parseEvent!(line)
  },

  async runHttp(ctx: HttpRunCtx): Promise<void> {
    const { systemPrompt, userPrompt, priorMessages, attachments, ollamaModel, onPhase, onEvent, onDone } = ctx
    const startedAt = Date.now()
    const duration = (): number => (Date.now() - startedAt) / 1000

    if (ollamaModel === '') {
      onDone(null, -1, '', 'No local model selected. Pick one pulled in Ollama from Settings.', 0, '', '')
      return
    }

    const think = await resolveThinking(ctx)
    ctx.onThinkingResolved?.(think)

    const { images: imageAtt, files: fileAtt } = splitAttachments(attachments)
    const rawImages = loadImagesForVision(imageAtt.map((a) => a.path)).map((dataUrl) => {
      const comma = dataUrl.indexOf(',')
      return comma === -1 ? dataUrl : dataUrl.slice(comma + 1)
    })
    const fileBlock = inlineFilesForPrompt(fileAtt)
    const trimmedPrior = trimToTokenBudget(priorMessages, PRIOR_MESSAGES_TOKEN_BUDGET)
    const contextLength = await getOllamaContextLength(ollamaModel)
    const numCtx = Math.min(CONFIG.OLLAMA_NUM_CTX_MAX, contextLength || CONFIG.OLLAMA_NUM_CTX_MAX)

    onPhase('Starting', 'connecting to Ollama')

    const abort = new AbortController()
    const killTimer =
      ctx.timeoutMs && ctx.timeoutMs > 0 ? setTimeout(() => abort.abort(), ctx.timeoutMs) : null
    const clearKillTimer = (): void => { if (killTimer) clearTimeout(killTimer) }
    const isAbort = (err: unknown): boolean =>
      err instanceof Error && (err.name === 'AbortError' || abort.signal.aborted)

    const wantsTools = (await getLocalModelCapabilities(ollamaModel)).tools && (await hasConfiguredMcpServers())
    if (wantsTools) {
      try {
        const result = await runOllamaToolLoop({
          model: ollamaModel,
          think,
          numCtx,
          keepAlive: CONFIG.OLLAMA_KEEP_ALIVE,
          signal: abort.signal,
          onPhase,
          onEvent,
          messages: [
            { role: 'system', content: systemPrompt },
            ...trimmedPrior,
            {
              role: 'user',
              content: userPrompt + fileBlock,
              ...(rawImages.length > 0 ? { images: rawImages } : {})
            }
          ]
        })
        clearKillTimer()
        onDone(result || null, result ? 0 : -1, '', '', duration(), '', '')
      } catch (err) {
        clearKillTimer()
        if (isAbort(err)) {
          onDone(null, -3, '', 'timed_out', duration(), '', '')
          return
        }
        const msg = err instanceof Error ? err.message : 'Ollama request failed'
        onDone(null, -1, '', msg, duration(), '', '')
      }
      return
    }

    let resp: Response
    try {
      resp = await fetch(`${CONFIG.OLLAMA_BASE_URL}/api/chat`, {
        method: 'POST',
        signal: abort.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: ollamaModel,
          stream: true,
          think,
          keep_alive: CONFIG.OLLAMA_KEEP_ALIVE,
          options: { num_ctx: numCtx },
          messages: [
            { role: 'system', content: systemPrompt },
            ...trimmedPrior,
            {
              role: 'user',
              content: userPrompt + fileBlock,
              ...(rawImages.length > 0 ? { images: rawImages } : {})
            }
          ]
        })
      })
    } catch (err) {
      clearKillTimer()
      if (isAbort(err)) {
        onDone(null, -3, '', 'timed_out', duration(), '', '')
        return
      }
      const msg = err instanceof Error ? err.message : 'Ollama not reachable. Is it running?'
      onDone(null, -1, '', msg, duration(), '', '')
      return
    }

    if (!resp.ok || !resp.body) {
      clearKillTimer()
      let errText = ''
      try { errText = await resp.text() } catch {}
      onDone(null, -1, '', errText || 'Ollama request failed', duration(), '', '')
      return
    }

    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let lineBuf = ''
    let result = ''

    const consumeLine = (raw: string): void => {
      const line = raw.trim()
      if (!line) return
      const ph = this.parsePhase(line)
      if (ph) onPhase(ph.phase, ph.detail)
      try {
        const e = JSON.parse(line) as {
          message?: { content?: string }
          done?: boolean
          eval_count?: number
          eval_duration?: number
          prompt_eval_count?: number
        }
        if (typeof e.message?.content === 'string') result += e.message.content
        if (e.done && typeof e.eval_count === 'number') {
          onEvent?.({
            kind: RUN_EVENT.usage,
            inputTokens: e.prompt_eval_count ?? 0,
            outputTokens: e.eval_count,
            durationMs: typeof e.eval_duration === 'number' ? e.eval_duration / 1e6 : undefined
          })
        }
      } catch {
        /* non-JSON line — ignore */
      }
    }

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        lineBuf += decoder.decode(value, { stream: true })
        let nl: number
        while ((nl = lineBuf.indexOf('\n')) !== -1) {
          consumeLine(lineBuf.slice(0, nl))
          lineBuf = lineBuf.slice(nl + 1)
        }
      }
      if (lineBuf.trim()) consumeLine(lineBuf)
    } catch (err) {
      clearKillTimer()
      if (isAbort(err)) {
        onDone(null, -3, '', 'timed_out', duration(), '', '')
        return
      }
      const msg = err instanceof Error ? err.message : 'Stream read error'
      onDone(null, -1, '', msg, duration(), '', '')
      return
    }

    clearKillTimer()
    onDone(result || null, result ? 0 : -1, '', '', duration(), '', '')
  }
}

const mlx: BackendAdapter = {
  id: 'mlx',
  label: CONFIG.BACKEND_META.mlx.label,
  // Static fallback; the live answer comes from getCapabilities (varies by model).
  capabilities: { vision: false, fileAttachments: false, toolCalls: false, deniableTools: false, thinking: false },
  transport: 'http',
  modelName: CONFIG.RAPIDMLX_MODEL,
  hasEnvelope: false,

  install: { brew: 'rapid-mlx' },

  parseOutput(stdout) {
    return stdout
  },

  parsePhase(line) {
    // OpenAI SSE lines arrive here already stripped of the `data: ` prefix by runHttp.
    let e: { choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }> }
    try {
      e = JSON.parse(line)
    } catch {
      return null
    }
    const choice = e.choices?.[0]
    if (!choice) return null
    if (typeof choice.delta?.content === 'string' && choice.delta.content !== '') {
      return { phase: 'Writing', detail: '' }
    }
    return { phase: 'Starting', detail: '' }
  },

  async runHttp(ctx: HttpRunCtx): Promise<void> {
    const { systemPrompt, userPrompt, priorMessages, attachments, mlxModel, onPhase, onEvent, onDone } = ctx
    const startedAt = Date.now()
    const duration = (): number => (Date.now() - startedAt) / 1000

    if (mlxModel === '') {
      onDone(null, -1, '', 'No Rapid-MLX model selected. Serve one and pick it in Settings.', 0, '', '')
      return
    }

    // Images: OpenAI multimodal content — `image_url` blocks with a data: URL
    // (exactly what loadImagesForVision produces). Files: Rapid-MLX's chat endpoint
    // has no document block, so inline as text the same way codex/local degrade.
    const { images: imageAtt, files: fileAtt } = splitAttachments(attachments)
    const imageUrls = loadImagesForVision(imageAtt.map((a) => a.path))
    const fileBlock = inlineFilesForPrompt(fileAtt)
    const trimmedPrior = trimToTokenBudget(priorMessages, PRIOR_MESSAGES_TOKEN_BUDGET)

    // OpenAI content: a bare string when text-only, or a content-part array when
    // images are attached (the server folds image_url parts into the vision path).
    const userText = userPrompt + fileBlock
    const userContent =
      imageUrls.length > 0
        ? [
            { type: 'text', text: userText },
            ...imageUrls.map((url) => ({ type: 'image_url', image_url: { url } }))
          ]
        : userText

    onPhase('Starting', 'connecting to Rapid-MLX')

    const abort = new AbortController()
    const killTimer =
      ctx.timeoutMs && ctx.timeoutMs > 0 ? setTimeout(() => abort.abort(), ctx.timeoutMs) : null
    const clearKillTimer = (): void => { if (killTimer) clearTimeout(killTimer) }
    const isAbort = (err: unknown): boolean =>
      err instanceof Error && (err.name === 'AbortError' || abort.signal.aborted)

    let resp: Response
    try {
      resp = await fetch(`${CONFIG.RAPIDMLX_BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        signal: abort.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: mlxModel,
          stream: true,
          messages: [
            { role: 'system', content: systemPrompt },
            ...trimmedPrior,
            { role: 'user', content: userContent }
          ]
        })
      })
    } catch (err) {
      clearKillTimer()
      if (isAbort(err)) {
        onDone(null, -3, '', 'timed_out', duration(), '', '')
        return
      }
      const msg = err instanceof Error ? err.message : 'Rapid-MLX not reachable. Is it running?'
      onDone(null, -1, '', msg, duration(), '', '')
      return
    }

    if (!resp.ok || !resp.body) {
      clearKillTimer()
      let errText = ''
      try { errText = await resp.text() } catch {}
      onDone(null, -1, '', errText || 'Rapid-MLX request failed', duration(), '', '')
      return
    }

    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let lineBuf = ''
    let result = ''

    // One SSE line → drive progress + accumulate delta text. Skips `: keepalive`
    // comment lines and the terminal `data: [DONE]`; everything else is a chunk.
    const consumeLine = (raw: string): void => {
      const line = raw.trim()
      if (!line || line.startsWith(':')) return // '' or SSE comment/keepalive
      if (!line.startsWith('data:')) return
      const payload = line.slice(5).trim()
      if (payload === '' || payload === '[DONE]') return
      const ph = this.parsePhase(payload)
      if (ph) onPhase(ph.phase, ph.detail)
      try {
        const e = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string } }>
          usage?: { prompt_tokens?: number; completion_tokens?: number }
        }
        const chunk = e.choices?.[0]?.delta?.content
        if (typeof chunk === 'string') result += chunk
        if (e.usage) {
          onEvent?.({
            kind: RUN_EVENT.usage,
            inputTokens: e.usage.prompt_tokens ?? 0,
            outputTokens: e.usage.completion_tokens ?? 0
          })
        }
      } catch {
        /* non-JSON data line — ignore */
      }
    }

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        lineBuf += decoder.decode(value, { stream: true })
        let nl: number
        while ((nl = lineBuf.indexOf('\n')) !== -1) {
          consumeLine(lineBuf.slice(0, nl))
          lineBuf = lineBuf.slice(nl + 1)
        }
      }
      if (lineBuf.trim()) consumeLine(lineBuf)
    } catch (err) {
      clearKillTimer()
      if (isAbort(err)) {
        onDone(null, -3, '', 'timed_out', duration(), '', '')
        return
      }
      const msg = err instanceof Error ? err.message : 'Stream read error'
      onDone(null, -1, '', msg, duration(), '', '')
      return
    }

    clearKillTimer()
    onDone(result || null, result ? 0 : -1, '', '', duration(), '', '')
  }
}

/** The registry. Add a provider by appending its adapter here — nothing else changes. */
export const BACKENDS = { claude, codex, mightymouse, opencode, gemini, local, mlx, openrouter } as const

/** The provider id union, derived from the registry keys. Single source of truth. */
export type BackendId = keyof typeof BACKENDS

/** Default backend id, validated against the registry. */
export const DEFAULT_BACKEND: BackendId = (CONFIG.DEFAULT_BACKEND in BACKENDS
  ? CONFIG.DEFAULT_BACKEND
  : 'claude') as BackendId

/** Narrow an arbitrary string to a known BackendId, falling back to the default. */
export function toBackendId(value: string | null | undefined): BackendId {
  return value && value in BACKENDS ? (value as BackendId) : DEFAULT_BACKEND
}

export function canRunUnattended(id: BackendId): boolean {
  const caps = BACKENDS[id].capabilities
  return caps.deniableTools || !caps.toolCalls
}

export async function getCapabilities(
  id: BackendId,
  ollamaModel?: string,
  mlxModel?: string
): Promise<BackendCapabilities> {
  const adapter = BACKENDS[id]
  if (id === 'local') {
    const { vision, tools, thinking } = await getLocalModelCapabilities(ollamaModel ?? '')
    // deniableTools: false — an http backend has no CLI to pass a deny flag to.
    return { vision, fileAttachments: false, toolCalls: tools, deniableTools: false, thinking }
  }
  if (id === 'mlx') {
    const { vision, tools } = await getMlxModelCapabilities(mlxModel ?? '')
    // deniableTools: false — an http backend has no CLI to pass a deny flag to.
    return { vision, fileAttachments: false, toolCalls: tools, deniableTools: false, thinking: false }
  }
  return adapter.capabilities
}

// Subagents add cheaper models to modelUsage; the one that wrote the most is the one the user picked.
function mainModel(usage: Record<string, { outputTokens?: number }> | undefined): string | undefined {
  const rows = Object.entries(usage ?? {})
  if (rows.length === 0) return undefined
  return rows.reduce((a, b) => ((b[1].outputTokens ?? 0) > (a[1].outputTokens ?? 0) ? b : a))[0]
}

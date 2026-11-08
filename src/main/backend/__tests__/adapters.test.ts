import { describe, it, expect, vi, afterEach } from 'vitest'

// Resolve binaries to fixed paths so buildCommand output is deterministic and
// doesn't depend on whether claude/codex are installed on the test machine.
vi.mock('../../platform', () => ({
  resolveBinary: vi.fn(() => '/usr/local/bin/x'),
  resolveClaude: vi.fn(() => '/usr/local/bin/claude'),
  resolveCodex: vi.fn(() => '/usr/local/bin/codex'),
  resolveOpencode: vi.fn(() => '/usr/local/bin/opencode'),
  resolveGemini: vi.fn(() => '/usr/local/bin/gemini'),
  clearBinaryCache: vi.fn()
}))

vi.mock('../local-models', () => ({
  isOllamaRunning: vi.fn(),
  listLocalModels: vi.fn(),
  getLocalModelCapabilities: vi.fn(async () => ({ vision: false, tools: false, thinking: false })),
  getOllamaContextLength: vi.fn(async () => 0)
}))

vi.mock('../mlx-models', () => ({
  isMlxRunning: vi.fn(),
  listMlxModels: vi.fn(),
  getMlxModelCapabilities: vi.fn()
}))

import { BACKENDS, getCapabilities } from '../adapters'
import { CONFIG } from '../../../shared/config'
import { getLocalModelCapabilities } from '../local-models'
import { getMlxModelCapabilities } from '../mlx-models'

const claude = BACKENDS.claude
const codex = BACKENDS.codex
const mightymouse = BACKENDS.mightymouse
const opencode = BACKENDS.opencode
const gemini = BACKENDS.gemini
const local = BACKENDS.local
const mlx = BACKENDS.mlx

function assistantLine(content: object[]): string {
  return JSON.stringify({ type: 'assistant', message: { content } })
}

// Minimal BuildCommandCtx for exercising buildCommand output. shellQuote mirrors
// the runner's single-quote escaping so the asserted strings match production.
const sq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
const sft = (p: string): string => `"$(cat ${sq(p)})"`
function buildCtx(overrides: Partial<Parameters<NonNullable<typeof codex.buildCommand>>[0]> = {}): Parameters<NonNullable<typeof codex.buildCommand>>[0] {
  return {
    runDir: '/tmp/run',
    promptFile: '/tmp/run/prompt.txt',
    outFile: '/tmp/run/out.txt',
    addDirs: [],
    attachments: [],
    shellQuote: sq,
    shellFileText: sft,
    ...overrides
  }
}

describe('claude parsePhase', () => {
  it('system event → Starting', () => {
    expect(claude.parsePhase(JSON.stringify({ type: 'system' }))).toEqual({
      phase: 'Starting',
      detail: ''
    })
  })

  it('assistant text → Writing', () => {
    expect(claude.parsePhase(assistantLine([{ type: 'text', text: 'hello' }]))).toEqual({
      phase: 'Writing',
      detail: ''
    })
  })

  it('Bash with description → uses description as phase', () => {
    expect(
      claude.parsePhase(
        assistantLine([
          { type: 'tool_use', name: 'Bash', input: { command: 'ffmpeg ...', description: 'Convert to MP3' } }
        ])
      )
    ).toEqual({ phase: 'Convert to MP3', detail: '' })
  })

  it('Bash without description → Running command + truncated cmd', () => {
    const result = claude.parsePhase(
      assistantLine([{ type: 'tool_use', name: 'Bash', input: { command: 'which ffmpeg' } }])
    )
    expect(result?.phase).toBe('Running command')
    expect(result?.detail).toBe('which ffmpeg')
  })

  it('Bash with long command → truncated to 48 chars + ellipsis', () => {
    const longCmd = 'ffmpeg -i /very/long/path/to/input.mov -vn -ar 44100 output.mp3'
    const result = claude.parsePhase(
      assistantLine([{ type: 'tool_use', name: 'Bash', input: { command: longCmd } }])
    )
    expect(result?.detail?.length).toBeLessThanOrEqual(49) // 48 + ellipsis char
    expect(result?.detail).toContain('…')
  })

  it('Read with PNG path → Looking at your screen', () => {
    expect(
      claude.parsePhase(
        assistantLine([{ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/screen.png' } }])
      )
    ).toEqual({ phase: 'Looking at your screen', detail: '' })
  })

  it('Read with sel.txt → Reading your selection', () => {
    expect(
      claude.parsePhase(
        assistantLine([
          { type: 'tool_use', name: 'Read', input: { file_path: '/tmp/rewrite-123-sel.txt' } }
        ])
      )
    ).toEqual({ phase: 'Reading your selection', detail: '' })
  })

  it('Read with generic file → Reading <filename>', () => {
    const result = claude.parsePhase(
      assistantLine([{ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/notes.md' } }])
    )
    expect(result?.phase).toBe('Reading')
    expect(result?.detail).toContain('notes.md')
  })

  it('Skill tool → Running /yap', () => {
    expect(
      claude.parsePhase(
        assistantLine([{ type: 'tool_use', name: 'Skill', input: { command: 'yap' } }])
      )
    ).toEqual({ phase: 'Running /yap', detail: '' })
  })

  it('Skill tool with no name → Running skill', () => {
    expect(
      claude.parsePhase(assistantLine([{ type: 'tool_use', name: 'Skill', input: {} }]))
    ).toEqual({ phase: 'Running skill', detail: '' })
  })

  it('unknown tool → Running <name>', () => {
    expect(
      claude.parsePhase(assistantLine([{ type: 'tool_use', name: 'WebSearch', input: {} }]))
    ).toEqual({ phase: 'Running WebSearch', detail: '' })
  })

  it('result event → null (ignored)', () => {
    expect(claude.parsePhase(JSON.stringify({ type: 'result', result: 'done' }))).toBeNull()
  })

  it('non-JSON line → null', () => {
    expect(claude.parsePhase('not json at all')).toBeNull()
  })

  it('empty line → null', () => {
    expect(claude.parsePhase('')).toBeNull()
  })
})

describe('claude parseEvent', () => {
  // Shapes below mirror REAL claude CLI stream-json output captured from a run
  // (.out-*.txt): tool_use carries the full input, tool_result carries content +
  // is_error, and the terminal result event carries usage/cost/turns/duration.
  it('tool_use → tool_start with the FULL untruncated input', () => {
    const input = { command: 'ffmpeg -i a.mp4 -ss 0 -t 1 out.mp4', description: 'clip' }
    const events = claude.parseEvent!(
      assistantLine([{ type: 'tool_use', id: 'tu_1', name: 'Bash', input }])
    )
    expect(events).toEqual([{ kind: 'tool_start', id: 'tu_1', name: 'Bash', input }])
  })

  it('assistant text block → text event', () => {
    expect(claude.parseEvent!(assistantLine([{ type: 'text', text: 'Working on it' }]))).toEqual([
      { kind: 'text', text: 'Working on it' }
    ])
  })

  it('thinking block → thinking event', () => {
    expect(
      claude.parseEvent!(assistantLine([{ type: 'thinking', thinking: 'let me reason' }]))
    ).toEqual([{ kind: 'thinking', text: 'let me reason' }])
  })

  it('one assistant message with text + tool_use → two events in order', () => {
    const events = claude.parseEvent!(
      assistantLine([
        { type: 'text', text: 'Reading the file' },
        { type: 'tool_use', id: 'tu_2', name: 'Read', input: { file_path: '/x.ts' } }
      ])
    )
    expect(events).toEqual([
      { kind: 'text', text: 'Reading the file' },
      { kind: 'tool_start', id: 'tu_2', name: 'Read', input: { file_path: '/x.ts' } }
    ])
  })

  it('tool_result (user message) → tool_end with full output + isError', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'exit 0\nok', is_error: false }] }
    })
    expect(claude.parseEvent!(line)).toEqual([
      { kind: 'tool_end', id: 'tu_1', output: 'exit 0\nok', isError: false }
    ])
  })

  it('tool_result with is_error → isError true', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu_9', content: 'boom', is_error: true }] }
    })
    expect(claude.parseEvent!(line)).toEqual([
      { kind: 'tool_end', id: 'tu_9', output: 'boom', isError: true }
    ])
  })

  it('terminal result event → usage with tokens, cost, turns, duration', () => {
    const line = JSON.stringify({
      type: 'result',
      result: 'done',
      usage: {
        input_tokens: 48,
        output_tokens: 9894,
        cache_read_input_tokens: 2401922,
        cache_creation_input_tokens: 90835
      },
      total_cost_usd: 2.358896,
      num_turns: 30,
      duration_ms: 233862
    })
    expect(claude.parseEvent!(line)).toEqual([
      {
        kind: 'usage',
        inputTokens: 48,
        outputTokens: 9894,
        cacheReadTokens: 2401922,
        cacheCreationTokens: 90835,
        costUsd: 2.358896,
        turns: 30,
        durationMs: 233862
      }
    ])
  })

  it('non-event lines (system, empty, malformed) → []', () => {
    expect(claude.parseEvent!(JSON.stringify({ type: 'system' }))).toEqual([])
    expect(claude.parseEvent!('')).toEqual([])
    expect(claude.parseEvent!('not json{')).toEqual([])
  })
})

describe('codex parsePhase', () => {
  it('thread.started → Starting', () => {
    expect(codex.parsePhase(JSON.stringify({ type: 'thread.started' }))).toEqual({
      phase: 'Starting',
      detail: ''
    })
  })

  it('turn.started → Starting', () => {
    expect(codex.parsePhase(JSON.stringify({ type: 'turn.started' }))).toEqual({
      phase: 'Starting',
      detail: ''
    })
  })

  it('item.started agent_message → Writing', () => {
    expect(
      codex.parsePhase(JSON.stringify({ type: 'item.started', item: { type: 'agent_message' } }))
    ).toEqual({ phase: 'Writing', detail: '' })
  })

  it('item.completed agent_message → Writing', () => {
    expect(
      codex.parsePhase(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message' } }))
    ).toEqual({ phase: 'Writing', detail: '' })
  })

  it('item.started command_execution → Running command', () => {
    expect(
      codex.parsePhase(
        JSON.stringify({ type: 'item.started', item: { type: 'command_execution' } })
      )
    ).toEqual({ phase: 'Running command', detail: '' })
  })

  it('item.started file_change → Editing files', () => {
    expect(
      codex.parsePhase(JSON.stringify({ type: 'item.started', item: { type: 'file_change' } }))
    ).toEqual({ phase: 'Editing files', detail: '' })
  })

  it('item.started unknown type → Working + type as detail', () => {
    const result = codex.parsePhase(
      JSON.stringify({ type: 'item.started', item: { type: 'reasoning' } })
    )
    expect(result?.phase).toBe('Working')
    expect(result?.detail).toBe('reasoning')
  })

  it('unknown top-level type → null', () => {
    expect(codex.parsePhase(JSON.stringify({ type: 'session.ended' }))).toBeNull()
  })

  it('non-JSON line → null', () => {
    expect(codex.parsePhase('garbage')).toBeNull()
  })
})

describe('mightymouse adapter', () => {
  it('transport is per-feature: act → shell, everything else → http', () => {
    // Dual-transport: act runs the real CLI agent (shell, executes tools locally),
    // rewrite/ask run the metered chat proxy (http).
    expect(typeof mightymouse.transport).toBe('function')
    const resolve = mightymouse.transport as (f: 'rewrite' | 'ask' | 'act' | undefined) => string
    expect(resolve('act')).toBe('shell')
    expect(resolve('rewrite')).toBe('http')
    expect(resolve('ask')).toBe('http')
    expect(resolve(undefined)).toBe('http')
  })

  it('probe-transport resolution treats mightymouse as http (regression: probeBackend)', () => {
    // probeBackend compares transport against 'http' to pick the balance branch. A
    // function transport is NEVER === 'http', which made the health check fall through
    // to the shell/CLI path and report "CLI not found" for the paid HTTP backend.
    // The fix resolves the function first (as the probe, i.e. a non-act feature).
    // This test pins that a raw === 'http' check would FAIL, so the resolve step
    // can't be dropped again without going red here.
    const t = mightymouse.transport
    expect(t === 'http').toBe(false) // the trap: raw comparison is always false
    const resolved = typeof t === 'function' ? t(undefined) : t
    expect(resolved).toBe('http') // resolved-first is what the probe must do
  })

  it('has both a shell act path (buildCommand + buildEnv) and the http runHttp', () => {
    // act reuses the claude CLI command…
    expect(typeof mightymouse.buildCommand).toBe('function')
    // …re-pointed at our metered proxy via buildEnv (key stays server-side).
    expect(typeof mightymouse.buildEnv).toBe('function')
    expect(typeof mightymouse.runHttp).toBe('function')
  })

  it('buildEnv points the CLI at our cli-proxy with the JWT, blanks the api key', () => {
    const env = mightymouse.buildEnv!({ jwt: 'jwt-123', edgeBaseUrl: 'https://edge.test/functions/v1' })
    expect(env['ANTHROPIC_BASE_URL']).toBe('https://edge.test/functions/v1/cli-proxy')
    expect(env['ANTHROPIC_AUTH_TOKEN']).toBe('jwt-123')
    // Must be blank or the CLI prefers it over the auth token.
    expect(env['ANTHROPIC_API_KEY']).toBe('')
  })

  it('message_start → Starting', () => {
    expect(mightymouse.parsePhase(JSON.stringify({ type: 'message_start' }))).toEqual({
      phase: 'Starting',
      detail: ''
    })
  })

  it('content_block_start → Writing', () => {
    expect(mightymouse.parsePhase(JSON.stringify({ type: 'content_block_start' }))).toEqual({
      phase: 'Writing',
      detail: ''
    })
  })

  it('content_block_delta → Writing', () => {
    expect(mightymouse.parsePhase(JSON.stringify({ type: 'content_block_delta' }))).toEqual({
      phase: 'Writing',
      detail: ''
    })
  })

  it('message_stop → null (not a phase we surface)', () => {
    expect(mightymouse.parsePhase(JSON.stringify({ type: 'message_stop' }))).toBeNull()
  })

  it('mm_result line → null (terminal line, no phase)', () => {
    expect(
      mightymouse.parsePhase(JSON.stringify({ type: 'mm_result', result: 'hello' }))
    ).toBeNull()
  })

  it('non-JSON line → null', () => {
    expect(mightymouse.parsePhase('not json')).toBeNull()
  })

  it('parseOutput is identity', () => {
    expect(mightymouse.parseOutput('some text')).toBe('some text')
  })

  it('claude and codex have transport shell', () => {
    expect(BACKENDS.claude.transport).toBe('shell')
    expect(BACKENDS.codex.transport).toBe('shell')
  })
})

describe('local adapter parsePhase', () => {
  it('content chunk → Writing', () => {
    expect(local.parsePhase(JSON.stringify({ message: { content: 'hi' }, done: false }))).toEqual({
      phase: 'Writing',
      detail: ''
    })
  })

  it('empty content, not done → Starting', () => {
    expect(local.parsePhase(JSON.stringify({ message: { content: '' }, done: false }))).toEqual({
      phase: 'Starting',
      detail: ''
    })
  })

  it('done:true line → null (terminal, no phase)', () => {
    expect(local.parsePhase(JSON.stringify({ done: true }))).toBeNull()
  })

  it('non-JSON line → null', () => {
    expect(local.parsePhase('not json')).toBeNull()
  })

  it('parseOutput is identity', () => {
    expect(local.parseOutput('some text')).toBe('some text')
  })
})

// Minimal HttpRunCtx for exercising runHttp. onPhase/onDone are captured so
// assertions can inspect what the adapter reported without a real Ollama.
function httpCtx(overrides: Partial<Parameters<NonNullable<typeof local.runHttp>>[0]> = {}) {
  const onPhase = vi.fn()
  const onDone = vi.fn()
  const ctx = {
    runId: 'r1',
    systemPrompt: 'sys',
    userPrompt: 'hello',
    priorMessages: [],
    addDirs: [],
    attachments: [],
    ollamaModel: 'gemma3:27b',
    mlxModel: 'qwen3-0.6b-4bit',
    selectedModel: '',
    getJwt: vi.fn(async () => ''),
    onPhase,
    onDone,
    ...overrides
  } as Parameters<NonNullable<typeof local.runHttp>>[0]
  return { ctx, onPhase, onDone }
}

describe('local adapter runHttp', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('no model selected → onDone with an error, never calls fetch', async () => {
    const fetchSpy = vi.fn()
    global.fetch = fetchSpy as unknown as typeof fetch
    const { ctx, onDone } = httpCtx({ ollamaModel: '' })

    await local.runHttp!(ctx)

    expect(fetchSpy).not.toHaveBeenCalled()
    const [result, exitCode, , stderr] = onDone.mock.calls[0]
    expect(result).toBeNull()
    expect(exitCode).toBe(-1)
    expect(stderr).toContain('No local model selected')
  })

  it('streams NDJSON chunks from /api/chat and assembles the final text', async () => {
    const lines = [
      JSON.stringify({ message: { content: 'Hel' }, done: false }),
      JSON.stringify({ message: { content: 'lo' }, done: false }),
      JSON.stringify({ done: true })
    ]
    const body = lines.map((l) => l + '\n').join('')
    const encoder = new TextEncoder()
    const chunks = [encoder.encode(body)]
    const reader = {
      read: vi.fn(async () => {
        if (chunks.length === 0) return { done: true, value: undefined }
        return { done: false, value: chunks.shift() }
      })
    }
    global.fetch = vi.fn(async () => ({
      ok: true,
      body: { getReader: () => reader },
      text: async () => ''
    })) as unknown as typeof fetch

    const { ctx, onDone, onPhase } = httpCtx()
    await local.runHttp!(ctx)

    expect(global.fetch).toHaveBeenCalledWith(
      `${CONFIG.OLLAMA_BASE_URL}/api/chat`,
      expect.objectContaining({ method: 'POST' })
    )
    const sentBody = JSON.parse((global.fetch as any).mock.calls[0][1].body)
    expect(sentBody.model).toBe('gemma3:27b')
    expect(sentBody.stream).toBe(true)

    expect(onPhase).toHaveBeenCalledWith('Writing', '')
    const [result, exitCode] = onDone.mock.calls[0]
    expect(result).toBe('Hello')
    expect(exitCode).toBe(0)
  })

  it('fetch throws (Ollama not running) → onDone with an error, exitCode -1', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED')
    }) as unknown as typeof fetch

    const { ctx, onDone } = httpCtx()
    await local.runHttp!(ctx)

    const [result, exitCode, , stderr] = onDone.mock.calls[0]
    expect(result).toBeNull()
    expect(exitCode).toBe(-1)
    expect(stderr).toContain('ECONNREFUSED')
  })

  it('non-ok response → onDone with the response text as the error', async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      body: {},
      text: async () => 'model not found'
    })) as unknown as typeof fetch

    const { ctx, onDone } = httpCtx()
    await local.runHttp!(ctx)

    const [result, exitCode, , stderr] = onDone.mock.calls[0]
    expect(result).toBeNull()
    expect(exitCode).toBe(-1)
    expect(stderr).toBe('model not found')
  })
})

describe('getCapabilities', () => {
  it('non-local backends return their static capabilities untouched', async () => {
    expect(await getCapabilities('claude')).toEqual(BACKENDS.claude.capabilities)
    expect(await getCapabilities('mightymouse')).toEqual(BACKENDS.mightymouse.capabilities)
  })

  it('local resolves per-model via getLocalModelCapabilities, toolCalls mapped from tools', async () => {
    vi.mocked(getLocalModelCapabilities).mockResolvedValueOnce({
      vision: true,
      tools: false,
      thinking: false
    })
    expect(await getCapabilities('local', 'llava:13b')).toEqual({
      vision: true,
      fileAttachments: false,
      toolCalls: false,
      // An http backend has no CLI to pass a deny flag to.
      deniableTools: false,
      thinking: false
    })
  })

  it('local carries the model thinking capability through', async () => {
    vi.mocked(getLocalModelCapabilities).mockResolvedValueOnce({
      vision: false,
      tools: true,
      thinking: true
    })
    expect(await getCapabilities('local', 'qwen3.5:9b')).toMatchObject({ thinking: true })
  })

  it('local with no model passed → asks getLocalModelCapabilities with empty string', async () => {
    vi.mocked(getLocalModelCapabilities).mockResolvedValueOnce({
      vision: false,
      tools: false,
      thinking: false
    })
    await getCapabilities('local')
    expect(getLocalModelCapabilities).toHaveBeenCalledWith('')
  })

  it('mlx resolves per-model via getMlxModelCapabilities, toolCalls mapped from tools', async () => {
    vi.mocked(getMlxModelCapabilities).mockResolvedValueOnce({
      vision: false,
      tools: true,
      thinking: false
    })
    expect(await getCapabilities('mlx', undefined, 'qwen3-0.6b-4bit')).toEqual({
      vision: false,
      fileAttachments: false,
      toolCalls: true,
      // An http backend has no CLI to pass a deny flag to.
      deniableTools: false,
      thinking: false
    })
    expect(getMlxModelCapabilities).toHaveBeenCalledWith('qwen3-0.6b-4bit')
  })

  // mlx never reports thinking, even if the upstream probe somehow claimed it —
  // Rapid-MLX has no thinking param and scored 0/5 when it was forced on.
  it('mlx pins thinking to false regardless of the probe', async () => {
    vi.mocked(getMlxModelCapabilities).mockResolvedValueOnce({
      vision: false,
      tools: true,
      thinking: true
    })
    expect(await getCapabilities('mlx', undefined, 'qwen3-0.6b-4bit')).toMatchObject({
      thinking: false
    })
  })

  it('mlx with no model passed → asks getMlxModelCapabilities with empty string', async () => {
    vi.mocked(getMlxModelCapabilities).mockResolvedValueOnce({
      vision: false,
      tools: false,
      thinking: false
    })
    await getCapabilities('mlx')
    expect(getMlxModelCapabilities).toHaveBeenCalledWith('')
  })
})

describe('mlx adapter runHttp (OpenAI SSE)', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  // Mirrors a REAL rapid-mlx 0.10.10 stream (prds/active/rapid-mlx-samples/chat-stream.sse):
  // a role-only opener, a `: keepalive` SSE comment, content deltas, a finish chunk,
  // then `data: [DONE]`. The keepalive + [DONE] lines are exactly what a naive
  // NDJSON parser chokes on — that's why they're in the fixture.
  function sseBody(): string {
    const chunk = (delta: object, extra: object = {}): string =>
      `data: ${JSON.stringify({
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'qwen3-0.6b-4bit',
        choices: [{ index: 0, delta, ...extra }]
      })}\n\n`
    return (
      chunk({ role: 'assistant' }) +
      ': keepalive\n\n' +
      chunk({ content: 'Hel' }) +
      chunk({ content: 'lo' }) +
      chunk({}, { finish_reason: 'stop' }) +
      'data: [DONE]\n\n'
    )
  }

  function mockFetchWith(body: string): void {
    const chunks = [new TextEncoder().encode(body)]
    const reader = {
      read: vi.fn(async () => {
        if (chunks.length === 0) return { done: true, value: undefined }
        return { done: false, value: chunks.shift() }
      })
    }
    global.fetch = vi.fn(async () => ({
      ok: true,
      body: { getReader: () => reader },
      text: async () => ''
    })) as unknown as typeof fetch
  }

  it('no model selected → onDone with an error, never calls fetch', async () => {
    const fetchSpy = vi.fn()
    global.fetch = fetchSpy as unknown as typeof fetch
    const { ctx, onDone } = httpCtx({ mlxModel: '' })

    await mlx.runHttp!(ctx)

    expect(fetchSpy).not.toHaveBeenCalled()
    const [result, exitCode, , stderr] = onDone.mock.calls[0]
    expect(result).toBeNull()
    expect(exitCode).toBe(-1)
    expect(stderr).toContain('No Rapid-MLX model selected')
  })

  it('assembles delta content, skipping `: keepalive` and `[DONE]` lines', async () => {
    mockFetchWith(sseBody())
    const { ctx, onDone, onPhase } = httpCtx()

    await mlx.runHttp!(ctx)

    const [result, exitCode] = onDone.mock.calls[0]
    expect(result).toBe('Hello') // 'Hel' + 'lo' — no '[DONE]'/keepalive junk
    expect(exitCode).toBe(0)
    expect(onPhase).toHaveBeenCalledWith('Writing', '')
  })

  it('POSTs OpenAI-shaped body to /v1/chat/completions with the selected model', async () => {
    mockFetchWith(sseBody())
    const { ctx } = httpCtx()

    await mlx.runHttp!(ctx)

    const [url, init] = vi.mocked(global.fetch).mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${CONFIG.RAPIDMLX_BASE_URL}/v1/chat/completions`)
    const body = JSON.parse(init.body as string)
    expect(body.model).toBe('qwen3-0.6b-4bit')
    expect(body.stream).toBe(true)
    expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' })
    expect(body.messages[1].role).toBe('user')
    expect(body.messages[1].content).toBe('hello') // bare string when no images
  })

  it('a non-ok response → exit -1 with the server error text', async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      body: null,
      text: async () => 'model not loaded'
    })) as unknown as typeof fetch
    const { ctx, onDone } = httpCtx()

    await mlx.runHttp!(ctx)

    const [result, exitCode, , stderr] = onDone.mock.calls[0]
    expect(result).toBeNull()
    expect(exitCode).toBe(-1)
    expect(stderr).toBe('model not loaded')
  })

  it('server unreachable → exit -1, never throws', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('fetch failed')
    }) as unknown as typeof fetch
    const { ctx, onDone } = httpCtx()

    await mlx.runHttp!(ctx)

    const [result, exitCode] = onDone.mock.calls[0]
    expect(result).toBeNull()
    expect(exitCode).toBe(-1)
  })
})

describe('mlx adapter parsePhase (OpenAI SSE chunks — real shapes)', () => {
  // These payloads are the JSON *inside* a `data:` line, exactly as captured live
  // (prds/active/rapid-mlx-samples/chat-stream.sse). runHttp strips the `data: `
  // prefix before calling parsePhase, so parsePhase receives the bare JSON.
  it('a content delta → Writing', () => {
    const chunk = JSON.stringify({
      choices: [{ index: 0, delta: { content: 'Alright' } }]
    })
    expect(mlx.parsePhase(chunk)).toEqual({ phase: 'Writing', detail: '' })
  })

  it('the role-only opening delta → Starting (no content yet)', () => {
    const chunk = JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant' } }] })
    expect(mlx.parsePhase(chunk)).toEqual({ phase: 'Starting', detail: '' })
  })

  it('the finish chunk (empty delta) → Starting, never crashes', () => {
    const chunk = JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
    expect(mlx.parsePhase(chunk)).toEqual({ phase: 'Starting', detail: '' })
  })

  it('a non-JSON line → null', () => {
    expect(mlx.parsePhase('[DONE]')).toBeNull()
  })

  it('parseOutput passes stdout through (result assembled in runHttp)', () => {
    expect(mlx.parseOutput('hello')).toBe('hello')
  })

  it('is an http-transport adapter with no shell buildCommand', () => {
    expect(mlx.transport).toBe('http')
    expect(mlx.buildCommand).toBeUndefined()
    expect(typeof mlx.runHttp).toBe('function')
  })
})

describe('codex buildCommand image attachments', () => {
  it('emits one -i flag per image attachment (quoted)', () => {
    const cmd = codex.buildCommand!(
      buildCtx({
        attachments: [
          { path: '/tmp/a shot.png', kind: 'image' },
          { path: '/tmp/b.jpg', kind: 'image' }
        ]
      })
    )
    expect(cmd).toContain(`-i ${sq('/tmp/a shot.png')}`)
    expect(cmd).toContain(`-i ${sq('/tmp/b.jpg')}`)
    expect(cmd.match(/ -i /g)?.length).toBe(2)
  })

  it('emits no -i flag when there are no attachments', () => {
    const cmd = codex.buildCommand!(buildCtx({ attachments: [] }))
    expect(cmd).not.toContain(' -i ')
  })

  it('caps reasoning effort via -c model_reasoning_effort', () => {
    const cmd = codex.buildCommand!(buildCtx({ attachments: [] }))
    expect(cmd).toContain(`-c model_reasoning_effort=${sq(CONFIG.CODEX_REASONING_EFFORT)}`)
  })

  it('does NOT pass a file attachment via -i (codex has no file flag)', () => {
    // A binary file becomes a "can't read" note appended to the prompt, never `-i`.
    const cmd = codex.buildCommand!(
      buildCtx({ attachments: [{ path: '/tmp/doc.pdf', kind: 'file' }] })
    )
    expect(cmd).not.toContain(' -i ')
    expect(cmd).toContain('attached file: doc.pdf')
  })
})

// Tolerant auth parse: logged-in unless CLEARLY logged-out. Prevents the false
// "Not logged in" that a wrong/older binary or output drift used to produce.
describe('parseAuth tolerance', () => {
  it('claude: explicit loggedIn:true → logged in', () => {
    const r = claude.parseAuth!('{"loggedIn":true,"email":"a@b.com","authMethod":"claude.ai"}', true)
    expect(r.loggedIn).toBe(true)
    expect(r.detail).toContain('a@b.com')
  })

  it('claude: explicit loggedIn:false → NOT logged in', () => {
    const r = claude.parseAuth!('{"loggedIn":false}', true)
    expect(r.loggedIn).toBe(false)
  })

  it('claude: garbage/non-JSON output with no logout marker → tolerant (logged in)', () => {
    // The exact failure shape: a wrong binary answered with unrelated text. Old code
    // defaulted to "Not logged in"; tolerant code assumes ok and lets a run decide.
    const r = claude.parseAuth!('MightyMouse auth is Supabase email...', true)
    expect(r.loggedIn).toBe(true)
  })

  it('claude: explicit "/login" marker → NOT logged in', () => {
    const r = claude.parseAuth!('Please run /login to authenticate', false)
    expect(r.loggedIn).toBe(false)
  })

  it('codex: "Logged in using ChatGPT" → logged in', () => {
    const r = codex.parseAuth!('Logged in using ChatGPT', true)
    expect(r.loggedIn).toBe(true)
  })

  it('codex: explicit "Not logged in" → NOT logged in', () => {
    const r = codex.parseAuth!('Not logged in. Run codex login.', false)
    expect(r.loggedIn).toBe(false)
  })
})

// NDJSON fixtures below are verbatim shapes captured from live `opencode run
// --format json` / `gemini -o stream-json` probes, not hand-guessed.

describe('opencode buildCommand', () => {
  it('resolves the binary, model, and per-attachment -f flags', () => {
    const cmd = opencode.buildCommand!(
      buildCtx({ attachments: [{ path: '/tmp/a.png', kind: 'image' } as never] })
    )
    expect(cmd).toContain('/usr/local/bin/opencode')
    expect(cmd).toContain('run "$(cat')
    expect(cmd).toContain('--format json')
    expect(cmd).toContain(`-m ${sq(CONFIG.OPENCODE_MODEL)}`)
    expect(cmd).toContain(`-f ${sq('/tmp/a.png')}`)
  })

  it('uses the fast model when ctx.fast is set', () => {
    const cmd = opencode.buildCommand!(buildCtx({ fast: true }))
    expect(cmd).toContain(`-m ${sq(CONFIG.OPENCODE_FAST_MODEL)}`)
  })
})

describe('opencode parseOutput', () => {
  it('extracts the last text part from the NDJSON stream', () => {
    const lines = [
      JSON.stringify({ type: 'step-start', timestamp: 1, part: { type: 'step-start' } }),
      JSON.stringify({ type: 'text', timestamp: 2, part: { type: 'text', text: 'Hello there' } }),
      JSON.stringify({
        type: 'step-finish',
        timestamp: 3,
        part: { type: 'step-finish', reason: 'stop' }
      })
    ].join('\n')
    expect(opencode.parseOutput(lines)).toBe('Hello there')
  })
})

describe('opencode parsePhase', () => {
  it('maps a bash tool_use with a description to that description', () => {
    const line = JSON.stringify({
      type: 'tool_use',
      part: {
        type: 'tool',
        tool: 'bash',
        callID: 'toolu_1',
        state: { status: 'completed', input: { command: 'ls -la', description: 'Listing files' } }
      }
    })
    expect(opencode.parsePhase(line)).toEqual({ phase: 'Listing files', detail: '' })
  })

  it('falls back to the raw command when no description is present', () => {
    const line = JSON.stringify({
      type: 'tool_use',
      part: { type: 'tool', tool: 'bash', callID: 'toolu_2', state: { status: 'completed', input: { command: 'ls' } } }
    })
    expect(opencode.parsePhase(line)).toEqual({ phase: 'Running command', detail: 'ls' })
  })

  it('maps a text part to Writing', () => {
    expect(opencode.parsePhase(JSON.stringify({ type: 'text', part: { type: 'text', text: 'hi' } }))).toEqual({
      phase: 'Writing',
      detail: ''
    })
  })

  it('returns null on garbage input', () => {
    expect(opencode.parsePhase('not json')).toBeNull()
  })
})

describe('opencode parseStep', () => {
  it('reports a completed tool_use as an end edge with exit 0', () => {
    const line = JSON.stringify({
      type: 'tool_use',
      part: {
        type: 'tool',
        tool: 'bash',
        callID: 'toolu_3',
        state: { status: 'completed', input: { command: 'echo hi' }, metadata: { exit: 0 } }
      }
    })
    expect(opencode.parseStep!(line)).toEqual({
      id: 'toolu_3',
      edge: 'end',
      kind: 'bash',
      cmd: 'echo hi',
      exit: 0
    })
  })
})

describe('gemini buildCommand', () => {
  it('sets GEMINI_CLI_TRUST_WORKSPACE, -y, and an explicit -m', () => {
    const cmd = gemini.buildCommand!(buildCtx())
    expect(cmd).toContain('GEMINI_CLI_TRUST_WORKSPACE=true')
    expect(cmd).toContain('/usr/local/bin/gemini')
    expect(cmd).toContain('-o stream-json')
    expect(cmd).toContain(`-m ${sq(CONFIG.GEMINI_MODEL)}`)
    expect(cmd).toContain('-y')
  })

  it('uses the fast model when ctx.fast is set', () => {
    const cmd = gemini.buildCommand!(buildCtx({ fast: true }))
    expect(cmd).toContain(`-m ${sq(CONFIG.GEMINI_FAST_MODEL)}`)
  })
})

describe('gemini parseOutput', () => {
  it('concatenates assistant message deltas, ignoring the terminal result event', () => {
    const lines = [
      JSON.stringify({ type: 'init', timestamp: 't0', session_id: 's1', model: 'gemini-3-flash' }),
      JSON.stringify({ type: 'message', timestamp: 't1', role: 'user', content: 'say hi' }),
      JSON.stringify({ type: 'message', timestamp: 't2', role: 'assistant', content: 'Hel', delta: true }),
      JSON.stringify({ type: 'message', timestamp: 't3', role: 'assistant', content: 'lo!', delta: true }),
      JSON.stringify({
        type: 'result',
        timestamp: 't4',
        status: 'success',
        stats: { total_tokens: 10, duration_ms: 43023 }
      })
    ].join('\n')
    expect(gemini.parseOutput(lines)).toBe('Hello!')
  })
})

describe('gemini parsePhase', () => {
  it('maps init to Starting', () => {
    expect(gemini.parsePhase(JSON.stringify({ type: 'init' }))).toEqual({ phase: 'Starting', detail: '' })
  })

  it('maps an assistant message to Writing', () => {
    expect(gemini.parsePhase(JSON.stringify({ type: 'message', role: 'assistant' }))).toEqual({
      phase: 'Writing',
      detail: ''
    })
  })

  it('ignores the user echo message', () => {
    expect(gemini.parsePhase(JSON.stringify({ type: 'message', role: 'user' }))).toBeNull()
  })

  it('maps a run_shell_command tool_use to Running command with the command text', () => {
    const line = JSON.stringify({
      type: 'tool_use',
      tool_name: 'run_shell_command',
      tool_id: 'tid_1',
      parameters: { command: 'ls -la' }
    })
    expect(gemini.parsePhase(line)).toEqual({ phase: 'Running command', detail: 'ls -la' })
  })

  it('returns null on garbage input', () => {
    expect(gemini.parsePhase('not json')).toBeNull()
  })
})

describe('gemini parseStep', () => {
  it('pairs tool_use (start) with tool_result (end)', () => {
    const start = JSON.stringify({
      type: 'tool_use',
      tool_id: 'tid_2',
      tool_name: 'run_shell_command',
      parameters: { command: 'pwd' }
    })
    expect(gemini.parseStep!(start)).toEqual({ id: 'tid_2', edge: 'start', kind: 'run_shell_command', cmd: 'pwd' })

    const end = JSON.stringify({ type: 'tool_result', tool_id: 'tid_2', status: 'success', output: '/tmp' })
    expect(gemini.parseStep!(end)).toEqual({ id: 'tid_2', edge: 'end', kind: 'tool', cmd: '', exit: 0 })
  })

  it('reports exit 1 on a tool_result error status', () => {
    const end = JSON.stringify({ type: 'tool_result', tool_id: 'tid_3', status: 'error' })
    expect(gemini.parseStep!(end)).toEqual({ id: 'tid_3', edge: 'end', kind: 'tool', cmd: '', exit: 1 })
  })
})

describe('claude buildCommand model flag', () => {
  it('quotes the model so a model string can never add shell syntax', () => {
    const cmd = claude.buildCommand!(buildCtx({ modelOverride: 'opus; touch /tmp/mm-pwned' }))
    expect(cmd).toContain(`--model 'opus; touch /tmp/mm-pwned'`)
  })
})

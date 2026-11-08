import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { HttpRunCtx } from '../adapters'

let savedKey: string | undefined = 'sk-or-test'
vi.mock('../../keys/store', () => ({ KEYS: { getValue: async () => savedKey } }))
vi.mock('../image-vision', () => ({ loadImagesForVision: () => [] }))
vi.mock('../adapters', () => ({
  trimToTokenBudget: <T>(m: T[]): T[] => m,
  PRIOR_MESSAGES_TOKEN_BUDGET: 1
}))

const { openrouter, probeOpenRouter, openRouterThinks } = await import('../openrouter')

const MODELS = {
  data: [
    { id: 'meta/effort-model', supported_parameters: ['reasoning', 'reasoning_effort'] },
    { id: 'x/toggle-model', supported_parameters: ['reasoning'] },
    { id: 'plain/model', supported_parameters: ['temperature'] }
  ]
}

type Handler = (init: RequestInit) => Promise<Response>
let chat: Handler
let keyInfo: () => Promise<Response>
const chatBodies: Record<string, unknown>[] = []

function sse(chunks: string[]): Response {
  const enc = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(c) {
        for (const ch of chunks) c.enqueue(enc.encode(ch))
        c.close()
      }
    }),
    { status: 200 }
  )
}

beforeEach(() => {
  savedKey = 'sk-or-test'
  chatBodies.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.endsWith('/models')) return new Response(JSON.stringify(MODELS))
      if (url.endsWith('/key')) return keyInfo()
      if (url.endsWith('/chat/completions')) {
        chatBodies.push(JSON.parse(String(init.body)))
        return chat(init)
      }
      throw new Error(`unexpected url ${url}`)
    })
  )
})

afterEach(() => vi.unstubAllGlobals())

interface Done {
  text: string | null
  code: number
  err: string
}

async function run(over: Partial<HttpRunCtx> = {}): Promise<Done & { events: unknown[] }> {
  const events: unknown[] = []
  let done: Done | undefined
  await openrouter.runHttp!({
    runId: 'r1',
    systemPrompt: 'sys',
    userPrompt: 'hi',
    priorMessages: [],
    addDirs: [],
    attachments: [],
    ollamaModel: '',
    mlxModel: '',
    thinkingEnabled: false,
    selectedModel: 'plain/model',
    getJwt: async () => '',
    onPhase: () => {},
    onEvent: (e) => events.push(e),
    onDone: (text, code, _out, err) => {
      done = { text, code, err }
    },
    ...over
  } as HttpRunCtx)
  if (!done) throw new Error('onDone never called')
  return { ...done, events }
}

describe('openrouter runHttp', () => {
  it('fails fast with a settings pointer when no key is saved, without calling the API', async () => {
    savedKey = undefined
    const prev = process.env.OPENROUTER_API_KEY
    delete process.env.OPENROUTER_API_KEY
    const r = await run()
    process.env.OPENROUTER_API_KEY = prev
    expect(r.code).toBe(-1)
    expect(r.err).toMatch(/No OpenRouter key saved/)
    expect(chatBodies).toHaveLength(0)
  })

  it('joins streamed deltas, even when a data line is split across reads', async () => {
    chat = async () =>
      sse([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n',
        'data: {"choices":[{"delta":{"con',
        'tent":"lo"}}]}\n: keep-alive\n',
        'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":7,"completion_tokens":2,"cost":0.0003}}\n',
        'data: [DONE]\n'
      ])
    const r = await run()
    expect(r).toMatchObject({ text: 'Hello', code: 0, err: '' })
    expect(r.events).toContainEqual(expect.objectContaining({ inputTokens: 7, outputTokens: 2, costUsd: 0.0003 }))
  })

  it('reads a final data line that has no trailing newline', async () => {
    chat = async () => sse(['data: {"choices":[{"delta":{"content":"tail"}}]}'])
    expect((await run()).text).toBe('tail')
  })

  it('surfaces the error body of a rejected request', async () => {
    chat = async () => new Response('{"error":{"message":"Insufficient credits"}}', { status: 402 })
    const r = await run()
    expect(r.code).toBe(-1)
    expect(r.text).toBeNull()
    expect(r.err).toContain('Insufficient credits')
  })

  it('falls back to the status code when a rejected request has no body', async () => {
    chat = async () => new Response('', { status: 503 })
    expect((await run()).err).toBe('OpenRouter request failed (503)')
  })

  it('reports an in-stream error when no text arrived', async () => {
    chat = async () => sse(['data: {"error":{"message":"Provider returned error"}}\n'])
    expect(await run()).toMatchObject({ text: null, code: -1, err: 'Provider returned error' })
  })

  it('reports an empty answer instead of succeeding with nothing', async () => {
    chat = async () => sse(['data: [DONE]\n'])
    expect(await run()).toMatchObject({ text: null, code: -1, err: 'OpenRouter returned no text' })
  })

  it('maps a network failure to its message', async () => {
    chat = async () => {
      throw new Error('getaddrinfo ENOTFOUND openrouter.ai')
    }
    expect(await run()).toMatchObject({ code: -1, err: 'getaddrinfo ENOTFOUND openrouter.ai' })
  })

  it('maps its own timeout to exit -3 timed_out', async () => {
    chat = (init) =>
      new Promise((_, reject) => {
        init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    expect(await run({ timeoutMs: 20 })).toMatchObject({ text: null, code: -3, err: 'timed_out' })
  })

  it('Fast on a reasoning_effort model sends the lowest effort, never enabled:false', async () => {
    chat = async () => sse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n'])
    await run({ selectedModel: 'meta/effort-model', thinkingEnabled: false })
    expect(chatBodies[0].reasoning).toEqual({ effort: 'minimal' })
  })

  it('Fast on a toggle-only reasoning model turns reasoning off', async () => {
    chat = async () => sse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n'])
    await run({ selectedModel: 'x/toggle-model', thinkingEnabled: false })
    expect(chatBodies[0].reasoning).toEqual({ enabled: false })
  })

  it('Think sends high effort to any reasoning model', async () => {
    chat = async () => sse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n'])
    await run({ selectedModel: 'x/toggle-model', thinkingEnabled: true })
    expect(chatBodies[0].reasoning).toEqual({ effort: 'high' })
  })

  it('sends no reasoning field to a model that does not reason', async () => {
    chat = async () => sse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n'])
    await run({ selectedModel: 'plain/model', thinkingEnabled: true })
    expect(chatBodies[0]).not.toHaveProperty('reasoning')
    expect(openRouterThinks('plain/model')).toBe(false)
    expect(openRouterThinks('meta/effort-model')).toBe(true)
  })
})

describe('probeOpenRouter', () => {
  it('shows credit left on a key with a limit', async () => {
    keyInfo = async () => new Response(JSON.stringify({ data: { limit_remaining: 4.5, usage: 1 } }))
    const r = await probeOpenRouter()
    expect(r.ok).toBe(true)
    expect(r.checks[0].detail).toBe('$4.50 left')
    expect(r.advice).toBeNull()
  })

  it('fails a key with no credit left and says to top up', async () => {
    keyInfo = async () => new Response(JSON.stringify({ data: { limit_remaining: 0, usage: 10 } }))
    const r = await probeOpenRouter()
    expect(r.ok).toBe(false)
    expect(r.checks[0].ok).toBe(false)
    expect(r.advice).toMatch(/no credit left/)
  })

  it('shows usage on an unlimited key', async () => {
    keyInfo = async () => new Response(JSON.stringify({ data: { limit_remaining: null, usage: 2.345 } }))
    const r = await probeOpenRouter()
    expect(r.ok).toBe(true)
    expect(r.checks[0].detail).toBe('Key works · $2.35 used')
  })

  it('reports a rejected key with its status', async () => {
    keyInfo = async () => new Response('', { status: 401 })
    const r = await probeOpenRouter()
    expect(r.ok).toBe(false)
    expect(r.checks[0].detail).toBe('Key rejected (401)')
  })

  it('reports an unreachable API', async () => {
    keyInfo = async () => {
      throw new TypeError('fetch failed')
    }
    const r = await probeOpenRouter()
    expect(r.ok).toBe(false)
    expect(r.checks[0].detail).toBe('OpenRouter not reachable')
  })
})

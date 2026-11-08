// local-models.ts — talk to the Ollama HTTP service (localhost:11434) to list
// pulled models and probe per-model capabilities. Ollama has no CLI binary to
// resolve (it's a background service, not a spawned process) so this is the
// local-backend sibling of binary-resolver.ts: same "find what's actually
// available" job, different transport (HTTP, not `which`).
import { CONFIG } from '../../shared/config'
import type { LocalModel, ModelCapabilities } from '../../shared/types'

const FETCH_TIMEOUT_MS = 3_000

async function fetchJson(path: string, init?: RequestInit): Promise<unknown | null> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS)
  try {
    const resp = await fetch(`${CONFIG.OLLAMA_BASE_URL}${path}`, { ...init, signal: abort.signal })
    if (!resp.ok) return null
    return await resp.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** True if the Ollama service answers on its base URL. Cheap — no model load. */
export async function isOllamaRunning(): Promise<boolean> {
  return (await fetchJson('/api/version')) !== null
}

/**
 * Per-model capability lookup via `ollama show`. Older Ollama versions (or a
 * model with no declared capabilities) return an empty/missing list — treated
 * as text-only, the most conservative default (never claim a capability the
 * model hasn't declared). For `thinking` that conservatism is load-bearing:
 * `/api/chat` hard-errors on `think: true` for a model without it.
 */
interface ShowResponse {
  capabilities?: string[]
  model_info?: Record<string, unknown>
}

async function fetchShow(name: string): Promise<ShowResponse | null> {
  return (await fetchJson('/api/show', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: name })
  })) as ShowResponse | null
}

function capabilitiesFrom(body: ShowResponse | null): ModelCapabilities {
  const capabilities = body?.capabilities ?? []
  return {
    vision: capabilities.includes('vision'),
    tools: capabilities.includes('tools'),
    thinking: capabilities.includes('thinking')
  }
}

async function showCapabilities(name: string): Promise<ModelCapabilities> {
  return capabilitiesFrom(await fetchShow(name))
}

// model_info's context-length key is architecture-prefixed ("qwen3.context_length"); match by suffix.
export async function getOllamaContextLength(name: string): Promise<number> {
  if (name === '') return 0
  const info = (await fetchShow(name))?.model_info ?? {}
  for (const [key, value] of Object.entries(info)) {
    if (key.endsWith('.context_length') && typeof value === 'number') return value
  }
  return 0
}

/**
 * List every model the user has already pulled, each with its capabilities
 * resolved. Returns [] if Ollama isn't running or has nothing pulled — callers
 * treat that as "nothing to pick from", never an error.
 */
export async function listLocalModels(): Promise<LocalModel[]> {
  const body = await fetchJson('/api/tags')
  const models = (body as { models?: Array<{ name: string; size: number }> } | null)?.models ?? []
  return Promise.all(
    models.filter((m) => !m.name.includes(AGENT_MODEL_SUFFIX)).map(async (m) => {
      const caps = await showCapabilities(m.name)
      return { name: m.name, sizeBytes: m.size, ...caps }
    })
  )
}

/** Look up one already-listed model's capabilities, e.g. to gate the attach button. */
export async function getLocalModelCapabilities(name: string): Promise<ModelCapabilities> {
  if (name === '') return { vision: false, tools: false, thinking: false }
  return showCapabilities(name)
}

const AGENT_MIN_CONTEXT = 65536
const AGENT_MODEL_SUFFIX = '-mm64k'

// Ollama's Anthropic endpoint ignores num_ctx, so the coding agent runs on a copy with it baked in.
export async function ensureAgentModel(name: string): Promise<{ model: string } | { error: string }> {
  const trained = await getOllamaContextLength(name)
  if (trained > 0 && trained < AGENT_MIN_CONTEXT) {
    return { error: `${name} can't hold enough text to run the coding agent. Pick a bigger local model in Settings.` }
  }
  const model = `${name}${AGENT_MODEL_SUFFIX}`
  const created = await fetchJson('/api/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, from: name, parameters: { num_ctx: AGENT_MIN_CONTEXT }, stream: false })
  })
  return { model: created ? model : name }
}

export async function listCodingModels(): Promise<string[]> {
  const body = await fetchJson('/api/tags')
  const names = ((body as { models?: Array<{ name: string }> } | null)?.models ?? [])
    .map((m) => m.name)
    .filter((n) => !n.includes(AGENT_MODEL_SUFFIX))
  const shows = await Promise.all(names.map((n) => fetchShow(n)))
  return names.filter((_, i) => {
    const caps = shows[i]?.capabilities ?? []
    const ctx = Object.entries(shows[i]?.model_info ?? {}).find(([k]) => k.endsWith('.context_length'))?.[1]
    const bigEnough = typeof ctx !== 'number' || ctx >= AGENT_MIN_CONTEXT
    return caps.includes('completion') && caps.includes('tools') && bigEnough
  })
}

export async function pullOllamaModel(
  name: string,
  onProgress: (percent: number) => void
): Promise<boolean> {
  try {
    const resp = await fetch(`${CONFIG.OLLAMA_BASE_URL}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: name, stream: true })
    })
    if (!resp.ok || !resp.body) return false
    const decoder = new TextDecoder()
    let buffered = ''
    let last = ''
    for await (const chunk of resp.body as unknown as AsyncIterable<Uint8Array>) {
      buffered += decoder.decode(chunk, { stream: true })
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim() === '') continue
        const e = JSON.parse(line) as { status?: string; total?: number; completed?: number; error?: string }
        if (e.error) return false
        last = e.status ?? last
        if (e.total && e.completed !== undefined) onProgress(Math.round((e.completed / e.total) * 100))
      }
    }
    return last === 'success'
  } catch {
    return false
  }
}

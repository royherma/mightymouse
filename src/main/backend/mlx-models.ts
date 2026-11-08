// mlx-models.ts — talk to a user-run Rapid-MLX HTTP server (localhost:8000) to
// list served models and read their capabilities. Rapid-MLX has no CLI binary to
// spawn per run (it's a background OpenAI-compatible service, like Ollama), so this
// is the `mlx`-backend sibling of local-models.ts: same "find what's actually
// available" job, different wire (OpenAI `/v1/models`, not Ollama's `/api/tags`).
//
// Wire shape verified live against rapid-mlx 0.10.10:
//   GET /v1/models → { object:"list", data:[{ id, capabilities:["text","tools"], ... }] }
// Two quirks handled here:
//   1. Each model appears TWICE — once as the full HF repo id ("mlx-community/Qwen3-0.6B-4bit")
//      and once as the short alias ("qwen3-0.6b-4bit"). We keep the ALIAS (what you pass
//      to `serve` and the `model` field) and drop the repo-slug rows (id contains "/").
//   2. `/v1/models` reports NO byte size, so sizeBytes is always 0 (LocalModel allows it).
import { CONFIG } from '../../shared/config'
import type { LocalModel, ModelCapabilities } from '../../shared/types'

const FETCH_TIMEOUT_MS = 3_000

async function fetchJson(path: string, init?: RequestInit): Promise<unknown | null> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS)
  try {
    const resp = await fetch(`${CONFIG.RAPIDMLX_BASE_URL}${path}`, { ...init, signal: abort.signal })
    if (!resp.ok) return null
    return await resp.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** True if the Rapid-MLX server answers. Cheap — `/v1/models` is a metadata read, no model load. */
export async function isMlxRunning(): Promise<boolean> {
  return (await fetchJson('/v1/models')) !== null
}

interface MlxModelRow {
  id: string
  capabilities?: string[]
  modality?: string
}

/**
 * List every model the running Rapid-MLX server exposes, de-duped to short aliases,
 * each with capabilities resolved. Returns [] if the server isn't running or serves
 * nothing — callers treat that as "nothing to pick from", never an error.
 */
export async function listMlxModels(): Promise<LocalModel[]> {
  const body = await fetchJson('/v1/models')
  const rows = (body as { data?: MlxModelRow[] } | null)?.data ?? []
  return rows
    // Drop the full-HF-repo-id duplicate rows; keep the short serve alias.
    .filter((m) => typeof m.id === 'string' && m.id !== '' && !m.id.includes('/'))
    .map((m) => {
      const caps = m.capabilities ?? []
      // 'vision' capability OR a non-text modality both signal image support.
      const vision = caps.includes('vision') || (m.modality !== undefined && m.modality !== 'text')
      // thinking: false always — Rapid-MLX declares no thinking capability, and the
      // one benchmarked run with it forced on scored 0/5. Nothing to gate on yet.
      return { name: m.id, sizeBytes: 0, vision, tools: caps.includes('tools'), thinking: false }
    })
}

/** Look up one served model's capabilities, e.g. to gate the attach button. */
export async function getMlxModelCapabilities(name: string): Promise<ModelCapabilities> {
  const none: ModelCapabilities = { vision: false, tools: false, thinking: false }
  if (name === '') return none
  const models = await listMlxModels()
  const m = models.find((lm) => lm.name === name)
  return m ? { vision: m.vision, tools: m.tools, thinking: m.thinking } : none
}

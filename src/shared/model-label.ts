/**
 * Human-readable "who's answering" labels — shared by the renderer's backend chip
 * and by main's prompt builder.
 *
 * Lives in shared/ rather than renderer/ because main needs the SAME string it puts
 * in the run footer to also go into the system prompt: a model that reads a different
 * name than the UI shows will confidently tell the user the wrong one.
 */
import { CONFIG } from './config'
import type { BackendId } from './types'

/** The Ollama backend — runs a locally-pulled model, so its label names the model.
 *  Typed as BackendId so an adapter-id rename fails the typecheck here instead of
 *  silently mismatching. */
export const LOCAL_BACKEND: BackendId = 'local'

/** The Rapid-MLX local backend — like `local`, its label shows the served model. */
export const MLX_BACKEND: BackendId = 'mlx'

/** The paid managed backend — the only one with a per-conversation model picker
 *  (its models come from CONFIG.MODEL_CATALOG + the server allowlist). */
export const MIGHTYMOUSE_BACKEND: BackendId = 'mightymouse'

/** The sub-model the selection bar's instant path runs as. Which model actually
 *  serves it (CONFIG.SELECTION_BAR.FAST_MODEL) is ours to change; the user only
 *  ever sees "MightyMouse API · Fast". */
export const FAST_SUBMODEL = 'Fast'

/**
 * Pretty-print a raw Ollama model tag. Ollama tags look like "gemma3:4b" /
 * "llama3.1:8b-instruct"; we show "Gemma3 4B" — capitalize the family, uppercase the
 * size suffix, keep it short. Falls back to the raw tag if it doesn't split cleanly,
 * so an unusual name never renders blank.
 */
export function prettyOllamaModel(tag: string): string {
  const [family, variant] = tag.split(':')
  if (!family) return tag
  const name = family.charAt(0).toUpperCase() + family.slice(1)
  if (!variant) return name
  // Uppercase a pure size suffix ("4b" → "4B"); leave richer variants as-is.
  const size = /^[\d.]+b$/i.test(variant) ? variant.toUpperCase() : variant
  return `${name} ${size}`
}

/**
 * Label a RESOLVED run — "Local · Qwen3.5 9B" — from the backend + the model that
 * actually ran. `model` is optional because turns predating per-turn model recording
 * have none; those degrade to the bare backend label rather than claiming a wrong one.
 */
const OPENCODE_ACCOUNT_NAME: Record<string, string> = {
  opencode: 'Zen',
  'opencode-go': 'Go',
  openrouter: 'OpenRouter'
}

export const opencodeAccountName = (model: string): string | undefined => {
  if (!model.includes('/')) return undefined
  const id = model.split('/')[0]
  return OPENCODE_ACCOUNT_NAME[id] ?? id
}

export const opencodeAccount = (model: string): string | undefined => {
  const name = opencodeAccountName(model)
  return name && `via ${name}`
}

export function opencodeModelLabel(model: string): string {
  const account = opencodeAccount(model)
  return account ? `${claudeModelLabel(model.split('/').slice(1).join('/'))} ${account}` : model
}

// "claude-opus-5-5" / "anthropic/claude-opus-5.5" -> "Opus 5.5"; anything else passes through.
export function claudeModelLabel(model: string): string {
  const m = /^(?:[a-z0-9-]+\/)*claude-([a-z]+)-(\d+)(?:[-.](\d{1,2}))?(?:-\d{8})?$/.exec(model)
  if (!m) return model
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[3] ? `${m[2]}.${m[3]}` : m[2]}`
}

const CLAUDE_ALIASES = new Set(['opus', 'sonnet', 'haiku', 'fable'])

export function modelDisplayName(model: string, backend?: string): string {
  if (!model || model === 'unknown') return (backend && CONFIG.BACKEND_META[backend]?.label) || 'Not recorded'
  if (model === FAST_SUBMODEL) return `${CONFIG.APP_NAME} Fast`
  if (model === 'codex-default') return 'Codex default'
  const id = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model
  if (CLAUDE_ALIASES.has(id)) return id[0].toUpperCase() + id.slice(1)
  if (id.startsWith('claude-')) return claudeModelLabel(id)
  if (id.includes(':')) return prettyOllamaModel(id)
  return id
}

// These CLIs run on the user's own subscription; their cost figure is an API-price estimate, not a charge.
const PLAN_NAMES: Record<string, string> = { claude: 'Claude plan', codex: 'ChatGPT plan' }

export function planName(backend: string | undefined): string | undefined {
  return backend ? PLAN_NAMES[backend] : undefined
}

export function runLabel(backend: string, model?: string): string {
  const base = CONFIG.BACKEND_META[backend]?.label ?? backend
  if (!model) return base
  // Ollama is the only backend whose raw tag ("qwen3.5:9b") needs prettifying; every
  // other backend already stores a display-ready name.
  const pretty =
    backend === LOCAL_BACKEND
      ? prettyOllamaModel(model)
      : backend === 'opencode'
        ? opencodeModelLabel(model)
        : claudeModelLabel(model)
  return `${base} · ${pretty}`
}

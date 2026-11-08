/**
 * Backend chip labelling — shared by every surface that shows "who's answering".
 *
 * Extracted from PanelApp.tsx when MightyApp's composer chip needed the same
 * label: a local run must name the MODEL, not just "Local", or the two windows
 * disagree about the same global pref. One home so a change to how a local model
 * reads (or a new local backend) lands everywhere at once.
 *
 * The label primitives themselves now live in shared/model-label.ts — main builds
 * the system prompt from the same strings, so the model can't name itself something
 * other than what the chip shows. Re-exported here so existing importers are unchanged.
 */
import { CONFIG } from '../../shared/config'
import {
  LOCAL_BACKEND,
  MLX_BACKEND,
  prettyOllamaModel
} from '../../shared/model-label'

export {
  LOCAL_BACKEND,
  MLX_BACKEND,
  MIGHTYMOUSE_BACKEND,
  prettyOllamaModel,
  runLabel
} from '../../shared/model-label'

/**
 * The model half of a local backend's chip — "Gemma3 4B", "qwen3-0.6b-4bit", or
 * '' when this backend has no user-picked local model (every cloud backend) or
 * none is chosen yet. Callers that want the joined chip text use
 * backendChipLabel; MightyApp renders the two halves as separate elements so the
 * model can carry its own muted styling.
 */
export function localModelLabel(backend: string, ollamaModel: string, mlxModel: string): string {
  if (backend === LOCAL_BACKEND && ollamaModel) return prettyOllamaModel(ollamaModel)
  // Rapid-MLX aliases are already short + readable ("qwen3-0.6b-4bit") — show as-is.
  if (backend === MLX_BACKEND && mlxModel) return mlxModel
  return ''
}

/**
 * Chip label for the active backend. Cloud backends use their static
 * BACKEND_META label; the local backends append the chosen model so the user can
 * see it's running e.g. "Local · Gemma3 4B", not just "Local". No model picked
 * yet → plain "Local".
 */
export function backendChipLabel(backend: string, ollamaModel: string, mlxModel: string): string {
  const base = CONFIG.BACKEND_META[backend]?.label ?? backend
  const model = localModelLabel(backend, ollamaModel, mlxModel)
  return model ? `${base} · ${model}` : base
}

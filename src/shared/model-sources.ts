import { claudeModelLabel, opencodeAccount } from './model-label'
import type { ProviderIconId } from './provider-icon'

export type PickerSurface = 'chat' | 'code'

export type ModelSourceId = 'claude' | 'codex' | 'opencode' | 'cursor' | 'openrouter' | 'ollama'

export interface ModelSource {
  name: string
  icon: ProviderIconId
  runs: 'harness' | 'api'
  chat: boolean
  code: boolean
}

// The one place that decides which picker lists which source. Code only lists 'harness' sources - an API call can't edit files.
export const MODEL_SOURCES: Record<ModelSourceId, ModelSource> = {
  claude: { name: 'Claude Code', icon: 'claude', runs: 'harness', chat: false, code: true },
  codex: { name: 'Codex', icon: 'codex', runs: 'harness', chat: false, code: true },
  openrouter: { name: 'OpenRouter (your key)', icon: 'openrouter', runs: 'api', chat: true, code: false },
  opencode: { name: 'OpenCode', icon: 'opencode', runs: 'harness', chat: true, code: true },
  cursor: { name: 'Cursor', icon: 'letter:C', runs: 'harness', chat: false, code: true },
  ollama: { name: 'Local (Ollama)', icon: 'local', runs: 'harness', chat: true, code: true }
}

// OpenCode takes --variant only on `opencode run`, not the interactive app, so it gets no chip.
export const THINK_ARGS: Partial<Record<ModelSourceId, Record<'fast' | 'think', string[]>>> = {
  claude: { fast: ['--effort', 'low'], think: ['--effort', 'high'] },
  codex: { fast: ['-c', 'model_reasoning_effort=low'], think: ['-c', 'model_reasoning_effort=high'] }
}

// Codex has no plan flag on its interactive app, so it gets no Plan chip.
export const PLAN_ARGS: Partial<Record<ModelSourceId, string[]>> = {
  claude: ['--permission-mode', 'plan'],
  opencode: ['--agent', 'plan'],
  cursor: ['--plan']
}

export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

export const CLAUDE_REASONING_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return REASONING_EFFORTS.some((effort) => effort === value)
}

export function reasoningArgs(source: ModelSourceId, effort?: ReasoningEffort, think?: boolean): string[] {
  if (effort !== undefined) {
    if (source === 'codex') return ['-c', `model_reasoning_effort=${effort}`]
    if (source === 'claude' && CLAUDE_REASONING_EFFORTS.includes(effort)) return ['--effort', effort]
    return []
  }
  return think === undefined ? [] : THINK_ARGS[source]?.[think ? 'think' : 'fast'] ?? []
}

export const showsOn = (source: ModelSourceId, surface: PickerSurface): boolean =>
  MODEL_SOURCES[source][surface] && (surface === 'chat' || MODEL_SOURCES[source].runs === 'harness')

export interface SourceModel {
  source: ModelSourceId
  model: string
  label: string
  hint?: string
  thinks?: boolean
}

export function opencodeSourceModels(models: string[], surface: PickerSurface): SourceModel[] {
  const direct = showsOn('openrouter', surface)
  return models
    .filter((m) => !(direct && m.startsWith('openrouter/')))
    .map((model) => ({
      source: 'opencode',
      model,
      label: claudeModelLabel(model.slice(model.indexOf('/') + 1)),
      hint: opencodeAccount(model)
    }))
}

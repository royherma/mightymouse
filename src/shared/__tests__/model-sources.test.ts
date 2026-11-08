import { describe, it, expect } from 'vitest'
import { CLAUDE_REASONING_EFFORTS, MODEL_SOURCES, REASONING_EFFORTS, isReasoningEffort, opencodeSourceModels, reasoningArgs, showsOn, type ModelSourceId } from '../model-sources'

const ids = Object.keys(MODEL_SOURCES) as ModelSourceId[]

describe('reasoningArgs', () => {
  it.each(REASONING_EFFORTS)('forwards Codex effort %s exactly', (effort) => {
    expect(reasoningArgs('codex', effort, false)).toEqual(['-c', `model_reasoning_effort=${effort}`])
  })

  it.each(CLAUDE_REASONING_EFFORTS)('forwards Claude effort %s exactly', (effort) => {
    expect(reasoningArgs('claude', effort)).toEqual(['--effort', effort])
  })

  it('keeps CLI defaults and the old low/high toggle, and skips unsupported harnesses', () => {
    expect(reasoningArgs('codex')).toEqual([])
    expect(reasoningArgs('claude', undefined, false)).toEqual(['--effort', 'low'])
    expect(reasoningArgs('codex', undefined, true)).toEqual(['-c', 'model_reasoning_effort=high'])
    expect(reasoningArgs('claude', 'ultra')).toEqual([])
    expect(reasoningArgs('opencode', 'medium')).toEqual([])
    expect(reasoningArgs('ollama', 'high')).toEqual([])
    expect(isReasoningEffort('medium')).toBe(true)
    expect(isReasoningEffort('invalid')).toBe(false)
  })
})

describe('showsOn', () => {
  it('Code never lists a source that runs as a plain API call', () => {
    for (const id of ids) {
      if (showsOn(id, 'code')) expect(MODEL_SOURCES[id].runs).toBe('harness')
    }
  })

  it('OpenRouter direct is Chat only; Claude Code and Codex are Code only', () => {
    expect(showsOn('openrouter', 'chat')).toBe(true)
    expect(showsOn('openrouter', 'code')).toBe(false)
    expect(showsOn('claude', 'chat')).toBe(false)
    expect(showsOn('claude', 'code')).toBe(true)
    expect(showsOn('codex', 'chat')).toBe(false)
  })
})

describe('opencodeSourceModels', () => {
  const models = ['opencode/big-pickle', 'openrouter/meta/muse-spark-1.3', 'opencode-go/kimi-k2']

  it('Chat drops OpenCode models routed through OpenRouter, since OpenRouter direct already lists them', () => {
    expect(opencodeSourceModels(models, 'chat').map((m) => m.model)).toEqual([
      'opencode/big-pickle',
      'opencode-go/kimi-k2'
    ])
  })

  it('Code keeps them, because OpenRouter direct cannot edit files', () => {
    const out = opencodeSourceModels(models, 'code')
    expect(out.map((m) => m.model)).toEqual(models)
    expect(out[1]).toEqual({
      source: 'opencode',
      model: 'openrouter/meta/muse-spark-1.3',
      label: 'meta/muse-spark-1.3',
      hint: 'via OpenRouter'
    })
  })

  it('labels each model without its account prefix and names the account in the hint', () => {
    const [zen, , go] = opencodeSourceModels(models, 'code')
    expect(zen).toMatchObject({ label: 'big-pickle', hint: 'via Zen' })
    expect(go).toMatchObject({ label: 'kimi-k2', hint: 'via Go' })
  })
})

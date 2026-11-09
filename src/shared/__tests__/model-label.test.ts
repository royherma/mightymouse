import { describe, expect, it } from 'vitest'
import { CONFIG } from '../config'
import { claudeModelLabel, modelDisplayName, opencodeModelLabel } from '../model-label'

describe('claudeModelLabel', () => {
  it.each([
    ['claude-opus-5-5', 'Opus 5.5'],
    ['claude-sonnet-4-5-20250929', 'Sonnet 4.5'],
    ['claude-sonnet-4-20250514', 'Sonnet 4'],
    ['claude-haiku-4-5', 'Haiku 4.5'],
    ['anthropic/claude-opus-4.5', 'Opus 4.5'],
    ['openrouter/anthropic/claude-sonnet-4.6', 'Sonnet 4.6']
  ])('%s -> %s', (raw, label) => {
    expect(claudeModelLabel(raw)).toBe(label)
  })

  it.each(['opus', 'gpt-5.1-codex', 'claude-3-5-sonnet-20241022', 'google/gemini-2.5-pro'])('%s passes through', (raw) => {
    expect(claudeModelLabel(raw)).toBe(raw)
  })
})

describe('opencodeModelLabel', () => {
  it('names the Claude model and the account it runs through', () => {
    expect(opencodeModelLabel('opencode/claude-sonnet-4-5')).toBe('Sonnet 4.5 via Zen')
    expect(opencodeModelLabel('openrouter/anthropic/claude-opus-4.5')).toBe('Opus 4.5 via OpenRouter')
    expect(opencodeModelLabel('opencode-go/kimi-k2')).toBe('kimi-k2 via Go')
    expect(opencodeModelLabel('bare-model')).toBe('bare-model')
  })
})

describe('modelDisplayName', () => {
  it('a run with no recorded model shows its backend, or says so', () => {
    expect(modelDisplayName('', 'claude')).toBe(CONFIG.BACKEND_META.claude.label)
    expect(modelDisplayName('unknown', 'codex')).toBe(CONFIG.BACKEND_META.codex.label)
    expect(modelDisplayName('')).toBe('Not recorded')
    expect(modelDisplayName('unknown', 'no-such-backend')).toBe('Not recorded')
  })

  it('names our own sub-models and CLI defaults', () => {
    expect(modelDisplayName('Fast')).toBe(`${CONFIG.APP_NAME} Fast`)
    expect(modelDisplayName('codex-default')).toBe('Codex default')
  })

  it('capitalizes Claude aliases, even behind a provider prefix', () => {
    expect(modelDisplayName('opus')).toBe('Opus')
    expect(modelDisplayName('sonnet', 'claude')).toBe('Sonnet')
    expect(modelDisplayName('anthropic/haiku')).toBe('Haiku')
  })

  it('turns full Claude ids into the short name', () => {
    expect(modelDisplayName('claude-opus-5-5')).toBe('Opus 5.5')
    expect(modelDisplayName('openrouter/anthropic/claude-sonnet-4.5')).toBe('Sonnet 4.5')
  })

  it('prettifies Ollama tags and leaves other vendor ids alone', () => {
    expect(modelDisplayName('gemma3:4b', 'local')).toBe('Gemma3 4B')
    expect(modelDisplayName('hf.co/org/qwen3:8b')).toBe('Qwen3 8B')
    expect(modelDisplayName('gpt-5.1-codex', 'codex')).toBe('gpt-5.1-codex')
    expect(modelDisplayName('google/gemini-2.5-pro')).toBe('gemini-2.5-pro')
  })
})

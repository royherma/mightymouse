import { describe, it, expect } from 'vitest'
import { runLabel } from '../backend-chip'

// runLabel names what ACTUALLY ran on a recorded turn, so the detail line can say
// "Local · Qwen3.5 9B" instead of a bare "local" that hides which model answered.
describe('runLabel', () => {
  it('prettifies a raw Ollama tag for the local backend', () => {
    expect(runLabel('local', 'qwen3.5:9b')).toBe('Local · Qwen3.5 9B')
  })

  it('passes a non-Ollama model through as-is', () => {
    // MLX aliases are already display-ready — prettifying would mangle them.
    expect(runLabel('mlx', 'qwen3-0.6b-4bit')).toBe('Rapid-MLX · qwen3-0.6b-4bit')
  })

  it('falls back to the bare backend label when the turn has no model', () => {
    // Turns recorded before per-turn model tracking: name the backend, invent nothing.
    expect(runLabel('local')).toBe('Local')
    expect(runLabel('claude')).toBe('Claude')
  })

  it('falls back to the raw id for a backend with no metadata', () => {
    expect(runLabel('some-future-backend')).toBe('some-future-backend')
  })
})

import { describe, it, expect, vi } from 'vitest'

// runner.ts pulls in the whole main-process world (electron, supabase, sqlite).
// Stub the leaves so the two pure model-chain helpers can be tested in isolation.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false } }))
vi.mock('../../store/prefs', () => ({ PREFS: { getOllamaModel: () => '', getMlxModel: () => '', getIncognito: () => false } }))
vi.mock('../../supabase', () => ({ getSupabase: () => null }))
vi.mock('../../analytics', () => ({ trackError: () => {} }))

import { resolveModelChain, isModelUnavailable } from '../runner'
import { CONFIG } from '../../../shared/config'

/**
 * The exact stdout the `claude` CLI emits for an unknown/no-access model —
 * captured 2026-07-27 from `claude --model claude-opus-99 -p "say ok"` (exit 1,
 * message on STDOUT, not stderr). If the CLI ever reworks this string the
 * fallback goes silently dead, so pin the real text here.
 */
const REAL_CLI_REJECTION =
  "There's an issue with the selected model (claude-opus-99). It may not exist or you may not have access to it. Run --model to pick a different model."

describe('isModelUnavailable', () => {
  it('matches the real claude CLI rejection on stdout', () => {
    expect(isModelUnavailable(REAL_CLI_REJECTION, '')).toBe(true)
  })

  it('matches when the message lands on stderr instead', () => {
    expect(isModelUnavailable('', REAL_CLI_REJECTION)).toBe(true)
  })

  it('does NOT match an ordinary run failure', () => {
    // The critical negative: a normal error must never trigger a model retry.
    expect(isModelUnavailable('Error: ENOENT: no such file or directory', '')).toBe(false)
    expect(isModelUnavailable('', 'TypeError: cannot read property of undefined')).toBe(false)
    expect(isModelUnavailable('', '')).toBe(false)
  })

  it('does not match prose merely mentioning a model', () => {
    expect(isModelUnavailable('The model responded with a summary of the file.', '')).toBe(false)
  })
})

describe('resolveModelChain', () => {
  it('leads with the configured flagship, then the fallbacks', () => {
    const chain = resolveModelChain('claude', false)
    expect(chain[0]).toBe(CONFIG.CLAUDE_MODEL)
    expect(chain.slice(1)).toEqual(CONFIG.CLAUDE_MODEL_FALLBACKS)
  })

  it('uses the fast ladder when fast is set', () => {
    const chain = resolveModelChain('claude', true)
    expect(chain[0]).toBe(CONFIG.CLAUDE_FAST_MODEL)
    expect(chain.slice(1)).toEqual(CONFIG.CLAUDE_FAST_MODEL_FALLBACKS)
  })

  it('never repeats a model — a duplicate would respawn the same failing run', () => {
    const chain = resolveModelChain('claude', false)
    expect(new Set(chain).size).toBe(chain.length)
  })

  it('never yields an empty model (would spawn a blank --model)', () => {
    for (const fast of [true, false]) {
      expect(resolveModelChain('claude', fast).every((m) => m !== '')).toBe(true)
    }
  })

  it('returns no chain for backends without one, so retry is a no-op', () => {
    expect(resolveModelChain('codex', false)).toEqual([])
    expect(resolveModelChain('gemini', false)).toEqual([])
  })
})

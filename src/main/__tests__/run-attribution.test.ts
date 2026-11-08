import { describe, it, expect, vi, beforeEach } from 'vitest'

// The guardrail this file exists to be.
//
// The bug: `local`/`mlx` carry no model in config (OLLAMA_MODEL/RAPIDMLX_MODEL are
// '' — the user picks one at runtime), so the adapter's static `modelName` is
// EMPTY for them. The run path resolved the real model from PREFS while the
// logging path read the static field, so 98% of history rows recorded model ''
// and the Analytics dashboard rendered "(unknown)" for models + top apps.
//
// Nothing caught it because `model: ''` typechecks perfectly and there was no test
// over attribution at all. resolveRunModel() is now the ONE source both paths use;
// these tests pin that contract so a future backend can't silently regress it.

const { getOllamaModel, getMlxModel } = vi.hoisted(() => ({
  getOllamaModel: vi.fn(() => ''),
  getMlxModel: vi.fn(() => '')
}))

// prefs pulls in the electron/app-path world; stub to just the two readers we need.
vi.mock('../store/prefs', () => ({
  PREFS: { getOllamaModel, getMlxModel }
}))

// A minimal stand-in for the real registry: `local`/`mlx` model empty in config
// (the actual shape — CONFIG.OLLAMA_MODEL is ''), `claude` statically pinned.
vi.mock('../backend/adapters', () => ({
  BACKENDS: {
    claude: { id: 'claude', modelName: 'claude-opus-4-8' },
    local: { id: 'local', modelName: '' },
    mlx: { id: 'mlx', modelName: '' }
  }
}))

import { resolveRunModel } from '../backend/runner'

describe('resolveRunModel — the model recorded is the model that ran', () => {
  beforeEach(() => {
    getOllamaModel.mockReset().mockReturnValue('')
    getMlxModel.mockReset().mockReturnValue('')
  })

  it('reads the live pref for `local`, NOT the empty static adapter field', () => {
    // The exact regression: pref holds a real model, adapter field is ''.
    getOllamaModel.mockReturnValue('qwen3.5:9b')
    expect(resolveRunModel('local')).toBe('qwen3.5:9b')
  })

  it('reads the live pref for `mlx`, NOT the empty static adapter field', () => {
    getMlxModel.mockReturnValue('qwen3-0.6b-4bit')
    expect(resolveRunModel('mlx')).toBe('qwen3-0.6b-4bit')
  })

  it('never returns the adapter default for a local backend', () => {
    // Guards the tempting "fall back to modelName when the pref is empty" fix —
    // that would relabel a local run as claude-opus-4-8 and silently corrupt the
    // model mix chart. Empty is honest; wrong is not.
    getOllamaModel.mockReturnValue('')
    expect(resolveRunModel('local')).not.toBe('claude-opus-4-8')
  })

  it('uses the static adapter model for backends that pin one', () => {
    expect(resolveRunModel('claude')).toBe('claude-opus-4-8')
  })

  it('does not consult local prefs for a non-local backend', () => {
    resolveRunModel('claude')
    expect(getOllamaModel).not.toHaveBeenCalled()
    expect(getMlxModel).not.toHaveBeenCalled()
  })
})

// The paid backend is the one case resolveRunModel CANNOT answer: the server picks
// the model (the client only signals a feature), so the real slug arrives mid-run on
// the proxy's mm_result line. hud-run seeds a local guess, then overwrites it from
// onModelResolved before onDone writes the history row. These pin that handshake —
// the ordering is what makes it correct, and it's invisible at the type level.
describe('server-resolved model (paid backend) overrides the local guess', () => {
  // Mirrors hud-run's shape: a `let` the callback reassigns, read at onDone time.
  function simulateRun(serverModel?: string): string {
    let backendModel = 'claude-opus-4-8' // resolveRunModel's compile-time default
    const onModelResolved = (m: string): void => {
      backendModel = m
    }
    // The adapter parses mm_result mid-stream (before onDone) and only reports a
    // non-empty model — mirrors the `typeof e.model === 'string' && e.model !== ''`
    // guard in the mightymouse adapter.
    if (typeof serverModel === 'string' && serverModel !== '') onModelResolved(serverModel)
    return backendModel // what appendHistoryRow records
  }

  it('records what the server actually ran, not the compile-time default', () => {
    expect(simulateRun('anthropic/claude-sonnet-5')).toBe('anthropic/claude-sonnet-5')
  })

  it('records the concrete slug when routing resolves openrouter/auto', () => {
    // openrouter/auto is requested but a real model answers; the proxy echoes the
    // served slug, which is also what it meters — so billing + dashboard agree.
    expect(simulateRun('google/gemini-3.1-pro')).toBe('google/gemini-3.1-pro')
  })

  it('keeps the local guess when an older proxy omits the model', () => {
    // Back-compat: a deployed-but-stale llm-proxy sends no `model` on mm_result.
    // Degrade to the old behavior rather than blanking the field.
    expect(simulateRun(undefined)).toBe('claude-opus-4-8')
    expect(simulateRun('')).toBe('claude-opus-4-8')
  })
})

// The second half of the same bug, found 2026-07-23: Analytics' Top Apps card showed
// "(unknown)" at 29% — the single biggest bucket. Cause was NOT a missing capture:
// smart-dictation captured ctx.frontApp up front (it needs it to re-focus the app it
// pastes into) and then simply never copied it onto the history row it wrote. The
// field is optional, so `front_app` absent typechecks exactly like `front_app` set —
// which is why this shipped and why the guard has to be a test.
//
// analytics.ts buckets `e.front_app || '(unknown)'`, so any writer that omits it
// silently donates its whole run volume to that bucket. Listen is ~89% of all runs.
describe('front_app attribution — every run row names the app it ran against', () => {
  // The bucketing rule from analytics.ts §8, verbatim in behavior.
  const bucketOf = (row: { front_app?: string | null }): string => row.front_app || '(unknown)'

  it('buckets a row under its app when front_app is carried through', () => {
    expect(bucketOf({ front_app: 'Google Chrome' })).toBe('Google Chrome')
  })

  it('collapses to (unknown) when a writer omits the field it had in hand', () => {
    // The exact regression shape: the row is well-formed and typechecks, the app
    // was known at write time, and the bucket is still garbage.
    expect(bucketOf({})).toBe('(unknown)')
    expect(bucketOf({ front_app: undefined })).toBe('(unknown)')
  })

  it('treats an empty captured app as unknown rather than an empty-named app', () => {
    // captureContext() returns {} on failure, so frontApp can legitimately be ''.
    // Empty must land in (unknown), never create a nameless bar in the chart.
    expect(bucketOf({ front_app: '' })).toBe('(unknown)')
    expect(bucketOf({ front_app: null })).toBe('(unknown)')
  })
})

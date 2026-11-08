/**
 * Tests for the whisper transcription hint injected into the ACT system prompt
 * (whisperActHint, via buildActPrompts in prompts.ts).
 *
 * Covers:
 *   1. Media file + all binaries present -> hint injected (paths + recipe)
 *   2. Non-media file -> no hint (don't pollute unrelated act runs)
 *   3. Media file but a binary missing -> no hint (never claim a tool that isn't there)
 *   4. Hint reflects user-overridden SETTINGS paths
 *   5. Transcribe-y instruction with NO finderFiles -> hint still injected (the real bug)
 *   6. "transribe" typo still triggers the hint
 *   7. Media filename in the SELECTION (no finderFiles) -> hint injected
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock fs so we control which binaries "exist".
const existsSet = new Set<string>()
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    existsSync: vi.fn((p: string) => existsSet.has(p))
  }
})

// Mock SETTINGS so paths are deterministic and overridable per test.
const settings = {
  ffmpegPath: '/opt/homebrew/bin/ffmpeg',
  whisperPath: '/opt/homebrew/bin/whisper-cli',
  whisperModelPath: '/Users/x/.cache/whisper/ggml-base.en.bin'
}
vi.mock('../../store/settings', () => ({
  SETTINGS: { get: () => settings }
}))

// resolveClaude is called for the skill hint; stub it.
vi.mock('../../platform', () => ({
  resolveClaude: () => 'claude',
  shell: { agentToolHints: () => '' }
}))

import { buildActPrompts } from '../prompts'

const baseOpts = {
  instruction: 'transcribe this',
  selection: '',
  ctxData: null
}

function allBinariesPresent(): void {
  existsSet.clear()
  existsSet.add(settings.ffmpegPath)
  existsSet.add(settings.whisperPath)
  existsSet.add(settings.whisperModelPath)
}

describe('whisperActHint', () => {
  beforeEach(() => {
    settings.ffmpegPath = '/opt/homebrew/bin/ffmpeg'
    settings.whisperPath = '/opt/homebrew/bin/whisper-cli'
    settings.whisperModelPath = '/Users/x/.cache/whisper/ggml-base.en.bin'
    allBinariesPresent()
  })

  it('injects the hint for a media file when all binaries exist', () => {
    const { systemPrompt } = buildActPrompts({ ...baseOpts, finderFiles: ['/clips/talk.mov'] })
    expect(systemPrompt).toContain('MEDIA TOOLS')
    expect(systemPrompt).toContain('/opt/homebrew/bin/whisper-cli')
    expect(systemPrompt).toContain('-ar 16000 -ac 1')
  })

  it('does NOT inject the hint for a non-media file + non-media instruction', () => {
    const { systemPrompt } = buildActPrompts({
      ...baseOpts,
      instruction: 'rename this',
      finderFiles: ['/docs/notes.txt']
    })
    expect(systemPrompt).not.toContain('MEDIA TOOLS')
  })

  it('does NOT inject the hint when the whisper model is missing', () => {
    existsSet.delete(settings.whisperModelPath)
    // media file in play, but a binary is gone -> stay silent
    const { systemPrompt } = buildActPrompts({
      ...baseOpts,
      instruction: 'do it',
      finderFiles: ['/clips/talk.m4a']
    })
    expect(systemPrompt).not.toContain('MEDIA TOOLS')
  })

  it('reflects user-overridden SETTINGS paths', () => {
    settings.whisperPath = '/custom/bin/whisper-cli'
    allBinariesPresent()
    const { systemPrompt } = buildActPrompts({ ...baseOpts, finderFiles: ['/clips/talk.mp4'] })
    expect(systemPrompt).toContain('/custom/bin/whisper-cli')
  })

  it('injects the hint for a transcribe-y instruction with NO finderFiles (the real bug)', () => {
    const { systemPrompt } = buildActPrompts({
      ...baseOpts,
      instruction: 'transcribe this',
      finderFiles: []
    })
    expect(systemPrompt).toContain('MEDIA TOOLS')
  })

  it('tolerates the "transribe" typo', () => {
    const { systemPrompt } = buildActPrompts({
      ...baseOpts,
      instruction: 'transribe this',
      finderFiles: []
    })
    expect(systemPrompt).toContain('MEDIA TOOLS')
  })

  it('injects when a media filename is in the SELECTION (no finderFiles)', () => {
    const { systemPrompt } = buildActPrompts({
      ...baseOpts,
      instruction: 'do the thing',
      selection: 'IMG_0860.mp4',
      finderFiles: []
    })
    expect(systemPrompt).toContain('MEDIA TOOLS')
  })

  it('does NOT inject for a plain non-transcription act with no media', () => {
    const { systemPrompt } = buildActPrompts({
      ...baseOpts,
      instruction: 'rename these to lowercase',
      selection: '',
      finderFiles: ['/docs/a.txt']
    })
    expect(systemPrompt).not.toContain('MEDIA TOOLS')
  })
})

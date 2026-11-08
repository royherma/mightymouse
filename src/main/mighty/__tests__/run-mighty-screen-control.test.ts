import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CONFIG } from '../../../shared/config'

// `screenControl` is the whole difference between a live turn that ANSWERS and one
// that DRIVES the Mac. Three things have to move together for that, and each is a
// silent failure on its own:
//   • the capture   — no screenshot means every coordinate the agent emits is a guess
//   • the prompt    — no mm-input verb list means it narrates the click instead of doing it
//   • the ceiling   — voice's 20s answer fuse kills a multi-click run halfway through,
//                     leaving the screen in a half-done state nobody asked for
// The off case is pinned just as hard: a plain spoken turn must not start paying for
// a screenshot, and must not be handed verbs it was never meant to use.

const runBackend = vi.fn()
vi.mock('../../backend/runner', () => ({
  runBackend: (opts: unknown) => runBackend(opts),
  resolveRunModel: () => 'claude-opus-4-8'
}))

const fireScreenshot = vi.fn(async () => ({ kind: 'screenshot', folder: '/tmp/shot', screenshotPath: '/tmp/shot/live.png' }))
vi.mock('../../capture/screenshot', () => ({ fireScreenshot: () => fireScreenshot() }))

vi.mock('../../store/history', () => ({
  HISTORY: { append: vi.fn(), appendPending: vi.fn() },
  historyTimestamp: () => '2026-08-22T08:00:00Z',
  failDetail: (s: string) => s
}))

vi.mock('../../store/prefs', () => ({
  PREFS: {
    getBackend: () => 'claude',
    getIncognito: () => false,
    getMightyName: () => 'Mighty',
    getGlobalInstructions: () => ({
      text: '',
      appliesTo: { rewrite: true, ask: true, act: true, mighty: true }
    }),
    getMightySettings: () => ({ name: '', instructions: '', outputFormat: 'auto' }),
    getRunTranscript: () => false
  }
}))

vi.mock('../../backend/adapters', () => {
  const BACKENDS = {
    claude: { label: 'Claude', modelName: 'claude', hasEnvelope: false, capabilities: { deniableTools: true, toolCalls: true } }
  }
  return {
    BACKENDS,
    toBackendId: () => 'claude',
    canRunUnattended: () => true,
    getCapabilities: async () => BACKENDS.claude.capabilities
  }
})

vi.mock('../../store/paths', () => ({
  PATHS: { MIGHTY_RUNS: '/tmp/mighty/runs', MIGHTY_WORKSPACE: '/tmp/mighty/workspace' }
}))
vi.mock('../../store/mighty', () => ({
  MIGHTY: {
    getSession: () => null,
    getProject: () => null,
    appendTurn: vi.fn(() => 'session-1'),
    startTurn: vi.fn(() => 'session-1'),
    addArtifact: vi.fn(),
    upsertJob: vi.fn()
  }
}))
vi.mock('../broadcast', () => ({
  broadcastMightyTurnAppended: vi.fn(),
  broadcastMightyPhase: vi.fn()
}))
// The real one reaches for the packaged binary paths through electron; the block's
// job here is only to prove the verb list is present, so a stub path is enough.
vi.mock('../../platform', () => ({
  resolveClaude: () => '/usr/local/bin/claude',
  captureContext: vi.fn(async () => ({ frontApp: 'Finder' })),
  input: {
    inputBinPath: () => '/opt/mm/mm-input',
    uiBinPath: () => '/opt/mm/mm-ui',
    shotCommand: () => '/opt/mm/mm-shot --exclude-pid 42'
  }
}))
vi.mock('../../backend/context-memory', () => ({ buildMemoryBlob: () => '' }))
vi.mock('../../backend/parse', () => ({ parseActResult: vi.fn(() => null) }))
vi.mock('../../backend/audio-transcribe', () => ({ transcribeAttachments: vi.fn(async () => '') }))
vi.mock('../../../shared/attachments', () => ({ summarizeAttachments: vi.fn() }))
vi.mock('../../analytics', () => ({ track: vi.fn() }))
vi.mock('fs', () => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  readdirSync: vi.fn(() => []),
  statSync: vi.fn()
}))

import { runMighty } from '../run-mighty'

/** run-mighty spawns inside an async IIFE, after several awaits. */
async function tick(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
}

function lastRunOpts(): Record<string, unknown> {
  return runBackend.mock.calls.at(-1)?.[0] as Record<string, unknown>
}

beforeEach(() => {
  runBackend.mockClear()
  fireScreenshot.mockClear()
  runBackend.mockImplementation(() => new Promise(() => {}))
})

describe('screenControl', () => {
  it('gives the turn the mm-input verbs and the screenshot it measures them on', async () => {
    void runMighty({ message: 'open Safari', source: 'voice', screenControl: true })
    await tick()
    const prompt = lastRunOpts().systemPrompt as string
    expect(fireScreenshot).toHaveBeenCalledTimes(1)
    expect(prompt).toContain('/opt/mm/mm-input click')
    // The re-shoot loop must point at mm-shot with our pid excluded, not at
    // screencapture — otherwise every fresh frame the agent takes mid-run has
    // MightyMouse's own overlays in it and it starts clicking our UI.
    expect(prompt).toContain('/opt/mm/mm-shot --exclude-pid 42 /tmp/mm-shot.png')
    expect(prompt).not.toContain('screencapture -x /tmp/mm-shot.png')
    // The capture path has to reach the prompt, not just be taken: the verbs are
    // useless if the agent can't find the image the coordinates refer to.
    expect(prompt).toContain('/tmp/shot/live.png')
  })

  it('raises a spoken turn past the 20s answer fuse so a multi-click run can finish', async () => {
    void runMighty({ message: 'open Safari', source: 'voice', screenControl: true })
    await tick()
    expect(lastRunOpts().timeoutMs).toBe(CONFIG.MIGHTY.VOICE_ACT_TIMEOUT_MS)
    expect(lastRunOpts().timeoutMs).toBeGreaterThan(CONFIG.MIGHTY.RUN_TIMEOUT_MS.voice)
  })

  it('leaves an answer-only turn with no verbs, no capture, and the tight fuse', async () => {
    void runMighty({ message: 'what time is it', source: 'voice' })
    await tick()
    expect(fireScreenshot).not.toHaveBeenCalled()
    expect(lastRunOpts().systemPrompt as string).not.toContain('mm-input')
    expect(lastRunOpts().timeoutMs).toBe(CONFIG.MIGHTY.RUN_TIMEOUT_MS.voice)
  })

  it('degrades to an answer-only turn when the capture fails', async () => {
    // A screenshot can fail for reasons the user can fix later (permission not yet
    // granted, display asleep). Failing the whole turn over it would take the voice
    // assistant down entirely; answering without the screen is the honest fallback.
    fireScreenshot.mockRejectedValueOnce(new Error('no screen recording permission'))
    void runMighty({ message: 'open Safari', source: 'voice', screenControl: true })
    await tick()
    expect(lastRunOpts().systemPrompt as string).not.toContain('mm-input')
    expect(lastRunOpts().timeoutMs).toBe(CONFIG.MIGHTY.RUN_TIMEOUT_MS.voice)
  })
})

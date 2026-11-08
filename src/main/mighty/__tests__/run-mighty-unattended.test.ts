import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CONFIG } from '../../../shared/config'

// Attended and unattended runs are different situations, and this file pins the
// three places that difference is enforced:
//   • the ceiling      — a job gets an hour, chat keeps its 5-minute fuse
//   • the watchdog     — only a job gets silence-killed
//   • the safety gate  — a job may not run on a backend that can't refuse a command
//
// The gate is the load-bearing one: every act run passes bypassPermissions with
// unrestricted Bash, so an unattended hour with no deny list is how you ship an
// incident instead of a feature.

const runBackend = vi.fn()
vi.mock('../../backend/runner', () => ({
  runBackend: (opts: unknown) => runBackend(opts),
  resolveRunModel: () => 'claude-opus-4-8'
}))

const appendPending = vi.fn()
vi.mock('../../store/history', () => ({
  HISTORY: { append: vi.fn(), appendPending: (e: unknown) => appendPending(e) },
  historyTimestamp: () => '2026-07-16T08:00:00Z'
}))

// The backend under test is swapped per-test via H.backend.
const H = vi.hoisted(() => ({ backend: 'claude' }))
vi.mock('../../store/prefs', () => ({
  PREFS: {
    getBackend: () => H.backend,
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

// Real adapters would drag in electron + the binary resolver. Mirror only the
// capability shape the gate reads, with claude/mightymouse able to deny commands
// and codex not — which is the true split (only buildClaudeCommand takes
// --disallowedTools).
vi.mock('../../backend/adapters', () => {
  const BACKENDS = {
    claude: { label: 'Claude', modelName: 'claude', hasEnvelope: false, capabilities: { deniableTools: true, toolCalls: true } },
    mightymouse: { label: 'MightyMouse', modelName: 'mm', hasEnvelope: false, capabilities: { deniableTools: true, toolCalls: true } },
    codex: { label: 'Codex', modelName: 'codex', hasEnvelope: false, capabilities: { deniableTools: false, toolCalls: true } }
  }
  return {
    BACKENDS,
    toBackendId: (v: string) => (v in BACKENDS ? v : 'claude'),
    canRunUnattended: (id: string) => {
      const c = BACKENDS[id as keyof typeof BACKENDS].capabilities
      return c.deniableTools || !c.toolCalls
    },
    // The real one resolves per-model for local/mlx; none of these three are
    // http backends, so the static capabilities ARE the live answer here.
    getCapabilities: async (id: string) => BACKENDS[id as keyof typeof BACKENDS].capabilities
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
// './broadcast' (not mighty-window) is the real import — it's the seam that exists
// precisely so run-mighty never pulls in electron's BrowserWindow.
vi.mock('../broadcast', () => ({ broadcastMightyTurnAppended: vi.fn() }))
// '../platform' fronts both the macOS context bridge and the binary resolver.
vi.mock('../../platform', () => ({
  resolveClaude: () => '/usr/local/bin/claude',
  captureContext: vi.fn(async () => ({ frontApp: 'Finder' }))
}))
vi.mock('../../backend/context-memory', () => ({ buildMemoryBlob: () => '' }))
vi.mock('../../backend/parse', () => ({ parseActResult: vi.fn(() => null) }))
vi.mock('../../backend/audio-transcribe', () => ({ transcribeAttachments: vi.fn(async () => '') }))
vi.mock('../../../shared/attachments', () => ({ summarizeAttachments: vi.fn() }))
vi.mock('fs', () => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  readdirSync: vi.fn(() => []),
  statSync: vi.fn()
}))

import { runMighty } from '../run-mighty'

/**
 * Let run-mighty reach its spawn. runBackend is called inside an async IIFE, after
 * awaits (context capture, audio transcribe), so a synchronous assertion would run
 * before the spawn ever happened and read an empty mock.
 */
async function tick(): Promise<void> {
  await new Promise((r) => setImmediate(r))
}

/** The options run-mighty handed runBackend on its most recent call. */
function lastRunOpts(): Record<string, unknown> {
  return runBackend.mock.calls.at(-1)?.[0] as Record<string, unknown>
}

beforeEach(() => {
  H.backend = 'claude'
  runBackend.mockClear()
  appendPending.mockClear()
  // Never invoke onDone: these assertions are all about what's passed IN at spawn.
  // Must return a promise — run-mighty chains .catch() onto the result — and one
  // that never settles, so the run stays "in flight" for the duration of the test.
  runBackend.mockImplementation(() => new Promise(() => {}))
})

describe('unattended run ceiling', () => {
  it('gives a scheduled job the 1-hour ceiling', async () => {
    void runMighty({ message: 'do the thing', source: 'job' })
    await tick()
    expect(lastRunOpts().timeoutMs).toBe(CONFIG.MIGHTY.RUN_TIMEOUT_MS.job)
    // Pin the number itself, not just the constant round-trip — the whole feature
    // is that an unattended job gets materially longer than 5 minutes.
    expect(lastRunOpts().timeoutMs).toBe(3_600_000)
  })

  it('leaves attended chat on the 5-minute fuse', async () => {
    void runMighty({ message: 'do the thing', source: 'chat' })
    await tick()
    expect(lastRunOpts().timeoutMs).toBe(CONFIG.MIGHTY.RUN_TIMEOUT_MS.chat)
    expect(lastRunOpts().timeoutMs).toBe(300_000)
  })
})

describe('stall watchdog', () => {
  it('arms the watchdog for a job', async () => {
    void runMighty({ message: 'do the thing', source: 'job' })
    await tick()
    expect(lastRunOpts().stallMs).toBe(CONFIG.MIGHTY.RUN_STALL_MS)
  })

  it('leaves chat unwatched — a human is there to hit stop', async () => {
    void runMighty({ message: 'do the thing', source: 'chat' })
    await tick()
    expect(lastRunOpts().stallMs).toBeUndefined()
  })
})

describe('unattended tool policy', () => {
  it('marks a job unattended so the adapter clamps irreversible commands', async () => {
    void runMighty({ message: 'do the thing', source: 'job' })
    await tick()
    expect(lastRunOpts().unattended).toBe(true)
  })

  it('does not clamp attended chat', async () => {
    void runMighty({ message: 'do the thing', source: 'chat' })
    await tick()
    expect(lastRunOpts().unattended).toBe(false)
  })

  it('runs lean on every source so user MCP servers and skills stay out of the prompt', async () => {
    for (const source of ['chat', 'job', 'voice', 'phone'] as const) {
      void runMighty({ message: 'do the thing', source })
      await tick()
      expect(lastRunOpts().lean).toBe(true)
    }
  })
})

describe('unattended safety gate', () => {
  it('refuses to run a job on a backend that cannot deny commands', async () => {
    H.backend = 'codex'
    const res = await runMighty({ message: 'do the thing', source: 'job' })

    // Never spawned. This is the point: no human, no fuse, no deny list → no run.
    expect(runBackend).not.toHaveBeenCalled()
    expect(res.error).toBe('spawn_failed')
    // The message names the backend and the way out, rather than failing silently.
    expect(res.answer).toContain('Codex')
    expect(res.answer).toContain('Claude')
  })

  it('still allows attended chat on that same backend', async () => {
    H.backend = 'codex'
    void runMighty({ message: 'do the thing', source: 'chat' })
    await tick()
    // A human is watching, so codex stays fully usable in chat — the gate must not
    // bleed into the attended path.
    expect(runBackend).toHaveBeenCalled()
  })

  it('allows a job on a backend that can deny commands', async () => {
    H.backend = 'mightymouse'
    void runMighty({ message: 'do the thing', source: 'job' })
    await tick()
    expect(runBackend).toHaveBeenCalled()
  })
})

describe('pending history row', () => {
  it('writes the run evidence BEFORE the run starts', async () => {
    void runMighty({ message: 'do the thing', source: 'job' })
    await tick()

    // Ordering is the contract: if the app dies mid-run, the row must already exist.
    expect(appendPending).toHaveBeenCalledTimes(1)
    const invokeOrder = runBackend.mock.invocationCallOrder[0]
    const pendingOrder = appendPending.mock.invocationCallOrder[0]
    expect(pendingOrder).toBeLessThan(invokeOrder)

    const entry = appendPending.mock.calls[0][0] as Record<string, unknown>
    expect(entry.instruction).toBe('do the thing')
    expect(entry.mode).toBe('act')
  })

  it('does not write a pending row for a refused job', async () => {
    H.backend = 'codex'
    await runMighty({ message: 'do the thing', source: 'job' })
    // Nothing ran, so there's nothing to leave evidence of.
    expect(appendPending).not.toHaveBeenCalled()
  })
})

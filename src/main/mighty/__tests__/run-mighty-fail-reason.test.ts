import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EXIT_TIMEOUT, EXIT_STOPPED } from '../../backend/runner'

// Every failed run must record WHY it failed — in the history row AND in what the
// caller is handed. This file exists because both used to record only the string
// shown to the user: 423 of 437 failed act runs all said "Something went wrong on
// that run.", which made a 420-failure burst on 2026-07-15 permanently
// undiagnosable. The display copy and the machine-readable reason are separate
// values now, and these tests are what stop them collapsing back into one.

const runBackend = vi.fn()
vi.mock('../../backend/runner', async (orig) => {
  // Keep the REAL exit-code constants — a test that hardcodes -3/-4 would still
  // pass if the constants changed, which is the bug it's meant to catch.
  const actual = await orig<typeof import('../../backend/runner')>()
  return {
    ...actual,
    runBackend: (opts: unknown) => runBackend(opts),
    resolveRunModel: () => 'claude-opus-4-8'
  }
})

const historyAppend = vi.fn()
vi.mock('../../store/history', () => ({
  HISTORY: { append: (e: unknown) => historyAppend(e), appendPending: vi.fn() },
  historyTimestamp: () => '2026-07-26T08:00:00Z',
  failDetail: (t: string) => (t.trim() === '' ? undefined : t.trim().slice(0, 200))
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
    claude: { label: 'Claude', modelName: 'claude', hasEnvelope: false, capabilities: { deniableTools: true, toolCalls: true } },
    mightymouse: { label: 'MightyMouse', modelName: 'mm', hasEnvelope: false, capabilities: { deniableTools: true, toolCalls: true } }
  }
  return {
    BACKENDS,
    toBackendId: (v: string) => (v in BACKENDS ? v : 'claude'),
    canRunUnattended: () => true,
    getCapabilities: async (id: string) => BACKENDS[id as keyof typeof BACKENDS].capabilities
  }
})
vi.mock('../../store/paths', () => ({
  PATHS: { ROOT: '/tmp/mighty', MIGHTY_RUNS: '/tmp/mighty/runs', MIGHTY_WORKSPACE: '/tmp/mighty/workspace' }
}))
vi.mock('../../store/mighty', () => ({
  MIGHTY: {
    getSession: () => null,
    getProject: () => null,
    appendTurn: vi.fn(() => 'session-1'),
    startTurn: vi.fn(() => 'session-1'),
    resolveTurn: vi.fn(),
    addArtifact: vi.fn(),
    upsertJob: vi.fn()
  }
}))
vi.mock('../broadcast', () => ({ broadcastMightyTurnAppended: vi.fn() }))
vi.mock('../../platform', () => ({
  resolveClaude: () => '/usr/local/bin/claude',
  captureContext: vi.fn(async () => ({ frontApp: 'Finder' }))
}))
vi.mock('../../backend/context-memory', () => ({ buildMemoryBlob: () => '' }))
vi.mock('../../backend/parse', () => ({ parseActResult: vi.fn(() => null), stripResultLine: (s: string) => s }))
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

async function tick(): Promise<void> {
  await new Promise((r) => setImmediate(r))
}

/** The history row run-mighty wrote on its most recent append. */
function lastRow(): Record<string, unknown> {
  return historyAppend.mock.calls.at(-1)?.[0] as Record<string, unknown>
}

/** Drive a run to completion with a given exit code + stderr. */
async function runWithExit(exitCode: number, stdErr = ''): Promise<Record<string, unknown>> {
  const done = runMighty({ message: 'do the thing', source: 'chat' })
  await tick()
  const opts = runBackend.mock.calls.at(-1)?.[0] as { onDone: (...a: unknown[]) => void }
  opts.onDone(null, exitCode, '', stdErr, 1)
  return (await done) as unknown as Record<string, unknown>
}

beforeEach(() => {
  runBackend.mockReset()
  historyAppend.mockReset()
  runBackend.mockImplementation(() => Promise.resolve())
})

describe('a failed Mighty run records why', () => {
  it('records timeout, not the sentence shown to the user', async () => {
    const res = await runWithExit(EXIT_TIMEOUT)
    expect(lastRow().reason).toBe('timeout')
    expect(res.error).toBe('timeout')
    // The display copy stays human. It is no longer the ONLY record.
    expect(String(lastRow().result)).toContain('timed out')
  })

  it('distinguishes a user stop from a crash', async () => {
    await runWithExit(EXIT_STOPPED)
    expect(lastRow().reason).toBe('stopped')
  })

  it('records out_of_credits for the paid backend 402 sentinel', async () => {
    await runWithExit(-2)
    expect(lastRow().reason).toBe('out_of_credits')
  })

  it('never leaves reason absent on a failure it cannot classify', async () => {
    await runWithExit(1)
    // 'error' explicitly, NOT undefined — an absent field and a genuinely
    // unclassifiable cause must not look identical when you query the log.
    expect(lastRow().reason).toBe('error')
  })

  it('keeps stderr as local detail, capped', async () => {
    const long = 'x'.repeat(500)
    await runWithExit(1, long)
    expect(String(lastRow().result_detail)).toHaveLength(200)
  })

  it('writes no reason at all on success', async () => {
    await runWithExit(0)
    expect(lastRow().ok).toBe(true)
    expect(lastRow().reason).toBeUndefined()
    expect(lastRow().result_detail).toBeUndefined()
  })

  it('records spawn_failed with the thrown message when nothing ever ran', async () => {
    runBackend.mockImplementation(() => Promise.reject(new Error('claude: command not found')))
    const done = runMighty({ message: 'do the thing', source: 'chat' })
    await tick()
    const res = (await done) as unknown as Record<string, unknown>
    expect(lastRow().reason).toBe('spawn_failed')
    expect(res.error).toBe('spawn_failed')
    // A pre-spawn throw is the most diagnosable failure there is — keep the message.
    expect(String(lastRow().result_detail)).toContain('command not found')
  })
})

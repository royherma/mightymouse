import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { MightyTurn } from '../../../shared/types'

const h = vi.hoisted(() => ({ prior: [] as MightyTurn[] }))

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
    getSession: () => ({ id: 'session-1', turns: h.prior }),
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

async function tick(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
}

const turn = (ts: string, q: string, a = 'ok'): MightyTurn => ({ source: 'chat', q, a, ts, ok: true }) as MightyTurn
const at = (y: number, m: number, d: number, hh: number): string => new Date(y, m - 1, d, hh).toISOString()

async function promptFor(prior: MightyTurn[], message: string): Promise<string[]> {
  h.prior = prior
  void runMighty({ message, source: 'chat', sessionId: 'session-1' })
  await tick()
  return (runBackend.mock.calls.at(-1)?.[0] as { userPrompt: string }).userPrompt.split('\n')
}

beforeEach(() => {
  runBackend.mockClear()
  runBackend.mockImplementation(() => new Promise(() => {}))
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 10, 21, 10, 30))
})
afterEach(() => vi.useRealTimers())

describe('the model knows what time it is now', () => {
  it('the prompt opens with the current day and time', async () => {
    const lines = await promptFor([], 'what time is it')
    expect(lines[0]).toMatch(/^NOW: .*21.*10:30/)
    expect(lines[0]).toMatch(/Nov/)
  })

  it("an earlier day's message carries its date; today's does not", async () => {
    const lines = await promptFor(
      [turn(at(2026, 11, 19, 9), 'is the shop open now?', 'Yes, until 7.'), turn(at(2026, 11, 21, 8), 'thanks')],
      'what about now?'
    )
    const old = lines.find((l) => l.endsWith('User: is the shop open now?'))!
    expect(old).toMatch(/^\[.*19.*\] User: is the shop open now\?$/)
    expect(lines).toContain('User: thanks')
    expect(lines.indexOf('User: what about now?')).toBeGreaterThan(lines.indexOf('User: thanks'))
  })

  it('late last night is an earlier day even though it was under 24 hours ago', async () => {
    const lines = await promptFor([turn(at(2026, 11, 20, 23), 'late last night'), turn(at(2026, 11, 21, 0), 'just after midnight')], 'hi')
    expect(lines.find((l) => l.includes('late last night'))).toMatch(/^\[.*20.*\] User:/)
    expect(lines).toContain('User: just after midnight')
  })

  it('a turn with an unreadable time is shown without a date instead of breaking the prompt', async () => {
    const lines = await promptFor([turn('not a date', 'old question')], 'hi')
    expect(lines).toContain('User: old question')
    expect(lines.join('\n')).not.toMatch(/Invalid Date/)
  })
})

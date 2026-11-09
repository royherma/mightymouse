import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EXIT_STOPPED } from '../../backend/runner'
import { RUN_EVENT } from '../../../shared/types'
import { STOPPED_MARK } from '../../../shared/stopped-reply'
import { CONFIG } from '../../../shared/config'

const runBackend = vi.fn()
vi.mock('../../backend/runner', async (orig) => {
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
const getSession = vi.fn((_id: string): unknown => null)
const resolveTurn = vi.fn()
vi.mock('../../store/mighty', () => ({
  MIGHTY: {
    getSession: (id: string) => getSession(id),
    getProject: () => null,
    appendTurn: vi.fn(() => 'session-1'),
    startTurn: vi.fn(() => 'session-1'),
    resolveTurn: (...a: unknown[]) => resolveTurn(...a),
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

type BackendOpts = {
  userPrompt: string
  priorMessages?: Array<{ role: string; content: string }>
  onEvent: (e: unknown) => void
  onDone: (...a: unknown[]) => void
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))
const lastBackend = (): BackendOpts => runBackend.mock.calls.at(-1)?.[0] as BackendOpts
const savedAnswer = (): string => (resolveTurn.mock.calls.at(-1)?.[2] as { a: string }).a

async function streamThenStop(source: 'chat' | 'phone', chunks: string[]): Promise<{ answer: string; error?: string }> {
  const done = runMighty({ message: 'write me a long list', source, sessionId: 'session-1' })
  await tick()
  for (const text of chunks) lastBackend().onEvent({ kind: RUN_EVENT.text, text })
  lastBackend().onDone(null, EXIT_STOPPED, '{"type":"assistant"}', '', 1)
  return (await done) as { answer: string; error?: string }
}

beforeEach(() => {
  runBackend.mockReset()
  resolveTurn.mockReset()
  getSession.mockReset()
  getSession.mockReturnValue(null)
  runBackend.mockImplementation(() => Promise.resolve())
})

describe('a stopped chat run keeps what it already wrote', () => {
  it('desktop chat: saves the streamed partial plus the cut-off marker', async () => {
    const res = await streamThenStop('chat', ['1. Apples', '2. Pears'])
    expect(savedAnswer()).toBe(`1. Apples\n\n2. Pears\n\n${STOPPED_MARK}`)
    expect(res.answer).toBe(savedAnswer())
    expect(res.error).toBe('stopped')
  })

  it('phone chat: the same run path saves the partial plus the marker', async () => {
    const res = await streamThenStop('phone', ['Half a sentence'])
    expect(savedAnswer()).toBe(`Half a sentence\n\n${STOPPED_MARK}`)
    expect(res.answer).toBe(savedAnswer())
  })

  it('a stop before any text arrives still saves the plain stopped reply', async () => {
    await streamThenStop('chat', [])
    expect(savedAnswer()).toBe(CONFIG.MIGHTY.STOPPED_REPLY)
  })

  it('a steered follow-up sends the cut-off text to the provider', async () => {
    await streamThenStop('chat', ['1. Apples'])
    const cut = savedAnswer()
    getSession.mockReturnValue({ id: 'session-1', turns: [{ q: 'write me a long list', a: cut, ok: false, ts: 't' }] })
    const next = runMighty({ message: 'actually only fruit that is red', source: 'chat', sessionId: 'session-1' })
    await tick()
    const sent = lastBackend()
    expect(sent.userPrompt).toContain(`1. Apples\n\n${STOPPED_MARK}`)
    expect(sent.userPrompt).toContain('actually only fruit that is red')
    expect(sent.priorMessages).toContainEqual({ role: 'assistant', content: cut })
    sent.onDone(null, 0, '', '', 1)
    await next
  })
})

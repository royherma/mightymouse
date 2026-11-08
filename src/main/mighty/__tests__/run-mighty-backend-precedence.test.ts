import { describe, it, expect, vi, beforeEach } from 'vitest'

// Picking a provider in one chat used to call settingsSetBackend, which wrote the
// machine-wide pref and broadcast it to every window — so every other open chat
// silently repointed too. These tests pin the precedence that replaced it.

const runBackend = vi.fn()
vi.mock('../../backend/runner', async (orig) => {
  const actual = await orig<typeof import('../../backend/runner')>()
  return {
    ...actual,
    runBackend: (opts: unknown) => runBackend(opts),
    resolveRunModel: () => 'claude-opus-4-8'
  }
})

vi.mock('../../store/history', () => ({
  HISTORY: { append: vi.fn(), appendPending: vi.fn() },
  historyTimestamp: () => '2026-08-04T08:00:00Z',
  failDetail: (t: string) => (t.trim() === '' ? undefined : t.trim())
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
  const mk = (label: string): unknown => ({
    label,
    modelName: label.toLowerCase(),
    hasEnvelope: false,
    capabilities: { deniableTools: true, toolCalls: true }
  })
  const BACKENDS = { claude: mk('Claude'), codex: mk('Codex'), mightymouse: mk('MightyMouse') }
  return {
    BACKENDS,
    toBackendId: (v: string) => (v in BACKENDS ? v : 'claude'),
    canRunUnattended: () => true,
    getCapabilities: async (id: string) => (BACKENDS as Record<string, { capabilities: unknown }>)[id].capabilities
  }
})

vi.mock('../../store/paths', () => ({
  PATHS: { ROOT: '/tmp/mighty', MIGHTY_RUNS: '/tmp/mighty/runs', MIGHTY_WORKSPACE: '/tmp/mighty/workspace' }
}))

const sessions = new Map<string, Record<string, unknown>>()
const projects = new Map<string, Record<string, unknown>>()
const setSessionBackend = vi.fn((id: string, backend: string) => {
  const s = sessions.get(id)
  if (!s) return false
  s.backend = backend
  return true
})
vi.mock('../../store/mighty', () => ({
  MIGHTY: {
    getSession: (id: string) => sessions.get(id) ?? null,
    getProject: (id: string) => projects.get(id) ?? null,
    appendTurn: vi.fn(() => 'session-new'),
    startTurn: vi.fn((sessionId?: string) => sessionId ?? 'session-new'),
    resolveTurn: vi.fn(),
    setSessionBackend: (id: string, backend: string) => setSessionBackend(id, backend),
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
  captureContext: vi.fn(async () => ({ frontApp: 'Finder' }))
}))
vi.mock('../../backend/context-memory', () => ({ buildMemoryBlob: () => '' }))
vi.mock('../../backend/parse', () => ({
  parseActResult: vi.fn(() => null),
  stripResultLine: (s: string) => s
}))
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
import type { BackendId } from '../../../shared/types'

async function tick(): Promise<void> {
  await new Promise((r) => setImmediate(r))
}

/** Start a run, let it reach the spawn, and report which backend it spawned on. */
async function backendUsedFor(opts: {
  sessionId?: string
  projectId?: string
  backend?: BackendId
}): Promise<string> {
  const done = runMighty({ message: 'hello', source: 'chat', ...opts })
  await tick()
  const call = runBackend.mock.calls.at(-1)?.[0] as {
    backend: string
    onDone: (...a: unknown[]) => void
  }
  call.onDone(null, 0, 'ok', '', 1)
  await done
  return call.backend
}

beforeEach(() => {
  runBackend.mockReset()
  setSessionBackend.mockClear()
  runBackend.mockImplementation(() => Promise.resolve())
  sessions.clear()
  projects.clear()
  projects.set('proj-1', { id: 'proj-1', defaultBackend: 'mightymouse' })
})

describe('which provider a Mighty run lands on', () => {
  it('prefers the session pin over the project default and the global pref', async () => {
    sessions.set('s1', { id: 's1', backend: 'codex', projectId: 'proj-1', turns: [] })
    expect(await backendUsedFor({ sessionId: 's1' })).toBe('codex')
  })

  it('falls back to the project default when the session has no pin', async () => {
    sessions.set('s1', { id: 's1', projectId: 'proj-1', turns: [] })
    expect(await backendUsedFor({ sessionId: 's1' })).toBe('mightymouse')
  })

  it('falls back to the global pref when neither is set', async () => {
    sessions.set('s1', { id: 's1', turns: [] })
    expect(await backendUsedFor({ sessionId: 's1' })).toBe('claude')
  })

  it('lets a pane with no session yet pass its choice through, and pins it', async () => {
    expect(await backendUsedFor({ backend: 'codex' })).toBe('codex')
    expect(setSessionBackend).toHaveBeenCalledWith('session-new', 'codex')
  })

  it('does not let a passed-in choice overwrite a session that is already pinned', async () => {
    sessions.set('s1', { id: 's1', backend: 'codex', turns: [] })
    await backendUsedFor({ sessionId: 's1', backend: 'mightymouse' })
    expect(sessions.get('s1')?.backend).toBe('codex')
    expect(setSessionBackend).not.toHaveBeenCalled()
  })

  it('leaves a second conversation untouched when one changes provider', async () => {
    sessions.set('a', { id: 'a', backend: 'codex', turns: [] })
    sessions.set('b', { id: 'b', backend: 'claude', turns: [] })
    expect(await backendUsedFor({ sessionId: 'a' })).toBe('codex')
    expect(await backendUsedFor({ sessionId: 'b' })).toBe('claude')
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CONFIG } from '../../../shared/config'

// Capture the options the run pipeline hands to runBackend so we can assert the
// timeout ceiling is wired (a missing timeoutMs is what let voice runs hang).
// runCaptureAction delegates to the shared hud-run service, so the assertion
// flows capture-actions -> hud-run -> runBackend.
const runBackend = vi.fn()
vi.mock('../../backend/runner', () => ({
  runBackend: (opts: unknown) => runBackend(opts),
  // hud-run labels every run's model through this; `claude` (the mocked backend
  // here) pins its model statically, so the stub mirrors that.
  resolveRunModel: () => 'claude-opus-4-8'
}))

// Stub every side-effecting collaborator the service touches so the call reaches
// runBackend without disk, prefs files, the HUD, electron windows, or analytics.
vi.mock('../../store/prefs', () => ({ PREFS: { getBackend: () => 'claude', getIncognito: () => false, getRunTranscript: () => false } }))
vi.mock('../../store/events', () => ({ EVENTS: { append: vi.fn() } }))
vi.mock('../../store/history', () => ({ HISTORY: { append: vi.fn() }, historyTimestamp: () => '2026-06-14T10-00-00Z' }))
vi.mock('../../store/paths', () => ({
  PATHS: { TMP: '/tmp', RUNS: '/tmp/runs', ACTS: '/tmp/acts', ACTS_AUDITS: '/tmp/acts/audits', LATEST_ACT: '/tmp/acts/latest.txt' }
}))
vi.mock('../../hud-window', () => ({
  startHud: vi.fn(),
  updateHud: vi.fn(),
  doneHud: vi.fn(),
  failHud: vi.fn(),
  runningHud: vi.fn()
}))
// getPanelWindow: broadcastMightyTurnAppended fans a turn out to the panel too;
// null = "no panel open", the right shape for a headless run.
vi.mock('../../panel-window', () => ({
  closePanelWindow: vi.fn(),
  sendToPanelRenderer: vi.fn(),
  getPanelWindow: () => null
}))
// hud-run reaches the Mighty window (live-handoff) — stub it and its store so the
// import graph never pulls in mighty-window's electron BrowserWindow.
vi.mock('../../mighty/mighty-window', () => ({ getMightyWindow: () => null }))
vi.mock('../../store/mighty', () => ({
  MIGHTY: {
    appendTurn: vi.fn(),
    newSession: vi.fn(() => ({ id: 'session-stub' })),
    // An ask run opens its Mighty turn up front (so a mid-flight run renders a
    // thinking bubble); returns the landed session id.
    startTurn: vi.fn(() => 'session-stub')
  }
}))
vi.mock('../../platform', () => ({
  captureContext: vi.fn(),
  pasteText: vi.fn(),
  pasteTextToApp: vi.fn(),
  input: { clickAt: vi.fn(), typeText: vi.fn() }
}))
// Point-at / click collaborators of hud-run — stub so the import graph never
// pulls in cursor-window (electron BrowserWindow) or the native click/OCR paths.
vi.mock('../../cursor-window', () => ({ flyCursorTo: vi.fn() }))
vi.mock('../../highlight-window', () => ({ flashHighlightBox: vi.fn() }))
vi.mock('../../transcript-window', () => ({ pushTranscriptEvent: vi.fn() }))
vi.mock('../../capture/find-on-screen', () => ({ findOnScreen: vi.fn() }))
// hud-run pushes act-progress steps to a phone-remote run — stub so the import
// graph never pulls in server.ts's real module (which bootstraps the
// cloudflared tunnel path off PATHS.BIN, undefined above).
vi.mock('../../phone-remote/server', () => ({ isPhoneRun: () => false, sendToPhone: vi.fn() }))
vi.mock('../../analytics', () => ({ track: vi.fn(), trackError: vi.fn() }))
vi.mock('../../backend/context-memory', () => ({ buildMemoryBlob: () => '' }))
vi.mock('../../backend/prompts', () => ({
  buildActPrompts: () => ({ systemPrompt: 'sys', userPrompt: 'usr' }),
  buildRewritePrompts: () => ({ systemPrompt: 'sys', userPrompt: 'usr' })
}))
vi.mock('../../backend/parse', () => ({ parseActResult: vi.fn() }))
vi.mock('../../backend/adapters', () => ({
  BACKENDS: { claude: { modelName: 'claude', hasEnvelope: false } }
}))
vi.mock('fs', () => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => false)
}))

import { runCaptureAction, rememberCapture } from '../capture-actions'

describe('runCaptureAction backend timeout', () => {
  beforeEach(() => {
    runBackend.mockClear()
  })

  it('passes the ask timeout for a voice Ask run', () => {
    rememberCapture('run-ask', { folder: '/tmp/cap', kind: 'listen', transcript: 'summarize this' })
    runCaptureAction('run-ask', 'ask')

    expect(runBackend).toHaveBeenCalledTimes(1)
    expect(runBackend.mock.calls[0][0].timeoutMs).toBe(CONFIG.RUN_TIMEOUT_MS.ask)
  })

  it('passes the (longer) act timeout for a voice Act run', () => {
    rememberCapture('run-act', { folder: '/tmp/cap', kind: 'recording', transcript: 'create a file' })
    runCaptureAction('run-act', 'act')

    expect(runBackend).toHaveBeenCalledTimes(1)
    expect(runBackend.mock.calls[0][0].timeoutMs).toBe(CONFIG.RUN_TIMEOUT_MS.act)
  })
})

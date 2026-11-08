import { describe, it, expect, vi, beforeEach } from 'vitest'

// probeBackend's http-transport branch is the backend preflight gate — the
// severest bug in PRD 2026-07-23-credit-balance-under-reports.md (§2c):
// `ok: cents > 0` used to read balance_cents (packs) alone, so a subscriber
// with $0 packs and a funded subscription_cents bucket was told the backend
// was unusable, even though the real paywall (llm-proxy) would have served
// them. This test drives probeBackend end to end (not just spendableCents in
// isolation) so the WIRING — the actual select + the actual gate predicate in
// settings.ts — is what's proven, not just the helper it calls.
//
// settings.ts imports a wide graph (electron, onboarding/dock/panel windows,
// capture, history, insights, island/companion windows). Every side-reaching
// import is stubbed to a no-op so importing the module for its one exported
// function (probeBackend) doesn't require an Electron runtime.

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }))
vi.mock('../../platform', () => ({
  PERMISSIONS: { list: vi.fn(() => []) },
  clearBinaryCache: vi.fn()
}))
vi.mock('../../routing', () => ({ route: vi.fn() }))
vi.mock('../../ftue-replay', () => ({ replayFirstRun: vi.fn() }))
vi.mock('../../dock', () => ({ applyDockIcon: vi.fn() }))
vi.mock('../../capture/binaries', () => ({
  getBinaryStatuses: vi.fn(async () => ({})),
  downloadWhisperModel: vi.fn(),
  installWhisperViaBrew: vi.fn(),
  installFfmpegViaBrew: vi.fn(),
  hasHomebrew: vi.fn(() => false)
}))
vi.mock('../../capture/devices', () => ({ listAvDevices: vi.fn(async () => ({})) }))
vi.mock('../../store/settings', () => ({ SETTINGS: { get: vi.fn(() => ({})) } }))
vi.mock('../../capture', () => ({ isRecording: vi.fn(() => false) }))
vi.mock('../../capture/context-logger', () => ({ startContextLogging: vi.fn(), stopContextLogging: vi.fn() }))
vi.mock('../../settings-window', () => ({
  sendToSettingsRenderer: vi.fn(),
  takePendingSettingsFocus: vi.fn()
}))
vi.mock('../../panel-window', () => ({ sendToPanelRenderer: vi.fn(), showPanelWindow: vi.fn() }))
vi.mock('../../selection-watcher', () => ({ applySelectionWatcher: vi.fn() }))
vi.mock('../../store/paths', () => ({ PATHS: { ROOT: '/tmp/mm-test' } }))
vi.mock('../../store/prefs', () => ({ PREFS: {} }))
vi.mock('../../store/history', () => ({ HISTORY: {}, reconcileHistoryEncryption: vi.fn() }))
vi.mock('../../analytics', () => ({ track: vi.fn() }))
vi.mock('../../backend/local-models', () => ({ isOllamaRunning: vi.fn(), listLocalModels: vi.fn() }))
vi.mock('../../backend/mlx-models', () => ({ isMlxRunning: vi.fn(), listMlxModels: vi.fn() }))
vi.mock('../../insights/insights-manager', () => ({
  startInsightsManager: vi.fn(),
  stopInsightsManager: vi.fn()
}))
vi.mock('../phone-remote', () => ({ sendLayoutPrefsToPhone: vi.fn() }))
vi.mock('../../phone-remote/web-client', () => ({ closeWebClients: vi.fn() }))
vi.mock('../../web-chat-sync', () => ({ scheduleChatSync: vi.fn() }))
vi.mock('../../island-window', () => ({ setIslandWindow: vi.fn() }))
vi.mock('../../companion-window', () => ({ setCompanionWindow: vi.fn() }))
// Turning live mode off ends the spoken conversation; the real module reaches
// whisper + the companion orchestrator, so stub it to the one function used here.
vi.mock('../../capture/live-listen', () => ({ setLiveSession: vi.fn() }))
vi.mock('../../cursor-window', () => ({
  setCursorCompanion: vi.fn(),
  broadcastCursorStyle: vi.fn(),
  startCursorCompanion: vi.fn(),
  stopCursorCompanion: vi.fn()
}))

// The two seams the test actually drives: who's signed in, and what the DB
// returns for credit_balances.
const getSessionMock = vi.fn()
vi.mock('../../auth', () => ({
  getSession: (...args: unknown[]) => getSessionMock(...args),
  isCurrentUserAdmin: vi.fn(async () => false)
}))

const selectChain = {
  eq: vi.fn().mockReturnThis(),
  single: vi.fn()
}
const fromMock = vi.fn(() => ({ select: vi.fn(() => selectChain) }))
vi.mock('../../supabase', () => ({ getSupabase: () => ({ from: fromMock }) }))

// mightymouse's http transport is all probeBackend's balance-gate branch reads
// off the adapter — stub just that, not the whole 1000+ line adapters module.
vi.mock('../../backend/adapters', () => ({
  BACKENDS: { mightymouse: { transport: 'http' } },
  toBackendId: (b: string) => b
}))

import { probeBackend } from '../settings'

describe('probeBackend (mightymouse / http transport) — balance gate', () => {
  beforeEach(() => {
    getSessionMock.mockReset()
    selectChain.eq.mockClear()
    selectChain.single.mockReset()
    fromMock.mockClear()
  })

  it('reads BOTH balance_cents and subscription_cents from credit_balances', async () => {
    getSessionMock.mockResolvedValue({ userId: 'u1' })
    selectChain.single.mockResolvedValue({ data: { balance_cents: 500, subscription_cents: 0 } })
    await probeBackend('mightymouse')
    const selectSpy = fromMock.mock.results[0].value.select as ReturnType<typeof vi.fn>
    expect(selectSpy.mock.calls[0][0]).toContain('subscription_cents')
    expect(selectSpy.mock.calls[0][0]).toContain('balance_cents')
  })

  it('THE BUG: $0 packs + funded subscription still passes the gate (ok: true)', async () => {
    getSessionMock.mockResolvedValue({ userId: 'u1' })
    // This is the exact denial case from PRD §2c: balance_cents (packs) is 0,
    // subscription_cents is funded. The old code read balance_cents alone and
    // returned ok: false here, blocking a paying subscriber.
    selectChain.single.mockResolvedValue({ data: { balance_cents: 0, subscription_cents: 2000 } })
    const result = await probeBackend('mightymouse')
    const balanceCheck = result.checks.find((c) => c.detail.includes('balance'))
    expect(balanceCheck?.ok).toBe(true)
    expect(result.ok).toBe(true)
    expect(result.advice).toBeNull()
  })

  it('packs only, no subscription — still passes (unchanged behavior)', async () => {
    getSessionMock.mockResolvedValue({ userId: 'u1' })
    selectChain.single.mockResolvedValue({ data: { balance_cents: 1500, subscription_cents: 0 } })
    const result = await probeBackend('mightymouse')
    expect(result.ok).toBe(true)
  })

  it('both buckets zero — correctly denied', async () => {
    getSessionMock.mockResolvedValue({ userId: 'u1' })
    selectChain.single.mockResolvedValue({ data: { balance_cents: 0, subscription_cents: 0 } })
    const result = await probeBackend('mightymouse')
    expect(result.ok).toBe(false)
    expect(result.advice).toBe('You have used all your usage. Upgrade or add extra usage in Settings → Your MightyMouse plan.')
  })

  it('not signed in — denied before any balance read', async () => {
    getSessionMock.mockResolvedValue(null)
    const result = await probeBackend('mightymouse')
    expect(result.ok).toBe(false)
    expect(fromMock).not.toHaveBeenCalled()
  })
})

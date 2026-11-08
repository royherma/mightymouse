import { describe, it, expect, vi, beforeEach } from 'vitest'

// live-listen.ts holds the session id that makes consecutive spoken turns ONE
// conversation. It lives in main, not the renderer, on purpose: the companion
// window reloads (HMR, a crash, the live-mode toggle) and a renderer-held id
// would split a conversation in two without any visible symptom.
//
// These pin the latch's three rules: set it once, reuse it, and drop it only when
// live mode ends.

const runCompanionAskTurn = vi.hoisted(() => vi.fn())
const transcribe = vi.hoisted(() => vi.fn())

vi.mock('../companion-orchestrator', () => ({
  runCompanionAskTurn: async (...a: unknown[]) => ({ answeredBy: { backend: 'claude', model: 'm', label: 'm' }, ...(await runCompanionAskTurn(...a)) }),
  speakCompanionReply: vi.fn(async () => ({ audio: null, mimeType: 'audio/mpeg', tookMs: 0 })),
  abortCompanionTurn: vi.fn()
}))
vi.mock('./whisper', () => ({ transcribe }))
vi.mock('../capture/whisper', () => ({ transcribe }))
vi.mock('../companion-window', () => ({ sendCompanionStageEvent: vi.fn(), sendToCompanion: vi.fn(), isCompanionMicPaused: () => false }))
vi.mock('../actions/engine', () => ({ proposeActions: vi.fn(async () => null), runProposal: vi.fn(), expireProposals: vi.fn(), primeActions: vi.fn() }))
vi.mock('../actions/decide-transport', () => ({ warmJev: vi.fn(), takeJevInputTokens: () => 0 }))
vi.mock('../actions/capabilities/system', () => ({ quickOpenApp: vi.fn(async () => null), SCREEN_ACTION_ID: 'system.screen' }))
vi.mock('../sound-window', () => ({ playSound: vi.fn() }))
vi.mock('../hideout', () => ({ isHideoutOpen: () => false, isHideoutPaused: () => false, recordHideoutTurn: vi.fn(), runHideoutTurn: async () => null, setHideoutWords: vi.fn(), showHideoutTurn: vi.fn() }))
vi.mock('../audio/tts', () => ({ speak: async () => ({ audio: null, mimeType: '' }) }))
vi.mock('../store/paths', () => ({ PATHS: { TMP: '/tmp/mm-test' } }))
vi.mock('fs', () => ({
  existsSync: () => false,
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
  writeFileSync: vi.fn()
}))

import { runLiveTurn, setLiveSession, getLiveSession } from '../capture/live-listen'

const WAV = new Uint8Array([1, 2, 3])

describe('live mode holds one session across spoken turns', () => {
  beforeEach(() => {
    runCompanionAskTurn.mockReset()
    transcribe.mockReset().mockResolvedValue({ ok: true, text: 'hey Mighty, hello there', wordCount: 4 })
    setLiveSession(undefined)
  })

  it('latches the session from the first turn and reuses it on the next', async () => {
    runCompanionAskTurn.mockResolvedValue({ ok: true, reply: 'Hi.', sessionId: 'sess-1', tookMs: 10 })

    await runLiveTurn(WAV)
    expect(getLiveSession()).toBe('sess-1')

    await runLiveTurn(WAV)
    // Turn 2 must be told to continue turn 1's conversation, not open a new one.
    expect(runCompanionAskTurn.mock.calls[1][1]).toBe('sess-1')
  })

  it('starts the first turn with NO session (a fresh conversation)', async () => {
    runCompanionAskTurn.mockResolvedValue({ ok: true, reply: 'Hi.', sessionId: 'sess-1', tookMs: 10 })

    await runLiveTurn(WAV)

    expect(runCompanionAskTurn.mock.calls[0][1]).toBeUndefined()
  })

  it('keeps the session after a FAILED turn so the retry continues it', async () => {
    runCompanionAskTurn.mockResolvedValue({
      ok: false,
      reply: '',
      error: 'timeout',
      sessionId: 'sess-1',
      tookMs: 10
    })

    const result = await runLiveTurn(WAV)

    expect(result.ok).toBe(false)
    expect(getLiveSession()).toBe('sess-1')
  })

  it('never reaches the LLM on an empty transcript — silence is not a turn', async () => {
    transcribe.mockResolvedValue({ ok: true, text: '   ', wordCount: 0 })

    const result = await runLiveTurn(WAV)

    expect(result.ok).toBe(false)
    expect(runCompanionAskTurn).not.toHaveBeenCalled()
    // And it must not have opened a session for a noise misfire.
    expect(getLiveSession()).toBeUndefined()
  })

  it('setLiveSession joins an existing chat session — voice picking up a typed convo', async () => {
    setLiveSession('typed-session-42')
    runCompanionAskTurn.mockResolvedValue({
      ok: true,
      reply: 'Continuing.',
      sessionId: 'typed-session-42',
      tookMs: 10
    })

    await runLiveTurn(WAV)

    expect(runCompanionAskTurn.mock.calls[0][1]).toBe('typed-session-42')
  })

  it('clears on setLiveSession(undefined) — switching live mode off ends the convo', async () => {
    runCompanionAskTurn.mockResolvedValue({ ok: true, reply: 'Hi.', sessionId: 'sess-1', tookMs: 10 })
    await runLiveTurn(WAV)

    setLiveSession(undefined)

    expect(getLiveSession()).toBeUndefined()
  })
})

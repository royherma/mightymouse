import { describe, it, expect, vi, beforeEach } from 'vitest'

// Stage's input bar submits a typed instruction over `companionSendText`, which
// lands here. The whole point of the split is that typing is not a second
// pipeline: it runs the SAME ask + speak + session-latching a spoken turn does,
// minus whisper. These tests pin that equivalence, because the failure mode is
// silent — a typed turn that quietly starts its own session, or skips the
// screen-control path, still returns a plausible-looking reply.

const askTurn = vi.fn()
const speak = vi.fn()
const abort = vi.fn()

vi.mock('../../companion-window', () => ({ sendCompanionStageEvent: vi.fn(), sendToCompanion: vi.fn(), isCompanionMicPaused: () => false }))
vi.mock('../../actions/engine', () => ({ proposeActions: vi.fn(async () => null), runProposal: vi.fn(), expireProposals: vi.fn(), primeActions: vi.fn() }))
vi.mock('../../actions/decide-transport', () => ({ warmJev: vi.fn(), takeJevInputTokens: () => 0 }))
vi.mock('../../actions/capabilities/system', () => ({ quickOpenApp: vi.fn(async () => null), SCREEN_ACTION_ID: 'system.screen' }))
vi.mock('../../sound-window', () => ({ playSound: vi.fn() }))
vi.mock('../../hideout', () => ({ isHideoutOpen: () => false, isHideoutPaused: () => false, recordHideoutTurn: vi.fn(), runHideoutTurn: async () => null, setHideoutWords: vi.fn(), showHideoutTurn: vi.fn() }))
vi.mock('../../audio/tts', () => ({ speak: async () => ({ audio: null, mimeType: '' }) }))
vi.mock('../../companion-orchestrator', () => ({
  runCompanionAskTurn: async (text: string, sessionId: string) => ({ answeredBy: { backend: 'claude', model: 'm', label: 'm' }, ...(await askTurn(text, sessionId)) }),
  speakCompanionReply: (text: string) => speak(text),
  abortCompanionTurn: () => abort()
}))
vi.mock('../segmented-listen', () => ({ transcribeSegment: vi.fn() }))

import { runLiveTurnFromText } from '../live-listen'

beforeEach(() => {
  askTurn.mockReset()
  speak.mockReset()
  abort.mockReset()
  speak.mockResolvedValue({ audio: null, mimeType: '' })
})

describe('runLiveTurnFromText', () => {
  it('runs the typed text as one ask turn and speaks the reply', async () => {
    askTurn.mockResolvedValue({ ok: true, reply: 'closed it', sessionId: 's1' })

    const result = await runLiveTurnFromText('now close it')

    expect(askTurn).toHaveBeenCalledTimes(1)
    expect(askTurn.mock.calls[0][0]).toBe('now close it')
    expect(speak).toHaveBeenCalledWith('closed it')
    expect(result).toMatchObject({ ok: true, transcript: 'now close it', reply: 'closed it' })
  })

  it('keeps the SAME session across turns', async () => {
    // The regression this guards: a typed follow-up that starts a fresh session
    // loses everything the spoken turn before it just did, so "now close it"
    // has no idea what "it" is.
    askTurn.mockResolvedValue({ ok: true, reply: 'ok', sessionId: 'sess-a' })
    await runLiveTurnFromText('open calendar')

    askTurn.mockResolvedValue({ ok: true, reply: 'ok', sessionId: 'sess-a' })
    await runLiveTurnFromText('now close it')

    expect(askTurn.mock.calls[1][1]).toBe('sess-a')
  })

  it('treats a typed "stop" as a kill, not an instruction', async () => {
    const result = await runLiveTurnFromText('stop')

    expect(abort).toHaveBeenCalledTimes(1)
    expect(askTurn).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
  })

  it('ignores an empty submit', async () => {
    const result = await runLiveTurnFromText('   ')

    expect(askTurn).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
  })

  it('reports a failed turn without speaking anything', async () => {
    askTurn.mockResolvedValue({ ok: false, reply: '', error: 'timed out', sessionId: 's2' })

    const result = await runLiveTurnFromText('do the thing')

    expect(speak).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: false, error: 'timed out', sessionId: 's2' })
  })
})

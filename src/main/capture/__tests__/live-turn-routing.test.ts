import { describe, it, expect, vi, beforeEach } from 'vitest'

const askTurn = vi.fn()
const speak = vi.fn()
const abort = vi.fn()
const proposeActions = vi.fn()
const runProposal = vi.fn()

vi.mock('../../companion-window', () => ({ sendCompanionStageEvent: vi.fn(), sendToCompanion: vi.fn(), isCompanionMicPaused: () => false }))
vi.mock('../../actions/engine', () => ({
  proposeActions: (...a: unknown[]) => proposeActions(...a),
  runProposal: (...a: unknown[]) => runProposal(...a),
  expireProposals: vi.fn(),
  primeActions: vi.fn()
}))
vi.mock('../../actions/decide-transport', () => ({ warmJev: vi.fn(), takeJevInputTokens: () => 0 }))
vi.mock('../../actions/capabilities/system', () => ({ quickOpenApp: vi.fn(async () => null), SCREEN_ACTION_ID: 'system.screen' }))
vi.mock('../../sound-window', () => ({ playSound: vi.fn() }))
vi.mock('../../hideout', () => ({ isHideoutOpen: () => false, isHideoutPaused: () => false, recordHideoutTurn: vi.fn(), runHideoutTurn: async () => null, setHideoutWords: vi.fn(), showHideoutTurn: vi.fn() }))
vi.mock('../../audio/tts', () => ({ speak: async () => ({ audio: null, mimeType: '' }) }))
vi.mock('../../talk/talk-turn', () => ({
  recordTalkTurn: vi.fn(),
  runTalk: async (_id: string, text: string, start: { events: { runOnComputer: (t: string, s: string) => Promise<{ error?: string }> } }) => {
    const r = await start.events.runOnComputer(text, 'computer-chat')
    return { kind: 'computer', ok: !r.error, reply: r.error ?? '', target: '', sessionId: 'computer-chat' }
  }
}))
vi.mock('../../companion-orchestrator', () => ({
  runCompanionAskTurn: async (text: string, sessionId: string, recipe?: string) => ({
    answeredBy: { backend: 'claude', model: 'm', label: 'm' },
    ...(await askTurn(text, sessionId, recipe))
  }),
  speakCompanionReply: (text: string) => speak(text),
  abortCompanionTurn: () => abort()
}))
vi.mock('../segmented-listen', () => ({ transcribeSegment: vi.fn() }))

import { runLiveTurnFromText, stopLiveTurn } from '../live-listen'
import { CONFIG } from '../../../shared/config'

function card(actionId: string, preselected = true): unknown {
  return { proposals: [{ proposalId: 'p1', actionId, preselected, title: 'Quick', chips: [] }] }
}

beforeEach(() => {
  askTurn.mockReset()
  speak.mockReset()
  abort.mockReset()
  proposeActions.mockReset()
  runProposal.mockReset()
  speak.mockResolvedValue({ audio: null, mimeType: '' })
  askTurn.mockResolvedValue({ ok: true, reply: 'done', sessionId: 's1' })
  proposeActions.mockResolvedValue(null)
})

describe('quick action vs agent routing', () => {
  it('sends "can you fill in the post in my vibe" to the agent instead of typing it', async () => {
    proposeActions.mockResolvedValue(card('input.type'))

    await runLiveTurnFromText('can you fill in the post in my vibe')

    expect(runProposal).not.toHaveBeenCalled()
    expect(askTurn).toHaveBeenCalledTimes(1)
    expect(askTurn.mock.calls[0][0]).toBe('can you fill in the post in my vibe')
  })

  it('still types plain dictation with the quick action', async () => {
    proposeActions.mockResolvedValue(card('input.type'))
    runProposal.mockResolvedValue({ ok: true, line: 'Typed it' })

    const result = await runLiveTurnFromText('see you at five')

    expect(runProposal).toHaveBeenCalledTimes(1)
    expect(askTurn).not.toHaveBeenCalled()
    expect(result.ok).toBe(true)
  })

  it('hands a long request to the agent after its quick opening action', async () => {
    const said = 'open Google Docs with a new document about our trip to Japan next spring'
    proposeActions.mockResolvedValue(card('app.open'))
    runProposal.mockResolvedValue({ ok: true, line: 'Opened Google Docs' })

    await runLiveTurnFromText(said)

    expect(runProposal).toHaveBeenCalledTimes(1)
    expect(askTurn).toHaveBeenCalledTimes(1)
    expect(askTurn.mock.calls[0][0]).toBe(`${said} (already done: Opened Google Docs)`)
  })

  it('finishes a short request on the quick action alone', async () => {
    proposeActions.mockResolvedValue(card('app.open'))
    runProposal.mockResolvedValue({ ok: true, line: 'Opened Safari' })

    await runLiveTurnFromText('open Safari')

    expect(askTurn).not.toHaveBeenCalled()
  })
})

describe('writing recipe', () => {
  it('gives a writing ask the compose recipe', async () => {
    await runLiveTurnFromText('write a reply to this email')
    expect(askTurn.mock.calls[0][2]).toBe(CONFIG.SYSTEM_PROMPT_COMPOSE)
  })

  it('gives any other ask no recipe', async () => {
    await runLiveTurnFromText('what is on my screen')
    expect(askTurn.mock.calls[0][2]).toBeUndefined()
  })
})

describe('stop always stops', () => {
  it('drops the answer of a run stopped while the agent was working', async () => {
    let finish: (v: unknown) => void = () => {}
    askTurn.mockReturnValue(new Promise((r) => (finish = r)))

    const pending = runLiveTurnFromText('summarize this page')
    await vi.waitFor(() => expect(askTurn).toHaveBeenCalled())
    stopLiveTurn()
    finish({ ok: true, reply: 'Here is the summary', sessionId: 's9' })
    const result = await pending

    expect(abort).toHaveBeenCalled()
    expect(speak).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: false, error: 'stopped' })
  })

  it('never starts the agent when stopped during the quick action', async () => {
    let finishQuick: (v: unknown) => void = () => {}
    proposeActions.mockReturnValue(new Promise((r) => (finishQuick = r)))

    const pending = runLiveTurnFromText('summarize this page')
    await vi.waitFor(() => expect(proposeActions).toHaveBeenCalled())
    stopLiveTurn()
    finishQuick(null)
    const result = await pending

    expect(askTurn).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: false, error: 'stopped' })
  })
})

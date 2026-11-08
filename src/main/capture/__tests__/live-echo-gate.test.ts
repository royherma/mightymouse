import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  heard: '',
  draft: '',
  paused: false,
  hideoutOpen: false,
  ask: vi.fn(),
  abort: vi.fn(),
  transcribe: vi.fn(),
  hideoutTurn: vi.fn()
}))

vi.mock('../../companion-window', () => ({
  sendCompanionStageEvent: vi.fn(),
  sendToCompanion: vi.fn(),
  isCompanionMicPaused: () => h.paused
}))
vi.mock('../../companion-orchestrator', () => ({
  runCompanionAskTurn: async (text: string, sessionId: string) => ({ answeredBy: { backend: 'claude', model: 'm', label: 'm' }, ...(await h.ask(text, sessionId)) }),
  speakCompanionReply: async () => ({ audio: null, mimeType: '' }),
  abortCompanionTurn: () => h.abort()
}))
vi.mock('../segmented-listen', () => ({
  transcribeSegment: async () => {
    h.transcribe()
    return { ok: true, text: h.heard, wordCount: h.heard.split(' ').length, tookMs: 1 }
  },
  transcribeDraftSegment: async () => h.draft
}))
vi.mock('../../actions/engine', () => ({
  proposeActions: async () => null,
  runProposal: vi.fn(),
  expireProposals: vi.fn(),
  primeActions: vi.fn()
}))
vi.mock('../../actions/capabilities/system', () => ({ quickOpenApp: async () => null, SCREEN_ACTION_ID: 'system.screen' }))
vi.mock('../../actions/decide-transport', () => ({ warmJev: () => {}, takeJevInputTokens: () => 0 }))
vi.mock('../../sound-window', () => ({ playSound: vi.fn() }))
vi.mock('../../hideout', () => ({
  isHideoutOpen: () => h.hideoutOpen,
  isHideoutPaused: () => false,
  recordHideoutTurn: vi.fn(),
  runHideoutTurn: (said: string, addressed: boolean) => h.hideoutTurn(said, addressed),
  setHideoutWords: vi.fn(),
  showHideoutTurn: vi.fn()
}))
vi.mock('../../audio/tts', () => ({ speak: async () => ({ audio: null, mimeType: '' }) }))

import { runLiveDraft, runLiveTurn, setLiveSession } from '../live-listen'

const WAV = new Uint8Array([1])
const REPLY = 'Your build\npassed on main'
const say = (text: string, echo = REPLY) => {
  h.heard = text
  return runLiveTurn(WAV, echo)
}

beforeEach(() => {
  setLiveSession(undefined)
  h.paused = false
  h.hideoutOpen = false
  for (const fn of [h.ask, h.abort, h.transcribe, h.hideoutTurn]) fn.mockReset()
  h.ask.mockResolvedValue({ ok: true, reply: 'Sure.', sessionId: 's1' })
  h.hideoutTurn.mockImplementation(async (said: string) =>
    h.hideoutOpen ? { commands: 1, hops: [], result: { ok: true, transcript: said, reply: 'ok' } } : null
  )
})

describe('the companion does not answer its own voice', () => {
  it('its reply heard back through the mic is dropped, and nothing is cut off', async () => {
    expect(await say('passed on main.')).toMatchObject({ ok: false, ignored: true, error: 'own voice' })
    expect(h.ask).not.toHaveBeenCalled()
    expect(h.abort).not.toHaveBeenCalled()
  })

  it('the wake word is never stripped as echo', async () => {
    await say('Hey Mighty, passed on main')
    expect(h.ask).toHaveBeenCalledWith('passed on main', undefined)
  })

  it('"stop" still stops even when the reply was saying it', async () => {
    const result = await say('stop', 'Please\nstop')
    expect(result).toMatchObject({ error: 'stopped' })
    expect(h.abort).toHaveBeenCalledTimes(1)
  })

  it('in the Hideout, only your words over the reply reach the planner', async () => {
    h.hideoutOpen = true
    await say("passed on main what's running")
    expect(h.hideoutTurn).toHaveBeenCalledWith("what's running", true)
  })

  it('a paused mic ignores the clip without transcribing it', async () => {
    h.paused = true
    expect(await say('Hey Mighty, open Safari')).toMatchObject({ ignored: true, error: 'paused' })
    expect(h.transcribe).not.toHaveBeenCalled()
  })

  it('live words drop the echo too, unless they carry the name', async () => {
    h.draft = 'passed on main'
    expect((await runLiveDraft(WAV, REPLY)).text).toBe('')
    h.draft = 'hey Mighty passed on main'
    expect((await runLiveDraft(WAV, REPLY)).text).toBe('hey Mighty passed on main')
  })
})

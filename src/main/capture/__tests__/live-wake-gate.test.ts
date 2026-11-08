import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  heard: '',
  draft: '',
  ask: vi.fn(),
  abort: vi.fn(),
  quick: vi.fn(),
  propose: vi.fn(),
  runProposal: vi.fn(),
  expire: vi.fn(),
  prime: vi.fn(),
  sound: vi.fn()
}))

vi.mock('../../companion-window', () => ({ sendCompanionStageEvent: vi.fn(), sendToCompanion: vi.fn(), isCompanionMicPaused: () => false }))
vi.mock('../../companion-orchestrator', () => ({
  runCompanionAskTurn: async (text: string, sessionId: string) => ({ answeredBy: { backend: 'claude', model: 'm', label: 'm' }, ...(await h.ask(text, sessionId)) }),
  speakCompanionReply: async () => ({ audio: null, mimeType: '' }),
  abortCompanionTurn: () => h.abort()
}))
vi.mock('../segmented-listen', () => ({
  transcribeSegment: async () => ({ ok: true, text: h.heard, wordCount: h.heard.split(' ').length }),
  transcribeDraftSegment: async () => h.draft
}))
vi.mock('../../actions/engine', () => ({
  proposeActions: (...a: unknown[]) => h.propose(...a),
  runProposal: (...a: unknown[]) => h.runProposal(...a),
  expireProposals: (...a: unknown[]) => h.expire(...a),
  primeActions: (...a: unknown[]) => h.prime(...a)
}))
vi.mock('../../actions/capabilities/system', () => ({ quickOpenApp: (s: string) => h.quick(s), SCREEN_ACTION_ID: 'system.screen' }))
vi.mock('../../actions/decide-transport', () => ({ warmJev: () => {}, takeJevInputTokens: () => 0 }))
vi.mock('../../sound-window', () => ({ playSound: (name: string) => h.sound(name) }))
vi.mock('../../hideout', () => ({ isHideoutOpen: () => false, isHideoutPaused: () => false, recordHideoutTurn: vi.fn(), runHideoutTurn: async () => null, setHideoutWords: vi.fn(), showHideoutTurn: vi.fn() }))
vi.mock('../../audio/tts', () => ({ speak: async () => ({ audio: null, mimeType: '' }) }))

import { CONFIG } from '../../../shared/config'
import { runLiveDraft, runLiveTurn, setLiveSession } from '../live-listen'

const WAV = new Uint8Array([1])
const say = (text: string) => {
  h.heard = text
  return runLiveTurn(WAV)
}
const later = (ms: number) => vi.setSystemTime(Date.now() + ms)
let clock = Date.now()

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  clock += 3_600_000
  vi.setSystemTime(clock)
  setLiveSession(undefined)
  for (const fn of [h.ask, h.abort, h.quick, h.propose, h.runProposal, h.expire, h.prime, h.sound]) fn.mockReset()
  h.ask.mockResolvedValue({ ok: true, reply: 'Sure.', sessionId: 's1' })
  h.quick.mockResolvedValue(null)
  h.propose.mockResolvedValue(null)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('voice mode only acts when addressed', () => {
  it('ignores speech without the name and does not cut off a running turn', async () => {
    const result = await say('So I was telling him about the meeting.')
    expect(result).toMatchObject({ ok: false, ignored: true, error: 'not addressed' })
    expect(h.ask).not.toHaveBeenCalled()
    expect(h.abort).not.toHaveBeenCalled()
  })

  it('strips the name, stops the old run, and asks with the rest', async () => {
    await say('Hey Mighty, what is on my calendar?')
    expect(h.abort).toHaveBeenCalledTimes(1)
    expect(h.ask).toHaveBeenCalledWith('what is on my calendar?', undefined)
  })

  it('"stop" stops the run even without the name', async () => {
    const result = await say('stop')
    expect(result).toMatchObject({ ok: false, error: 'stopped' })
    expect(h.abort).toHaveBeenCalledTimes(1)
    expect(h.ask).not.toHaveBeenCalled()
  })

  it('the name alone arms the next sentence, which then runs without the name', async () => {
    expect(await say('Hey Mighty.')).toMatchObject({ ignored: true, error: 'armed' })
    later(CONFIG.COMPANION.WAKE_ARM_MS - 1000)
    await say('what is the weather tomorrow')
    expect(h.ask).toHaveBeenCalledWith('what is the weather tomorrow', undefined)
  })

  it('the arm runs out after the window', async () => {
    await say('Hey Mighty.')
    later(CONFIG.COMPANION.WAKE_ARM_MS + 1000)
    expect(await say('what is the weather tomorrow')).toMatchObject({ ignored: true, error: 'not addressed' })
  })

  it('an arm is used once: the sentence after a failed armed turn needs the name again', async () => {
    h.ask.mockResolvedValue({ ok: false, reply: '', error: 'timeout', sessionId: 's1' })
    await say('Hey Mighty.')
    await say('what is the weather')
    expect(h.ask).toHaveBeenCalledTimes(1)
    expect(await say('and tomorrow')).toMatchObject({ ignored: true })
  })

  it('a successful turn keeps listening for a follow-up, then goes quiet', async () => {
    await say('Hey Mighty, what time is it')
    later(CONFIG.COMPANION.FOLLOW_UP_MS - 1000)
    await say('and in Tokyo')
    expect(h.ask).toHaveBeenLastCalledWith('and in Tokyo', 's1')
    later(CONFIG.COMPANION.FOLLOW_UP_MS + 1000)
    expect(await say('nice weather huh')).toMatchObject({ ignored: true })
    expect(h.ask).toHaveBeenCalledTimes(2)
  })
})

describe('fast actions run before the agent', () => {
  const opened = (app: string) => ({ app, run: async () => ({ ok: true, line: `Opened ${app}` }) })

  it('every clause handled fast: no agent call, one chime, lines joined', async () => {
    h.quick.mockImplementation(async (s: string) => (s === 'open Safari' ? opened('Safari') : s === 'open Notes' ? opened('Notes') : null))
    const result = await say('Hey Mighty, open Safari and open Notes')
    expect(h.ask).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: true, reply: 'Opened Safari · Opened Notes' })
    expect(h.sound).toHaveBeenCalledWith('success')
  })

  it('a clause the fast path cannot do goes to the agent with what was already done', async () => {
    h.quick.mockImplementation(async (s: string) => (s === 'open Safari' ? opened('Safari') : null))
    await say('Hey Mighty, open Safari and go to example.com')
    expect(h.ask).toHaveBeenCalledWith('open Safari and go to example.com (already done: Opened Safari)', undefined)
  })

  it('runs a preselected matched action, and expires a card nobody preselected', async () => {
    h.propose.mockResolvedValueOnce({ proposals: [{ proposalId: 'p1', preselected: true, title: 'Mute', chips: [] }] })
    h.runProposal.mockResolvedValueOnce({ ok: true, line: 'Muted' })
    expect(await say('Hey Mighty, mute')).toMatchObject({ ok: true, reply: 'Muted' })
    expect(h.ask).not.toHaveBeenCalled()

    later(60_000)
    h.propose.mockResolvedValueOnce({ proposals: [{ proposalId: 'p2', preselected: false, title: 'Maybe', chips: [] }] })
    await say('Hey Mighty, tidy my desktop')
    const runId = h.propose.mock.calls[1][0]
    expect(h.expire).toHaveBeenCalledWith(runId)
    expect(h.ask).toHaveBeenCalledWith('tidy my desktop', undefined)
  })
})

describe('live words while talking', () => {
  it('hearing the name warms the action list and chimes once per window', async () => {
    h.draft = 'hey Mighty open'
    expect(await runLiveDraft(WAV)).toEqual({ text: 'hey Mighty open', addressed: true })
    await runLiveDraft(WAV)
    expect(h.prime).toHaveBeenCalledWith('voice')
    expect(h.sound.mock.calls.filter(([n]) => n === 'record-start')).toHaveLength(1)
    later(CONFIG.COMPANION.WAKE_ARM_MS + 1000)
    await runLiveDraft(WAV)
    expect(h.sound.mock.calls.filter(([n]) => n === 'record-start')).toHaveLength(2)
  })

  it('unaddressed words warm nothing', async () => {
    h.draft = 'so anyway the meeting'
    expect(await runLiveDraft(WAV)).toEqual({ text: 'so anyway the meeting', addressed: false })
    expect(h.prime).not.toHaveBeenCalled()
    expect(h.sound).not.toHaveBeenCalled()
  })
})

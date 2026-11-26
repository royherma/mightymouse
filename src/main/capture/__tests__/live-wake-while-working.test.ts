import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  heard: '',
  ask: vi.fn(),
  abort: vi.fn(),
  speak: vi.fn(),
  stage: vi.fn()
}))

vi.mock('../../companion-window', () => ({ sendCompanionStageEvent: (e: unknown) => h.stage(e), sendToCompanion: vi.fn(), isCompanionMicPaused: () => false }))
vi.mock('../../talk/talk-turn', () => ({
  recordTalkTurn: () => {},
  runTalk: async (_id: string, text: string, start: { events: { runOnComputer: (t: string, s: string) => Promise<{ error?: string }> } }) => {
    const r = await start.events.runOnComputer(text, 'computer-chat')
    return { kind: 'computer', ok: !r.error, reply: r.error ?? '', target: '', sessionId: 'computer-chat' }
  }
}))
vi.mock('../../companion-orchestrator', () => ({
  runCompanionAskTurn: async (text: string, sessionId: string) => ({ answeredBy: { backend: 'claude', model: 'm', label: 'm' }, ...(await h.ask(text, sessionId)) }),
  speakCompanionReply: (text: string) => h.speak(text),
  abortCompanionTurn: () => h.abort()
}))
vi.mock('../segmented-listen', () => ({
  transcribeSegment: async () => ({ ok: true, text: h.heard, wordCount: h.heard.split(' ').length }),
  transcribeDraftSegment: async () => ''
}))
vi.mock('../../actions/engine', () => ({ proposeActions: async () => null, runProposal: vi.fn(), expireProposals: vi.fn(), primeActions: vi.fn() }))
vi.mock('../../actions/capabilities/system', () => ({ quickOpenApp: async () => null, SCREEN_ACTION_ID: 'system.screen' }))
vi.mock('../../actions/decide-transport', () => ({ warmJev: () => {}, takeJevInputTokens: () => 0 }))
vi.mock('../../sound-window', () => ({ playSound: vi.fn() }))
vi.mock('../../hideout', () => ({ isHideoutOpen: () => false, isHideoutPaused: () => false, recordHideoutTurn: vi.fn(), runHideoutTurn: async () => null, setHideoutWords: vi.fn(), showHideoutTurn: vi.fn() }))
vi.mock('../../audio/tts', () => ({ speak: async () => ({ audio: null, mimeType: '' }) }))

import { CONFIG } from '../../../shared/config'
import { WAKE_EVENT } from '../../../shared/companion-debug'
import { runLiveTurn, setLiveSession } from '../live-listen'

const WAV = new Uint8Array([1])
const say = (text: string) => {
  h.heard = text
  return runLiveTurn(WAV)
}
const later = (ms: number) => vi.setSystemTime(Date.now() + ms)
const wakeEvents = (): string[] =>
  h.stage.mock.calls.map(([e]) => e as { stage: string; detail?: string }).filter((e) => e.stage === 'wake').map((e) => e.detail ?? '')
let clock = Date.now()

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  clock += 3_600_000
  vi.setSystemTime(clock)
  setLiveSession(undefined)
  for (const fn of [h.ask, h.abort, h.speak, h.stage]) fn.mockReset()
  h.ask.mockResolvedValue({ ok: true, reply: 'Sure.', sessionId: 's1' })
  h.speak.mockResolvedValue({ audio: null, mimeType: '' })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('"Hey Mighty, stop"', () => {
  it('stops instead of starting a turn', async () => {
    const result = await say('Hey Mighty, stop.')

    expect(result).toMatchObject({ ok: false, error: 'stopped' })
    expect(h.ask).not.toHaveBeenCalled()
    expect(h.abort).toHaveBeenCalled()
    expect(wakeEvents()).toEqual([WAKE_EVENT.stop])
  })
})

describe('talking to a running turn without the name', () => {
  it('"no, the other tab" redirects the running turn and drops its answer', async () => {
    let finishFirst: (v: unknown) => void = () => {}
    h.ask.mockReturnValueOnce(new Promise((r) => (finishFirst = r)))
    const first = say('Hey Mighty, open my newest email')
    await vi.waitFor(() => expect(h.ask).toHaveBeenCalledTimes(1))

    const second = await say('no, the other tab')
    finishFirst({ ok: true, reply: 'Opened it.', sessionId: 's1' })

    expect(h.ask.mock.calls.at(-1)?.[0]).toBe('no, the other tab')
    expect(second).toMatchObject({ ok: true, reply: 'Sure.' })
    expect(await first).toMatchObject({ ok: false, error: 'stopped' })
  })

  it('the same words with nothing running are ignored', async () => {
    expect(await say('no, the other tab')).toMatchObject({ ignored: true, error: 'not addressed' })
    expect(h.ask).not.toHaveBeenCalled()
  })

  it('chatter that is not a correction is still ignored while a turn runs', async () => {
    let finishFirst: (v: unknown) => void = () => {}
    h.ask.mockReturnValueOnce(new Promise((r) => (finishFirst = r)))
    const first = say('Hey Mighty, open my newest email')
    await vi.waitFor(() => expect(h.ask).toHaveBeenCalledTimes(1))

    expect(await say('so I told him about the meeting')).toMatchObject({ ignored: true })
    finishFirst({ ok: true, reply: 'Opened it.', sessionId: 's1' })
    expect(await first).toMatchObject({ ok: true })
  })
})

describe('follow-up window opens when the spoken reply ends', () => {
  it('keeps listening for a follow-up through a long spoken reply', async () => {
    h.speak.mockResolvedValue({ audio: 'b64', mimeType: 'audio/mpeg', words: [{ w: 'Sure', s: 0, e: 20 }] })
    await say('Hey Mighty, read me the news')

    later(20_000 + CONFIG.COMPANION.FOLLOW_UP_MS - 1000)
    h.speak.mockResolvedValue({ audio: null, mimeType: '' })
    await say('and the weather')
    expect(h.ask).toHaveBeenLastCalledWith('and the weather', 's1')
  })

  it('still closes once the reply and the follow-up window are over', async () => {
    h.speak.mockResolvedValue({ audio: 'b64', mimeType: 'audio/mpeg', words: [{ w: 'Sure', s: 0, e: 20 }] })
    await say('Hey Mighty, read me the news')

    later(20_000 + CONFIG.COMPANION.FOLLOW_UP_MS + 1000)
    expect(await say('and the weather')).toMatchObject({ ignored: true })
  })
})

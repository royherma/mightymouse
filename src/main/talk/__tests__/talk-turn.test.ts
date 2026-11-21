import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TalkDecision } from '../../../shared/talk'

const h = vi.hoisted(() => ({
  route: vi.fn(),
  runMighty: vi.fn(),
  abortRun: vi.fn(),
  deliver: vi.fn(),
  startNewAgent: vi.fn(),
  harness: vi.fn(),
  appendTurn: vi.fn(),
  sessions: [] as { id: string; title: string; archived?: boolean; turns: unknown[] }[]
}))

vi.mock('../talk-route', () => ({ routeTalk: (text: string) => h.route(text) }))
vi.mock('../../mighty/run-mighty', () => ({ runMighty: (req: unknown) => h.runMighty(req) }))
vi.mock('../../mighty/broadcast', () => ({ broadcastMightyTurnAppended: () => {} }))
vi.mock('../../store/prefs', () => ({ PREFS: { getLiveActs: () => false } }))
vi.mock('../../backend/runner', () => ({ abortRun: (id: string) => h.abortRun(id) }))
vi.mock('../../voice-routing/deliver-helper', () => ({ deliverToAgent: (...a: unknown[]) => h.deliver(...a) }))
vi.mock('../../voice-routing/new-agent-sink', () => ({
  defaultCodeUiHarness: () => h.harness(),
  projectRootFor: async (cwd: string) => cwd,
  startNewAgent: (...a: unknown[]) => h.startNewAgent(...a)
}))
vi.mock('../../ipc/voice-routing', () => ({ reasonText: () => 'the CLI is missing' }))
vi.mock('../../ipc/phone-remote-chat', () => ({ recordOpeningTurn: () => {} }))
vi.mock('../../store/mighty', () => ({
  MIGHTY: {
    listSessions: () => h.sessions,
    newSession: (title: string) => {
      const s = { id: `s${h.sessions.length + 1}`, title, turns: [] }
      h.sessions.push(s)
      return s
    },
    getSession: (id: string) => h.sessions.find((s) => s.id === id) ?? null,
    appendTurn: (id: string, turn: unknown) => h.appendTurn(id, turn) ?? id
  }
}))

import { cancelTalk, goTalk, isTalkSession, offerTalk, pickTalk, recordTalkTurn, runTalk, talkSession } from '../talk-turn'
import { TALK, TALK_LABELS } from '../../../shared/talk'
import { CONFIG } from '../../../shared/config'

const agentSink = { kind: 'agent', id: 'a1', label: 'api-server', session: { label: 'Fix login' } }
const freshSink = { kind: 'new-agent', id: 'n1', label: 'Docs', project: 'Docs', cwd: '/p/docs' }

const askDecision: TalkDecision = {
  auto: false,
  pick: 'a1',
  options: [
    { id: 'a1', kind: 'agent', label: 'api-server', detail: '', percent: 60 },
    { id: TALK.COMPUTER_ID, kind: 'computer', label: 'Your computer', detail: '', percent: 40 }
  ]
}

function routed(decision: TalkDecision = askDecision) {
  return {
    ...decision,
    sinks: new Map<string, unknown>([
      ['a1', agentSink],
      ['n1', freshSink]
    ]),
    screenHeader: '[on screen: Safari]\n\n'
  }
}

const start = (runOnComputer?: (t: string, s: string) => Promise<{ answer: string; sessionId: string; error?: never }>) => ({
  source: 'talk' as const,
  events: runOnComputer ? { runOnComputer } : {}
})

const shown = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

let n = 0
const nextId = (): string => `turn-${++n}`

beforeEach(() => {
  for (const fn of [h.route, h.runMighty, h.abortRun, h.deliver, h.startNewAgent, h.harness, h.appendTurn]) fn.mockReset()
  h.sessions.length = 0
  h.route.mockResolvedValue(routed())
  h.deliver.mockResolvedValue({ ok: true })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('offerTalk', () => {
  it('falls back to doing it on the computer when routing throws', async () => {
    h.route.mockRejectedValue(new Error('jev down'))
    const d = await offerTalk(nextId(), 'open Spotify', start())
    expect(d).toMatchObject({ auto: true, pick: TALK.COMPUTER_ID })
  })

  it('a second offer under the same id wins; the first one resolves to nothing', async () => {
    let release!: (v: unknown) => void
    h.route.mockReturnValueOnce(new Promise((r) => (release = r)))
    const id = nextId()
    const first = offerTalk(id, 'one', start())
    const second = await offerTalk(id, 'two', start())
    release(routed())
    expect(await first).toBeNull()
    expect(second?.pick).toBe('a1')
  })

  it('cancelling while it is still deciding drops the turn', async () => {
    let release!: (v: unknown) => void
    h.route.mockReturnValueOnce(new Promise((r) => (release = r)))
    const id = nextId()
    const offered = offerTalk(id, 'one', start())
    expect(cancelTalk(id)).toBe(true)
    release(routed())
    expect(await offered).toBeNull()
    expect(await goTalk(id, 'a1')).toBeNull()
  })
})

describe('goTalk', () => {
  it('runs the message once even when Go is tapped twice', async () => {
    const id = nextId()
    await offerTalk(id, 'fix the login bug', start())
    const [a, b] = await Promise.all([goTalk(id, 'a1'), goTalk(id, 'a1')])
    expect(h.deliver).toHaveBeenCalledTimes(1)
    expect([a, b].filter((o) => o === null)).toHaveLength(1)
  })

  it('an agent that went away is a no-helper answer, and the turn can still go elsewhere', async () => {
    const id = nextId()
    await offerTalk(id, 'fix it', start())
    expect(await goTalk(id, 'gone')).toMatchObject({ ok: false, reply: TALK_LABELS.noHelper })
    expect(await goTalk(id, 'a1')).toMatchObject({ ok: true, kind: 'agent' })
  })

  it('hands off to the agent with the screen header and records it in Computer chat', async () => {
    const id = nextId()
    await offerTalk(id, 'fix the login bug', start())
    const out = await goTalk(id, 'a1')
    expect(h.deliver).toHaveBeenCalledWith('[on screen: Safari]\n\n', 'fix the login bug', agentSink, 'paste', '')
    expect(out).toMatchObject({
      kind: 'agent',
      ok: true,
      reply: TALK_LABELS.agentHasIt,
      target: `${TALK_LABELS.done_.agent} api-server`,
      openLabel: 'Fix login'
    })
    const chat = h.sessions.find((s) => s.title === TALK.SESSION_TITLE)
    expect(h.appendTurn).toHaveBeenCalledWith(
      chat?.id,
      expect.objectContaining({ q: 'fix the login bug', a: `${TALK_LABELS.agentHasIt}\n\n_${TALK_LABELS.done_.agent} api-server_`, ok: true })
    )
  })

  it('reports a failed paste as no helper, not as success', async () => {
    h.deliver.mockResolvedValue({ ok: false })
    const id = nextId()
    await offerTalk(id, 'fix it', start())
    expect(await goTalk(id, 'a1')).toMatchObject({ ok: false, reply: TALK_LABELS.noHelper })
  })

  it('a new agent with no coding CLI installed says to install one', async () => {
    h.harness.mockReturnValue(undefined)
    const id = nextId()
    await offerTalk(id, 'write docs', start())
    expect(await goTalk(id, 'n1')).toMatchObject({ kind: 'new-agent', ok: false, reply: TALK_LABELS.noHarness })
    expect(h.startNewAgent).not.toHaveBeenCalled()
  })

  it('reuses the one Computer chat session instead of making a new one per turn', async () => {
    const run = vi.fn(async (_t: string, sessionId: string) => ({ answer: 'Opened.', sessionId }))
    for (let i = 0; i < 2; i++) {
      const id = nextId()
      await offerTalk(id, 'open Spotify', start(run))
      expect(await goTalk(id, TALK.COMPUTER_ID)).toMatchObject({ kind: 'computer', ok: true, reply: 'Opened.' })
    }
    expect(h.sessions.filter((s) => s.title === TALK.SESSION_TITLE)).toHaveLength(1)
    expect(new Set(run.mock.calls.map((c) => c[1])).size).toBe(1)
  })

  it('a stopped computer run reads Cancelled; any other failure gets its plain reason', async () => {
    const id1 = nextId()
    await offerTalk(id1, 'x', { source: 'talk', events: { runOnComputer: async () => ({ answer: '', sessionId: 's', error: 'stopped' as const }) } })
    expect(await goTalk(id1, TALK.COMPUTER_ID)).toMatchObject({ ok: false, reply: TALK_LABELS.cancelled, error: 'stopped' })
    const id2 = nextId()
    await offerTalk(id2, 'x', { source: 'talk', events: { runOnComputer: async () => ({ answer: '', sessionId: 's', error: 'timeout' as const }) } })
    expect(await goTalk(id2, TALK.COMPUTER_ID)).toMatchObject({ ok: false, reply: CONFIG.UI_LABELS.RUN_FAIL_REASON.timeout })
  })

  it('Cancel during a computer run stops that run', async () => {
    let finish!: (v: unknown) => void
    h.runMighty.mockImplementation((req: { onRunId: (id: string) => void }) => {
      req.onRunId('run-7')
      return new Promise((r) => (finish = r))
    })
    const id = nextId()
    await offerTalk(id, 'tidy my desktop', start())
    const going = goTalk(id, TALK.COMPUTER_ID)
    await vi.waitFor(() => expect(h.runMighty).toHaveBeenCalled())
    cancelTalk(id)
    expect(h.abortRun).toHaveBeenCalledWith('run-7')
    finish({ answer: '', sessionId: 's1', error: 'stopped' })
    expect(await going).toMatchObject({ ok: false, reply: TALK_LABELS.cancelled })
  })

  it('forgets the oldest turns past the history cap', async () => {
    const first = nextId()
    await offerTalk(first, 'old', start())
    for (let i = 0; i < TALK.HISTORY_MAX; i++) await offerTalk(nextId(), 'newer', start())
    expect(await goTalk(first, 'a1')).toBeNull()
  })
})

describe('runTalk', () => {
  it('goes with the tapped choice when the user picks before the wait runs out', async () => {
    const id = nextId()
    const run = vi.fn(async (_t: string, sessionId: string) => ({ answer: 'Done here.', sessionId }))
    const going = runTalk(id, 'what is on my screen', { ...start(run), waitMs: 60_000 })
    await shown()
    pickTalk(id, TALK.COMPUTER_ID)
    expect(await going).toMatchObject({ kind: 'computer', ok: true, reply: 'Done here.' })
    expect(h.deliver).not.toHaveBeenCalled()
  })

  it('goes with the top option once the wait runs out', async () => {
    vi.useFakeTimers()
    const id = nextId()
    const going = runTalk(id, 'fix the login bug', { ...start(), waitMs: 2500 })
    await vi.advanceTimersByTimeAsync(2500)
    expect(await going).toMatchObject({ kind: 'agent', ok: true })
  })

  it('Cancel while waiting for a pick runs nothing', async () => {
    const id = nextId()
    const going = runTalk(id, 'fix the login bug', { ...start(), waitMs: 60_000 })
    await shown()
    cancelTalk(id)
    expect(await going).toMatchObject({ ok: false, reply: TALK_LABELS.cancelled })
    expect(h.deliver).not.toHaveBeenCalled()
  })

  it('with only one option it goes straight away, without waiting', async () => {
    h.route.mockResolvedValue(routed({ auto: true, pick: TALK.COMPUTER_ID, options: [askDecision.options[1]] }))
    const run = vi.fn(async (_t: string, sessionId: string) => ({ answer: 'ok', sessionId }))
    const out = await runTalk(nextId(), 'open Spotify', { ...start(run), waitMs: 60_000 })
    expect(out).toMatchObject({ kind: 'computer', ok: true })
  })
})

describe('recordTalkTurn: a voice quick action saved in Computer chat', () => {
  it('keeps its steps in plain words and how long it took', () => {
    recordTalkTurn('voice', 'open spotify', 'Opened Spotify.', { steps: ['Opening Spotify', 'Pressing play'], durationMs: 900 })
    const [, saved] = h.appendTurn.mock.calls[0]
    expect(saved).toMatchObject({ source: 'voice', q: 'open spotify', a: 'Opened Spotify.', ok: true, durationMs: 900 })
    expect(saved.toolCalls).toEqual([
      { name: '', inputPreview: '', ok: true, say: 'Opening Spotify' },
      { name: '', inputPreview: '', ok: true, say: 'Pressing play' }
    ])
  })

  it('a run with no steps saves its time but no empty step list', () => {
    recordTalkTurn('voice', 'volume up', 'Done.', { steps: [], durationMs: 120 })
    const [, saved] = h.appendTurn.mock.calls[0]
    expect(saved.durationMs).toBe(120)
    expect('toolCalls' in saved).toBe(false)
  })

  it('a turn recorded without a run has neither', () => {
    recordTalkTurn('talk', 'hi', 'Hello.')
    const [, saved] = h.appendTurn.mock.calls[0]
    expect('durationMs' in saved).toBe(false)
    expect('toolCalls' in saved).toBe(false)
  })
})

describe('Start fresh: archiving Computer chat opens a new one', () => {
  it('the next Computer chat is a new session once the old one is archived', () => {
    const first = talkSession()
    expect(talkSession().id).toBe(first.id)
    h.sessions.find((s) => s.id === first.id)!.archived = true
    const fresh = talkSession()
    expect(fresh.id).not.toBe(first.id)
    expect(fresh.title).toBe(TALK.SESSION_TITLE)
    expect(isTalkSession(first.id)).toBe(false)
    expect(isTalkSession(fresh.id)).toBe(true)
  })

  it('a quick action after Start fresh lands in the new chat, not the archived one', () => {
    const first = talkSession()
    h.sessions.find((s) => s.id === first.id)!.archived = true
    recordTalkTurn('voice', 'open spotify', 'Opened Spotify.')
    expect(h.appendTurn.mock.calls[0][0]).not.toBe(first.id)
  })
})

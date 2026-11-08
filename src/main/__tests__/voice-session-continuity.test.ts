import { describe, it, expect, vi, beforeEach } from 'vitest'

// The guardrail for "voice is a mode, not a surface".
//
// Before this, a spoken turn called runBackend directly with `conversationHistory:
// []` — so ten minutes of talking produced ten unrelated single-shot asks, no
// History rows, no session, and nothing to resume. The fix is one swap: voice runs
// through runMighty like every other surface, holding the session id across turns.
//
// These tests pin the two properties that swap has to keep, because both fail
// silently — a regression still answers the user perfectly, it just quietly stops
// remembering, and nobody notices until they go looking for the conversation.
//
//   1. Turn 2 continues turn 1's session (that reuse IS voice's memory).
//   2. A FAILED turn still latches the session, so the retry lands in the same
//      conversation rather than orphaning it.

const runMighty = vi.hoisted(() => vi.fn())

vi.mock('../mighty/run-mighty', () => ({ runMighty }))

// The orchestrator's other collaborators reach into electron/AppleScript/the
// screen — stub them to nothing so the test is about session threading only.
// getLiveActs gates whether a voice turn can DRIVE the Mac. Default it OFF
// here so these tests keep asserting the plain ask path; the screen-control
// prompt has its own coverage in run-mighty-screen-control.test.ts.
vi.mock('../store/prefs', () => ({
  PREFS: { getBackend: () => 'claude', getLiveActs: () => false }
}))
vi.mock('../audio/tts', () => ({
  speak: vi.fn(async () => ({ audio: null, mimeType: 'audio/mpeg', provider: 'silent-no-key' })),
  resolvedTtsProvider: () => 'silent-no-key'
}))
vi.mock('../companion-window', () => ({ sendCompanionStageEvent: vi.fn(), setCompanionRunActive: vi.fn() }))
vi.mock('../capture/screenshot', () => ({ fireScreenshot: vi.fn() }))

import { runCompanionAskTurn } from '../companion-orchestrator'

/** One successful runMighty result landing in `sessionId`. */
function ok(sessionId: string, answer = 'Sure.'): unknown {
  return { answer, sessionId, artifacts: [] }
}

describe('voice turns are one conversation, not N single-shot asks', () => {
  beforeEach(() => {
    runMighty.mockReset()
  })

  it('runs with source "voice" so it gets the spoken-answer system prompt', async () => {
    runMighty.mockResolvedValue(ok('sess-1'))

    await runCompanionAskTurn('what is the weather')

    expect(runMighty).toHaveBeenCalledWith(expect.objectContaining({ source: 'voice' }))
  })

  it('starts a NEW session when given no session id', async () => {
    runMighty.mockResolvedValue(ok('sess-1'))

    const result = await runCompanionAskTurn('hello')

    expect(runMighty.mock.calls[0][0].sessionId).toBeUndefined()
    // The caller needs the id back — it's the only way turn 2 can continue this one.
    expect(result.sessionId).toBe('sess-1')
  })

  it('continues a session it is handed — this is what makes voice remember', async () => {
    runMighty.mockResolvedValue(ok('sess-1'))
    const first = await runCompanionAskTurn('my name is Pat')

    runMighty.mockResolvedValue(ok('sess-1', 'You said Pat.'))
    await runCompanionAskTurn('what is my name', first.sessionId)

    // runMighty replays a session's prior turns as context, so forwarding the id
    // unchanged is exactly what makes turn 2 aware of turn 1.
    expect(runMighty.mock.calls[1][0].sessionId).toBe('sess-1')
    // This function is deliberately STATELESS — the latch that remembers the id
    // between turns lives in live-listen.ts (see live-session-latch.test.ts), so
    // a companion window reload can't split one conversation into two.
    expect(runMighty.mock.calls[0][0].sessionId).toBeUndefined()
  })

  it('reports the session even when the turn FAILED, so the retry stays in it', async () => {
    // A timed-out run still wrote a (failed) turn into a real session. Dropping the
    // id here would orphan that conversation and start the retry somewhere new.
    runMighty.mockResolvedValue({
      answer: 'That took too long and timed out. Try again or narrow it down.',
      sessionId: 'sess-1',
      artifacts: [],
      error: 'timeout'
    })

    const result = await runCompanionAskTurn('something slow')

    expect(result.ok).toBe(false)
    expect(result.sessionId).toBe('sess-1')
    // The failure sentence is human copy, not a status code — it's what gets spoken.
    expect(result.reply).toMatch(/took too long/)
  })

  it('passes the transcript through as the message verbatim', async () => {
    runMighty.mockResolvedValue(ok('sess-1'))

    await runCompanionAskTurn('remind me to call mum')

    expect(runMighty.mock.calls[0][0].message).toBe('remind me to call mum')
  })
})

import { describe, it, expect } from 'vitest'
import { isPhoneChatSession, countBubbles } from '../chat-session-filter'
import type { MightySession, MightyTurn, MightyRunSource } from '../../../shared/types'

// Measured on real data 2026-07-27: 623 sessions reached the phone's picker and 561
// of them were single-bubble voice notes, so the whole first page but one duplicated
// the History sheet. These lock the two edges that make the filter safe to apply --
// a live run and a settled one-turn Q+A both survive it -- because both only show up
// on a phone mid-conversation, where nobody is watching a test suite.

function turn(q: string, a: string, source: MightyRunSource = 'listen'): MightyTurn {
  return { source, q, a, ts: '2026-07-27T09:00:00Z', ok: true, backend: '' }
}

function session(turns: MightyTurn[], runId?: string): MightySession {
  return {
    schema_version: 1,
    id: 'sid',
    created: '2026-07-27T09:00:00Z',
    updated: '2026-07-27T09:00:00Z',
    title: turns[0]?.q ?? '',
    turns,
    ...(runId !== undefined ? { runId } : {})
  }
}

describe('countBubbles', () => {
  it('counts an unanswered turn as one bubble and an answered one as two', () => {
    expect(countBubbles(session([turn('hi', '')]))).toBe(1)
    expect(countBubbles(session([turn('hi', 'hello')]))).toBe(2)
  })

  it('treats a whitespace-only answer as no answer', () => {
    expect(countBubbles(session([turn('hi', '   \n ')]))).toBe(1)
  })

  it('sums across turns', () => {
    expect(countBubbles(session([turn('a', 'b'), turn('c', '')]))).toBe(3)
  })
})

describe('isPhoneChatSession', () => {
  it('hides a lone unanswered voice note -- the 90% case', () => {
    expect(isPhoneChatSession(session([turn('remember to buy milk', '')]))).toBe(false)
  })

  it('hides a lone screenshot capture', () => {
    expect(isPhoneChatSession(session([turn('what is this', '', 'capture')]))).toBe(false)
  })

  it('keeps a one-turn ask that actually got an answer', () => {
    expect(isPhoneChatSession(session([turn('what is 2+2', '4', 'phone')]))).toBe(true)
  })

  it('keeps a multi-turn conversation', () => {
    expect(isPhoneChatSession(session([turn('a', 'b'), turn('c', 'd')]))).toBe(true)
  })

  it('keeps a RUNNING session whose answer has not landed yet', () => {
    // The reason the filter reads runId at all: mid-flight this is one bubble, and
    // dropping it would make the thread the user just started vanish until it
    // finished -- the worst possible moment to hide a row.
    expect(isPhoneChatSession(session([turn('do the thing', '', 'phone')], 'run-1'))).toBe(true)
  })

  it('hides an empty session even when it carries a title', () => {
    // listSessions keeps these (a scheduled job's placeholder); the phone should not
    // show a thread with nothing in it.
    const s = session([])
    s.title = 'Morning report (scheduled)'
    expect(isPhoneChatSession(s)).toBe(false)
  })
})

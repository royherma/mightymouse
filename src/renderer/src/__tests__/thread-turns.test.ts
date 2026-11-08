import { describe, it, expect } from 'vitest'
import { visibleThreadTurns } from '../thread-turns'
import type { MightyTurn } from '../../../shared/types'

const turn = (q: string, a: string): MightyTurn => ({
  source: 'chat',
  q,
  a,
  ts: '2026-07-27T12:00:00.000Z',
  ok: true,
  backend: 'claude'
})

// The panel draws its in-flight question from lastSentRef, while main publishes that
// same question to the store the moment the run starts. Both rendered = the question
// appears twice (real bug, 2026-07-27).
describe('visibleThreadTurns', () => {
  it('hides the store copy of the turn the pending bubble is showing', () => {
    const turns = [turn('first', 'answer'), turn('in flight', '')]
    expect(visibleThreadTurns(turns, true)).toEqual([turns[0]])
  })

  it('keeps an unanswered turn when nothing else is rendering it', () => {
    // A run started elsewhere (Mighty, a hotkey) that we merely bound to: no pending
    // bubble is drawing it, so dropping it would blank the question entirely.
    const turns = [turn('bound elsewhere', '')]
    expect(visibleThreadTurns(turns, false)).toEqual(turns)
  })

  it('keeps every answered turn while a NEW question is pending', () => {
    // The follow-up case from the bug report: prior turns must survive the dedup.
    const turns = [turn('q1', 'a1'), turn('q2', 'a2')]
    expect(visibleThreadTurns(turns, true)).toEqual(turns)
  })

  it('restores the turn once the answer lands', () => {
    // resolveTurn patches `a` in place, so the same turn stops being dropped —
    // this is what makes the handoff from pending bubble to real bubble seamless.
    const turns = [turn('q', 'now answered')]
    expect(visibleThreadTurns(turns, true)).toEqual(turns)
  })

  it('handles an empty thread', () => {
    expect(visibleThreadTurns([], true)).toEqual([])
  })
})

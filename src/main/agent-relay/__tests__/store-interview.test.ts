/**
 * a multi-question ask BUFFERS answers and settles exactly once, at
 * the end. The N=1 contract is unchanged -- the first two tests are here to
 * fail loudly if buffering ever leaks into the single-question path.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { RelayQuestion } from '../../../shared/relay-interview'

const TEST_ROOT = join(tmpdir(), 'mm-agent-relay-interview-test')

vi.mock('../../store/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/paths')>()
  return {
    ...actual,
    PATHS: {
      ...actual.PATHS,
      ROOT: TEST_ROOT,
      AGENT_RELAY_LOG: join(TEST_ROOT, 'agent-relay-log.jsonl')
    }
  }
})

const THREE: RelayQuestion[] = [
  { question: 'one', options: ['a', 'b'] },
  { question: 'two', options: ['c', 'd'] },
  { question: 'three', options: ['e', 'f'] }
]

describe('agent-relay multi-question interview', () => {
  let mod: typeof import('../store')

  beforeEach(async () => {
    rmSync(TEST_ROOT, { recursive: true, force: true })
    mkdirSync(TEST_ROOT, { recursive: true })
    vi.useFakeTimers()
    vi.resetModules()
    mod = await import('../store')
  })

  afterEach(() => {
    mod.relayRequestStore.resetForTests()
    vi.useRealTimers()
    rmSync(TEST_ROOT, { recursive: true, force: true })
  })

  const mintThree = (): ReturnType<typeof mod.relayRequestStore.mint> =>
    mod.relayRequestStore.mint('ask', {
      question: THREE[0].question,
      options: THREE[0].options,
      questions: THREE
    })

  it('N=1 still settles on the FIRST answer -- the contract that must not change', () => {
    const req = mod.relayRequestStore.mint('ask', { question: 'one', options: ['a', 'b'] })
    expect(mod.relayRequestStore.resolve(req.id, { answer: 'a' }, null, 'chip')).toBe('resolved')
    expect(req.status).toBe('resolved')
    expect(req.buffered).toEqual([])
  })

  it('holds each answer and leaves the request PENDING until the last one', () => {
    const req = mintThree()

    expect(mod.relayRequestStore.resolve(req.id, { answer: 'a' }, null, 'chip')).toBe('buffered')
    expect(req.status).toBe('pending')
    expect(mod.relayRequestStore.resolve(req.id, { answer: 'c' }, null, 'chip')).toBe('buffered')
    expect(req.status).toBe('pending')

    // The third completes it: one settle, at the end.
    expect(mod.relayRequestStore.resolve(req.id, { answer: 'e' }, null, 'chip')).toBe('resolved')
    expect(req.status).toBe('resolved')
    expect(req.buffered.map((b) => b.answer)).toEqual(['a', 'c', 'e'])
  })

  it("settles carrying question 0's answer, so single-question readers keep working", () => {
    const req = mintThree()
    for (const answer of ['a', 'c', 'e']) {
      mod.relayRequestStore.resolve(req.id, { answer }, null, 'chip')
    }
    expect(req.response?.answer).toBe('a')
  })

  it('honours an explicit questionIndex -- the card states its own cursor', () => {
    const req = mintThree()
    // The card jumps to Q3 (the lock screen already took Q1 in the real flow).
    mod.relayRequestStore.resolve(req.id, { answer: 'e', questionIndex: 2 }, null, 'chip')
    expect(req.buffered).toEqual([{ index: 2, answer: 'e' }])
    expect(req.status).toBe('pending')
  })

  it('keeps the FIRST answer per index when two surfaces race', () => {
    const req = mintThree()
    mod.relayRequestStore.resolve(req.id, { answer: 'phone', questionIndex: 0 }, null, 'chip')
    mod.relayRequestStore.resolve(req.id, { answer: 'hud', questionIndex: 0 }, null, 'chip')
    expect(req.buffered).toEqual([{ index: 0, answer: 'phone' }])
  })

  // A race and a revision are the same shape on the wire, so the surface that
  // navigated back has to SAY so -- the store must never infer it from timing.
  it('overwrites the held answer only when the surface declares a revision', () => {
    const req = mintThree()
    mod.relayRequestStore.resolve(req.id, { answer: 'phone', questionIndex: 0 }, null, 'chip')
    mod.relayRequestStore.resolve(
      req.id,
      { answer: 'changed', questionIndex: 0, revise: true },
      null,
      'chip'
    )
    expect(req.buffered).toEqual([{ index: 0, answer: 'changed' }])
  })

  // The dangerous case: revising the LAST question satisfies isComplete, which
  // would fire the burst out from under someone still stepping through.
  // The dangerous case: the LAST question is already held, so re-answering it
  // satisfies isComplete and would fire the burst out from under someone who
  // only stepped back to change an answer.
  it('a revision never settles the request, even when it completes the set', () => {
    const req = mintThree()
    // Q1 and Q3 held, Q2 still open -- reachable in the real flow because the
    // lock screen and the phone card answer independently.
    mod.relayRequestStore.resolve(req.id, { answer: 'a', questionIndex: 0 }, null, 'chip')
    mod.relayRequestStore.resolve(req.id, { answer: 'e', questionIndex: 2 }, null, 'chip')
    expect(req.status).toBe('pending')

    // Revising Q3 leaves the set exactly as incomplete as it was.
    expect(
      mod.relayRequestStore.resolve(
        req.id,
        { answer: 'f', questionIndex: 2, revise: true },
        null,
        'chip'
      )
    ).toBe('buffered')
    expect(req.status).toBe('pending')
    expect(req.buffered).toEqual([
      { index: 0, answer: 'a' },
      { index: 2, answer: 'f' }
    ])

    // Filling the gap is what settles it -- and it carries the revision.
    expect(mod.relayRequestStore.resolve(req.id, { answer: 'c', questionIndex: 1 }, null, 'chip')).toBe(
      'resolved'
    )
    expect(req.buffered.map((b) => b.answer)).toEqual(['a', 'c', 'f'])
  })

  // The "Send my answers" button is what makes a revision recoverable: it
  // re-sends the held last answer WITHOUT revise, so it falls through to the
  // settle. Without it a revised-complete interview sits pending forever.
  it('send-all settles a set whose last resolve was a revision', () => {
    const req = mintThree()
    // Q1 and Q3 held; Q2 fills the gap LAST, which normally settles it.
    mod.relayRequestStore.resolve(req.id, { answer: 'a', questionIndex: 0 }, null, 'chip')
    mod.relayRequestStore.resolve(req.id, { answer: 'e', questionIndex: 2 }, null, 'chip')
    // ...but it arrives as a revision-marked write on an index already held,
    // so the guard holds the request open and no burst fires.
    mod.relayRequestStore.resolve(
      req.id,
      { answer: 'a2', questionIndex: 0, revise: true },
      null,
      'chip'
    )
    mod.relayRequestStore.resolve(req.id, { answer: 'c', questionIndex: 1 }, null, 'chip')
    expect(req.status).toBe('resolved')
    expect(req.buffered.map((b) => b.answer)).toEqual(['a2', 'c', 'e'])
  })

  // A stale card could otherwise hold an interview open forever by flagging
  // revise on an index nobody has answered.
  it('ignores revise on an index that is not actually held', () => {
    const req = mintThree()
    expect(
      mod.relayRequestStore.resolve(
        req.id,
        { answer: 'a', questionIndex: 0, revise: true },
        null,
        'chip'
      )
    ).toBe('buffered')
    expect(req.buffered).toEqual([{ index: 0, answer: 'a' }])
  })

  it('ignores an out-of-range index rather than growing a buffer nothing reads', () => {
    const req = mintThree()
    // Out of range falls through to a plain settle -- it must never sit in the
    // buffer, where the final burst would have no question to type it into.
    mod.relayRequestStore.resolve(req.id, { answer: 'x', questionIndex: 9 }, null, 'chip')
    expect(req.buffered).toEqual([])
    expect(req.status).toBe('resolved')
  })

  it('a dismiss still clears the whole interview, part-answered or not', () => {
    const req = mintThree()
    mod.relayRequestStore.resolve(req.id, { answer: 'a' }, null, 'chip')
    expect(mod.relayRequestStore.dismiss(req.id, null)).toBe('dismissed')
    expect(req.status).toBe('dismissed')
  })

  it('a multiSelect question buffers with valid picks, then settles with the rest (§8.2)', () => {
    const req = mod.relayRequestStore.mint('ask', {
      question: THREE[0].question,
      options: THREE[0].options,
      questions: [THREE[0], { ...THREE[1], multiSelect: true }, THREE[2]]
    })
    expect(mod.relayRequestStore.resolve(req.id, { answer: 'a' }, null, 'chip')).toBe('buffered')
    expect(
      mod.relayRequestStore.resolve(req.id, { answer: 'c, d', questionIndex: 1, picks: [0, 1] }, null, 'chip')
    ).toBe('buffered')
    expect(req.buffered).toEqual([
      { index: 0, answer: 'a' },
      { index: 1, answer: 'c, d', picks: [0, 1] }
    ])
    expect(mod.relayRequestStore.resolve(req.id, { answer: 'e' }, null, 'chip')).toBe('resolved')
    expect(req.status).toBe('resolved')
  })

  it('drops a multiSelect answer with out-of-range picks rather than buffering it', () => {
    const req = mod.relayRequestStore.mint('ask', {
      question: THREE[0].question,
      options: THREE[0].options,
      questions: [THREE[0], { ...THREE[1], multiSelect: true }, THREE[2]]
    })
    mod.relayRequestStore.resolve(req.id, { answer: 'a' }, null, 'chip')
    expect(
      mod.relayRequestStore.resolve(req.id, { answer: 'c, d', questionIndex: 1, picks: [0, 9] }, null, 'chip')
    ).toBe('buffered')
    expect(req.buffered).toEqual([{ index: 0, answer: 'a' }])
    expect(req.status).toBe('pending')
  })

  it('nudges a part-answered interview that goes quiet (§7.7)', () => {
    const req = mintThree()
    const stalled: string[] = []
    mod.onRelayStalled((r) => stalled.push(r.id))

    mod.relayRequestStore.resolve(req.id, { answer: 'a' }, null, 'chip')
    vi.advanceTimersByTime(mod.RELAY_STALL_NUDGE_MS + 100)
    expect(stalled).toEqual([req.id])

    // Answering again re-arms it: a second silence is a second nudge, because
    // the person still has questions they may not know exist.
    mod.relayRequestStore.resolve(req.id, { answer: 'c' }, null, 'chip')
    vi.advanceTimersByTime(mod.RELAY_STALL_NUDGE_MS + 100)
    expect(stalled).toEqual([req.id, req.id])
  })

  it('a finished interview never nudges', () => {
    const req = mintThree()
    const stalled: string[] = []
    mod.onRelayStalled((r) => stalled.push(r.id))
    for (const answer of ['a', 'c', 'e']) {
      mod.relayRequestStore.resolve(req.id, { answer }, null, 'chip')
    }
    vi.advanceTimersByTime(mod.RELAY_STALL_NUDGE_MS * 3)
    expect(stalled).toEqual([])
  })

  it('a dismiss cancels a pending nudge', () => {
    const req = mintThree()
    const stalled: string[] = []
    mod.onRelayStalled((r) => stalled.push(r.id))
    mod.relayRequestStore.resolve(req.id, { answer: 'a' }, null, 'chip')
    mod.relayRequestStore.dismiss(req.id, null)
    vi.advanceTimersByTime(mod.RELAY_STALL_NUDGE_MS * 3)
    expect(stalled).toEqual([])
  })

  it('a part-answered interview still times out rather than hanging', () => {
    const req = mod.relayRequestStore.mint(
      'ask',
      { question: THREE[0].question, options: THREE[0].options, questions: THREE },
      1_000
    )
    mod.relayRequestStore.resolve(req.id, { answer: 'a' }, null, 'chip')
    vi.advanceTimersByTime(1_500)
    expect(req.status).toBe('timedout')
  })
})

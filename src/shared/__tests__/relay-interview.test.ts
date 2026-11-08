import { describe, expect, it } from 'vitest'
import {
  answerableCount,
  blockFor,
  bufferAnswer,
  cursorFor,
  interviewPushSuffix,
  isComplete,
  isInterview,
  canTypeAnswer,
  interviewView,
  type RelayQuestion
} from '../relay-interview'

const Q = (question: string, extra: Partial<RelayQuestion> = {}): RelayQuestion => ({
  question,
  options: ['a', 'b'],
  ...extra
})

describe('bufferAnswer', () => {
  it('keeps the FIRST answer per index -- two surfaces racing must agree', () => {
    const once = bufferAnswer([], { index: 0, answer: 'phone' })
    const twice = bufferAnswer(once, { index: 0, answer: 'hud' })
    expect(twice).toEqual([{ index: 0, answer: 'phone' }])
  })

  it('sorts by index, so the lock screen answering Q1 late still lands first', () => {
    const out = bufferAnswer(bufferAnswer([], { index: 2, answer: 'c' }), { index: 0, answer: 'a' })
    expect(out.map((a) => a.index)).toEqual([0, 2])
  })
})

describe('cursorFor', () => {
  const three = [Q('one'), Q('two'), Q('three')]

  it('points at the first UNANSWERED question, not the count answered', () => {
    // The gap case: the lock screen answered Q1, the card opens at Q2.
    expect(cursorFor(three, [{ index: 0, answer: 'a' }])).toBe(1)
  })

  it('skips over a hole rather than counting past it', () => {
    expect(cursorFor(three, [{ index: 1, answer: 'b' }])).toBe(0)
  })

  it('returns -1 once every question is answered', () => {
    const all = three.map((_, index) => ({ index, answer: 'a' }))
    expect(cursorFor(three, all)).toBe(-1)
    expect(isComplete(three, all)).toBe(true)
  })

  it('is not complete while one is missing', () => {
    expect(isComplete(three, [{ index: 0, answer: 'a' }])).toBe(false)
  })
})

describe('blockFor', () => {
  it('allows a multiSelect question inside tmux -- picker-keys types it', () => {
    expect(blockFor([Q('one'), Q('two', { multiSelect: true })], true)).toBeNull()
  })

  it('blocks N>1 with no tmux pane -- never replay a burst blind (§5)', () => {
    expect(blockFor([Q('one'), Q('two')], false)).toBe('noPane')
  })

  it('leaves N=1 answerable with no pane: one Down+Enter needs no advancement check', () => {
    expect(blockFor([Q('one')], false)).toBeNull()
  })

  it('allows N>1 inside tmux', () => {
    expect(blockFor([Q('one'), Q('two')], true)).toBeNull()
  })
})

describe('answerableCount', () => {
  it('collects the whole array when nothing blocks', () => {
    expect(answerableCount([Q('one'), Q('two'), Q('three')], true)).toBe(3)
  })

  it('collects only Q1 when blocked, so the rest is finished on the Mac', () => {
    expect(answerableCount([Q('one'), Q('two')], false)).toBe(1)
  })
})

describe('interviewPushSuffix', () => {
  it('stays silent for a single question -- N=1 pushes read exactly as before', () => {
    expect(interviewPushSuffix(undefined)).toBeNull()
    expect(interviewPushSuffix([Q('one')])).toBeNull()
  })

  it('says TAP, because an interview push carries no buttons to press', () => {
    expect(interviewPushSuffix([Q('one'), Q('two'), Q('three')])).toBe(
      '3 questions - tap to answer.'
    )
  })

  it('counts DOWN on a nudge: what is left to do, not what was done', () => {
    const three = [Q('one'), Q('two'), Q('three')]
    expect(interviewPushSuffix(three, [{ index: 0, answer: 'a' }])).toBe(
      '2 questions - tap to answer.'
    )
    expect(
      interviewPushSuffix(three, [
        { index: 0, answer: 'a' },
        { index: 1, answer: 'c' }
      ])
    ).toBe('1 question left - tap to answer.')
  })
})

describe('isInterview', () => {
  it('is false for none or one -- N=1 keeps its lock-screen buttons', () => {
    expect(isInterview(undefined)).toBe(false)
    expect(isInterview([Q('one')])).toBe(false)
  })

  it('is true past one, which is what strips the buttons', () => {
    expect(isInterview([Q('one'), Q('two')])).toBe(true)
  })
})

describe('canTypeAnswer', () => {
  // picker-keys refuses a free answer with no pane to read, so a box offered
  // there takes input that is never typed into the picker.
  it('hides the box when chips can answer and no pane can carry free text', () => {
    expect(canTypeAnswer(false, true)).toBe(false)
  })

  it('keeps the box whenever a pane can carry it', () => {
    expect(canTypeAnswer(true, true)).toBe(true)
  })

  it('keeps the box with no chips -- an uncontrollable card is worse', () => {
    expect(canTypeAnswer(false, false)).toBe(true)
  })
})

describe('interviewView canType', () => {
  it('reads the flat options of a single question, not just questions[0]', () => {
    // N=1 carries its options beside `questions`, so without the 4th argument
    // this reads as "no chips" and wrongly keeps the box.
    expect(interviewView(undefined, undefined, false, ['a', 'b']).canType).toBe(false)
    expect(interviewView(undefined, undefined, true, ['a', 'b']).canType).toBe(true)
    expect(interviewView(undefined, undefined, false, []).canType).toBe(true)
  })

  it('follows the CURRENT question through an interview', () => {
    const qs = [Q('one'), Q('two')]
    expect(interviewView(qs, undefined, true).canType).toBe(true)
    expect(interviewView(qs, undefined, false).canType).toBe(false)
  })
})

describe('back navigation', () => {
  const three = [Q('one'), Q('two'), Q('three')]
  const held = [
    { index: 0, answer: 'a' },
    { index: 1, answer: 'b' }
  ]

  it('offers no arrows on the first question of a fresh interview', () => {
    const v = interviewView(three, [], true)
    expect(v.prevIndex).toBe(-1)
    expect(v.nextIndex).toBe(-1)
  })

  it('can step back once an earlier question has been answered', () => {
    const v = interviewView(three, held, true)
    expect(v.index).toBe(2)
    expect(v.prevIndex).toBe(1)
    // Nothing past the cursor exists yet, so forward is closed.
    expect(v.nextIndex).toBe(-1)
  })

  it('surfaces the held answer of the question being reviewed', () => {
    const v = interviewView(three, held, true, undefined, 0)
    expect(v.index).toBe(0)
    expect(v.answered).toBe('a')
    expect(v.step).toBe(1)
    expect(v.nextIndex).toBe(1)
  })

  it('clamps a stale viewIndex -- `buffered` can move under a card', () => {
    // Another surface answered nothing yet, so 2 is not reachable.
    expect(interviewView(three, [], true, undefined, 2).index).toBe(0)
    // And a negative one can never render.
    expect(interviewView(three, held, true, undefined, -5).index).toBe(0)
  })

  it('never walks forward past the cursor', () => {
    const v = interviewView(three, held, true, undefined, 99)
    expect(v.index).toBe(2)
    expect(v.nextIndex).toBe(-1)
  })
})

describe('bufferAnswer revision', () => {
  const held = [
    { index: 0, answer: 'a' },
    { index: 1, answer: 'b' }
  ]

  it('is first-answer-wins by default -- two surfaces racing must not fight', () => {
    expect(bufferAnswer(held, { index: 0, answer: 'z' })).toEqual(held)
  })

  it('replaces in place when the surface declares a revision', () => {
    expect(bufferAnswer(held, { index: 0, answer: 'z' }, true)).toEqual([
      { index: 0, answer: 'z' },
      { index: 1, answer: 'b' }
    ])
  })

  it('still appends an unheld index even under revise', () => {
    expect(bufferAnswer(held, { index: 2, answer: 'c' }, true)).toEqual([
      ...held,
      { index: 2, answer: 'c' }
    ])
  })
})

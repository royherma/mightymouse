import { describe, it, expect } from 'vitest'
import { armingKey, armedAction, rememberedValue } from '../swipe-arming'
import type { SwipeAction, SwipeCard } from '../swipe-triage'
import type { RelayRequestWire } from '../phone-remote-protocol'

const NOW = 1_786_600_000_000

function action(id: string, label: string, kind: SwipeAction['kind'] = 'chip'): SwipeAction {
  return { id, label, kind }
}

/** Only the two fields arming reads. Building a whole `SwipeCard` here would
 *  couple these tests to `buildDeck`, which has its own. */
function card(pending?: Partial<RelayRequestWire>): SwipeCard {
  return {
    label: 'a',
    session: { label: 'a', stated: 'a', pid: 1, since: NOW },
    row: { state: 'connected', repo: 'r' },
    activity: { total: 1, waiting: 0, medianReplyMs: null },
    pending: pending as RelayRequestWire | undefined,
    questionIndex: -1,
    moreQuestions: false
  } as SwipeCard
}

describe('armingKey', () => {
  it('keys on the option SHAPE, so the same question repeats across sessions', () => {
    const a = armingKey(card({ id: 'x' }), [action('opt-0', 'postgres'), action('opt-1', 'sqlite')])
    const b = armingKey(card({ id: 'y' }), [action('opt-0', 'postgres'), action('opt-1', 'sqlite')])
    expect(a).toBe(b)
    expect(a).toBeDefined()
  })

  it('ignores the order the options were asked in', () => {
    const asked = armingKey(card({ id: 'x' }), [action('opt-0', 'yes'), action('opt-1', 'no')])
    const flipped = armingKey(card({ id: 'x' }), [action('opt-0', 'no'), action('opt-1', 'yes')])
    expect(asked).toBe(flipped)
  })

  it('separates an ask from an idle card offering the same words', () => {
    const ask = armingKey(card({ id: 'x' }), [action('opt-0', 'wrap up')])
    const idle = armingKey(card(), [action('wrap', 'wrap up', 'wrap')])
    expect(ask).not.toBe(idle)
  })

  it('has no key when the only action is free text -- nothing to remember', () => {
    expect(armingKey(card(), [action('typed', 'Type your own', 'typed')])).toBeUndefined()
  })
})

describe('armedAction', () => {
  const actions = [
    action('opt-0', 'postgres'),
    action('opt-1', 'sqlite'),
    action('typed', 'Type your own', 'typed')
  ]

  it('arms the first action when nothing is remembered', () => {
    expect(armedAction(actions)?.id).toBe('opt-0')
  })

  it('arms what was picked last time for this shape', () => {
    expect(armedAction(actions, 'sqlite')?.id).toBe('opt-1')
  })

  it('falls back to the first when the remembered option is no longer offered', () => {
    expect(armedAction(actions, 'mysql')?.id).toBe('opt-0')
  })

  it('never arms "Type your own" -- an empty field is the unarmed state', () => {
    const typedOnly = [action('typed', 'Type your own', 'typed')]
    expect(armedAction(typedOnly)).toBeUndefined()
    expect(armedAction(typedOnly, 'type your own')).toBeUndefined()
  })

  it('arms nothing when the card has no actions at all', () => {
    expect(armedAction([])).toBeUndefined()
  })
})

describe('rememberedValue', () => {
  it('normalizes the same way armedAction matches, so a write survives a read', () => {
    const remembered = rememberedValue(action('opt-0', '  SQLite  '))
    expect(armedAction([action('opt-0', 'sqlite')], remembered)?.id).toBe('opt-0')
  })

  it('remembers nothing for free text -- one typed line is not a preference', () => {
    expect(rememberedValue(action('typed', 'Type your own', 'typed'))).toBeUndefined()
  })
})

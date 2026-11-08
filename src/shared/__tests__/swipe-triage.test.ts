import { describe, it, expect } from 'vitest'
import {
  buildDeck,
  actionsFor,
  affirmFor,
  pendingOptions,
  skip,
  jumpTo,
  removeCard,
  mergeDeck,
  KEEP_GOING_TEXT
} from '../swipe-triage'
import type { SwipeCard } from '../swipe-triage'
import type { RelayRequestWire, RelayVerbWire } from '../phone-remote-protocol'
import type { AgentRelaySessionInfo } from '../types'

const NOW = 1_786_600_000_000

/** `pid` by default so `sessionCanReply` is true -- a session with no way to
 *  type into it is the exception these tests opt into, not the baseline. */
function session(
  label: string,
  extra: Partial<AgentRelaySessionInfo> = {}
): AgentRelaySessionInfo {
  return { label, stated: label, pid: 4242, since: NOW - 60_000, ...extra }
}

function req(opts: {
  from: string
  verb?: RelayVerbWire
  status?: RelayRequestWire['status']
  createdAt?: number
  params?: RelayRequestWire['params']
}): RelayRequestWire {
  return {
    id: `${opts.verb ?? 'ask'}-${opts.from}-${opts.createdAt ?? NOW}`,
    verb: opts.verb ?? 'ask',
    params: { from: opts.from, ...opts.params },
    createdAt: opts.createdAt ?? NOW,
    timeoutMs: 600_000,
    status: opts.status ?? 'pending',
    response: null
  }
}

/** One resolved card, so a session counts as having spoken. `buildDeck` drops
 *  never-spoken sessions, which is its own test below -- every OTHER test here
 *  is about ordering or payloads and needs its fixtures to reach the deck. */
function spoke(from: string): RelayRequestWire {
  return req({ from, status: 'resolved', createdAt: NOW - 300_000 })
}

/** A deck of sessions that have all spoken, for the tests about ORDER. */
function deckOf(...sessions: AgentRelaySessionInfo[]): SwipeCard[] {
  return buildDeck(sessions, sessions.map((s) => spoke(s.label)), NOW)
}

/** Requests for the tests that do not supply their own. */
function cardFor(
  sessions: AgentRelaySessionInfo[],
  requests?: RelayRequestWire[]
): SwipeCard {
  return buildDeck(sessions, requests ?? sessions.map((s) => spoke(s.label)), NOW)[0]
}

describe('buildDeck', () => {
  it('sorts sessions with a pending ask ahead of idle ones', () => {
    const sessions = [session('idle', { since: NOW - 1000 }), session('blocked')]
    const requests = [
      spoke('idle'),
      req({ from: 'blocked', params: { from: 'blocked', question: 'Which db?' } })
    ]
    expect(buildDeck(sessions, requests, NOW).map((c) => c.label)).toEqual(['blocked', 'idle'])
  })

  it('drops ended sessions -- a dropped socket cannot be acted on', () => {
    expect(deckOf(session('live'), session('gone', { stale: true })).map((c) => c.label)).toEqual([
      'live'
    ])
  })

  it('drops a session that has never exchanged a card -- nothing to decide on', () => {
    const deck = buildDeck([session('spoken'), session('silent')], [spoke('spoken')], NOW)
    expect(deck.map((c) => c.label)).toEqual(['spoken'])
  })

  it('keeps a never-spoken session when it is ASKING: the question is the point', () => {
    const deck = buildDeck([session('first-timer')], [req({ from: 'first-timer' })], NOW)
    expect(deck.map((c) => c.label)).toEqual(['first-timer'])
  })

  it('keeps a spoken session that is idle now -- it still has work to nudge', () => {
    expect(deckOf(session('spoken')).map((c) => c.label)).toEqual(['spoken'])
  })

  it('ignores notify as a blocker: it resolves on mint and waits for nobody', () => {
    const requests = [req({ from: 'a', verb: 'notify' })]
    expect(cardFor([session('a')], requests).pending).toBeUndefined()
  })

  it('picks the OLDEST pending card when a session has several', () => {
    const requests = [
      req({ from: 'a', createdAt: NOW - 1000 }),
      req({ from: 'a', createdAt: NOW - 90_000 })
    ]
    expect(cardFor([session('a')], requests).pending?.createdAt).toBe(NOW - 90_000)
  })

  it('prefers a declared TLDR over a derived subject', () => {
    const requests = [req({ from: 'a', params: { from: 'a', question: 'Which db?' } })]
    const card = cardFor([session('a', { tldr: 'porting the phone list' })], requests)
    expect(card.subject).toBe('porting the phone list')
  })
})

describe('question cursor', () => {
  const questions = [
    { question: 'Which db?', options: ['postgres', 'sqlite'] },
    { question: 'Which port?', options: ['5432', '5433'] }
  ]

  it('renders the first UNANSWERED question of an interview', () => {
    const requests = [
      req({
        from: 'a',
        params: { from: 'a', questions, buffered: [{ index: 0, answer: 'postgres' }] }
      })
    ]
    const card = cardFor([session('a')], requests)
    expect(card.questionIndex).toBe(1)
    expect(pendingOptions(card)).toEqual(['5432', '5433'])
  })

  it('flags a multi-question ask so the card offers a tap-through, not options', () => {
    const requests = [req({ from: 'a', params: { from: 'a', questions } })]
    const card = cardFor([session('a')], requests)
    expect(card.moreQuestions).toBe(true)
    expect(actionsFor(card).map((a) => a.id)).toEqual([])
  })

  it('treats a single-question array as an ordinary ask', () => {
    const requests = [req({ from: 'a', params: { from: 'a', questions: [questions[0]] } })]
    const card = cardFor([session('a')], requests)
    expect(card.moreQuestions).toBe(false)
    expect(pendingOptions(card)).toEqual(['postgres', 'sqlite'])
  })
})

describe('actionsFor', () => {
  it('offers the ask options plus type-your-own, and no canned actions', () => {
    const requests = [
      req({ from: 'a', params: { from: 'a', question: 'Which db?', options: ['postgres', 'sqlite'] } })
    ]
    const actions = actionsFor(cardFor([session('a', { canWrapUp: true })], requests))
    expect(actions.map((a) => a.label)).toEqual(['postgres', 'sqlite', 'Type your own'])
  })

  it('offers exactly the canned three when nothing is pending', () => {
    const actions = actionsFor(cardFor([session('a', { canWrapUp: true })]))
    expect(actions.map((a) => a.label)).toEqual(['Keep going', 'Wrap up', 'Type your own'])
  })

  it('lets suggestions replace Keep going rather than joining it', () => {
    const actions = actionsFor(cardFor([session('a', { canWrapUp: true })]), [
      'Run the tests',
      'Show me the diff'
    ])
    expect(actions.map((a) => a.label)).toEqual([
      'Run the tests',
      'Show me the diff',
      'Wrap up',
      'Type your own'
    ])
  })

  it('sends a suggestion as its own text, not the nudge', () => {
    const card = cardFor([session('a', { canWrapUp: true })])
    const actions = actionsFor(card, ['Run the tests'])
    const affirm = affirmFor(card, actions[0])
    expect(affirm).toEqual({ kind: 'reply', label: 'a', ref: 'a', text: 'Run the tests' })
  })

  it('ignores suggestions on a card that is blocking on a question', () => {
    const requests = [req({ from: 'a', params: { from: 'a', question: 'Which db?', options: ['pg'] } })]
    const actions = actionsFor(cardFor([session('a')], requests), ['Run the tests'])
    expect(actions.map((a) => a.label)).toEqual(['pg', 'Type your own'])
  })

  it('hides Wrap up when the shim cannot report the agent pid', () => {
    const actions = actionsFor(cardFor([session('a', { canWrapUp: false })]))
    expect(actions.map((a) => a.id)).toEqual(['keep', 'typed'])
  })

  it('hides every reply action when there is no pane and no pid', () => {
    const card = cardFor([session('a', { pid: undefined, canWrapUp: true })])
    expect(actionsFor(card).map((a) => a.id)).toEqual(['wrap'])
  })

  it('renders a card with no available action at all', () => {
    const card = cardFor([session('a', { pid: undefined })])
    expect(actionsFor(card)).toEqual([])
    expect(card.label).toBe('a')
  })
})

describe('affirmFor', () => {
  const askRequests = [
    req({ from: 'a', params: { from: 'a', question: 'Which db?', options: ['postgres', 'sqlite'] } })
  ]

  it('answers a pending ask with the tapped option', () => {
    const card = cardFor([session('a')], askRequests)
    const [chip] = actionsFor(card)
    expect(affirmFor(card, chip)).toEqual({
      kind: 'respond',
      requestId: askRequests[0].id,
      questionIndex: undefined,
      answer: 'postgres',
      via: 'chip'
    })
  })

  it('offers nothing at all on a multi-question ask -- not even the canned three', () => {
    const questions = [
      { question: 'Which db?', options: ['postgres'] },
      { question: 'Which port?', options: ['5432'] }
    ]
    const requests = [
      req({
        from: 'a',
        params: { from: 'a', questions, buffered: [{ index: 0, answer: 'postgres' }] }
      })
    ]
    const card = cardFor([session('a', { canWrapUp: true })], requests)
    expect(card.questionIndex).toBe(1)
    expect(actionsFor(card)).toEqual([])
  })

  it('carries the question index when a one-question array is answered', () => {
    const questions = [{ question: 'Which db?', options: ['postgres', 'sqlite'] }]
    const requests = [req({ from: 'a', params: { from: 'a', questions } })]
    const card = cardFor([session('a')], requests)
    const affirm = affirmFor(card, actionsFor(card)[0])
    expect(affirm).toMatchObject({ kind: 'respond', questionIndex: 0, answer: 'postgres' })
  })

  it('sends typed text as an answer, not as a chip', () => {
    const card = cardFor([session('a')], askRequests)
    const typed = actionsFor(card).find((a) => a.id === 'typed')!
    expect(affirmFor(card, typed, '  mysql  ')).toMatchObject({ answer: 'mysql', via: 'typed' })
  })

  it('refuses an empty type-your-own rather than sending a blank answer', () => {
    const card = cardFor([session('a')], askRequests)
    const typed = actionsFor(card).find((a) => a.id === 'typed')!
    expect(affirmFor(card, typed, '   ')).toBeNull()
  })

  it('turns Keep going into a pane reply with the nudge text', () => {
    const card = cardFor([session('a')])
    expect(affirmFor(card, actionsFor(card)[0])).toEqual({
      kind: 'reply',
      label: 'a',
      ref: 'a',
      text: KEEP_GOING_TEXT
    })
  })

  it('turns Wrap up into a wrap for this label', () => {
    const card = cardFor([session('a', { canWrapUp: true })])
    const wrap = actionsFor(card).find((a) => a.id === 'wrap')!
    expect(affirmFor(card, wrap)).toEqual({ kind: 'wrap', label: 'a', ref: 'a' })
  })

  it('returns null for a wrap on a session that lost canWrapUp mid-deck', () => {
    const stale = cardFor([session('a', { canWrapUp: true })])
    const card: SwipeCard = { ...stale, session: { ...stale.session, canWrapUp: false } }
    expect(affirmFor(card, { id: 'wrap', label: 'Wrap up', kind: 'wrap' })).toBeNull()
  })
})

describe('deck movement', () => {
  const deck = ['a', 'b', 'c']

  it('drops a skipped card so a run of passes reaches an end', () => {
    expect(skip(deck)).toEqual(['b', 'c'])
    expect(skip(skip(skip(deck)))).toEqual([])
  })

  it('empties on the last card rather than handing it back forever', () => {
    expect(skip(['a'])).toEqual([])
    expect(skip([])).toEqual([])
  })

  it('removes an affirmed card and keeps the rest in order', () => {
    const cards = deckOf(session('a'), session('b'))
    expect(removeCard(cards, 'a').map((c) => c.label)).toEqual(['b'])
  })

  it('deals a jumped card to the top and rotates the ones it passed', () => {
    const cards = deckOf(session('a'), session('b'), session('c'))
    expect(jumpTo(cards, 'c').map((c) => c.label)).toEqual(['c', 'a', 'b'])
  })

  it('leaves the deck alone for the top card or a label that has gone', () => {
    const cards = deckOf(session('a'), session('b'))
    expect(jumpTo(cards, 'a').map((c) => c.label)).toEqual(['a', 'b'])
    expect(jumpTo(cards, 'gone').map((c) => c.label)).toEqual(['a', 'b'])
  })
})

describe('mergeDeck', () => {
  it('keeps the current order and drops sessions that ended', () => {
    const current = deckOf(session('a'), session('b'), session('c'))
    const next = deckOf(session('c'), session('a'))
    expect(mergeDeck(current, next).map((c) => c.label)).toEqual(['a', 'c'])
  })

  it('appends a newly-arrived session at the back, never under the thumb', () => {
    const current = deckOf(session('a'))
    const next = deckOf(session('new'), session('a'))
    expect(mergeDeck(current, next).map((c) => c.label)).toEqual(['a', 'new'])
  })

  it('refreshes the kept card from server state', () => {
    const current = deckOf(session('a'))
    const requests = [req({ from: 'a', params: { from: 'a', question: 'Which db?' } })]
    const next = buildDeck([session('a')], requests, NOW)
    expect(mergeDeck(current, next)[0].pending?.id).toBe(requests[0].id)
  })
})

import { describe, it, expect } from 'vitest'
import {
  groupBySender,
  levelEmoji,
  levelHeading,
  verbLabel,
  sortRequests,
  filterRequests,
  filteredEmptyNote,
  resolvedOutcome,
  resolvedWhen,
  previousList,
  viewBarVisible,
  isIdleNotify,
  sessionActivity
} from '../relay-cards'
import type { RelayRequestWire, RelayVerbWire } from '../phone-remote-protocol'

function req(id: string, createdAt: number, from?: string): RelayRequestWire {
  return {
    id,
    verb: 'ask',
    params: { question: id, from },
    createdAt,
    timeoutMs: 600_000,
    status: 'pending',
    response: null
  }
}

describe('groupBySender', () => {
  it('groups cards from the same sender together', () => {
    const groups = groupBySender([
      req('a', 1, 'repo-one/dev'),
      req('b', 2, 'repo-two/main'),
      req('c', 3, 'repo-one/dev')
    ])
    expect(groups).toHaveLength(2)
    expect(groups[0].requests.map((r) => r.id)).toEqual(['a', 'c'])
    expect(groups[1].requests.map((r) => r.id)).toEqual(['b'])
  })

  // The whole point of the ordering: whatever has blocked an agent longest is
  // answered first, so a card arriving later never pushes an older one down.
  it('orders groups and their cards oldest-first', () => {
    const groups = groupBySender([req('new', 500, 'b'), req('old', 100, 'a'), req('mid', 300, 'a')])
    expect(groups.map((g) => g.from)).toEqual(['a', 'b'])
    expect(groups[0].requests.map((r) => r.id)).toEqual(['old', 'mid'])
  })

  // An unlabelled card must still be answerable, and must not collapse into
  // whichever named group happens to be first.
  it('keeps senderless cards in their own group', () => {
    const groups = groupBySender([req('anon', 1), req('named', 2, 'repo/dev')])
    expect(groups[0].from).toBeUndefined()
    expect(groups[0].requests.map((r) => r.id)).toEqual(['anon'])
    expect(groups[1].from).toBe('repo/dev')
  })

  it('returns nothing for an empty list', () => {
    expect(groupBySender([])).toEqual([])
  })
})

describe('levelEmoji', () => {
  it('maps the three severities that carry a marker', () => {
    expect(levelEmoji('success')).toBe('✅')
    expect(levelEmoji('warn')).toBe('⚠️')
    expect(levelEmoji('error')).toBe('🛑')
  })

  it('gives info no marker', () => {
    expect(levelEmoji('info')).toBeNull()
  })

  it('gives an absent or unrecognised level no marker', () => {
    expect(levelEmoji(undefined)).toBeNull()
    expect(levelEmoji('catastrophe')).toBeNull()
  })
})

describe('levelHeading', () => {
  it('prefixes the verb label with the severity marker', () => {
    expect(levelHeading('notify', 'error')).toBe('🛑 Sent to you')
    expect(levelHeading('approve', 'warn')).toBe('⚠️ Approval needed')
  })

  it('leaves the label untouched when there is no marker', () => {
    expect(levelHeading('notify', 'info')).toBe('Sent to you')
    expect(levelHeading('notify', undefined)).toBe('Sent to you')
  })

  it('keeps the TEST badge ahead of the severity marker', () => {
    expect(levelHeading('notify', 'error', true)).toBe('[TEST] 🛑 Sent to you')
  })

  it('matches verbLabel when no level is present', () => {
    expect(levelHeading('ask', undefined, true)).toBe(verbLabel('ask', true))
  })
})

function verbReq(
  id: string,
  verb: RelayVerbWire,
  createdAt: number,
  risk?: 'high'
): RelayRequestWire {
  return {
    id,
    verb,
    params: { question: id, action: id, risk },
    createdAt,
    timeoutMs: 600_000,
    status: 'pending',
    response: null
  }
}

describe('sortRequests', () => {
  it('ranks high-risk approvals above everything, then approvals, asks, notifies', () => {
    const sorted = sortRequests(
      [
        verbReq('notify', 'notify', 1),
        verbReq('ask', 'ask', 2),
        verbReq('approve', 'approve', 3),
        verbReq('risky', 'approve', 4, 'high')
      ],
      'priority'
    )
    expect(sorted.map((r) => r.id)).toEqual(['risky', 'approve', 'ask', 'notify'])
  })

  // The two sorts break ties in OPPOSITE directions, which is the whole reason
  // both exist: same rank means the longest-blocked agent goes first.
  it('breaks a priority tie oldest-first, but sorts newest-first by date', () => {
    const rows = [verbReq('new', 'ask', 200), verbReq('old', 'ask', 100)]
    expect(sortRequests(rows, 'priority').map((r) => r.id)).toEqual(['old', 'new'])
    expect(sortRequests(rows, 'newest').map((r) => r.id)).toEqual(['new', 'old'])
  })

  it('does not mutate the snapshot it was handed', () => {
    const rows = [verbReq('a', 'notify', 1), verbReq('b', 'approve', 2)]
    sortRequests(rows, 'priority')
    expect(rows.map((r) => r.id)).toEqual(['a', 'b'])
  })
})

describe('filterRequests', () => {
  const rows = [verbReq('a', 'ask', 1), verbReq('b', 'approve', 2), verbReq('c', 'notify', 3)]

  it('keeps only the chosen verb, and everything on "all"', () => {
    expect(filterRequests(rows, 'approve').map((r) => r.id)).toEqual(['b'])
    expect(filterRequests(rows, 'all')).toHaveLength(3)
  })
})

describe('filteredEmptyNote', () => {
  // A first run has nothing to hide -- claiming otherwise would send someone
  // hunting for a filter that is not the reason the list is empty.
  it('is silent when nothing is hidden or no filter is set', () => {
    expect(filteredEmptyNote(0, 'ask')).toBeNull()
    expect(filteredEmptyNote(4, 'all')).toBeNull()
  })

  it('counts what is hidden and names the filter', () => {
    expect(filteredEmptyNote(1, 'approve')).toContain('1 card')
    expect(filteredEmptyNote(3, 'approve')).toContain('3 cards')
  })
})

describe('resolvedOutcome', () => {
  // The load-bearing one: a dismissed approve carries approved:false so the
  // AGENT is safe, but showing "Declined" would claim a decision the human
  // explicitly refused to make.
  it('calls a dismissed approval cleared, never declined', () => {
    const request = verbReq('x', 'approve', 1)
    expect(
      resolvedOutcome({
        ...request,
        status: 'dismissed',
        response: { approved: false, reason: 'dismissed' }
      })
    ).toBe('You cleared it without answering')
  })

  it('still says no for a real refusal', () => {
    const request = verbReq('x', 'approve', 1)
    expect(resolvedOutcome({ ...request, status: 'resolved', response: { approved: false } })).toBe(
      'You said no'
    )
  })

  // A notify resolves the instant it is minted, so it reaches Previous with no
  // response at all. Falling through to "Answered" made a wall of updates each
  // claim an answer nobody ever gave -- which is what the Previous tab looked
  // like in practice, since notify is the commonest verb.
  it('never claims an answer for a notify nobody replied to', () => {
    const request = verbReq('x', 'notify', 1)
    expect(resolvedOutcome({ ...request, status: 'resolved', response: null })).toBe('Delivered')
  })

  it('quotes a typed answer so it reads as the user speaking', () => {
    const request = verbReq('x', 'ask', 1)
    expect(resolvedOutcome({ ...request, status: 'resolved', response: { answer: 'yes' } })).toBe(
      'You said "yes"'
    )
  })
})

describe('resolvedWhen', () => {
  const at = 1_000_000_000

  // resolvedAt is the fact the card is dated by; createdAt is only a fallback
  // for a row that has not finished, where the two ask the same question.
  it('dates a card by when it was resolved, not when it was asked', () => {
    const request = { ...verbReq('x', 'ask', at - 3_600_000), resolvedAt: at - 120_000 }
    expect(resolvedWhen(request, at)).toBe('2m ago')
  })

  it('falls back to createdAt when nothing resolved it', () => {
    expect(resolvedWhen(verbReq('x', 'ask', at - 120_000), at)).toBe('2m ago')
  })

  it('rolls up through hours and days', () => {
    expect(resolvedWhen({ ...verbReq('x', 'ask', 0), resolvedAt: at - 20_000 }, at)).toBe('just now')
    expect(resolvedWhen({ ...verbReq('x', 'ask', 0), resolvedAt: at - 7_200_000 }, at)).toBe('2h ago')
    expect(resolvedWhen({ ...verbReq('x', 'ask', 0), resolvedAt: at - 172_800_000 }, at)).toBe(
      '2d ago'
    )
  })
})

describe('viewBarVisible', () => {
  it('stays hidden for a single card on the default filter', () => {
    expect(viewBarVisible(1, 'all')).toBe(false)
    expect(viewBarVisible(0, 'all')).toBe(false)
  })

  it('shows once ordering can do something', () => {
    expect(viewBarVisible(2, 'all')).toBe(true)
  })

  // The dead end this exists for: the filter persists, so a narrowed view plus
  // one non-matching card hid the only control that could clear it.
  it('always shows on a narrowed filter, however few cards', () => {
    expect(viewBarVisible(1, 'approve')).toBe(true)
    expect(viewBarVisible(0, 'ask')).toBe(true)
  })
})

describe('previousList', () => {
  // The case that made the old createdAt sort wrong: `slow` was asked first and
  // sat unanswered while `quick` arrived, got answered, and finished -- so
  // ordering by when they were ASKED buries the card you just dealt with.
  it('orders by when a card ended, not when it was asked', () => {
    const slow = { ...verbReq('slow', 'ask', 100), resolvedAt: 900 }
    const quick = { ...verbReq('quick', 'ask', 300), resolvedAt: 400 }
    expect(previousList([slow, quick], []).map((r) => r.id)).toEqual(['slow', 'quick'])
  })

  // A row that never carried a resolvedAt still has to sort somewhere sane
  // rather than sinking to the bottom as a 0.
  it('falls back to createdAt when a card carries no resolvedAt', () => {
    const dated = { ...verbReq('dated', 'ask', 100), resolvedAt: 200 }
    expect(previousList([dated, verbReq('bare', 'ask', 500)], []).map((r) => r.id)).toEqual([
      'bare',
      'dated'
    ])
  })

  it('interleaves cleared cards with answered ones by the same key', () => {
    const answered = { ...verbReq('answered', 'ask', 0), resolvedAt: 300 }
    const cleared = { ...verbReq('cleared', 'ask', 0), resolvedAt: 500 }
    expect(previousList([answered], [cleared]).map((r) => r.id)).toEqual(['cleared', 'answered'])
  })

  // notify resolves the instant it is minted, so leaving it in buried every
  // card that was actually a question.
  it('drops notify banners', () => {
    const banner = { ...verbReq('banner', 'notify', 0), resolvedAt: 900 }
    const ask = { ...verbReq('ask', 'ask', 0), resolvedAt: 100 }
    expect(previousList([banner, ask], []).map((r) => r.id)).toEqual(['ask'])
  })
})

describe('isIdleNotify', () => {
  it('is only a notify marked idle', () => {
    expect(isIdleNotify({ ...verbReq('idle', 'notify', 0), params: { idle: true } })).toBe(true)
    expect(isIdleNotify(verbReq('plain', 'notify', 0))).toBe(false)
    expect(isIdleNotify({ ...verbReq('ask', 'ask', 0), params: { idle: true } })).toBe(false)
  })
})

// The row subject for the ~99% of sessions that never call `recap` (measured
// 2026-08-15: 4 declared TLDRs against 1264 named sessions).
describe('sessionActivity derivedSubject', () => {
  function from(id: string, verb: RelayVerbWire, createdAt: number, text: string): RelayRequestWire {
    return {
      id,
      verb,
      params: verb === 'ask' ? { question: text, from: 'me' } : { action: text, from: 'me' },
      createdAt,
      timeoutMs: 600_000,
      status: 'pending',
      response: null
    }
  }

  it('names the newest non-notify card', () => {
    const subject = sessionActivity('me', [
      from('old', 'ask', 100, 'which db?'),
      from('new', 'approve', 300, 'the llm-proxy fix touches billing')
    ]).derivedSubject
    expect(subject).toBe('the llm-proxy fix touches billing')
  })

  // An ask names a decision about the work; a notify names an event. The notify
  // is newer here and still must not win -- that is the whole preference rule.
  it('prefers an older ask over a newer notify', () => {
    const subject = sessionActivity('me', [
      from('ask', 'ask', 100, 'which db?'),
      from('ping', 'notify', 900, 'tests are green')
    ]).derivedSubject
    expect(subject).toBe('which db?')
  })

  // Falling back to the newest card of any kind would duplicate lastSummary and
  // dress a plain status ping up as a considered subject.
  it('is undefined for a notify-only session', () => {
    const activity = sessionActivity('me', [from('ping', 'notify', 100, 'tests are green')])
    expect(activity.derivedSubject).toBeUndefined()
    expect(activity.lastSummary).toBe('tests are green')
  })

  it('is undefined for a session with no cards at all', () => {
    expect(sessionActivity('me', []).derivedSubject).toBeUndefined()
  })

  // `from` scoping is what keeps six panes on one checkout from wearing each
  // other's subject.
  it('ignores another session cards', () => {
    const mine = from('mine', 'ask', 100, 'my subject')
    const theirs = { ...from('theirs', 'ask', 900, 'their subject'), params: { question: 'their subject', from: 'someone-else' } }
    expect(sessionActivity('me', [mine, theirs]).derivedSubject).toBe('my subject')
  })
})


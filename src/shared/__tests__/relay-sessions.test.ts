import { describe, it, expect } from 'vitest'
import {
  sessionEntry,
  sessionBoardColumn,
  boardColumns,
  groupsInsideColumn,
  BOARD_COLUMNS,
  BOARD_COLUMN_LABELS,
  BOARD_DONE_FRESH_MS,
  sortEntries,
  passesFilters,
  sessionSpoke
} from '../relay-sessions'
import { sessionActivity } from '../relay-cards'
import type { RelayRequestWire, RelayVerbWire } from '../phone-remote-protocol'
import type { AgentRelaySessionInfo } from '../types'

const NOW = 1_786_600_000_000

function session(
  label: string,
  extra: Partial<AgentRelaySessionInfo> = {}
): AgentRelaySessionInfo {
  return { label, stated: label, ...extra }
}

function entryOf(
  label: string,
  extra: Partial<AgentRelaySessionInfo> = {},
  requests: RelayRequestWire[] = []
) {
  const s = session(label, extra)
  return sessionEntry(s, sessionActivity(s.stated ?? s.label, requests), NOW)
}

function req(opts: {
  from: string
  verb: RelayVerbWire
  status?: RelayRequestWire['status']
  createdAt?: number
  state?: 'done' | 'progress'
}): RelayRequestWire {
  return {
    id: `${opts.verb}-${opts.from}-${opts.createdAt ?? NOW}`,
    verb: opts.verb,
    params: { from: opts.from, state: opts.state },
    createdAt: opts.createdAt ?? NOW,
    timeoutMs: 600_000,
    status: opts.status ?? 'pending',
    response: null
  }
}

describe('sessionSpoke', () => {
  it('is false for a session that has never minted a card', () => {
    expect(sessionSpoke(entryOf('a'))).toBe(false)
  })

  it('is true once the session has any card at all', () => {
    const requests = [req({ from: 'a', verb: 'ask' })]
    expect(sessionSpoke(entryOf('a', {}, requests))).toBe(true)
  })

  // The resolved tail is capped, so these three are what keep a long-running
  // session visible after its cards age out of the snapshot.
  it('keeps a card-less session that has handed back', () => {
    const entry = entryOf('a', { idleSince: NOW - 60_000 })
    expect(entry.activity.total).toBe(0)
    expect(entry.row.health).toBe('your-turn')
    expect(sessionSpoke(entry)).toBe(true)
  })

  it('keeps a card-less session that is waiting on you', () => {
    const entry = entryOf('a', { waiting: 1 })
    expect(entry.activity.total).toBe(0)
    expect(sessionSpoke(entry)).toBe(true)
  })

  it('keeps a card-less session that declared a tldr', () => {
    const entry = entryOf('a', { tldr: 'porting the phone list' })
    expect(entry.activity.total).toBe(0)
    expect(sessionSpoke(entry)).toBe(true)
  })

  it('stays false for a card-less session that merely ended', () => {
    expect(sessionSpoke(entryOf('a', { stale: true, staleSince: NOW - 60_000 }))).toBe(false)
  })
})

describe('sessionBoardColumn', () => {
  it('files a pending approve under Needs the OK', () => {
    const requests = [req({ from: 'a', verb: 'approve' })]
    expect(sessionBoardColumn(entryOf('a', {}, requests), requests, NOW)).toBe('approve')
  })

  it('files a pending ask under Question', () => {
    const requests = [req({ from: 'a', verb: 'ask' })]
    expect(sessionBoardColumn(entryOf('a', {}, requests), requests, NOW)).toBe('ask')
  })

  it('files a pending show under Look at this', () => {
    const requests = [req({ from: 'a', verb: 'show' })]
    expect(sessionBoardColumn(entryOf('a', {}, requests), requests, NOW)).toBe('show')
  })

  it('lets approve win over ask on the same session', () => {
    const requests = [req({ from: 'a', verb: 'ask' }), req({ from: 'a', verb: 'approve' })]
    expect(sessionBoardColumn(entryOf('a', {}, requests), requests, NOW)).toBe('approve')
  })

  it('lets ended win over a pending card', () => {
    const requests = [req({ from: 'a', verb: 'ask' })]
    expect(
      sessionBoardColumn(entryOf('a', { stale: true, staleSince: NOW - 60_000 }, requests), requests, NOW)
    ).toBe('ended')
  })

  it('files a progress notify as Still working', () => {
    const requests = [
      req({ from: 'a', verb: 'notify', status: 'resolved', state: 'progress' })
    ]
    expect(sessionBoardColumn(entryOf('a', {}, requests), requests, NOW)).toBe('progress')
  })

  it('files a fresh done notify as All done', () => {
    const requests = [
      req({ from: 'a', verb: 'notify', status: 'resolved', state: 'done', createdAt: NOW - 5 * 60_000 })
    ]
    expect(sessionBoardColumn(entryOf('a', {}, requests), requests, NOW)).toBe('done')
  })

  it('drops a stale done notify through to Open', () => {
    const requests = [
      req({
        from: 'a',
        verb: 'notify',
        status: 'resolved',
        state: 'done',
        createdAt: NOW - BOARD_DONE_FRESH_MS - 1
      })
    ]
    expect(sessionBoardColumn(entryOf('a', {}, requests), requests, NOW)).toBe('live')
  })

  it('treats a notify with no state as done', () => {
    const requests = [
      req({ from: 'a', verb: 'notify', status: 'resolved', createdAt: NOW - 1_000 })
    ]
    expect(sessionBoardColumn(entryOf('a', {}, requests), requests, NOW)).toBe('done')
  })

  it('files a quiet connected session as Open', () => {
    expect(sessionBoardColumn(entryOf('a'), [], NOW)).toBe('live')
  })

  it('files an unread idle ping under Your turn, off main-computed idleSince', () => {
    expect(sessionBoardColumn(entryOf('a', { idleSince: NOW - 1_000 }), [], NOW)).toBe('your-turn')
  })

  it('lets any pending card outrank Your turn', () => {
    const requests = [req({ from: 'a', verb: 'ask' })]
    expect(
      sessionBoardColumn(entryOf('a', { idleSince: NOW - 1_000 }, requests), requests, NOW)
    ).toBe('ask')
  })
})

describe('your-turn filter and sort', () => {
  it('the Your turn chip matches only sessions with an unread idle ping', () => {
    expect(passesFilters(entryOf('a', { idleSince: NOW - 1_000 }), ['your-turn'])).toBe(true)
    expect(passesFilters(entryOf('b'), ['your-turn'])).toBe(false)
  })

  it('waiting sort ranks your-turn above plain connected, below waiting', () => {
    const waiting = entryOf('w', {}, [req({ from: 'w', verb: 'ask' })])
    const turn = entryOf('t', { idleSince: NOW - 1_000 })
    const quiet = entryOf('q')
    const order = sortEntries([quiet, turn, waiting], 'waiting').map((e) => e.session.label)
    expect(order).toEqual(['w', 't', 'q'])
  })
})

describe('boardColumns', () => {
  it('always returns seven columns, empty ones included', () => {
    const cols = boardColumns([entryOf('a')], [], NOW, 'recent')
    expect(cols.map((c) => c.key)).toEqual([...BOARD_COLUMNS])
    expect(cols.map((c) => c.title)).toEqual(BOARD_COLUMNS.map((k) => BOARD_COLUMN_LABELS[k]))
    expect(cols.find((c) => c.key === 'live')?.entries).toHaveLength(1)
    for (const col of cols) {
      if (col.key !== 'live') expect(col.entries).toHaveLength(0)
    }
  })

  it('puts each verb in its own column', () => {
    const requests = [
      req({ from: 'ok', verb: 'approve' }),
      req({ from: 'q', verb: 'ask' }),
      req({ from: 'pic', verb: 'show' })
    ]
    const cols = boardColumns(
      [entryOf('ok', {}, requests), entryOf('q', {}, requests), entryOf('pic', {}, requests)],
      requests,
      NOW,
      'name'
    )
    expect(cols.find((c) => c.key === 'approve')?.entries.map((e) => e.session.label)).toEqual(['ok'])
    expect(cols.find((c) => c.key === 'ask')?.entries.map((e) => e.session.label)).toEqual(['q'])
    expect(cols.find((c) => c.key === 'show')?.entries.map((e) => e.session.label)).toEqual(['pic'])
  })

  it('sorts inside a column the same way sortEntries does', () => {
    const a = entryOf('alpha')
    const b = entryOf('beta')
    const cols = boardColumns([b, a], [], NOW, 'name')
    const live = cols.find((c) => c.key === 'live')!.entries
    expect(live.map((e) => e.session.label)).toEqual(
      sortEntries([b, a], 'name').map((e) => e.session.label)
    )
  })
})

describe('groupsInsideColumn', () => {
  it('skips a header when every card shares a folder', () => {
    const lanes = groupsInsideColumn(
      [entryOf('ShowAndTell/dev - a'), entryOf('ShowAndTell/dev - b')],
      'folder',
      'name'
    )
    expect(lanes).toHaveLength(1)
    expect(lanes[0].title).toBe('')
  })

  it('splits when two folders sit in the same column', () => {
    const lanes = groupsInsideColumn(
      [entryOf('ShowAndTell/dev - a'), entryOf('other/main - b')],
      'folder',
      'name'
    )
    expect(new Set(lanes.map((l) => l.title))).toEqual(new Set(['ShowAndTell', 'other']))
  })
})

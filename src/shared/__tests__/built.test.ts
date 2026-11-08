import { describe, expect, it } from 'vitest'
import {
  BUILT_FILTERS,
  builtAge,
  builtByDay,
  builtCounts,
  builtDay,
  builtMatches,
  type BuiltFilter,
  type BuiltItem
} from '../built'

const NOW = new Date(2026, 8, 25, 15, 0, 0).getTime()
const START_OF_TODAY = new Date(2026, 8, 25, 0, 0, 0).getTime()
const DAY = 86_400_000
const iso = (ms: number): string => new Date(ms).toISOString()

function item(over: Partial<BuiltItem> & Pick<BuiltItem, 'id' | 'kind'>): BuiltItem {
  return {
    title: over.id,
    projectId: 'p1',
    madeBy: 'Claude',
    firstSeen: iso(NOW),
    lastSeen: iso(NOW),
    versions: 1,
    ...over
  }
}

const ITEMS: BuiltItem[] = [
  item({ id: 'online-1', kind: 'online', url: 'https://claude.ai/code/artifact/abc12345', favorite: true }),
  item({ id: 'file-1', kind: 'file', file: '/Users/me/app/.claude/artifacts/Pricing.html' }),
  item({ id: 'run-1', kind: 'running', url: 'http://localhost:5173', command: 'vite --port 5173' }),
  item({ id: 'stop-1', kind: 'stopped', url: 'http://localhost:3000', command: 'next dev', favorite: true }),
  item({ id: 'stop-2', kind: 'stopped', url: 'http://localhost:8080' })
]

describe('builtMatches', () => {
  it('Favorites shows only favorited items of any kind', () => {
    expect(ITEMS.filter((i) => builtMatches(i, 'favorites', '')).map((i) => i.id)).toEqual(['online-1', 'stop-1'])
  })

  it('Online and On this Mac narrow to their own kind', () => {
    expect(ITEMS.filter((i) => builtMatches(i, 'online', '')).map((i) => i.id)).toEqual(['online-1'])
    expect(ITEMS.filter((i) => builtMatches(i, 'file', '')).map((i) => i.id)).toEqual(['file-1'])
  })

  it('search is trimmed, case-insensitive, and reads title, url, file and command', () => {
    const ids = (q: string): string[] => ITEMS.filter((i) => builtMatches(i, 'all', q)).map((i) => i.id)
    expect(ids('  PRICING ')).toEqual(['file-1'])
    expect(ids('5173')).toEqual(['run-1'])
    expect(ids('next dev')).toEqual(['stop-1'])
    expect(ids('artifact/abc')).toEqual(['online-1'])
    expect(ids('   ')).toHaveLength(ITEMS.length)
  })

  it('search and filter combine', () => {
    expect(ITEMS.filter((i) => builtMatches(i, 'favorites', 'localhost')).map((i) => i.id)).toEqual(['stop-1'])
  })
})

describe('builtCounts matches what each chip shows', () => {
  const shownFor = (f: BuiltFilter): number => ITEMS.filter((i) => builtMatches(i, f, '')).length

  for (const f of ['all', 'favorites', 'online', 'file'] as BuiltFilter[]) {
    it(`${f}: chip count equals rows shown`, () => {
      expect(builtCounts(ITEMS)[f]).toBe(shownFor(f))
    })
  }

  it('running: chip count equals rows shown', () => {
    expect(builtCounts(ITEMS).running).toBe(shownFor('running'))
  })

  it('every chip has a count', () => {
    const counts = builtCounts(ITEMS)
    for (const f of BUILT_FILTERS) expect(typeof counts[f.id]).toBe('number')
  })
})

describe('builtDay', () => {
  it('labels today and yesterday explicitly, everything else by its calendar date', () => {
    expect(builtDay(iso(START_OF_TODAY), NOW)).toBe('Today')
    expect(builtDay(iso(START_OF_TODAY - 1), NOW)).toBe('Yesterday')
    expect(builtDay(iso(START_OF_TODAY - DAY), NOW)).toBe('Yesterday')
    const twoDaysAgoStart = START_OF_TODAY - 2 * DAY
    const older = builtDay(iso(twoDaysAgoStart), NOW)
    expect(older).not.toBe('Today')
    expect(older).not.toBe('Yesterday')
    expect(builtDay(iso(twoDaysAgoStart + 12 * 60 * 60_000), NOW)).toBe(older)
  })
})

describe('builtByDay', () => {
  it('groups by real day; a favorite is not pinned into its own section', () => {
    const groups = builtByDay(
      [
        item({ id: 'old-fav', kind: 'stopped', lastSeen: iso(NOW - 40 * DAY), favorite: true }),
        item({ id: 'today', kind: 'file', lastSeen: iso(NOW - 60_000) }),
        item({ id: 'yesterday', kind: 'file', lastSeen: iso(NOW - DAY) }),
        item({ id: 'ancient', kind: 'online', lastSeen: iso(NOW - 40 * DAY) })
      ],
      NOW
    )
    expect(groups.map(([day, list]) => [day, list.map((i) => i.id)])).toEqual([
      ['Today', ['today']],
      ['Yesterday', ['yesterday']],
      [builtDay(iso(NOW - 40 * DAY), NOW), ['old-fav', 'ancient']]
    ])
  })

  it('within a group, running servers come first, then newest first; empty groups are dropped', () => {
    const groups = builtByDay(
      [
        item({ id: 'file-newest', kind: 'file', lastSeen: iso(NOW - 1_000) }),
        item({ id: 'run-older', kind: 'running', lastSeen: iso(NOW - 3_600_000) }),
        item({ id: 'file-older', kind: 'file', lastSeen: iso(NOW - 7_200_000) })
      ],
      NOW
    )
    expect(groups).toHaveLength(1)
    expect(groups[0][1].map((i) => i.id)).toEqual(['run-older', 'file-newest', 'file-older'])
  })
})

describe('builtAge', () => {
  it('reads in plain units and never shows a negative or NaN age', () => {
    expect(builtAge(iso(NOW - 30_000), NOW)).toBe('just now')
    expect(builtAge(iso(NOW + 60 * 60_000), NOW)).toBe('just now')
    expect(builtAge('not a date', NOW)).toBe('just now')
    expect(builtAge(iso(NOW - 59 * 60_000), NOW)).toBe('59m ago')
    expect(builtAge(iso(NOW - 60 * 60_000), NOW)).toBe('1h ago')
    expect(builtAge(iso(NOW - DAY), NOW)).toBe('yesterday')
    expect(builtAge(iso(NOW - 3 * DAY), NOW)).toBe('3 days ago')
  })
})

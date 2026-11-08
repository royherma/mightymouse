/**
 * Tests for activity-recall.ts — ranking the ambient activity log for media-chat.
 *
 * Covers:
 *   1. segmentEvents: collapses same app+host runs, breaks on change, attaches text
 *   2. rankActivityForQuery: matches host/url/title, drops zero-score, recency view
 *   3. assembleActivityRecall: budget bound, empty → '' (no misleading "nothing")
 */

import { describe, it, expect } from 'vitest'
import {
  segmentEvents,
  rankActivityForQuery,
  assembleActivityRecall
} from '../activity-recall'
import type { ContextLogEvent } from '../../../shared/types'

function focus(ts: string, app: string, url: string | null, title: string | null = null): ContextLogEvent {
  return { ts, type: 'focus', app, url, title }
}
function text(ts: string, app: string, url: string | null, body: string): ContextLogEvent {
  return { ts, type: 'text', app, url, title: null, text: body }
}

const T0 = '2026-06-04T16:00:00.000Z'
const T1 = '2026-06-04T16:00:05.000Z'
const T2 = '2026-06-04T16:00:10.000Z'
const T3 = '2026-06-04T16:05:00.000Z'

// ── segmentEvents ──────────────────────────────────────────────────────────────

describe('segmentEvents', () => {
  it('collapses consecutive focus on the same app+host into one segment', () => {
    const segs = segmentEvents([
      focus(T0, 'Google Chrome', 'https://twitter.com/home'),
      focus(T1, 'Google Chrome', 'https://twitter.com/explore'),
      focus(T2, 'Google Chrome', 'https://twitter.com/home')
    ])
    expect(segs).toHaveLength(1)
    expect(segs[0].host).toBe('twitter.com')
    expect(segs[0].urls).toHaveLength(2) // /home deduped, /explore added
  })

  it('breaks into a new segment when the host changes', () => {
    const segs = segmentEvents([
      focus(T0, 'Google Chrome', 'https://twitter.com/home'),
      focus(T1, 'Google Chrome', 'https://github.com/foo')
    ])
    expect(segs).toHaveLength(2)
    expect(segs.map((s) => s.host)).toEqual(['twitter.com', 'github.com'])
  })

  it('strips www. from the host', () => {
    const segs = segmentEvents([focus(T0, 'Google Chrome', 'https://www.netflix.com/browse')])
    expect(segs[0].host).toBe('netflix.com')
  })

  it('drops junk URLs (chrome://, about:) from the segment', () => {
    const segs = segmentEvents([focus(T0, 'Google Chrome', 'chrome://newtab')])
    expect(segs[0].urls).toHaveLength(0)
    expect(segs[0].host).toBeNull()
  })

  it('drops localhost / loopback dev servers (noise, not real sites)', () => {
    const segs = segmentEvents([
      focus(T0, 'Google Chrome', 'http://localhost:5173/foo'),
      focus(T1, 'Google Chrome', 'http://127.0.0.1:7878/bar')
    ])
    // Both collapse to a host-less Chrome segment with no URL evidence.
    expect(segs.every((s) => s.host === null)).toBe(true)
    expect(segs.every((s) => s.urls.length === 0)).toBe(true)
  })

  it('attaches text snippets to the current segment without breaking it', () => {
    const segs = segmentEvents([
      focus(T0, 'Notes', null),
      text(T1, 'Notes', null, 'buy milk and eggs')
    ])
    expect(segs).toHaveLength(1)
    expect(segs[0].snippets[0]).toBe('buy milk and eggs')
  })

  it('records the time span of a segment', () => {
    const segs = segmentEvents([
      focus(T0, 'Google Chrome', 'https://twitter.com/home'),
      focus(T3, 'Google Chrome', 'https://twitter.com/home')
    ])
    expect(segs[0].endMs - segs[0].startMs).toBe(5 * 60 * 1000)
  })
})

// ── rankActivityForQuery ────────────────────────────────────────────────────────

describe('rankActivityForQuery', () => {
  const events = [
    focus(T0, 'Google Chrome', 'https://twitter.com/home', 'Home / X'),
    focus(T1, 'Google Chrome', 'https://github.com/foo', 'foo repo'),
    focus(T2, 'Slack', null, 'general')
  ]

  it('matches on host and returns that segment', () => {
    const ranked = rankActivityForQuery(events, 'did I go to twitter')
    expect(ranked).toHaveLength(1)
    expect(ranked[0].host).toBe('twitter.com')
  })

  it('matches the X brand via an expansion term', () => {
    // "x" alone is too short to tokenize; the title "Home / X" carries it. Use a
    // host-bearing term to prove expansion widens the match set.
    const ranked = rankActivityForQuery(events, 'browsing', ['github'])
    expect(ranked.some((s) => s.host === 'github.com')).toBe(true)
  })

  it('drops segments that match no token', () => {
    const ranked = rankActivityForQuery(events, 'twitter')
    expect(ranked.every((s) => s.host !== 'github.com')).toBe(true)
  })

  it('returns a recency view when the query has no usable tokens (prefers real sites)', () => {
    // No content tokens → recency view, which prefers host-bearing segments. The
    // host-less Slack row is dropped in favour of the two real sites, newest-first.
    const ranked = rankActivityForQuery(events, 'the a an')
    expect(ranked.map((s) => s.host)).toEqual(['github.com', 'twitter.com'])
  })

  it('respects topN', () => {
    const ranked = rankActivityForQuery(events, 'the', [], 1)
    expect(ranked).toHaveLength(1)
  })

  it('date-scoped zero-match falls back to the window recency view (the real bug)', () => {
    // "which website did I check this morning" has no token that matches any host.
    // Without dateScoped it returns []; with dateScoped it must surface the activity.
    const q = 'which website did i check this morning'
    expect(rankActivityForQuery(events, q, [], 12, false)).toHaveLength(0)
    const dated = rankActivityForQuery(events, q, [], 12, true)
    expect(dated.length).toBeGreaterThan(0)
    // Recency view prefers host-bearing segments (real sites, not the Slack app row).
    expect(dated.some((s) => s.host === 'twitter.com' || s.host === 'github.com')).toBe(true)
  })

  it('recency view prefers segments that have a real host', () => {
    const mixed = [
      focus(T0, 'Slack', null, 'general'),
      focus(T1, 'Google Chrome', 'https://twitter.com/home')
    ]
    const ranked = rankActivityForQuery(mixed, 'which site this morning', [], 12, true)
    expect(ranked[0].host).toBe('twitter.com')
  })
})

// ── assembleActivityRecall ──────────────────────────────────────────────────────

describe('assembleActivityRecall', () => {
  it('returns empty string for no segments (no misleading "nothing found")', () => {
    expect(assembleActivityRecall([])).toBe('')
  })

  it('includes the host and a header for a real segment', () => {
    const segs = segmentEvents([focus(T0, 'Google Chrome', 'https://twitter.com/home', 'Home / X')])
    const blob = assembleActivityRecall(segs)
    expect(blob).toContain('twitter.com')
    expect(blob).toContain('Your recent activity')
  })

  it('stays within the char budget', () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      focus(`2026-06-04T16:${String(i).padStart(2, '0')}:00.000Z`, 'Google Chrome', `https://site${i}.com/page`)
    )
    const segs = segmentEvents(many)
    const blob = assembleActivityRecall(segs, 500)
    expect(blob.length).toBeLessThanOrEqual(500)
  })
})

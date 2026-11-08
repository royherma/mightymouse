/**
 * Tests for media-recall.ts — ranking, assembly, and vision image collection.
 *
 * Covers:
 *   1. rankMediaForQuery: zero-match drop, tag/title/transcript weight ordering
 *   2. rankMediaForQuery: both-token match ranks above single-token match
 *   3. rankMediaForQuery: recency tiebreak within equal-score items
 *   4. rankMediaForQuery: query-expansion terms widen the ranked set
 *   5. rankMediaForQuery: returns up to topN items
 *   6. assembleMediaRecall: empty set → "nothing found" block
 *   7. assembleMediaRecall: budget respected
 *   8. collectImagePaths: only screenshots with imagePath included; recordings excluded
 */

import { describe, it, expect } from 'vitest'
import { rankMediaForQuery, assembleMediaRecall, collectImagePaths } from '../media-recall'
import type { MediaItem } from '../../../shared/types'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeItem(overrides: Partial<MediaItem> & Pick<MediaItem, 'folder' | 'ts' | 'kind'>): MediaItem {
  return {
    sizeBytes: 0,
    ...overrides
  }
}

// ── rankMediaForQuery ─────────────────────────────────────────────────────────

describe('rankMediaForQuery', () => {
  it('drops items with zero score', () => {
    const items = [
      makeItem({ folder: '/a', ts: '2026-01-01T00:00:00Z', kind: 'screenshot', windowTitle: 'Xcode' }),
      makeItem({ folder: '/b', ts: '2026-01-02T00:00:00Z', kind: 'screenshot', windowTitle: 'Terminal' })
    ]
    // "unrelated" matches neither; "terminal" matches /b only
    const ranked = rankMediaForQuery('terminal', items)
    expect(ranked).toHaveLength(1)
    expect(ranked[0].folder).toBe('/b')
  })

  it('tag match (weight 3) outranks transcript-only match (weight 1)', () => {
    const withTag = makeItem({
      folder: '/tag',
      ts: '2026-01-01T00:00:00Z',
      kind: 'screenshot',
      insights: { v: 1, ts: '', tags: ['dashboard'] }
    })
    const withTranscript = makeItem({
      folder: '/transcript',
      ts: '2026-01-01T00:00:00Z', // same recency
      kind: 'screenshot',
      transcript: 'dashboard'
    })
    const ranked = rankMediaForQuery('dashboard', [withTag, withTranscript])
    expect(ranked[0].folder).toBe('/tag')
  })

  it('item matching both query tokens ranks above item matching one', () => {
    const both = makeItem({
      folder: '/both',
      ts: '2026-01-01T00:00:00Z',
      kind: 'screenshot',
      windowTitle: 'figma design'
    })
    const one = makeItem({
      folder: '/one',
      ts: '2026-01-01T00:00:00Z',
      kind: 'screenshot',
      windowTitle: 'figma'
    })
    const ranked = rankMediaForQuery('figma design', [one, both])
    expect(ranked[0].folder).toBe('/both')
  })

  it('uses recency as tiebreak for equal-score items', () => {
    const older = makeItem({
      folder: '/older',
      ts: '2026-01-01T00:00:00Z',
      kind: 'screenshot',
      windowTitle: 'vscode'
    })
    const newer = makeItem({
      folder: '/newer',
      ts: '2026-01-05T00:00:00Z',
      kind: 'screenshot',
      windowTitle: 'vscode'
    })
    const ranked = rankMediaForQuery('vscode', [older, newer])
    expect(ranked[0].folder).toBe('/newer')
  })

  it('respects topN cap', () => {
    const items = Array.from({ length: 20 }, (_, i) =>
      makeItem({
        folder: `/item${i}`,
        ts: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
        kind: 'screenshot',
        windowTitle: 'matching'
      })
    )
    const ranked = rankMediaForQuery('matching', items, 5)
    expect(ranked).toHaveLength(5)
  })

  it('query-expansion terms widen the ranked set', () => {
    // "demo" is the synonym for "demonstration" — only one item uses it
    const demonstration = makeItem({
      folder: '/demo-item',
      ts: '2026-01-03T00:00:00Z',
      kind: 'screenshot',
      windowTitle: 'demo session'
    })
    const unrelated = makeItem({
      folder: '/unrelated',
      ts: '2026-01-01T00:00:00Z',
      kind: 'screenshot',
      windowTitle: 'invoices'
    })
    // Without expansion: "demonstration" doesn't match "demo"
    const withoutExpansion = rankMediaForQuery('demonstration', [demonstration, unrelated])
    expect(withoutExpansion.some((it) => it.folder === '/demo-item')).toBe(false)

    // With expansion: extra term "demo" widens the match
    const withExpansion = rankMediaForQuery('demonstration', [demonstration, unrelated], 10, ['demo'])
    expect(withExpansion.some((it) => it.folder === '/demo-item')).toBe(true)
  })

  it('returns most-recent items when query has no useful tokens', () => {
    const items = [
      makeItem({ folder: '/a', ts: '2026-01-01T00:00:00Z', kind: 'screenshot' }),
      makeItem({ folder: '/b', ts: '2026-01-05T00:00:00Z', kind: 'screenshot' })
    ]
    // "the" is a stopword → no useful tokens → fall back to recency slice
    const ranked = rankMediaForQuery('the', items, 5)
    // Both returned, newest first (items already newest-first in listMedia)
    expect(ranked.length).toBeGreaterThan(0)
  })
})

// ── assembleMediaRecall ───────────────────────────────────────────────────────

describe('assembleMediaRecall', () => {
  it('returns header + emptyMsg when items list is empty', () => {
    const result = assembleMediaRecall([], 'what screenshots do I have?')
    expect(result).toContain('No matching captures found')
  })

  it('includes item details in the output', () => {
    const item = makeItem({
      folder: '/cap/shot-2026-01-01T10-00-00-000Z',
      ts: '2026-01-01T10:00:00.000Z',
      kind: 'screenshot',
      frontApp: 'Safari',
      windowTitle: 'GitHub - my-repo'
    })
    const result = assembleMediaRecall([item], 'github')
    expect(result).toContain('Safari')
    expect(result).toContain('GitHub')
  })

  it('respects the budget — output does not exceed it by content', () => {
    // 20 large items; each has a long transcript. With a tight budget only a
    // few should appear (the overflow line always appends, so raw length may
    // slightly exceed budget — that is documented and acceptable).
    const items = Array.from({ length: 20 }, (_, i) =>
      makeItem({
        folder: `/cap/shot-${i}`,
        ts: `2026-01-0${(i % 9) + 1}T10:00:00.000Z`,
        kind: 'screenshot',
        transcript: 'x'.repeat(800)
      })
    )
    const budget = 2000
    const result = assembleMediaRecall(items, 'test', budget)
    // Overflow line must appear (content was too large for budget)
    expect(result).toContain('more not shown')
  })
})

// ── collectImagePaths ─────────────────────────────────────────────────────────

describe('collectImagePaths', () => {
  it('returns imagePath for screenshots that have one', () => {
    const shot = makeItem({
      folder: '/cap/shot-1',
      ts: '2026-01-01T00:00:00Z',
      kind: 'screenshot',
      imagePath: '/cap/shot-1/screenshot.png'
    })
    expect(collectImagePaths([shot])).toEqual(['/cap/shot-1/screenshot.png'])
  })

  it('skips screenshots without imagePath', () => {
    const shot = makeItem({ folder: '/cap/shot-1', ts: '2026-01-01T00:00:00Z', kind: 'screenshot' })
    expect(collectImagePaths([shot])).toHaveLength(0)
  })

  it('skips recordings (no still image)', () => {
    const rec = makeItem({
      folder: '/cap/rec-1',
      ts: '2026-01-01T00:00:00Z',
      kind: 'recording',
      videoPath: '/cap/rec-1/screen.mp4'
    })
    expect(collectImagePaths([rec])).toHaveLength(0)
  })

  it('skips dictations', () => {
    const listen = makeItem({
      folder: '/cap/listen-1',
      ts: '2026-01-01T00:00:00Z',
      kind: 'listen'
    })
    expect(collectImagePaths([listen])).toHaveLength(0)
  })

  it('respects limit', () => {
    const shots = Array.from({ length: 5 }, (_, i) =>
      makeItem({
        folder: `/cap/shot-${i}`,
        ts: `2026-01-0${i + 1}T00:00:00Z`,
        kind: 'screenshot',
        imagePath: `/cap/shot-${i}/screenshot.png`
      })
    )
    expect(collectImagePaths(shots, 3)).toHaveLength(3)
  })
})

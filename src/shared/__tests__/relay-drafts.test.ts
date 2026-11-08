/**
 * Item 4's guarantee: a half-typed answer survives the re-render that used to
 * eat it. The bug was per-card `useState('')` on a card that unmounts on every
 * relayPending snapshot -- so the regression to protect is "read it back after
 * the component that wrote it is gone."
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  readDraft,
  writeDraft,
  clearDraft,
  pruneDrafts,
  resetDraftCacheForTests
} from '../relay-drafts'

function installStorage(seed: Record<string, string> = {}): Map<string, string> {
  const map = new Map(Object.entries(seed))
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k)
  })
  return map
}

beforeEach(() => {
  resetDraftCacheForTests()
  installStorage()
})

describe('relay drafts', () => {
  it('reads back what was written, keyed by request id', () => {
    writeDraft('req-a', 'postgres, but check the index first')
    writeDraft('req-b', 'no')
    expect(readDraft('req-a')).toBe('postgres, but check the index first')
    expect(readDraft('req-b')).toBe('no')
  })

  it('survives a full cache drop -- the re-render that caused the bug', () => {
    writeDraft('req-a', 'half a sentence')
    // Standing in for the card unmounting and remounting: state is gone,
    // storage is not.
    resetDraftCacheForTests()
    expect(readDraft('req-a')).toBe('half a sentence')
  })

  it('returns empty for an unknown id rather than undefined', () => {
    expect(readDraft('never-seen')).toBe('')
  })

  it('clears on answer', () => {
    writeDraft('req-a', 'typed something')
    clearDraft('req-a')
    expect(readDraft('req-a')).toBe('')
  })

  it('deletes rather than storing empty string', () => {
    const store = installStorage()
    resetDraftCacheForTests()
    writeDraft('req-a', 'x')
    writeDraft('req-a', '')
    const raw = store.get('mm.relay.drafts.v1')
    expect(raw).toBeDefined()
    expect(JSON.parse(raw!)).toEqual({})
  })

  it('prunes drafts whose request is no longer pending', () => {
    writeDraft('still-open', 'keep me')
    writeDraft('answered-on-phone', 'drop me')
    pruneDrafts(['still-open'])
    expect(readDraft('still-open')).toBe('keep me')
    expect(readDraft('answered-on-phone')).toBe('')
  })

  it('drops rows older than a day on load', () => {
    const stale = Date.now() - 25 * 60 * 60 * 1000
    installStorage({
      'mm.relay.drafts.v1': JSON.stringify({
        old: { text: 'yesterday', ts: stale },
        fresh: { text: 'today', ts: Date.now() }
      })
    })
    resetDraftCacheForTests()
    expect(readDraft('old')).toBe('')
    expect(readDraft('fresh')).toBe('today')
  })

  it('survives a corrupt blob instead of throwing', () => {
    installStorage({ 'mm.relay.drafts.v1': '{not json' })
    resetDraftCacheForTests()
    expect(readDraft('anything')).toBe('')
    expect(() => writeDraft('req-a', 'still works')).not.toThrow()
  })

  it('works with no storage at all -- private mode / partitioned PWA', () => {
    vi.stubGlobal('localStorage', undefined)
    resetDraftCacheForTests()
    writeDraft('req-a', 'in memory only')
    expect(readDraft('req-a')).toBe('in memory only')
  })
})

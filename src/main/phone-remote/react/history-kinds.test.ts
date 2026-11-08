import { describe, it, expect, beforeEach } from 'vitest'

// The suite runs on `environment: 'node'`, which has no localStorage. A map is
// the whole contract this pref uses, so stub it here rather than pull jsdom in
// for one file — same approach as drag-haptics-pref.test.ts.
const store = new Map<string, string>()
globalThis.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size
  }
} as Storage

import {
  availableKinds,
  filterEntries,
  kindLabel,
  getHiddenKinds,
  setHiddenKinds
} from './history-kinds'

const rows = (...kinds: string[]): { kind: string }[] => kinds.map((kind) => ({ kind }))

describe('availableKinds', () => {
  it('offers only kinds present in the loaded entries', () => {
    expect(availableKinds(rows('act', 'listen', 'act'))).toEqual(['act', 'listen'])
  })

  it('orders known kinds canonically, not by first appearance', () => {
    expect(availableKinds(rows('screenshot', 'act', 'rewrite'))).toEqual([
      'rewrite',
      'act',
      'screenshot'
    ])
  })

  it('keeps an unknown wire kind filterable, after the known ones', () => {
    expect(availableKinds(rows('act', 'teleport'))).toEqual(['act', 'teleport'])
  })

  it('is empty for no entries', () => {
    expect(availableKinds([])).toEqual([])
  })
})

describe('filterEntries', () => {
  it('shows everything when nothing is hidden', () => {
    const all = rows('act', 'listen')
    expect(filterEntries(all, new Set())).toHaveLength(2)
  })

  it('drops only the hidden kinds', () => {
    const out = filterEntries(rows('act', 'listen', 'act'), new Set(['act']))
    expect(out.map((e) => e.kind)).toEqual(['listen'])
  })

  it('shows a kind that arrives on a later page and was never selected', () => {
    // Hidden-set semantics: a newly-seen kind is visible by default.
    const out = filterEntries(rows('act', 'screenshot'), new Set(['act']))
    expect(out.map((e) => e.kind)).toEqual(['screenshot'])
  })

  it('can hide everything', () => {
    expect(filterEntries(rows('act', 'listen'), new Set(['act', 'listen']))).toEqual([])
  })
})

describe('hidden-kinds persistence', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('round-trips a filter', () => {
    setHiddenKinds(new Set(['act', 'listen']))
    expect([...getHiddenKinds()].sort()).toEqual(['act', 'listen'])
  })

  it('defaults to showing everything when nothing is stored', () => {
    expect(getHiddenKinds().size).toBe(0)
  })

  it('clears the key rather than storing an empty list', () => {
    setHiddenKinds(new Set(['act']))
    setHiddenKinds(new Set())
    expect(localStorage.getItem('mm-remote-history-hidden')).toBeNull()
    expect(getHiddenKinds().size).toBe(0)
  })

  it('shows everything on corrupt JSON rather than hiding rows', () => {
    localStorage.setItem('mm-remote-history-hidden', '{not json')
    expect(getHiddenKinds().size).toBe(0)
  })

  it('shows everything when the stored value is not an array', () => {
    localStorage.setItem('mm-remote-history-hidden', '"act"')
    expect(getHiddenKinds().size).toBe(0)
  })

  it('drops non-string members of a stored array', () => {
    localStorage.setItem('mm-remote-history-hidden', '["act", 7, null]')
    expect([...getHiddenKinds()]).toEqual(['act'])
  })

  it('survives storage being unavailable (private mode)', () => {
    const real = globalThis.localStorage
    const denied = (): never => {
      throw new Error('denied')
    }
    globalThis.localStorage = {
      getItem: denied,
      setItem: denied,
      removeItem: denied
    } as unknown as Storage
    try {
      expect(getHiddenKinds().size).toBe(0)
      expect(() => setHiddenKinds(new Set(['act']))).not.toThrow()
    } finally {
      globalThis.localStorage = real
    }
  })
})

describe('kindLabel', () => {
  it('title-cases a known kind', () => {
    expect(kindLabel('act')).toBe('Act')
    expect(kindLabel('screenshot')).toBe('Screenshot')
  })

  it('passes an unknown kind through verbatim', () => {
    expect(kindLabel('teleport')).toBe('teleport')
  })
})

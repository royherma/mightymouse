import { beforeEach, describe, expect, it } from 'vitest'
import { readCachedAppContext, writeCachedAppContext } from './app-context-cache'
import type { AppContext } from '@shared/app-context'
import { EMPTY_READING } from '@shared/app-context'

const NOW = 1_700_000_000_000

// The suite runs on `environment: 'node'`, which has no localStorage. A map is
// the whole contract this module uses (getItem/setItem/clear), so stub it here
// rather than pull jsdom in for one file.
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

const chrome: AppContext = {
  ...EMPTY_READING,
  adapterId: 'chrome',
  appName: 'Google Chrome',
  bundleId: 'com.google.Chrome',
  appIconPngBase64: 'aWNvbg==',
  items: [{ id: '3', title: 'jul-26', subtitle: 'x.com', active: true, iconPngBase64: '' }],
  groups: [
    { id: 'p1', name: 'M', iconPngBase64: '', subtitle: '', itemCount: 8, active: true }
  ],
  activeGroupId: 'p1'
}

describe('app context chip cache', () => {
  beforeEach(() => localStorage.clear())

  it('has nothing to say before anything is written', () => {
    expect(readCachedAppContext(NOW)).toBeNull()
  })

  it('remembers the chip so a reopened keyboard draws it immediately', () => {
    writeCachedAppContext(chrome, NOW)
    const got = readCachedAppContext(NOW + 1_000)
    expect(got?.appName).toBe('Google Chrome')
    expect(got?.bundleId).toBe('com.google.Chrome')
    expect(got?.appIconPngBase64).toBe('aWNvbg==')
  })

  // The rule this file exists to protect: a stale chip is inert, a stale tab
  // list is TAPPABLE. Rehydrating items would activate a tab that closed.
  it('never rehydrates anything the user could tap', () => {
    writeCachedAppContext(chrome, NOW)
    const got = readCachedAppContext(NOW)
    expect(got?.items).toEqual([])
    expect(got?.groups).toEqual([])
    expect(got?.adapterId).toBeNull()
  })

  // A null appName means "unreadable this poll", never "no app" -- persisting
  // it would erase a good chip with a transient Apple-events timeout.
  it('does not let an unreadable poll erase a good chip', () => {
    writeCachedAppContext(chrome, NOW)
    writeCachedAppContext({ ...chrome, appName: '' }, NOW + 1)
    expect(readCachedAppContext(NOW + 2)?.appName).toBe('Google Chrome')
  })

  it('forgets a chip old enough to be a lie', () => {
    writeCachedAppContext(chrome, NOW)
    expect(readCachedAppContext(NOW + 31 * 60 * 1000)).toBeNull()
  })

  // A backwards clock jump must fail closed, not pass a naive `age < TTL`.
  it('rejects a chip from the future', () => {
    writeCachedAppContext(chrome, NOW)
    expect(readCachedAppContext(NOW - 31 * 60 * 1000)).toBeNull()
  })

  it('drops an icon too big to be one, keeping the name', () => {
    writeCachedAppContext({ ...chrome, appIconPngBase64: 'a'.repeat(40 * 1024) }, NOW)
    const got = readCachedAppContext(NOW)
    expect(got?.appName).toBe('Google Chrome')
    expect(got?.appIconPngBase64).toBe('')
  })

  it('survives a corrupt entry rather than throwing into the bar', () => {
    localStorage.setItem('mm-remote-app-chip', '{not json')
    expect(readCachedAppContext(NOW)).toBeNull()
  })
})

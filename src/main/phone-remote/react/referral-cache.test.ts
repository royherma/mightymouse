import { beforeEach, describe, expect, it } from 'vitest'
import { readCachedReferral, writeCachedReferral, clearCachedReferral } from './referral-cache'

const NOW = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000

// The suite runs on `environment: 'node'`, which has no localStorage. A map is
// the whole contract this module uses (getItem/setItem/removeItem/clear), so
// stub it here rather than pull jsdom in for one file.
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

const payload = {
  link: 'https://getmightymouse.com/?r=S11KCDAM',
  code: 'S11KCDAM',
  referredCount: 3
}

describe('referral cache', () => {
  beforeEach(() => localStorage.clear())

  it('has nothing to say before anything is written', () => {
    expect(readCachedReferral(NOW)).toBeNull()
  })

  it('remembers the payload so a reopened sheet draws the QR immediately', () => {
    writeCachedReferral(payload, NOW)
    const got = readCachedReferral(NOW + 1_000)
    expect(got?.link).toBe(payload.link)
    expect(got?.code).toBe('S11KCDAM')
    expect(got?.referredCount).toBe(3)
  })

  it('still serves a week-old link -- referral codes do not rot', () => {
    writeCachedReferral(payload, NOW)
    expect(readCachedReferral(NOW + 6 * DAY)?.link).toBe(payload.link)
  })

  it('forgets a link past the TTL, so a long-dormant phone re-asks', () => {
    writeCachedReferral(payload, NOW)
    expect(readCachedReferral(NOW + 8 * DAY)).toBeNull()
  })

  // A backwards clock makes `now - at` negative, which passes a naive `< TTL`
  // check forever. The magnitude comparison is what fails it closed.
  it('forgets an entry that appears to be from the future', () => {
    writeCachedReferral(payload, NOW)
    expect(readCachedReferral(NOW - 30 * DAY)).toBeNull()
  })

  // The Mac answers with no link when it is signed out or the fetch failed.
  // Persisting that would erase a good link over a transient failure.
  it('refuses to overwrite a good link with a linkless answer', () => {
    writeCachedReferral(payload, NOW)
    writeCachedReferral({ code: undefined, link: undefined }, NOW + 1_000)
    expect(readCachedReferral(NOW + 2_000)?.link).toBe(payload.link)
  })

  it('defaults a missing count and code rather than storing undefined', () => {
    writeCachedReferral({ link: payload.link }, NOW)
    const got = readCachedReferral(NOW)
    expect(got?.referredCount).toBe(0)
    expect(got?.code).toBe('')
  })

  it('survives a malformed entry rather than throwing into the sheet', () => {
    localStorage.setItem('mm-remote-referral', '{not json')
    expect(readCachedReferral(NOW)).toBeNull()
  })

  it('rejects an entry whose link went missing or blank', () => {
    localStorage.setItem('mm-remote-referral', JSON.stringify({ code: 'X', at: NOW }))
    expect(readCachedReferral(NOW)).toBeNull()
    localStorage.setItem(
      'mm-remote-referral',
      JSON.stringify({ link: '', code: 'X', referredCount: 0, at: NOW })
    )
    expect(readCachedReferral(NOW)).toBeNull()
  })

  // An absurd link would be handed to the QR encoder and drawn as an
  // unscannably dense code. Refusing it falls back to the loading line.
  it('rejects an implausibly long link', () => {
    writeCachedReferral({ ...payload, link: `https://x.com/${'a'.repeat(600)}` }, NOW)
    expect(readCachedReferral(NOW)).toBeNull()
  })

  // Sign-out is the one answer that invalidates the cache: the link belongs to
  // an account this phone can no longer prove it is on.
  it('clears on sign-out so the next opener never sees the old account code', () => {
    writeCachedReferral(payload, NOW)
    clearCachedReferral()
    expect(readCachedReferral(NOW)).toBeNull()
  })
})

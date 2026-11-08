import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { afterAll, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({ home: '' }))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, homedir: () => env.home }
})
vi.mock('electron', () => ({ app: { getPath: () => env.home }, net: { fetch: vi.fn() } }))

env.home = mkdtempSync(join(tmpdir(), 'mm-side-history-'))
const { importHistory, recent, recordVisit, suggest, topSites } = await import('../side-browser-history')

afterAll(() => rmSync(env.home, { recursive: true, force: true }))

const CHROMIUM_EPOCH_MS = 11644473600 * 1000
const chromeTime = (unixMs: number): number => (unixMs + CHROMIUM_EPOCH_MS) * 1000

describe('address-bar suggestions', () => {
  it('collapses URLs that differ only by query, hash or trailing slash', () => {
    recordVisit('https://dedupe.example/docs', 'Docs')
    recordVisit('https://dedupe.example/docs/', 'Docs')
    recordVisit('https://dedupe.example/docs?ref=nav', 'Docs')
    recordVisit('https://dedupe.example/docs#install', 'Docs')
    recordVisit('https://dedupe.example/pricing', 'Pricing')
    const urls = suggest('dedupe.example').map((s) => s.url.replace(/[?#].*$/, '').replace(/\/$/, ''))
    expect(urls.sort()).toEqual(['https://dedupe.example/docs', 'https://dedupe.example/pricing'])
  })

  it('ranks a host-prefix match above a more-visited mid-URL match', () => {
    for (let i = 0; i < 5; i++) recordVisit('https://news.site/story/rankme-guide', 'Guide')
    recordVisit('https://rankme.dev/', 'Rankme')
    expect(suggest('rankme')[0].url).toBe('https://rankme.dev/')
  })

  it('ignores non-web URLs and an empty query', () => {
    recordVisit('file:///etc/passwd', 'passwd')
    recordVisit('chrome://settings', 'Settings')
    expect(suggest('passwd')).toEqual([])
    expect(suggest('settings')).toEqual([])
    expect(suggest('   ')).toEqual([])
  })
})

describe('Recent pages', () => {
  it('skips sign-in, OAuth and accounts.* pages', () => {
    recordVisit('https://accounts.google.com/v3/signin/identifier', 'Sign in')
    recordVisit('https://app.recent.test/login', 'Log in')
    recordVisit('https://app.recent.test/oauth2/callback?code=x', '')
    recordVisit('https://app.recent.test/dashboard', 'Dashboard')
    const urls = recent().map((r) => r.url)
    expect(urls).toContain('https://app.recent.test/dashboard')
    expect(urls.filter((u) => /accounts\.|login|oauth/.test(u))).toEqual([])
  })

  it('hides a title that is just the URL', () => {
    recordVisit('https://plain.recent.test/page', 'plain.recent.test/page')
    expect(recent().find((r) => r.url === 'https://plain.recent.test/page')?.title).toBe('')
  })
})

describe('importHistory from a Chromium profile', () => {
  it('converts Chromium timestamps, keeps visit counts, and marks bookmarks', () => {
    const profile = join(env.home, 'Library', 'Application Support', 'Google/Chrome', 'Default')
    mkdirSync(profile, { recursive: true })
    const lastVisitMs = Date.UTC(2026, 8, 20, 12, 0, 0)
    const src = new Database(join(profile, 'History'))
    src.exec('CREATE TABLE urls (url TEXT, title TEXT, visit_count INTEGER, last_visit_time INTEGER)')
    const add = src.prepare('INSERT INTO urls VALUES (?,?,?,?)')
    add.run('https://imported.test/home', 'Imported Home', 42, chromeTime(lastVisitMs))
    add.run('https://never-visited.test/', 'Never', 0, chromeTime(lastVisitMs))
    add.run('not a url', 'junk', 3, chromeTime(lastVisitMs))
    src.close()
    writeFileSync(
      join(profile, 'Bookmarks'),
      JSON.stringify({
        roots: {
          bookmark_bar: { type: 'folder', children: [{ type: 'url', url: 'https://bookmarked.test/', name: 'Saved' }] },
          other: { type: 'folder', children: [{ type: 'folder', children: [{ type: 'url', url: 'https://nested-bm.test/', name: 'Nested' }] }] }
        }
      })
    )

    expect(importHistory('Google/Chrome', 'Default')).toEqual({ history: 1, bookmarks: 2 })

    const db = new Database(join(env.home, 'side-browser', 'history.db'), { readonly: true })
    const row = db.prepare('SELECT visits, last_visit, title FROM places WHERE url = ?').get('https://imported.test/home')
    const bm = db.prepare('SELECT bookmarked FROM places WHERE url = ?').get('https://nested-bm.test/')
    db.close()
    expect(row).toEqual({ visits: 42, last_visit: lastVisitMs, title: 'Imported Home' })
    expect(bm).toEqual({ bookmarked: 1 })
    expect(suggest('imported.test')[0].url).toBe('https://imported.test/home')
    expect(topSites().map((s) => s.url)).toContain('https://imported.test/')
  })

  it('a malformed Bookmarks file still imports history', () => {
    const profile = join(env.home, 'Library', 'Application Support', 'BraveSoftware/Brave-Browser', 'Default')
    mkdirSync(profile, { recursive: true })
    const src = new Database(join(profile, 'History'))
    src.exec('CREATE TABLE urls (url TEXT, title TEXT, visit_count INTEGER, last_visit_time INTEGER)')
    src.prepare('INSERT INTO urls VALUES (?,?,?,?)').run('https://brave-only.test/', 'B', 1, chromeTime(Date.now()))
    src.close()
    writeFileSync(join(profile, 'Bookmarks'), '{ not json')
    expect(importHistory('BraveSoftware/Brave-Browser', 'Default')).toEqual({ history: 1, bookmarks: 0 })
  })
})

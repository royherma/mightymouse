import { app, net } from 'electron'
import Database from 'better-sqlite3'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { SideBrowserSuggestion } from '../shared/types'

const APP_SUPPORT = join(homedir(), 'Library', 'Application Support')
const CHROMIUM_EPOCH_OFFSET_S = 11644473600
const SUGGEST_LIMIT = 6
const TOP_SITES_LIMIT = 8
const RECENT_LIMIT = 6
const ICON_TIMEOUT_MS = 1500
const NOT_A_DESTINATION = /\/(signin|sign-in|login|log-in|logout|oauth2?|auth|challenge|callback|consent|sso|gsi)\b/i

let db: Database.Database | null = null

function open(): Database.Database {
  if (db) return db
  const dir = join(app.getPath('userData'), 'side-browser')
  mkdirSync(dir, { recursive: true })
  const conn = new Database(join(dir, 'history.db'))
  conn.pragma('journal_mode = WAL')
  conn.exec(
    `CREATE TABLE IF NOT EXISTS places (
       url TEXT PRIMARY KEY,
       title TEXT NOT NULL DEFAULT '',
       host TEXT NOT NULL DEFAULT '',
       visits INTEGER NOT NULL DEFAULT 0,
       last_visit INTEGER NOT NULL DEFAULT 0,
       bookmarked INTEGER NOT NULL DEFAULT 0,
       favicon TEXT
     );
     CREATE INDEX IF NOT EXISTS places_host ON places(host);`
  )
  db = conn
  return conn
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function pageKey(url: string): string {
  return url.replace(/[#?].*$/, '').replace(/\/$/, '')
}

function realTitle(url: string, title: string): string {
  return title && !url.includes(title.replace(/[?#].*$/, '')) ? title : ''
}

export function recordVisit(url: string, title: string): void {
  if (!/^https?:/i.test(url)) return
  const host = hostOf(url)
  if (!host) return
  open()
    .prepare(
      `INSERT INTO places (url, title, host, visits, last_visit)
       VALUES (@url, @title, @host, 1, @now)
       ON CONFLICT(url) DO UPDATE SET
         visits = visits + 1,
         last_visit = @now,
         title = CASE WHEN @title != '' THEN @title ELSE title END`
    )
    .run({ url, title: realTitle(url, title), host, now: Date.now() })
}

export function recordTitle(url: string, title: string): void {
  const clean = realTitle(url, title)
  if (clean) open().prepare('UPDATE places SET title = ? WHERE url = ?').run(clean, url)
}

export function recordFavicon(url: string, favicon: string): void {
  if (!favicon) return
  open().prepare('UPDATE places SET favicon = ? WHERE url = ?').run(favicon, url)
}

function faviconFor(host: string): string {
  return `https://www.google.com/s2/favicons?domain=${host}&sz=64`
}

// Chrome ranks the same way: fewer chars from the URL start beats a match buried mid-path.
function rank(row: { visits: number; last_visit: number; bookmarked: number }): number {
  const days = (Date.now() - row.last_visit) / 86_400_000
  const recency = 1 / (1 + Math.max(0, days))
  return row.visits * (0.4 + 0.6 * recency) + (row.bookmarked ? 5 : 0)
}

export function suggest(query: string): SideBrowserSuggestion[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const like = `%${q}%`
  const rows = open()
    .prepare(
      `SELECT url, title, host, visits, last_visit, bookmarked, favicon FROM places
       WHERE url LIKE ? OR title LIKE ?
       ORDER BY visits DESC, last_visit DESC LIMIT 60`
    )
    .all(like, like) as (SideBrowserSuggestion & {
    visits: number
    last_visit: number
    bookmarked: number
    host: string
  })[]
  const startsHost = (r: (typeof rows)[number]): number =>
    r.host.startsWith(q) || r.url.replace(/^https?:\/\/(www\.)?/, '').startsWith(q) ? 1 : 0
  const ranked = rows.sort((a, b) => startsHost(b) - startsHost(a) || rank(b) - rank(a))
  const seen = new Set<string>()
  const out: SideBrowserSuggestion[] = []
  for (const r of ranked) {
    const key = pageKey(r.url)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ url: r.url, title: r.title, favicon: r.favicon || faviconFor(r.host) })
    if (out.length >= SUGGEST_LIMIT) break
  }
  return out
}

export function topSites(): SideBrowserSuggestion[] {
  const rows = open()
    .prepare(
      `SELECT url, title, host, visits, last_visit, bookmarked, favicon FROM places
       WHERE host != '' AND (visits > 0 OR bookmarked = 1)
       ORDER BY visits DESC, last_visit DESC LIMIT 200`
    )
    .all() as (SideBrowserSuggestion & {
    visits: number
    last_visit: number
    bookmarked: number
    host: string
  })[]
  const best = new Map<string, (typeof rows)[number]>()
  for (const r of rows) if (!best.has(r.host)) best.set(r.host, r)
  return [...best.values()]
    .sort((a, b) => rank(b) - rank(a))
    .slice(0, TOP_SITES_LIMIT)
    .map((r) => ({ url: `https://${r.host}/`, title: r.title || r.host, favicon: r.favicon || faviconFor(r.host) }))
}

export function recent(): SideBrowserSuggestion[] {
  const rows = open()
    .prepare(
      `SELECT url, title, host, favicon FROM places
       WHERE host != '' AND last_visit > 0 ORDER BY last_visit DESC LIMIT 60`
    )
    .all() as (SideBrowserSuggestion & { host: string })[]
  const seen = new Set<string>()
  const out: SideBrowserSuggestion[] = []
  for (const r of rows) {
    const key = pageKey(r.url)
    if (seen.has(key) || r.host.startsWith('accounts.') || NOT_A_DESTINATION.test(key)) continue
    seen.add(key)
    out.push({ url: r.url, title: realTitle(r.url, r.title), favicon: r.favicon || faviconFor(r.host) })
    if (out.length >= RECENT_LIMIT) break
  }
  return out
}

export function forgetPage(url: string): void {
  const conn = open()
  const key = pageKey(url)
  const page = conn.prepare('SELECT title FROM places WHERE url = ?').get(url) as { title: string } | undefined
  const rows = conn
    .prepare('SELECT url, title FROM places WHERE substr(url, 1, ?) = ?')
    .all(key.length, key) as { url: string; title: string }[]
  const drop = conn.prepare('DELETE FROM places WHERE url = ?')
  for (const r of rows) if (r.url === url || (r.title === page?.title && pageKey(r.url) === key)) drop.run(r.url)
}

export function forgetSite(url: string): void {
  open().prepare('UPDATE places SET visits = 0, bookmarked = 0 WHERE host = ?').run(hostOf(url))
}

const iconCache = new Map<string, Promise<string | undefined>>()

async function fetchIcon(url: string): Promise<string | undefined> {
  try {
    const res = await net.fetch(url, { signal: AbortSignal.timeout(ICON_TIMEOUT_MS) })
    const type = res.headers.get('content-type') ?? ''
    if (!res.ok || !type.startsWith('image/')) return undefined
    return `data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`
  } catch {
    return undefined
  }
}

// Renderer CSP blocks https: images, so favicons cross the IPC boundary as data: URLs.
export function inlineIcon(pageUrl: string, favicon?: string): Promise<string | undefined> {
  const host = hostOf(pageUrl)
  const key = favicon || host
  let icon = iconCache.get(key)
  if (!icon) {
    icon = (favicon ? fetchIcon(favicon) : Promise.resolve(undefined)).then(
      (got) => got ?? (host ? fetchIcon(faviconFor(host)) : undefined)
    )
    iconCache.set(key, icon)
  }
  return icon
}

export async function inlineIcons(list: SideBrowserSuggestion[]): Promise<SideBrowserSuggestion[]> {
  return Promise.all(list.map(async (s) => ({ ...s, favicon: await inlineIcon(s.url, s.favicon) })))
}

interface BookmarkNode {
  type?: string
  url?: string
  name?: string
  children?: BookmarkNode[]
}

function walkBookmarks(node: BookmarkNode, out: { url: string; title: string }[]): void {
  if (node.type === 'url' && node.url) out.push({ url: node.url, title: node.name || '' })
  for (const child of node.children ?? []) walkBookmarks(child, out)
}

export function importHistory(browserDir: string, profile: string): { history: number; bookmarks: number } {
  const profileDir = join(APP_SUPPORT, browserDir, profile)
  const conn = open()
  let history = 0
  let bookmarks = 0

  const historyPath = join(profileDir, 'History')
  if (existsSync(historyPath)) {
    const tmp = mkdtempSync(join(app.getPath('temp'), 'mm-history-import-'))
    try {
      const copy = join(tmp, 'History')
      copyFileSync(historyPath, copy)
      const src = new Database(copy, { readonly: true, fileMustExist: true })
      try {
        const rows = src
          .prepare('SELECT url, title, visit_count, last_visit_time FROM urls WHERE visit_count > 0')
          .all() as { url: string; title: string; visit_count: number; last_visit_time: number }[]
        const upsert = conn.prepare(
          `INSERT INTO places (url, title, host, visits, last_visit)
           VALUES (@url, @title, @host, @visits, @last)
           ON CONFLICT(url) DO UPDATE SET
             visits = MAX(visits, @visits),
             last_visit = MAX(last_visit, @last),
             title = CASE WHEN @title != '' THEN @title ELSE title END`
        )
        const tx = conn.transaction((batch: typeof rows) => {
          for (const r of batch) {
            const host = hostOf(r.url)
            if (!host) continue
            upsert.run({
              url: r.url,
              title: r.title || '',
              host,
              visits: r.visit_count,
              last: Math.round(r.last_visit_time / 1000 - CHROMIUM_EPOCH_OFFSET_S * 1000)
            })
            history++
          }
        })
        tx(rows)
      } finally {
        src.close()
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }

  const bookmarksPath = join(profileDir, 'Bookmarks')
  if (existsSync(bookmarksPath)) {
    try {
      const parsed = JSON.parse(readFileSync(bookmarksPath, 'utf8')) as {
        roots: Record<string, BookmarkNode>
      }
      const found: { url: string; title: string }[] = []
      for (const root of Object.values(parsed.roots ?? {})) walkBookmarks(root, found)
      const upsert = conn.prepare(
        `INSERT INTO places (url, title, host, visits, last_visit, bookmarked)
         VALUES (@url, @title, @host, 0, 0, 1)
         ON CONFLICT(url) DO UPDATE SET bookmarked = 1,
           title = CASE WHEN @title != '' THEN @title ELSE title END`
      )
      const tx = conn.transaction((batch: typeof found) => {
        for (const b of batch) {
          const host = hostOf(b.url)
          if (!host) continue
          upsert.run({ url: b.url, title: b.title, host })
          bookmarks++
        }
      })
      tx(found)
    } catch {
      // A malformed Bookmarks file just means no bookmarks come over.
    }
  }
  return { history, bookmarks }
}

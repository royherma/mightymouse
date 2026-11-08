import { app, type Session } from 'electron'
import Database from 'better-sqlite3'
import { execFile } from 'child_process'
import { createDecipheriv, pbkdf2Sync } from 'crypto'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { SideBrowserImportResult, SideBrowserImportSource } from '../shared/types'

interface ChromiumBrowser {
  id: string
  label: string
  dir: string
  keychain: string
}

const APP_SUPPORT = join(homedir(), 'Library', 'Application Support')
const BROWSERS: ChromiumBrowser[] = [
  { id: 'chrome', label: 'Chrome', dir: 'Google/Chrome', keychain: 'Chrome Safe Storage' },
  { id: 'brave', label: 'Brave', dir: 'BraveSoftware/Brave-Browser', keychain: 'Brave Safe Storage' },
  { id: 'edge', label: 'Edge', dir: 'Microsoft Edge', keychain: 'Microsoft Edge Safe Storage' },
  { id: 'arc', label: 'Arc', dir: 'Arc/User Data', keychain: 'Arc Safe Storage' }
]
// Seconds between 1601-01-01 (Chromium's cookie epoch) and 1970-01-01.
const CHROMIUM_EPOCH_OFFSET_S = 11644473600
// Cookie DB meta.version 24+ prefixes each decrypted value with SHA-256(host).
const HOST_HASH_VERSION = 24
const HOST_HASH_BYTES = 32
const SET_BATCH = 200
const SAME_SITE = { 0: 'no_restriction', 1: 'lax', 2: 'strict' } as const

interface CookieRow {
  host_key: string
  name: string
  value: string
  encrypted_value: Buffer
  path: string
  expires_utc: number
  is_secure: number
  is_httponly: number
  samesite: number
  has_expires: number
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout: 120_000 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout.trim())
    )
  )
}

async function hasKeychainItem(service: string): Promise<boolean> {
  return run('security', ['find-generic-password', '-s', service]).then(
    () => true,
    () => false
  )
}

function profilesOf(browser: ChromiumBrowser): SideBrowserImportSource[] {
  const root = join(APP_SUPPORT, browser.dir)
  let state: {
    profile?: { last_used?: string; info_cache?: Record<string, { name?: string; user_name?: string }> }
  }
  try {
    state = JSON.parse(readFileSync(join(root, 'Local State'), 'utf8'))
  } catch {
    return []
  }
  const cache = state.profile?.info_cache ?? {}
  const lastUsed = state.profile?.last_used ?? 'Default'
  return Object.entries(cache)
    .filter(([dir]) => existsSync(join(root, dir, 'Cookies')))
    .map(([dir, info]) => ({
      browser: browser.id,
      browserLabel: browser.label,
      profile: dir,
      name: info.name || browser.label,
      email: info.user_name || undefined,
      lastUsed: dir === lastUsed
    }))
    .sort((a, b) => Number(b.lastUsed) - Number(a.lastUsed) || a.name.localeCompare(b.name))
}

export function browserDir(browserId: string): string | null {
  return BROWSERS.find((b) => b.id === browserId)?.dir ?? null
}

export async function listImportSources(): Promise<SideBrowserImportSource[]> {
  const found = await Promise.all(
    BROWSERS.map(async (b) => ((await hasKeychainItem(b.keychain)) ? profilesOf(b) : []))
  )
  return found.flat()
}

function decryptor(password: string): (blob: Buffer) => Buffer | null {
  const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1')
  const iv = Buffer.alloc(16, ' ')
  return (blob) => {
    const prefix = blob.subarray(0, 3).toString()
    if (prefix !== 'v10' && prefix !== 'v11') return null
    try {
      const d = createDecipheriv('aes-128-cbc', key, iv)
      return Buffer.concat([d.update(blob.subarray(3)), d.final()])
    } catch {
      return null
    }
  }
}

function readCookieRows(profileDir: string): { rows: CookieRow[]; version: number } {
  const tmp = mkdtempSync(join(app.getPath('temp'), 'mm-cookie-import-'))
  try {
    const copy = join(tmp, 'Cookies')
    copyFileSync(join(profileDir, 'Cookies'), copy)
    for (const side of ['-journal', '-wal'])
      if (existsSync(join(profileDir, 'Cookies' + side)))
        copyFileSync(join(profileDir, 'Cookies' + side), copy + side)
    const db = new Database(copy, { readonly: true, fileMustExist: true })
    try {
      const meta = db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as
        | { value: string }
        | undefined
      const rows = db
        .prepare(
          'SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite, has_expires FROM cookies'
        )
        .all() as CookieRow[]
      return { rows, version: Number(meta?.value ?? 0) }
    } finally {
      db.close()
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

function toCookie(
  row: CookieRow,
  value: string,
  nowS: number
): Electron.CookiesSetDetails | null {
  const expires = row.has_expires ? row.expires_utc / 1e6 - CHROMIUM_EPOCH_OFFSET_S : undefined
  if (expires !== undefined && expires <= nowS) return null
  const host = row.host_key.replace(/^\./, '')
  const sameSite = SAME_SITE[row.samesite as keyof typeof SAME_SITE] ?? 'unspecified'
  return {
    url: `${row.is_secure ? 'https' : 'http'}://${host}${row.path || '/'}`,
    name: row.name,
    value,
    domain: row.host_key.startsWith('.') ? row.host_key : undefined,
    path: row.path || '/',
    secure: Boolean(row.is_secure) || sameSite === 'no_restriction',
    httpOnly: Boolean(row.is_httponly),
    sameSite,
    expirationDate: expires
  }
}

export async function importCookies(
  target: Session,
  browserId: string,
  profile: string
): Promise<SideBrowserImportResult> {
  const browser = BROWSERS.find((b) => b.id === browserId)
  const profileDir = browser && join(APP_SUPPORT, browser.dir, profile)
  if (!browser || !profileDir || profile.includes('..') || !existsSync(join(profileDir, 'Cookies')))
    return { ok: false, reason: 'missing' }

  let password: string
  try {
    password = await run('security', ['find-generic-password', '-w', '-s', browser.keychain])
  } catch {
    return { ok: false, reason: 'denied' }
  }
  const decrypt = decryptor(password)
  const { rows, version } = readCookieRows(profileDir)
  const nowS = Date.now() / 1000

  let unreadable = 0
  const cookies: Electron.CookiesSetDetails[] = []
  for (const row of rows) {
    let value = row.value
    if (!value && row.encrypted_value?.length) {
      const plain = decrypt(row.encrypted_value)
      if (!plain) {
        unreadable++
        continue
      }
      value = (version >= HOST_HASH_VERSION ? plain.subarray(HOST_HASH_BYTES) : plain).toString(
        'utf8'
      )
    }
    const cookie = toCookie(row, value, nowS)
    if (cookie) cookies.push(cookie)
  }

  let imported = 0
  const sites = new Set<string>()
  for (let i = 0; i < cookies.length; i += SET_BATCH) {
    const batch = cookies.slice(i, i + SET_BATCH)
    const results = await Promise.allSettled(batch.map((c) => target.cookies.set(c)))
    results.forEach((r, j) => {
      if (r.status !== 'fulfilled') return
      imported++
      sites.add(batch[j].domain?.replace(/^\./, '') ?? new URL(batch[j].url).hostname)
    })
  }
  await target.cookies.flushStore()
  if (rows.length > 0 && imported === 0) return { ok: false, reason: 'unreadable' }
  return {
    ok: true,
    browserLabel: browser.label,
    imported,
    sites: sites.size,
    skipped: cookies.length - imported + unreadable
  }
}

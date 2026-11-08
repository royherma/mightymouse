import { createCipheriv, createHash, pbkdf2Sync } from 'crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({
  home: '',
  keychain: { password: 'peanuts' as string | null }
}))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, homedir: () => env.home }
})
vi.mock('electron', () => ({ app: { getPath: () => env.home } }))
vi.mock('child_process', () => ({
  execFile: (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, out: string) => void) =>
    env.keychain.password === null ? cb(new Error('User canceled'), '') : cb(null, `${env.keychain.password}\n`)
}))

env.home = mkdtempSync(join(tmpdir(), 'mm-cookie-import-test-'))
const { importCookies } = await import('../side-browser-import')

const PROFILE_DIR = join(env.home, 'Library', 'Application Support', 'Google/Chrome', 'Default')
const CHROMIUM_EPOCH_S = 11644473600
const toChromeTime = (unixS: number): number => (unixS + CHROMIUM_EPOCH_S) * 1e6

function encrypt(password: string, plain: Buffer): Buffer {
  const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1')
  const c = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '))
  return Buffer.concat([Buffer.from('v10'), c.update(plain), c.final()])
}

interface Row {
  host: string
  name: string
  value: string
  path?: string
  expiresUnixS?: number
  secure?: boolean
  httpOnly?: boolean
  sameSite?: number
  encryptWith?: string
}

function writeCookiesDb(version: number, rows: Row[]): void {
  rmSync(PROFILE_DIR, { recursive: true, force: true })
  mkdirSync(PROFILE_DIR, { recursive: true })
  const db = new Database(join(PROFILE_DIR, 'Cookies'))
  db.exec(`CREATE TABLE meta (key TEXT, value TEXT);
    CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT,
      expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER, has_expires INTEGER);`)
  db.prepare("INSERT INTO meta VALUES ('version', ?)").run(String(version))
  const insert = db.prepare('INSERT INTO cookies VALUES (?,?,?,?,?,?,?,?,?,?)')
  for (const r of rows) {
    const hashed = version >= 24 ? Buffer.concat([createHash('sha256').update(r.host).digest(), Buffer.from(r.value)]) : Buffer.from(r.value)
    insert.run(
      r.host,
      r.name,
      '',
      encrypt(r.encryptWith ?? 'peanuts', hashed),
      r.path ?? '/',
      r.expiresUnixS === undefined ? 0 : toChromeTime(r.expiresUnixS),
      r.secure ? 1 : 0,
      r.httpOnly ? 1 : 0,
      r.sameSite ?? -1,
      r.expiresUnixS === undefined ? 0 : 1
    )
  }
  db.close()
}

function fakeSession() {
  const set = vi.fn(async (_c: Electron.CookiesSetDetails) => {})
  return { set, session: { cookies: { set, flushStore: vi.fn(async () => {}) } } as unknown as Electron.Session }
}

const inAYear = Math.floor(Date.now() / 1000) + 365 * 86_400

beforeEach(() => {
  env.keychain.password = 'peanuts'
})

afterAll(() => rmSync(env.home, { recursive: true, force: true }))

describe('importCookies from a Chromium profile', () => {
  it('decrypts a v24 cookie, strips the host hash, and keeps its flags and expiry', async () => {
    writeCookiesDb(24, [
      { host: '.example.com', name: 'SID', value: 'secret-value', expiresUnixS: inAYear, secure: true, httpOnly: true, sameSite: 1 }
    ])
    const { set, session } = fakeSession()
    const result = await importCookies(session, 'chrome', 'Default')
    expect(result).toEqual({ ok: true, browserLabel: 'Chrome', imported: 1, sites: 1, skipped: 0 })
    expect(set).toHaveBeenCalledWith({
      url: 'https://example.com/',
      name: 'SID',
      value: 'secret-value',
      domain: '.example.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      expirationDate: inAYear
    })
  })

  it('keeps pre-v24 values whole (no host hash to strip)', async () => {
    writeCookiesDb(23, [{ host: 'app.example.com', name: 'tok', value: 'abc', expiresUnixS: inAYear, secure: true }])
    const { set, session } = fakeSession()
    await importCookies(session, 'chrome', 'Default')
    expect(set.mock.calls[0][0]).toMatchObject({ value: 'abc', domain: undefined, url: 'https://app.example.com/' })
  })

  it('drops expired cookies and brings session cookies over without an expiry', async () => {
    writeCookiesDb(24, [
      { host: 'a.test', name: 'old', value: 'x', expiresUnixS: Math.floor(Date.now() / 1000) - 60 },
      { host: 'b.test', name: 'session', value: 'y', path: '/app', sameSite: 2 }
    ])
    const { set, session } = fakeSession()
    const result = await importCookies(session, 'chrome', 'Default')
    expect(set).toHaveBeenCalledTimes(1)
    expect(set.mock.calls[0][0]).toMatchObject({
      name: 'session',
      url: 'http://b.test/app',
      path: '/app',
      sameSite: 'strict',
      expirationDate: undefined
    })
    expect(result).toMatchObject({ ok: true, imported: 1 })
  })

  it('counts cookies it cannot decrypt as skipped, and reports unreadable when none decrypt', async () => {
    writeCookiesDb(24, [
      { host: 'a.test', name: 'good', value: 'x', expiresUnixS: inAYear },
      { host: 'b.test', name: 'bad', value: 'y', expiresUnixS: inAYear, encryptWith: 'other-password' }
    ])
    const mixed = await importCookies(fakeSession().session, 'chrome', 'Default')
    expect(mixed).toMatchObject({ ok: true, imported: 1, skipped: 1 })

    env.keychain.password = 'wrong'
    expect(await importCookies(fakeSession().session, 'chrome', 'Default')).toEqual({ ok: false, reason: 'unreadable' })
  })

  it('refuses when the keychain says no, an unknown browser, or a profile that escapes the browser dir', async () => {
    writeCookiesDb(24, [{ host: 'a.test', name: 'n', value: 'v', expiresUnixS: inAYear }])
    const { set, session } = fakeSession()
    env.keychain.password = null
    expect(await importCookies(session, 'chrome', 'Default')).toEqual({ ok: false, reason: 'denied' })
    env.keychain.password = 'peanuts'
    expect(await importCookies(session, 'netscape', 'Default')).toEqual({ ok: false, reason: 'missing' })
    expect(await importCookies(session, 'chrome', '../Chrome/Default')).toEqual({ ok: false, reason: 'missing' })
    expect(set).not.toHaveBeenCalled()
  })
})

import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({ home: '' }))

vi.mock('electron', () => ({ app: { getPath: () => env.home } }))
vi.mock('../platform/macos/helpers', () => ({ resolveHelper: () => '/nonexistent' }))

type Mod = typeof import('../side-browser-permissions')
type CheckHandler = (wc: unknown, perm: string, origin: string) => boolean
type RequestHandler = (wc: unknown, perm: string, cb: (allow: boolean) => void, details: { requestingUrl?: string }) => void

let mod: Mod
let check: CheckHandler
let request: RequestHandler
let asked: number

function tab(url: string, id = 1): Electron.WebContents & { url: string } {
  const wc = { id, url, getURL: () => wc.url, once: () => wc }
  return wc as unknown as Electron.WebContents & { url: string }
}

async function boot(): Promise<void> {
  vi.resetModules()
  mod = await import('../side-browser-permissions')
  asked = 0
  const sess = {
    setPermissionCheckHandler: (h: CheckHandler) => (check = h),
    setPermissionRequestHandler: (h: RequestHandler) => (request = h)
  }
  mod.installPermissionHandlers(sess as unknown as Electron.Session, () => asked++)
}

function ask(wc: Electron.WebContents, perm: string, url = wc.getURL()): boolean[] {
  const got: boolean[] = []
  request(wc, perm, (a) => got.push(a), { requestingUrl: url })
  return got
}

beforeEach(async () => {
  env.home = mkdtempSync(join(tmpdir(), 'mm-side-perms-'))
  await boot()
})
afterEach(() => rmSync(env.home, { recursive: true, force: true }))

describe('side-browser site permissions', () => {
  it('grants fullscreen and sanitized clipboard writes without asking', () => {
    expect(ask(tab('https://a.example/x'), 'fullscreen')).toEqual([true])
    expect(check(null, 'clipboard-sanitized-write', 'https://a.example')).toBe(true)
    expect(asked).toBe(0)
  })

  it('denies a permission it has no words for, without asking', () => {
    expect(ask(tab('https://a.example/x'), 'midi')).toEqual([false])
    expect(asked).toBe(0)
  })

  it('denies a page with no real origin', () => {
    expect(ask(tab('about:blank'), 'geolocation')).toEqual([false])
    expect(ask(tab('not a url'), 'geolocation')).toEqual([false])
    expect(asked).toBe(0)
  })

  it('holds a request until the user answers, then remembers it per origin across restarts', async () => {
    const wc = tab('https://maps.example/here')
    const got = ask(wc, 'geolocation')
    expect(got).toEqual([])
    expect(asked).toBe(1)
    expect(mod.permissionState(wc).ask).toEqual({ origin: 'https://maps.example', kind: 'geolocation', label: 'your location' })

    mod.decidePermission(wc, 'geolocation', 'allow')
    expect(got).toEqual([true])
    expect(mod.permissionState(wc).ask).toBeUndefined()

    await boot()
    expect(check(null, 'geolocation', 'https://maps.example')).toBe(true)
    expect(check(null, 'geolocation', 'https://evil.example')).toBe(false)
    expect(check(null, 'media', 'https://maps.example')).toBe(false)
    expect(ask(tab('https://maps.example/elsewhere'), 'geolocation')).toEqual([true])
    expect(asked).toBe(0)
  })

  it('remembers a block and answers the next request with no', () => {
    const wc = tab('https://spam.example/')
    const got = ask(wc, 'notifications')
    mod.decidePermission(wc, 'notifications', 'block')
    expect(got).toEqual([false])
    expect(ask(wc, 'notifications')).toEqual([false])
    expect(asked).toBe(1)
    const onDisk = JSON.parse(readFileSync(join(env.home, 'side-browser', 'permissions.json'), 'utf8'))
    expect(onDisk).toEqual({ 'https://spam.example': { notifications: false } })
  })

  it('reset forgets the choice so the site has to ask again, and drops an empty origin', () => {
    const wc = tab('https://cam.example/')
    ask(wc, 'media')
    mod.decidePermission(wc, 'media', 'allow')
    mod.decidePermission(wc, 'media', 'reset')
    expect(check(null, 'media', 'https://cam.example')).toBe(false)
    expect(mod.permissionState(wc).sitePermissions).toEqual([])
    expect(ask(wc, 'media')).toEqual([])
    expect(asked).toBe(2)
  })

  it('folds a repeat of the same request into the open question', () => {
    const wc = tab('https://maps.example/')
    const first = ask(wc, 'geolocation')
    const second = ask(wc, 'geolocation')
    expect(asked).toBe(1)
    mod.decidePermission(wc, 'geolocation', 'allow')
    expect([first, second]).toEqual([[true], [true]])
  })

  it('says no to the old question when a different one replaces it', () => {
    const wc = tab('https://maps.example/')
    const loc = ask(wc, 'geolocation')
    const clip = ask(wc, 'clipboard-read')
    expect(loc).toEqual([false])
    expect(clip).toEqual([])
    expect(mod.permissionState(wc).ask?.kind).toBe('clipboard-read')
  })

  it('never grants a question to the site the tab navigated to after asking', () => {
    const wc = tab('https://asker.example/')
    const got = ask(wc, 'geolocation')
    wc.url = 'https://other.example/'
    mod.dropStaleAsk(wc)
    expect(got).toEqual([false])
    expect(mod.permissionState(wc).ask).toBeUndefined()
    mod.decidePermission(wc, 'geolocation', 'allow')
    expect(check(null, 'geolocation', 'https://asker.example')).toBe(false)
    expect(check(null, 'geolocation', 'https://other.example')).toBe(true)
  })

  it('keeps the question when the tab only moved within the same site', () => {
    const wc = tab('https://asker.example/a')
    const got = ask(wc, 'geolocation')
    wc.url = 'https://asker.example/b'
    mod.dropStaleAsk(wc)
    expect(got).toEqual([])
    expect(mod.permissionState(wc).ask?.origin).toBe('https://asker.example')
  })

  it('siteLocation reports denied without locating when the user blocks', async () => {
    const wc = tab('https://maps.example/')
    const pending = mod.siteLocation(wc, () => mod.decidePermission(wc, 'geolocation', 'block'))
    await expect(pending).resolves.toEqual({ error: 'denied' })
  })
})

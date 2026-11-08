import { describe, it, expect, beforeEach, vi } from 'vitest'

/** The contract is "a row that names the app, or no row at all" -- never a blank
 *  row, never a throw. Fixture is measured live: cmux and Cursor both resolve
 *  via Spotlight, `com.nope.missing` resolves nowhere. */

const APP_PATHS: Record<string, string> = {
  'com.cmuxterm.app': '/Applications/cmux.app',
  'com.todesktop.230313mzl4w4u92': '/Applications/Cursor.app'
}

let iconWillFail: boolean
let iconIsEmpty: boolean
/** `sips` converting the bundle's own .icns is the PRIMARY icon path;
 *  `getFileIcon` is only the fallback, because for cmux it returns the generic
 *  placeholder square rather than the app's artwork. */
let sipsWillFail: boolean
let hasIcns: boolean

vi.mock('fs', () => ({
  existsSync: vi.fn(() => hasIcns),
  readFileSync: vi.fn(() => Buffer.from('ICNSPNG')),
  rmSync: vi.fn()
}))

/** Counted separately from `sips`, so a spawn-per-broadcast regression is still
 *  visible now that one lookup shells out twice. */
const mdfindCalls = { n: 0 }

vi.mock('child_process', () => ({
  execFile: vi.fn(
    (cmd: string, args: string[], _opts: unknown, cb: (e: Error | null, out?: string) => void) => {
      if (cmd === 'sips') return cb(sipsWillFail ? new Error('sips: no such file') : null, '')
      if (cmd !== 'mdfind') return cb(new Error(`unexpected command: ${cmd}`))
      mdfindCalls.n += 1
      // The real mdfind returns 0 with EMPTY stdout for an unknown id -- not an
      // error. Treating "no error" as "found" is the bug this models.
      const id = args[0].match(/'(.+)'/)?.[1] ?? ''
      return cb(null, APP_PATHS[id] ? `${APP_PATHS[id]}\n` : '')
    }
  )
}))

vi.mock('../../../shared/env', () => ({ devLog: { warn: vi.fn(), log: vi.fn() } }))

vi.mock('electron', () => ({
  app: {
    getFileIcon: vi.fn(async () => {
      if (iconWillFail) throw new Error('no icon representation')
      return {
        isEmpty: () => iconIsEmpty,
        toPNG: () => Buffer.from('PNGBYTES')
      }
    })
  }
}))

const { hostAppFor, cachedHostApp, warmHostApp, clearHostAppCache } = await import(
  '../host-app-icon'
)

describe('hostAppFor', () => {
  beforeEach(() => {
    clearHostAppCache()
    iconWillFail = false
    iconIsEmpty = false
    sipsWillFail = false
    hasIcns = true
    mdfindCalls.n = 0
    vi.clearAllMocks()
  })

  it('names the app and carries the icon from its OWN bundle', async () => {
    // The artwork must come from the .icns, not getFileIcon -- see the next test.
    const app = await hostAppFor('com.cmuxterm.app')
    expect(app?.name).toBe('cmux')
    expect(app?.iconPngBase64).toBe(Buffer.from('ICNSPNG').toString('base64'))
  })

  it('falls back to getFileIcon only when the bundle has no .icns', async () => {
    hasIcns = false
    expect((await hostAppFor('com.cmuxterm.app'))?.iconPngBase64).toBe(
      Buffer.from('PNGBYTES').toString('base64')
    )
  })

  it('falls back when sips cannot convert the .icns', async () => {
    sipsWillFail = true
    expect((await hostAppFor('com.cmuxterm.app'))?.iconPngBase64).toBe(
      Buffer.from('PNGBYTES').toString('base64')
    )
  })

  it('strips the .app suffix rather than showing a path', async () => {
    expect((await hostAppFor('com.todesktop.230313mzl4w4u92'))?.name).toBe('Cursor')
  })

  it('is undefined for an id Spotlight cannot place', async () => {
    // mdfind exits 0 with no output here, so this must key on the OUTPUT.
    expect(await hostAppFor('com.nope.missing')).toBeUndefined()
  })

  it('is undefined when the session reported no bundle id at all', async () => {
    expect(await hostAppFor(undefined)).toBeUndefined()
  })

  it('still names the app when every icon path fails', async () => {
    // Losing the picture is fine; losing the row over it is not.
    hasIcns = false
    iconWillFail = true
    const app = await hostAppFor('com.cmuxterm.app')
    expect(app?.name).toBe('cmux')
    expect(app?.iconPngBase64).toBeUndefined()
  })

  it('omits an empty icon rather than rendering a blank square', async () => {
    hasIcns = false
    iconIsEmpty = true
    expect((await hostAppFor('com.cmuxterm.app'))?.iconPngBase64).toBeUndefined()
  })
})

describe('the cache', () => {
  beforeEach(() => {
    clearHostAppCache()
    iconWillFail = false
    iconIsEmpty = false
    sipsWillFail = false
    hasIcns = true
    mdfindCalls.n = 0
    vi.clearAllMocks()
  })

  it('spawns mdfind once per bundle id, however many times it is asked', async () => {
    await hostAppFor('com.cmuxterm.app')
    await hostAppFor('com.cmuxterm.app')
    await hostAppFor('com.cmuxterm.app')
    expect(mdfindCalls.n).toBe(1)
  })

  it('caches the MISSES too, or an unresolvable app re-spawns forever', async () => {
    await hostAppFor('com.nope.missing')
    await hostAppFor('com.nope.missing')
    expect(mdfindCalls.n).toBe(1)
  })

  it('reads nothing before a warm has landed, and the app after', async () => {
    // The status build is synchronous: the first pass legitimately has no row.
    expect(cachedHostApp('com.cmuxterm.app')).toBeUndefined()
    await hostAppFor('com.cmuxterm.app')
    expect(cachedHostApp('com.cmuxterm.app')?.name).toBe('cmux')
  })

  it('spawns ONCE for calls that overlap, not once per caller', async () => {
    // The result cache is written after the await, so a has()-only guard is
    // still empty here -- this is the 472-spawn storm that broke the row.
    await Promise.all([
      hostAppFor('com.cmuxterm.app'),
      hostAppFor('com.cmuxterm.app'),
      hostAppFor('com.cmuxterm.app')
    ])
    expect(mdfindCalls.n).toBe(1)
  })

  it('warms once across back-to-back broadcasts', async () => {
    warmHostApp('com.cmuxterm.app')
    warmHostApp('com.cmuxterm.app')
    warmHostApp('com.cmuxterm.app')
    await vi.waitFor(() => expect(cachedHostApp('com.cmuxterm.app')?.name).toBe('cmux'))
    expect(mdfindCalls.n).toBe(1)
  })

  it('tells the caller when the app landed, so the rows can be re-sent', async () => {
    const onResolved = vi.fn()
    warmHostApp('com.cmuxterm.app', onResolved)
    await vi.waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1))
  })

  it('never calls back for an id it cannot place', async () => {
    const onResolved = vi.fn()
    warmHostApp('com.nope.missing', onResolved)
    await vi.waitFor(() => expect(cachedHostApp('com.nope.missing')).toBeUndefined())
    expect(onResolved).not.toHaveBeenCalled()
  })

  it('warms without being awaited, and never twice', async () => {
    warmHostApp('com.cmuxterm.app')
    await vi.waitFor(() => expect(cachedHostApp('com.cmuxterm.app')?.name).toBe('cmux'))
    warmHostApp('com.cmuxterm.app')
    expect(mdfindCalls.n).toBe(1)
  })
})

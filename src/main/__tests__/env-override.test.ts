/**
 * The admin env switcher's two load-bearing pieces: the flat override file, and
 * readAppEnv()'s precedence.
 *
 * What is deliberately NOT tested here: that CONFIG actually resolves the other
 * Supabase project. CONFIG reads readAppEnv() once at module-eval time, so a
 * test cannot re-resolve it without re-importing the whole module graph — and
 * the thing that would break (import ORDER between env-bootstrap and config) is
 * a property of the bundled main process, not of this module. That was verified
 * against the built CJS output instead.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// env-override.ts resolves its path from homedir() at module load, so the fake
// home has to exist before the import — hence vi.mock + a dynamic import below.
const FAKE_HOME = mkdtempSync(join(tmpdir(), 'mm-env-override-'))
vi.mock('os', async (orig) => {
  const actual = await orig<typeof import('os')>()
  return { ...actual, homedir: () => FAKE_HOME }
})

const OVERRIDE_FILE = join(FAKE_HOME, '.mightymouse-env')

const { readEnvOverride, writeEnvOverride } = await import('../env-override')

describe('env-override file', () => {
  beforeEach(() => {
    if (existsSync(OVERRIDE_FILE)) rmSync(OVERRIDE_FILE)
  })
  afterEach(() => {
    if (existsSync(OVERRIDE_FILE)) rmSync(OVERRIDE_FILE)
  })

  it('reads back what it wrote', () => {
    writeEnvOverride('staging')
    expect(readEnvOverride()).toBe('staging')
    writeEnvOverride('prod')
    expect(readEnvOverride()).toBe('prod')
  })

  it('reports no override when the file is absent', () => {
    expect(readEnvOverride()).toBeNull()
  })

  it('clears the file on null rather than writing "null"', () => {
    writeEnvOverride('staging')
    writeEnvOverride(null)
    expect(existsSync(OVERRIDE_FILE)).toBe(false)
    expect(readEnvOverride()).toBeNull()
  })

  it('clearing an already-absent override is a no-op, not a throw', () => {
    expect(() => writeEnvOverride(null)).not.toThrow()
    expect(readEnvOverride()).toBeNull()
  })

  // A corrupt file must never stop the app booting -- it reads before any UI
  // exists, so a throw here is an app that opens to nothing.
  it('treats garbage as no override', () => {
    writeFileSync(OVERRIDE_FILE, 'PRODUCTION\n', 'utf8')
    expect(readEnvOverride()).toBeNull()
    writeFileSync(OVERRIDE_FILE, '', 'utf8')
    expect(readEnvOverride()).toBeNull()
  })

  // Written by hand at least once, by whoever is debugging.
  it('tolerates surrounding whitespace and case', () => {
    writeFileSync(OVERRIDE_FILE, '  Staging \n', 'utf8')
    expect(readEnvOverride()).toBe('staging')
  })

  it('writes a plain value, not JSON', () => {
    writeEnvOverride('prod')
    expect(readFileSync(OVERRIDE_FILE, 'utf8').trim()).toBe('prod')
  })

  // Regression, found on-device. applyEnvSwitch used to clear the file whenever
  // the requested env matched the BUILD default; on a dev build that default is
  // staging, so "switch to prod" wrote null, the next launch resolved back to
  // staging, and the switch silently did nothing -- surfacing as an unexpected
  // sign-in window.
  //
  // This asserts the property that made the old code wrong: a written override
  // must survive being read back on a build that would default to the OTHER
  // env. It does not exercise applyEnvSwitch itself, which is private to a
  // module that pulls in Electron -- the caller-side guarantee is instead that
  // it now passes `value` through unconditionally.
  it('persists an override that disagrees with the build default', () => {
    writeEnvOverride('prod')
    expect(readEnvOverride()).toBe('prod')
    // And the inverse, so neither direction can regress to a silent clear.
    writeEnvOverride('staging')
    expect(readEnvOverride()).toBe('staging')
  })
})

describe('readAppEnv precedence', () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
    vi.resetModules()
  })

  async function readWith(env: Record<string, string | undefined>): Promise<string | undefined> {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    vi.resetModules()
    const { readAppEnv } = await import('../../shared/env')
    return readAppEnv()
  }

  it('lets the runtime override beat a build-time APP_ENV', async () => {
    // The whole point of the feature: a build baked as prod must be able to run
    // on staging without being rebuilt.
    expect(await readWith({ APP_ENV: 'prod', MM_ENV_OVERRIDE: 'staging' })).toBe('staging')
  })

  it('falls through to APP_ENV when no override is set', async () => {
    expect(await readWith({ APP_ENV: 'prod', MM_ENV_OVERRIDE: undefined })).toBe('prod')
  })

  it('ignores a junk override rather than resolving to it', async () => {
    // MM_ENV_OVERRIDE is set by our own bootstrap, but it is still an env var a
    // shell can set. An unrecognised value must not become a project name.
    expect(await readWith({ APP_ENV: 'prod', MM_ENV_OVERRIDE: 'wat' })).toBe('prod')
  })

  it('returns undefined when nothing is set at all', async () => {
    expect(await readWith({ APP_ENV: undefined, MM_ENV_OVERRIDE: undefined })).toBeUndefined()
  })
})

// Regression, found on-device after three earlier fixes to the same switch.
// env-bootstrap is what turns the FILE into the env var readAppEnv() reads, and
// in dev the switcher relaunches by spawning `npm run dev` -- which inherits our
// environment. A bootstrap that only ever SETS the var leaves a stale inherited
// value in place, so the relaunched app resolves the env it just switched away
// from. On screen that is a switch that restarts and changes nothing.
describe('env-bootstrap owns MM_ENV_OVERRIDE in both directions', () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
    if (existsSync(OVERRIDE_FILE)) rmSync(OVERRIDE_FILE)
    vi.resetModules()
  })

  /** Boot the bootstrap fresh against whatever is on disk + in the env. */
  async function boot(fileValue: string | null, inherited?: string): Promise<string | undefined> {
    if (fileValue === null) {
      if (existsSync(OVERRIDE_FILE)) rmSync(OVERRIDE_FILE)
    } else {
      writeFileSync(OVERRIDE_FILE, `${fileValue}\n`, 'utf8')
    }
    if (inherited === undefined) delete process.env.MM_ENV_OVERRIDE
    else process.env.MM_ENV_OVERRIDE = inherited
    vi.resetModules()
    await import('../env-bootstrap')
    return process.env.MM_ENV_OVERRIDE
  }

  it('replaces an inherited value that disagrees with the file', async () => {
    expect(await boot('prod', 'staging')).toBe('prod')
  })

  it('CLEARS an inherited value when the file is gone', async () => {
    // The direction that actually broke: no file means "build default", and a
    // leftover var must not quietly outrank it.
    expect(await boot(null, 'prod')).toBeUndefined()
  })

  it('sets the var from the file when nothing was inherited', async () => {
    expect(await boot('staging', undefined)).toBe('staging')
  })

  it('ignores a junk file rather than leaving a stale var behind', async () => {
    expect(await boot('PRODUCTION', 'prod')).toBeUndefined()
  })
})

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readdirSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG } from '../../../shared/config'

const HOME = mkdtempSync(join(tmpdir(), 'mm-advanced-'))
const appDir = join(HOME, CONFIG.APP_NAME)
mkdirSync(appDir, { recursive: true })

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => HOME }
})
vi.mock('../../platform', () => ({ resolveBinary: () => null }))

async function load(): Promise<{
  SETTINGS: typeof import('../settings').SETTINGS
  PREFS: typeof import('../prefs').PREFS
  PATHS: typeof import('../paths').PATHS
}> {
  vi.resetModules()
  const { SETTINGS } = await import('../settings')
  const { PREFS } = await import('../prefs')
  const { PATHS } = await import('../paths')
  return { SETTINGS, PREFS, PATHS }
}

const storedAdvanced = (PATHS: { SETTINGS_FILE: string }): unknown =>
  JSON.parse(readFileSync(PATHS.SETTINGS_FILE, 'utf-8')).advancedMode

describe('SETTINGS.advancedMode', () => {
  beforeEach(() => {
    for (const f of readdirSync(appDir)) rmSync(join(appDir, f), { recursive: true, force: true })
  })
  afterEach(() => vi.unstubAllEnvs())
  afterAll(() => rmSync(HOME, { recursive: true, force: true }))

  it('fresh install with no history and onboarding not done is off, and persists off', async () => {
    const { SETTINGS, PATHS } = await load()
    expect(SETTINGS.advancedMode()).toBe(false)
    expect(storedAdvanced(PATHS)).toBe(false)
  })

  it('existing user who finished onboarding is on, and persists on', async () => {
    const { SETTINGS, PREFS, PATHS } = await load()
    PREFS.setOnboardingComplete(true)
    expect(SETTINGS.advancedMode()).toBe(true)
    expect(storedAdvanced(PATHS)).toBe(true)
  })

  it('existing user with run history but no onboarding flag is on', async () => {
    const { SETTINGS, PATHS } = await load()
    writeFileSync(PATHS.HISTORY, '{}\n')
    expect(SETTINGS.advancedMode()).toBe(true)
  })

  it('a stored choice wins over the existing-user default', async () => {
    const { SETTINGS, PREFS } = await load()
    PREFS.setOnboardingComplete(true)
    SETTINGS.set({ advancedMode: false })
    expect(SETTINGS.advancedMode()).toBe(false)
  })

  it('a stored on survives a fresh-install look', async () => {
    const { SETTINGS } = await load()
    SETTINGS.set({ advancedMode: true })
    expect(SETTINGS.advancedMode()).toBe(true)
  })

  it('MM_INSTANCE=devtest is always off, even when stored on', async () => {
    vi.stubEnv('MM_INSTANCE', 'devtest')
    const { SETTINGS, PREFS } = await load()
    PREFS.setOnboardingComplete(true)
    SETTINGS.set({ advancedMode: true })
    expect(SETTINGS.advancedMode()).toBe(false)
  })

  it('first answer is cached on disk so a later history file does not flip a fresh install on', async () => {
    const first = await load()
    expect(first.SETTINGS.advancedMode()).toBe(false)
    writeFileSync(first.PATHS.HISTORY, '{}\n')
    const second = await load()
    expect(second.SETTINGS.advancedMode()).toBe(false)
  })
})

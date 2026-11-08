import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG } from '../../../shared/config'
import { PHONE_REMOTE_SKINS } from '../../../shared/types'

// PREFS is a flat write-through store keyed off PATHS, which derives every path
// from os.homedir() (NOT electron's app.getPath). paths.ts captures the home dir
// into a module-level const at eval time, so the temp home must exist and homedir()
// must already return it BEFORE prefs.ts (→ paths.ts) is first imported.
//
// So: create the temp dir at module load (top of file, before any import of prefs),
// mock os.homedir to return it, then import PREFS dynamically AFTER the mock is in
// place. Round-trips hit the real filesystem under the temp home — disposable, and
// the actual read/write/parse behavior is what we want to exercise.
const HOME = mkdtempSync(join(tmpdir(), 'mm-prefs-'))
mkdirSync(join(HOME, CONFIG.APP_NAME), { recursive: true })

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => HOME }
})

const appDir = join(HOME, CONFIG.APP_NAME)
const file = (name: string): string => join(appDir, name)

// Loaded once in beforeAll, after the os mock is active.
let PREFS: typeof import('../prefs').PREFS

describe('PREFS', () => {
  beforeAll(async () => {
    PREFS = (await import('../prefs')).PREFS
  })

  afterAll(() => {
    rmSync(HOME, { recursive: true, force: true })
  })

  beforeEach(() => {
    // Clear pref files between tests so each starts from "nothing written".
    for (const f of readdirSync(appDir)) unlinkSync(join(appDir, f))
  })

  it('returns defaults when nothing is written', () => {
    expect(PREFS.getCtxToggle()).toBe(false)
    expect(PREFS.getLastInstruction()).toBe('')
    expect(PREFS.getLastMode()).toBeNull()
    // Toggles that default ON when the file is absent.
    expect(PREFS.getSoundEnabled()).toBe(true)
    expect(PREFS.getCaptureHud()).toBe(true)
    expect(PREFS.getDockIcon()).toBe(true)
    // Opt-in toggles default OFF.
    expect(PREFS.getContextLog()).toBe(false)
    expect(PREFS.getCursorCompanion()).toBe(false)
    expect(PREFS.getDynamicIsland()).toBe(false)
    expect(PREFS.getOnboardingComplete()).toBe(false)
  })

  it('round-trips the dock icon toggle', () => {
    PREFS.setDockIcon(true)
    expect(PREFS.getDockIcon()).toBe(true)
    expect(existsSync(file('dock-icon-enabled.txt'))).toBe(true)
    PREFS.setDockIcon(false)
    expect(PREFS.getDockIcon()).toBe(false)
  })

  it('round-trips the dynamic island toggle', () => {
    PREFS.setDynamicIsland(true)
    expect(PREFS.getDynamicIsland()).toBe(true)
    expect(existsSync(file('dynamic-island-enabled.txt'))).toBe(true)
    PREFS.setDynamicIsland(false)
    expect(PREFS.getDynamicIsland()).toBe(false)
  })

  it('round-trips a boolean toggle through disk', () => {
    PREFS.setCtxToggle(true)
    expect(PREFS.getCtxToggle()).toBe(true)
    expect(existsSync(file('rewrite-ctx-toggle.txt'))).toBe(true)
    PREFS.setCtxToggle(false)
    expect(PREFS.getCtxToggle()).toBe(false)
  })

  it('persists and trims the last instruction', () => {
    PREFS.setLastInstruction('  make it shorter  ')
    expect(PREFS.getLastInstruction()).toBe('make it shorter')
  })

  it('only accepts valid modes, else null', () => {
    PREFS.setLastMode('ask')
    expect(PREFS.getLastMode()).toBe('ask')
    // A garbage value on disk must not be returned as a mode.
    writeFileSync(file('rewrite-last-mode.txt'), 'bogus', 'utf-8')
    expect(PREFS.getLastMode()).toBeNull()
  })

  it('generates a stable anon id and reuses it', () => {
    const id = PREFS.getAnonId()
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(PREFS.getAnonId()).toBe(id) // second read is identical, not regenerated
  })

  it('clamps max recording minutes and floors nonsense to the default', () => {
    PREFS.setMaxRecordingMin(12)
    expect(PREFS.getMaxRecordingMin()).toBe(12)
    // <= 0 / non-finite falls back to the 5-minute default on write.
    PREFS.setMaxRecordingMin(0)
    expect(PREFS.getMaxRecordingMin()).toBe(5)
    // A tiny positive value is floored at 0.1, not zeroed out.
    PREFS.setMaxRecordingMin(0.01)
    expect(PREFS.getMaxRecordingMin()).toBe(0.1)
  })

  it('round-trips the backend pref', () => {
    const before = PREFS.getBackend()
    expect(typeof before).toBe('string')
    PREFS.setBackend(before)
    expect(PREFS.getBackend()).toBe(before)
  })

  // Regression: 'military' was added to PhoneRemoteSkin but the getter still
  // validated against three hand-written literals, so the write landed and the
  // very next read coerced it back to the default -- the phone painted the new
  // skin, then snapped away. Looping the union (rather than naming skins here)
  // is the point: this test only stays honest if it can't be written to pass
  // for the skins that happened to exist the day it was authored.
  it('round-trips every skin in the union', () => {
    for (const skin of PHONE_REMOTE_SKINS) {
      PREFS.setPhoneRemoteSkin(skin)
      expect(PREFS.getPhoneRemoteSkin()).toBe(skin)
    }
  })

  it('falls back to the default skin for an unknown value', () => {
    writeFileSync(file('phone-remote-skin.txt'), 'not-a-skin', 'utf-8')
    expect(PREFS.getPhoneRemoteSkin()).toBe(CONFIG.PHONE_REMOTE.SKIN_DEFAULT)
  })
})

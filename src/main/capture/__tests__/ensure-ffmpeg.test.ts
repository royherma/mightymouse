import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock the three collaborators so the self-heal logic is testable without a real
// filesystem, a real settings file, or a real login shell:
//  - existsSync decides whether the cached ffmpeg path still points at a file
//  - SETTINGS stands in for the on-disk store (get/set)
//  - resolveBinary stands in for the priority-dir + `which` lookup
const existsSync = vi.fn<(p: string) => boolean>()
const settingsGet = vi.fn<() => { ffmpegPath: string }>()
const settingsSet = vi.fn()
const resolveBinary = vi.fn<(name: string) => string | null>()
const clearBinaryCache = vi.fn()

vi.mock('fs', () => ({ existsSync: (p: string) => existsSync(p) }))
vi.mock('../../store/settings', () => ({
  SETTINGS: { get: () => settingsGet(), set: (patch: unknown) => settingsSet(patch) }
}))
vi.mock('../../platform', () => ({
  resolveBinary: (name: string) => resolveBinary(name),
  clearBinaryCache: () => clearBinaryCache()
}))

import { ensureFfmpeg } from '../ensure-ffmpeg'

const CACHED = '/opt/homebrew/bin/ffmpeg'
const FRESH = '/usr/local/bin/ffmpeg'

describe('ensureFfmpeg', () => {
  beforeEach(() => {
    existsSync.mockReset()
    settingsGet.mockReset()
    settingsSet.mockReset()
    resolveBinary.mockReset()
    clearBinaryCache.mockReset()
  })

  it('takes the fast path when the cached path is still valid', () => {
    settingsGet.mockReturnValue({ ffmpegPath: CACHED })
    existsSync.mockReturnValue(true)

    expect(ensureFfmpeg()).toBe(CACHED)
    // The hit path must not shell out or write — it runs on every record.
    expect(resolveBinary).not.toHaveBeenCalled()
    expect(settingsSet).not.toHaveBeenCalled()
  })

  // The regression this module exists for: a user installs ffmpeg while the app
  // is running. Settings cached the path once at load, so the old bare
  // existsSync guard kept throwing "Can't find ffmpeg" until they relaunched.
  it('re-resolves when the cached path went stale, and persists the new one', () => {
    settingsGet.mockReturnValue({ ffmpegPath: CACHED })
    existsSync.mockReturnValue(false)
    resolveBinary.mockReturnValue(FRESH)

    expect(ensureFfmpeg()).toBe(FRESH)
    expect(resolveBinary).toHaveBeenCalledWith('ffmpeg')
    expect(settingsSet).toHaveBeenCalledWith({ ffmpegPath: FRESH })
  })

  // resolve-binary.ts memoizes per name, so a "not-found" recorded at startup
  // would be returned forever unless the cache is dropped first.
  it('clears the resolver cache before re-resolving', () => {
    settingsGet.mockReturnValue({ ffmpegPath: CACHED })
    existsSync.mockReturnValue(false)
    resolveBinary.mockReturnValue(FRESH)

    ensureFfmpeg()
    expect(clearBinaryCache).toHaveBeenCalled()
  })

  it('returns null when ffmpeg genuinely is not installed', () => {
    settingsGet.mockReturnValue({ ffmpegPath: CACHED })
    existsSync.mockReturnValue(false)
    resolveBinary.mockReturnValue(null)

    expect(ensureFfmpeg()).toBeNull()
    // Nothing resolved, so nothing to persist — don't write a null/empty path.
    expect(settingsSet).not.toHaveBeenCalled()
  })

  it('resolves from empty when no path was ever stored (fresh install)', () => {
    settingsGet.mockReturnValue({ ffmpegPath: '' })
    existsSync.mockReturnValue(false)
    resolveBinary.mockReturnValue(FRESH)

    expect(ensureFfmpeg()).toBe(FRESH)
    expect(settingsSet).toHaveBeenCalledWith({ ffmpegPath: FRESH })
  })
})

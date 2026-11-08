/**
 * Tests for screen-permission.ts — the pre-flight guard for capture actions.
 *
 * The two behaviours worth locking down are the cache asymmetry rules, because
 * both fail SILENTLY and in opposite directions:
 *   - caching a pass keeps the hot path fast;
 *   - caching a FAILURE would make a permission the user just granted keep
 *     reporting itself as broken until the TTL expired.
 *
 * Node-only (vitest env: node). Electron + platform bridges fully mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const H = vi.hoisted(() => ({
  selfTestOk: true,
  runSelfTest: vi.fn(),
  request: vi.fn(),
  route: vi.fn(),
  track: vi.fn(),
  screenStatus: vi.fn(),
  getSources: vi.fn()
}))

vi.mock('electron', () => ({
  systemPreferences: { getMediaAccessStatus: H.screenStatus },
  desktopCapturer: { getSources: H.getSources }
}))

vi.mock('../../platform', () => ({
  runSelfTest: (...a: unknown[]) => {
    H.runSelfTest(...a)
    return Promise.resolve({ ok: H.selfTestOk })
  },
  PERMISSIONS: { request: H.request }
}))
vi.mock('../../routing', () => ({ route: H.route }))
vi.mock('../../analytics', () => ({ track: H.track }))

import {
  ensureScreenPermission,
  getMirrorSources,
  hasScreenPermission,
  resetScreenPermissionCache,
  classifyMirrorError,
  SCREEN_ACTION
} from '../screen-permission'
import { CONFIG } from '../../../shared/config'

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  H.screenStatus.mockReturnValue('granted')
  H.getSources.mockResolvedValue([])
  H.selfTestOk = true
  resetScreenPermissionCache()
})

afterEach(() => vi.unstubAllGlobals())

describe('hasScreenPermission', () => {
  it('probes when nothing is cached', async () => {
    expect(await hasScreenPermission()).toBe(true)
    expect(H.runSelfTest).toHaveBeenCalledTimes(1)
  })

  it('caches a PASS so the probe stays off the hot path', async () => {
    await hasScreenPermission()
    await hasScreenPermission()
    await hasScreenPermission()
    expect(H.runSelfTest).toHaveBeenCalledTimes(1)
  })

  it('never caches a FAILURE — a fresh grant must be seen immediately', async () => {
    H.selfTestOk = false
    expect(await hasScreenPermission()).toBe(false)
    expect(await hasScreenPermission()).toBe(false)
    expect(H.runSelfTest).toHaveBeenCalledTimes(2)

    // The user grants it in the pane we opened; the very next call must pass.
    H.selfTestOk = true
    expect(await hasScreenPermission()).toBe(true)
  })

  it('re-probes after the cache is explicitly reset', async () => {
    await hasScreenPermission()
    resetScreenPermissionCache()
    await hasScreenPermission()
    expect(H.runSelfTest).toHaveBeenCalledTimes(2)
  })
})

describe('ensureScreenPermission', () => {
  it('returns true and stays silent when the permission works', async () => {
    const onDenied = vi.fn()
    expect(await ensureScreenPermission(SCREEN_ACTION.screenshot, onDenied)).toBe(true)
    expect(onDenied).not.toHaveBeenCalled()
    expect(H.request).not.toHaveBeenCalled()
    expect(H.track).not.toHaveBeenCalled()
  })

  it('tells the caller AND fires the real grant flow when denied', async () => {
    H.selfTestOk = false
    const onDenied = vi.fn()

    expect(await ensureScreenPermission(SCREEN_ACTION.screenshot, onDenied)).toBe(false)
    // A message the caller can render — the whole point is that the user is not
    // left with a black frame and a success card.
    expect(onDenied).toHaveBeenCalledTimes(1)
    expect(String(onDenied.mock.calls[0][0])).toBeTruthy()
    // …and a button that actually does something.
    expect(H.request).toHaveBeenCalledWith('screen')
  })

  it('reports which action was blocked', async () => {
    H.selfTestOk = false
    await ensureScreenPermission(SCREEN_ACTION.recording)
    expect(H.track).toHaveBeenCalledWith('screen_permission_blocked', {
      action: SCREEN_ACTION.recording
    })
  })

  it('does not require an onDenied callback', async () => {
    H.selfTestOk = false
    await expect(ensureScreenPermission(SCREEN_ACTION.mirror)).resolves.toBe(false)
  })
})

// Regression for the bug traced 2026-08-15 (mm-errors issue 6/7): a mirror
// decline reached the phone as a raw dev string ("no screen sources
// (grant=denied, displays=1)") instead of a sentence a person could act on.
// classifyMirrorError is the one place that turns index.ts's `decline(why)`
// text into what the phone shows.
describe('classifyMirrorError', () => {
  it('names the permission when zero sources trace to a denied grant', () => {
    expect(classifyMirrorError('no screen sources (grant=denied, displays=1)')).toBe(
      CONFIG.MIRROR_DECLINE.permissionOff
    )
  })

  it('names the permission for a restricted grant too', () => {
    expect(classifyMirrorError('no screen sources (grant=restricted, displays=1)')).toBe(
      CONFIG.MIRROR_DECLINE.permissionOff
    )
  })

  it('gives generic retry copy for a decline with a live grant (teardown/sleep race)', () => {
    expect(classifyMirrorError('no screen sources (grant=granted, displays=1)')).toBe(
      CONFIG.MIRROR_DECLINE.tryAgain
    )
  })

  it('gives generic retry copy for a display-mismatch decline', () => {
    expect(classifyMirrorError('display 3 not among 2')).toBe(CONFIG.MIRROR_DECLINE.tryAgain)
  })

  it('gives generic retry copy for a getSources() throw', () => {
    expect(classifyMirrorError('getSources failed: Failed to get sources.')).toBe(
      CONFIG.MIRROR_DECLINE.tryAgain
    )
  })

  it('gives generic retry copy for the raw Chromium rejection text', () => {
    expect(
      classifyMirrorError('Video was requested, but no video stream was provided')
    ).toBe(CONFIG.MIRROR_DECLINE.tryAgain)
  })

  it('passes unrelated mirrorError reasons through unchanged', () => {
    expect(classifyMirrorError('connection failed')).toBe('connection failed')
  })
})

describe('getMirrorSources', () => {
  it.each(['denied', 'restricted', 'not-determined'])('declines %s on macOS without entering native enumeration', async (status) => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' })
    H.screenStatus.mockReturnValue(status)
    const sources = await getMirrorSources()
    expect(sources).toEqual([])
    expect(H.getSources).not.toHaveBeenCalled()
    expect(H.screenStatus).toHaveBeenCalledWith('screen')
  })

  it('enumerates after the permission is granted, without caching the denial', async () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' })
    H.screenStatus.mockReturnValueOnce('denied').mockReturnValue('granted')
    const sources = [{ id: 'screen:1:0', display_id: '1' }]
    H.getSources.mockResolvedValue(sources)
    expect(await getMirrorSources()).toEqual([])
    expect(await getMirrorSources()).toBe(sources)
    expect(H.getSources).toHaveBeenCalledExactlyOnceWith({ types: ['screen'] })
  })

  it('preserves enumeration failures for the existing decline handler', async () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' })
    H.getSources.mockRejectedValueOnce(new Error('Failed to get sources.'))
    await expect(getMirrorSources()).rejects.toThrow('Failed to get sources.')
  })

  it.each(['win32', 'linux'])('does not apply the macOS permission gate on %s', async (platform) => {
    vi.stubGlobal('process', { ...process, platform })
    H.screenStatus.mockReturnValue('denied')
    await getMirrorSources()
    expect(H.screenStatus).not.toHaveBeenCalled()
    expect(H.getSources).toHaveBeenCalledExactlyOnceWith({ types: ['screen'] })
  })
})

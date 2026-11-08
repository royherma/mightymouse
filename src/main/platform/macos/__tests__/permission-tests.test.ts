/**
 * Tests for permission-tests.ts — the functional self-tests that gate onboarding.
 *
 * Covers, per the plan:
 *   1. granted status + working primitive → { ok: true }
 *   2. granted status + failing primitive (empty file / no devices / dead tap) → { ok: false } + detail
 *   3. denied status → { ok: false } WITHOUT invoking the heavy probe (short-circuit)
 *   4. needsOnboarding() matrix — complete flag × required-perm pass/fail
 *
 * Node-only (vitest env: node). Electron + native bridges are fully mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ───────────────────────────────────────────────────────────────────
//
// Shared mutable state lives in vi.hoisted() so the vi.mock factories (which are
// hoisted to the top of the file) can reference it without a TDZ error.

const H = vi.hoisted(() => ({
  sysPref: {
    isTrustedAccessibilityClient: vi.fn(() => true),
    getMediaAccessStatus: vi.fn((): string => 'granted')
  },
  execFile: vi.fn(),
  fileSize: 4096,
  fileExists: true,
  hotkeyAvailable: vi.fn(() => true),
  audioDevices: [{ index: '0', name: 'Built-in Mic' }] as Array<{ index: string; name: string }>,
  deviceError: undefined as string | undefined
}))

vi.mock('electron', () => ({
  systemPreferences: H.sysPref,
  shell: { openExternal: vi.fn() }
}))

// execFile is callback-style: execFile(bin, args, cb).
vi.mock('child_process', () => ({ execFile: (...a: unknown[]) => H.execFile(...a) }))

vi.mock('fs', () => ({
  existsSync: () => H.fileExists,
  statSync: () => ({ size: H.fileSize }),
  rmSync: vi.fn()
}))

vi.mock('../../../capture/capture-hotkey', () => ({
  isCaptureHotkeyAvailable: () => H.hotkeyAvailable()
}))

vi.mock('../../../capture/devices', () => ({
  listAvDevices: () => Promise.resolve({ video: [], audio: H.audioDevices, error: H.deviceError })
}))

vi.mock('../../../store/paths', () => ({ PATHS: { TMP: '/fake/tmp' } }))
vi.mock('../../../shared/config', () => ({
  CONFIG: { SCREENCAPTURE_PATH: '/usr/sbin/screencapture' }
}))

import { runSelfTest, needsOnboarding } from '../permission-tests'

// Aliases so the test bodies below read naturally.
const mockSysPref = H.sysPref
const mockExecFile = H.execFile
const mockHotkeyAvailable = H.hotkeyAvailable

// Default execFile: succeeds (err = null), invoking the last-arg callback.
function execFileOk(): void {
  mockExecFile.mockImplementation((_bin, _args, cb) => cb(null))
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSysPref.isTrustedAccessibilityClient.mockReturnValue(true)
  mockSysPref.getMediaAccessStatus.mockReturnValue('granted')
  mockHotkeyAvailable.mockReturnValue(true)
  H.audioDevices = [{ index: '0', name: 'Built-in Mic' }]
  H.deviceError = undefined
  H.fileSize = 4096
  H.fileExists = true
  execFileOk()
})

describe('runSelfTest — accessibility', () => {
  it('trusted client + live hotkey tap → ok', async () => {
    expect(await runSelfTest('accessibility')).toEqual({ ok: true })
  })

  it('not a trusted client → not ok, no tap check needed', async () => {
    mockSysPref.isTrustedAccessibilityClient.mockReturnValue(false)
    const r = await runSelfTest('accessibility')
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/trusted/i)
  })

  it('trusted but hotkey tap dead → not ok, and asks for a restart', async () => {
    mockHotkeyAvailable.mockReturnValue(false)
    const r = await runSelfTest('accessibility')
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/restart/i)
    // The regression this guards: without needsRestart the user finishes
    // onboarding, needsOnboarding() re-reads this same failure and reopens it.
    expect(r.needsRestart).toBe(true)
  })
})

describe('runSelfTest — screen', () => {
  it('granted + non-trivial frame → ok', async () => {
    expect(await runSelfTest('screen')).toEqual({ ok: true })
    expect(mockExecFile).toHaveBeenCalledOnce()
  })

  it('flag says denied but capture works → ok (stale TCC cache)', async () => {
    // The flag is cached per process, so a fresh grant still reads 'denied'.
    mockSysPref.getMediaAccessStatus.mockReturnValue('denied')
    expect(await runSelfTest('screen')).toEqual({ ok: true })
    expect(mockExecFile).toHaveBeenCalledOnce()
  })

  it('denied and capture fails → not ok, points at System Settings', async () => {
    mockSysPref.getMediaAccessStatus.mockReturnValue('denied')
    H.fileSize = 10
    const r = await runSelfTest('screen')
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/system settings/i)
  })

  it('not-determined and capture fails → says the app is not in the list yet', async () => {
    mockSysPref.getMediaAccessStatus.mockReturnValue('not-determined')
    H.fileSize = 10
    const r = await runSelfTest('screen')
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/isn.t in the Screen Recording list/i)
  })

  it('granted but capture produces an empty frame → not ok, tells the user to restart', async () => {
    H.fileSize = 10 // below MIN_SCREENSHOT_BYTES
    const r = await runSelfTest('screen')
    expect(r.ok).toBe(false)
    // This branch owns the quit-and-reopen advice — it's the only state where a
    // grant is on but capture still fails, which is what a restart fixes.
    expect(r.detail).toMatch(/quit and reopen/i)
  })

  it('granted but screencapture errors → not ok, restart advice not raw tool output', async () => {
    mockExecFile.mockImplementation((_b, _a, cb) => cb(new Error('boom')))
    const r = await runSelfTest('screen')
    expect(r.ok).toBe(false)
    // `boom` is for the log, never for the user.
    expect(r.detail).toMatch(/quit and reopen/i)
    expect(r.detail).not.toMatch(/boom/)
  })
})

describe('runSelfTest — microphone', () => {
  it('granted + ≥1 audio device → ok', async () => {
    expect(await runSelfTest('microphone')).toEqual({ ok: true })
  })

  it('denied → not ok, no device probe', async () => {
    mockSysPref.getMediaAccessStatus.mockReturnValue('denied')
    const r = await runSelfTest('microphone')
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/microphone/i)
  })

  it('granted but no audio devices → not ok', async () => {
    H.audioDevices = []
    const r = await runSelfTest('microphone')
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/device/i)
  })

  // A dyld-crashed ffmpeg enumerates nothing. Blaming the mic there sent the user
  // to an already-granted permission toggle.
  it('ffmpeg failed to run → blames ffmpeg, not the microphone', async () => {
    H.audioDevices = []
    H.deviceError = 'dyld[1]: Library not loaded: /opt/homebrew/opt/x265/lib/libx265.215.dylib'
    const r = await runSelfTest('microphone')
    expect(r.ok).toBe(false)
    // Asserts the INTENT, not the wording: "ffmpeg" is a jargon noun that must
    // not reach user copy (brand-voice.md:36), so the string says "recording
    // tool" instead. What matters is that it blames the tool and offers the fix.
    expect(r.detail).toMatch(/recording tool/i)
    expect(r.detail).not.toMatch(/audio input devices/i)
  })
})

describe('needsOnboarding', () => {
  it('not completed → always true, regardless of perms', async () => {
    expect(await needsOnboarding(false)).toBe(true)
  })

  it('completed + all required perms pass → false', async () => {
    expect(await needsOnboarding(true)).toBe(false)
  })

  it('completed but a required perm regressed → true (re-gate)', async () => {
    // Accessibility was granted before but the tap is now dead.
    mockHotkeyAvailable.mockReturnValue(false)
    expect(await needsOnboarding(true)).toBe(true)
  })

  it('completed + only the optional mic failing → false (mic not required)', async () => {
    H.audioDevices = []
    // getMediaAccessStatus stays 'granted' for screen; mic device list is empty
    // but microphone is not in requiredPermissionKeys().
    expect(await needsOnboarding(true)).toBe(false)
  })
})

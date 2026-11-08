// Functional self-tests for the three macOS permissions the app needs.
//
// Why these exist separately from PERMISSIONS.list(): the OS status flag lies.
// `getMediaAccessStatus('screen') === 'granted'` can be true while a stale TCC
// entry still yields black frames; accessibility can read "trusted" while the
// uiohook event tap never attached. The onboarding wizard needs to prove the
// permission actually *works*, not just that a toggle is on.
//
// Probes are intentionally CHEAP and NON-DESTRUCTIVE — a trust check, one PNG
// frame to a temp file, a device-list read. No full recordings, no clipboard
// mutation. Each returns { ok, detail } so the UI can show a precise reason.

import { systemPreferences } from 'electron'
import { execFile } from 'child_process'
import { existsSync, statSync, rmSync } from 'fs'
import { join } from 'path'
import { PATHS } from '../../store/paths'
import { CONFIG } from '../../../shared/config'
import { isCaptureHotkeyAvailable } from '../../capture/capture-hotkey'
import { listAvDevices } from '../../capture/devices'
import { PERMISSIONS, requiredPermissionKeys } from './permissions'
import { PermissionCheck, PermissionKey, PermissionTest } from '../../../shared/types'

/** A captured screen frame above this many bytes is treated as a real image.
 *  Shared with the runtime capture paths so the probe and the real thing agree. */
const MIN_SCREENSHOT_BYTES = CONFIG.MIN_SCREENSHOT_BYTES

/**
 * Accessibility: must be a trusted AX client AND the global event tap (uiohook)
 * must be live — that tap is what makes every hotkey fire. A trusted client
 * with a dead tap means hotkeys silently no-op, exactly the failure we gate on.
 */
function testAccessibility(): PermissionTest {
  let trusted = false
  try {
    trusted = systemPreferences.isTrustedAccessibilityClient(false)
  } catch (err) {
    return { ok: false, detail: `trust check failed: ${String(err)}` }
  }
  if (!trusted) return { ok: false, detail: 'Not a trusted accessibility client yet.' }
  if (!isCaptureHotkeyAvailable()) {
    // Trusted but no tap: the grant landed after the tap load was attempted, and
    // that result is cached for the life of the process. Only a relaunch attaches
    // it. Without needsRestart the user finishes onboarding, needsOnboarding()
    // re-reads this same failure and reopens it — the loop that made a real user
    // quit on 2026-09-02.
    return {
      ok: false,
      detail: `It's on, but macOS needs a restart to apply it. Quit and reopen ${CONFIG.APP_NAME}.`,
      needsRestart: true
    }
  }
  return { ok: true }
}

/**
 * Screen Recording: capture a single frame to a temp file and assert it's a
 * non-trivial PNG. Reuses the same `screencapture -x` binary the app uses for
 * real shots, so a pass here means real shots will work too.
 */
function testScreen(): Promise<PermissionTest> {
  const probePath = join(PATHS.TMP, `perm-probe-screen-${process.pid}.png`)
  return new Promise((resolve) => {
    execFile(CONFIG.SCREENCAPTURE_PATH, ['-x', '-t', 'png', probePath], (err) => {
      try {
        const captured =
          !err && existsSync(probePath) && statSync(probePath).size >= MIN_SCREENSHOT_BYTES
        if (captured) {
          resolve({ ok: true })
          return
        }
        const granted = systemPreferences.getMediaAccessStatus('screen') === 'granted'
        resolve({ ok: false, detail: screenFailureDetail(), needsRestart: granted })
      } finally {
        try {
          rmSync(probePath, { force: true })
        } catch {
          /* best effort */
        }
      }
    })
  })
}

/**
 * Why the frame came back empty. Explains a failure, never decides one — the
 * flag is cached per process, so a fresh grant still reads 'denied'.
 */
function screenFailureDetail(): string {
  const status = systemPreferences.getMediaAccessStatus('screen')
  // Grant on, capture dead: only a relaunch clears the cached refusal.
  if (status === 'granted') {
    return `It's on, but macOS needs a restart to apply it. Quit and reopen ${CONFIG.APP_NAME}.`
  }
  // 'not-determined' has no row in the pane yet, so "turn it on" sends the user
  // hunting for something that isn't there.
  return status === 'not-determined'
    ? `${CONFIG.APP_NAME} isn't in the Screen Recording list yet. Click Allow, or add it with + in System Settings.`
    : 'Screen Recording is off in System Settings.'
}

const FFMPEG_BROKEN_DETAIL = `The recording tool on this Mac can't start. ${CONFIG.APP_NAME} can download a working one.`

/**
 * Microphone: status granted AND ffmpeg can enumerate at least one AVFoundation
 * audio device. (A denied mic still lists devices on some macOS versions, so we
 * gate on status first and use the device list as a "ffmpeg is wired up" check.)
 */
async function testMicrophone(): Promise<PermissionTest> {
  if (systemPreferences.getMediaAccessStatus('microphone') !== 'granted') {
    return { ok: false, detail: 'Microphone is off in System Settings.' }
  }
  try {
    const devices = await listAvDevices()
    // ffmpeg died before it could enumerate: the mic is fine, our tool isn't.
    // Logged verbatim because the dyld line names the exact missing library,
    // and nothing else in the app writes a trace of this failure.
    if (devices.error) {
      console.error('[permissions] ffmpeg device enumeration failed:', devices.error)
      return { ok: false, detail: FFMPEG_BROKEN_DETAIL, ffmpegBroken: true }
    }
    if (devices.audio.length === 0) {
      return { ok: false, detail: 'No audio input devices found.' }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, detail: `device check failed: ${String(err)}` }
  }
}

/** Run the probe for a single permission key. */
export function runSelfTest(key: PermissionKey): Promise<PermissionTest> {
  switch (key) {
    case 'accessibility':
      return Promise.resolve(testAccessibility())
    case 'screen':
      return testScreen()
    case 'microphone':
      return testMicrophone()
  }
}

/** OS status + functional self-test for every permission, for the wizard. */
export async function buildPermissionChecks(): Promise<PermissionCheck[]> {
  const states = PERMISSIONS.list()
  return Promise.all(
    states.map(async (s) => ({
      key: s.key,
      status: s.status,
      test: await runSelfTest(s.key)
    }))
  )
}

/**
 * True when the user should be shown the onboarding wizard: either they've
 * never completed it, or a *required* permission's self-test currently fails.
 * The latter re-gates a user whose grant later broke (revoked in System
 * Settings, OS update reset TCC, etc.) even if they finished onboarding before.
 */
export async function needsOnboarding(onboardingComplete: boolean): Promise<boolean> {
  if (!onboardingComplete) return true
  const required = requiredPermissionKeys()
  for (const key of required) {
    const { ok } = await runSelfTest(key)
    if (!ok) return true
  }
  return false
}

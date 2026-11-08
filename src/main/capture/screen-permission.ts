/**
 * Pre-flight guard for every action that needs macOS Screen Recording.
 *
 * WHY A PRE-FLIGHT CHECK AND NOT A try/catch
 * `/usr/sbin/screencapture -x` with the permission denied **exits zero and
 * writes a valid PNG that is empty/black**. It does not error. So the two
 * `failHud('… Screen Recording permission?')` calls that used to sit in
 * capture/index.ts were unreachable for the case they named: the capture
 * "succeeded", the HUD said "Screenshot saved", and a black image went to the
 * clipboard and on to the model. The only honest signal is to test BEFORE
 * capturing — which is what `runSelfTest('screen')` already does, by asserting
 * the probe frame is over MIN_SCREENSHOT_BYTES rather than trusting the exit
 * code or the TCC status flag (both of which lie about stale grants).
 *
 * This became load-bearing on 2026-07-31, when Screen Recording dropped from
 * required to optional: before that a user without the grant could never reach
 * a hotkey, so the black-frame path was mostly unreachable. Now it's the normal
 * path for anyone who skipped the step.
 *
 */

import { desktopCapturer, systemPreferences } from 'electron'
import { PERMISSIONS, runSelfTest } from '../platform'
import { route } from '../routing'
import { track } from '../analytics'
import { ANALYTICS_EVENT } from '../../shared/analytics-events'
import { CONFIG } from '../../shared/config'

/**
 * Which action asked. Used for the message and for the analytics row that tells
 * us whether users who skip the grant come back and give it at point of use.
 */
export const SCREEN_ACTION = {
  screenshot: 'screenshot',
  recording: 'recording',
  context: 'context',
  mirror: 'mirror'
} as const

export type ScreenAction = (typeof SCREEN_ACTION)[keyof typeof SCREEN_ACTION]

export async function getMirrorSources(): Promise<Electron.DesktopCapturerSource[]> {
  if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
    return []
  }
  return desktopCapturer.getSources({ types: ['screen'] })
}

/**
 * A passing probe is cached briefly: `runSelfTest('screen')` spawns a
 * screencapture process and writes a temp file, and putting that on the hot
 * path of every screenshot would add latency to the action we most want to feel
 * instant.
 *
 * A FAILING probe is never cached. The user may have granted it in the pane we
 * just opened, and the next attempt has to see that immediately — caching the
 * failure is how a fixed permission would keep reporting itself as broken.
 */
let grantedUntil = 0

/** Invalidate the cached pass — call when a grant may have changed underneath us. */
export function resetScreenPermissionCache(): void {
  grantedUntil = 0
}

/**
 * True when Screen Recording actually works right now.
 *
 * Cheap when it recently passed, a real probe otherwise. No side effects — use
 * `ensureScreenPermission` when a denial should also tell the user.
 */
export async function hasScreenPermission(): Promise<boolean> {
  if (Date.now() < grantedUntil) return true
  const { ok } = await runSelfTest('screen')
  if (ok) grantedUntil = Date.now() + CONFIG.SCREEN_PERMISSION_TTL_MS
  return ok
}

// false → the caller MUST abort without reporting success; the grant flow has
// already fired. onDenied is a callback because the surface differs per caller
// (HUD for a capture run, Panel for a context grab).
export async function ensureScreenPermission(
  action: ScreenAction,
  onDenied?: (message: string) => void
): Promise<boolean> {
  if (await hasScreenPermission()) return true

  track(ANALYTICS_EVENT.screen_permission_blocked, { action })
  onDenied?.(CONFIG.SCREEN_PERMISSION.blocked)

  // Fire the real grant flow, not just a message. This is the same call the
  // Setup Check row uses, and since 2026-07-31 it passes openPreferences=true so
  // it still lands the user somewhere when macOS suppresses the prompt.
  void PERMISSIONS.request('screen')
  return false
}

/**
 * Open the Setup surface, which owns the screen row and its grant fix.
 * Exposed so a denial message can carry a button rather than just words.
 */
export function openScreenPermissionFix(): void {
  route('setup')
}

// True for index.ts decline() reasons — never reclassify an unrelated
// mirrorError like 'connection failed', which already reads fine as-is.
function isMirrorDeclineReason(reason: string): boolean {
  return (
    reason.includes('no screen sources') ||
    reason.includes('not among') ||
    reason.includes('getSources failed') ||
    reason.includes('Video was requested, but no video stream was provided')
  )
}

// grant=denied/restricted → permission copy; other decline reasons (mid-
// teardown, sleeping display) → generic retry, since there's no grant to fix.
export function classifyMirrorError(reason: string): string {
  if (!isMirrorDeclineReason(reason)) return reason
  const permissionOff = reason.includes('grant=denied') || reason.includes('grant=restricted')
  return permissionOff ? CONFIG.MIRROR_DECLINE.permissionOff : CONFIG.MIRROR_DECLINE.tryAgain
}

/** Names the capability and the fix, never "permission denied". */
const MIC_BLOCKED_MESSAGE = `${CONFIG.APP_NAME} needs permission to hear your mic`

/** Which action asked for the mic. Mirrors SCREEN_ACTION. */
export const MIC_ACTION = {
  listen: 'listen',
  dictation: 'dictation',
  recording: 'recording'
} as const

export type MicAction = (typeof MIC_ACTION)[keyof typeof MIC_ACTION]

let micGrantedUntil = 0

/** Invalidate the cached mic pass — call when a grant may have changed. */
export function resetMicPermissionCache(): void {
  micGrantedUntil = 0
}

/**
 * True when the mic works right now. Same lie as the screen path: a denied mic
 * makes ffmpeg exit zero over a WAV of silence, so only a pre-flight is honest.
 */
export async function hasMicPermission(): Promise<boolean> {
  if (Date.now() < micGrantedUntil) return true
  const { ok } = await runSelfTest('microphone')
  if (ok) micGrantedUntil = Date.now() + CONFIG.SCREEN_PERMISSION_TTL_MS
  return ok
}

/** Guard a mic-dependent action. Same contract as `ensureScreenPermission`. */
export async function ensureMicPermission(
  action: MicAction,
  onDenied?: (message: string) => void
): Promise<boolean> {
  if (await hasMicPermission()) return true

  track(ANALYTICS_EVENT.mic_permission_blocked, { action })
  onDenied?.(MIC_BLOCKED_MESSAGE)

  void PERMISSIONS.request('microphone')
  return false
}

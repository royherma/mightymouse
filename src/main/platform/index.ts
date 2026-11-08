/**
 * The platform boundary. This is the ONE place `process.platform` is allowed to
 * branch the OS implementation — everywhere else imports named functions from
 * here and never knows which OS answered.
 *
 * Pattern mirrors the `BACKENDS` registry in backend/adapters.ts: a small map
 * picked once, no scattered `if (platform === …)` in business logic. Adding an
 * OS = write a sibling that satisfies `PlatformImpl`, add one arm below.
 */
import type { PlatformImpl } from './contract'
export type { HostKeyboardLayoutType } from './contract'
// Pure validation logic, not an OS-specific capability (no windows impl needed) —
// same category as window-layout-geometry.ts's computeLayout (contract.ts §2.1).
export { clampVolume } from './macos/system-volume'

import { macos } from './macos'
import { windows } from './windows'

function pick(): PlatformImpl {
  switch (process.platform) {
    case 'darwin':
      return macos
    case 'win32':
      return windows
    default:
      // Linux etc. — no impl. Reuse the windows stub's honest-failure behaviour
      // so the app degrades loudly rather than fake-passing onboarding.
      return windows
  }
}

const platform: PlatformImpl = pick()

export default platform

// Named re-exports so call-sites read the same as the old `./macos/*` imports.
export const captureSelection = platform.selection.captureSelection
export const pasteText = platform.selection.pasteText
export const pasteTextToApp = platform.selection.pasteTextToApp
export const setSyntheticPasteListener = platform.selection.setSyntheticPasteListener
export const captureContext = platform.context.captureContext
export const captureFinderSelection = platform.context.captureFinderSelection
export const captureScreenshot = platform.context.captureScreenshot
export const PERMISSIONS = platform.permissions
export const requiredPermissionKeys = platform.requiredPermissionKeys
export const runSelfTest = platform.runSelfTest
export const buildPermissionChecks = platform.buildPermissionChecks
export const needsOnboarding = platform.needsOnboarding
export const resolveBinary = platform.binaries.resolveBinary
export const resolveClaude = platform.binaries.resolveClaude
export const resolveCodex = platform.binaries.resolveCodex
export const resolveOpencode = platform.binaries.resolveOpencode
export const resolveGemini = platform.binaries.resolveGemini
export const resolveNpm = platform.binaries.resolveNpm
export const resolveBrewBin = platform.binaries.resolveBrewBin
export const npmPrefixWritable = platform.binaries.npmPrefixWritable
export const clearBinaryCache = platform.binaries.clearBinaryCache
export const applyLoginShellPath = platform.shell.applyLoginShellPath

// Domain sub-contracts, for a consumer that wants one domain instead of the
// flat re-exports above (all new call-sites should prefer this form).
export const {
  selection,
  context,
  input,
  system,
  permissions,
  binaries,
  shell,
  helpers,
  chrome,
  capabilities
} = platform

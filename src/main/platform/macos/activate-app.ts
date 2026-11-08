// activate-app.ts — bring one running app to the front by bundle id, via the
// native ActivateApp binary.
//
// Consumer: src/main/ipc/phone-remote.ts, when the phone taps a specific row
// in the app-switcher popup (direct-activate). Distinct from mm-input's
// CGEvent keystroke synthesis — this is a plain NSRunningApplication.activate()
// call, no keystroke simulation involved.

import { spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { devLog } from '../../../shared/env'
import { resolveHelper } from './helpers'

const ACTIVATE_APP_BIN = 'activate-app'

const ACTIVATE_APP_TIMEOUT_MS = 1000

function resolveBinaryPath(): string {
  return resolveHelper(ACTIVATE_APP_BIN)
}

/**
 * Bring the running app with the given bundle id to the front. Resolves true
 * on success, false on any failure (binary missing, app not running, timeout).
 * Never throws — a failed activate must not crash the phone-remote session.
 */
export function activateApp(bundleId: string): boolean {
  const bin = resolveBinaryPath()
  if (!existsSync(bin)) {
    devLog.warn(
      `[activate-app] binary not found at ${bin}. ` +
        `Run: cd native/activate-app && bash build.sh`
    )
    return false
  }

  const result = spawnSync(bin, [bundleId], {
    timeout: ACTIVATE_APP_TIMEOUT_MS,
    encoding: 'utf-8'
  })

  if (result.error) {
    devLog.error('[activate-app] spawn error:', result.error.message)
    return false
  }

  if (result.status !== 0) {
    devLog.warn('[activate-app] failed:', result.stderr?.trim())
    return false
  }

  return true
}

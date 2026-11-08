import { join } from 'path'
import { PATHS } from './store/paths'
import { CONFIG } from '../shared/config'

// Split out from act-control.ts on purpose: this is the ONE fact both sides of
// the channel need (where the socket lives), and it must stay importable from
// runner.ts without dragging in highlight-window → electron. Keeping it in
// act-control.ts made four headless backend tests fail at import time.

/** Absolute path to the act control socket. */
export function actControlSocketPath(): string {
  return join(PATHS.TMP, CONFIG.ACT_CONTROL.SOCKET_NAME)
}

/** Sidecar file holding the live socket path, for callers that only know TMP. */
export function actControlPointerPath(): string {
  return join(PATHS.TMP, CONFIG.ACT_CONTROL.POINTER_NAME)
}

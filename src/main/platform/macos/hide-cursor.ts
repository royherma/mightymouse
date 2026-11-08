/**
 * Hide the mouse pointer while the privacy curtain is up. The curtain is
 * click-through and non-focusable, so it never owns the pointer and macOS keeps
 * drawing the arrow of whatever is underneath.
 *
 * BEST-EFFORT ONLY — CGDisplayHideCursor is documented as applying while the
 * caller is frontmost, and we deliberately never are. Nothing may branch on it.
 * Fire-and-forget: a ~0.85s `swift -e` must not sit in the curtain's path.
 */
import { exec } from 'child_process'
import { devLog } from '../../../shared/env'

const EXEC_TIMEOUT_MS = 5_000

const CURSOR_SWIFT = (fn: string): string =>
  `import CoreGraphics;exit(Int32(${fn}(CGMainDisplayID()).rawValue))`

function run(fn: string, label: string): void {
  exec(`swift -e '${CURSOR_SWIFT(fn)}'`, { timeout: EXEC_TIMEOUT_MS }, (err) => {
    if (err) devLog.warn(`Cursor: ${label} failed`, err.message)
  })
}

/** Best-effort hide. Safe to call repeatedly — each call is one refcount up. */
export function hideSystemCursor(): void {
  run('CGDisplayHideCursor', 'hide')
}

/** Undo one hide. Must pair 1:1 with hideSystemCursor or the arrow stays gone. */
export function showSystemCursor(): void {
  run('CGDisplayShowCursor', 'show')
}

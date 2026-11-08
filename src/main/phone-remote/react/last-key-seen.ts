/**
 * Records the last key the page saw and what the Enter bridge did with it.
 *
 * Its own module, not a field on `debug-layout.ts`, because that file touches
 * `document` at import time and this is imported by `enter-activates-focused`,
 * whose whole point is being unit-testable in this repo's DOM-free vitest.
 *
 * Exists because on a cursorless host "the pinch never reached JS" and "the
 * pinch arrived and was declined" are the same picture in the hand -- no
 * cursor, no console, nothing on screen either way.
 */

let lastKeySeen = '-'

export function noteKeySeen(key: string, outcome: string): void {
  lastKeySeen = `${key === ' ' ? 'Space' : key}/${outcome}`
}

export function readLastKeySeen(): string {
  return lastKeySeen
}

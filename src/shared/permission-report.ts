// Which permission observations are worth an analytics row, and how each one is
// labelled. Split out of main/platform/macos/permissions.ts because that module
// imports Electron, so the decision could never be tested where it lives — and
// this decision is exactly the kind that fails silently: a wrongly-skipped emit
// looks identical to a user who never launched the app.

import type { PermissionKey, PermissionStatus } from './types'

export interface PermissionObservation {
  key: PermissionKey
  status: PermissionStatus
}

export interface PermissionReport {
  permission: PermissionKey
  status: PermissionStatus
  /** True when this is the first observation of the process — the state the
   *  machine was already in, rather than the user changing something. */
  at_launch: boolean
}

/**
 * Decide what to emit for one poll of the permission list.
 *
 * `seen` is the caller's process-local memory of the last reported status per
 * key; this function MUTATES it, so the emit-once-per-change contract holds
 * across calls without the caller tracking anything itself.
 */
export function reportsForPoll(
  states: PermissionObservation[],
  seen: Map<PermissionKey, PermissionStatus>
): PermissionReport[] {
  const out: PermissionReport[] = []
  for (const s of states) {
    // 'unknown' is a failed check, not a user decision — never report it as one.
    if (s.status === 'unknown') continue
    if (seen.get(s.key) === s.status) continue
    const first = !seen.has(s.key)
    seen.set(s.key, s.status)
    out.push({ permission: s.key, status: s.status, at_launch: first })
  }
  return out
}

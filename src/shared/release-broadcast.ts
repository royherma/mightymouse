// The wire shape the release-broadcast Edge function expects for its `changes`
// array, plus the one mapper that builds it from CONFIG.RELEASE_NOTES.
//
// Why a shared helper for three lines of mapping: two callers (the Electron IPC
// handler and the portal dashboard) build this payload independently, and the
// first version of both silently dropped `icon` because they hand-listed the
// fields. Mapping in one place means a field added to RELEASE_NOTES reaches the
// email without touching every caller.

import { CONFIG } from './config'

/** One change as the email template renders it. `icon` is absent on pre-0.4 entries. */
export interface BroadcastChange {
  title: string
  detail: string
  icon?: string
}

/**
 * Changes for `version` in the wire shape, or null when the running build has no
 * notes for it. Null is the caller's cue to refuse the send: an email with zero
 * changes is worse than no email.
 */
export function broadcastChangesFor(version: string): BroadcastChange[] | null {
  const want = version.replace(/^v/, '')
  const entry = CONFIG.RELEASE_NOTES.find((r) => r.version === want)
  if (!entry) return null
  return entry.changes.map((c) => ({
    title: c.title,
    detail: c.detail,
    // Older entries predate the field, so read it off a widened view rather
    // than the union, which only declares `icon` on the newer members.
    icon: (c as { icon?: string }).icon
  }))
}

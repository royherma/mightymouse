/**
 * Unread-runs counter for the menu-bar badge.
 *
 * Tracks runs that have FINISHED but the user hasn't looked at yet (= hasn't opened
 * History since). The tray renders the count to the right of the icon (e.g. `🐁 2`).
 * In-memory by design: unread is a per-session "since you last checked" signal, so a
 * fresh launch starting at 0 is correct — nothing to persist.
 *
 * Deduped by runId so a multi-turn ask (which rewrites ONE History row across turns
 * under the same session runId) counts once, not once per turn.
 *
 * Decoupling: this module owns the count AND notifies a listener on change, but it
 * does NOT import the tray (that lives in index.ts, deeply tied to app state). index.ts
 * registers an onChange callback at boot. So hud-run.ts → unread store only, with no
 * back-import into index.ts and no import cycle.
 */

const unreadRunIds = new Set<string>()
let onChange: (() => void) | null = null

export const UNREAD = {
  /** Register the change listener (index.ts wires this to refreshTrayMenu). */
  onChange(fn: () => void): void {
    onChange = fn
  },

  /** Mark a finished run unread. No-op (and no notify) if already counted. */
  mark(runId: string): void {
    if (runId === '' || unreadRunIds.has(runId)) return
    unreadRunIds.add(runId)
    onChange?.()
  },

  /**
   * Mark ONE run as seen/used (the user viewed or acted on its HUD card). Drops
   * just that run from the badge (3 → 2), unlike clear() which wipes everything.
   * The id stays out of the Set, so the same finished run never re-counts.
   */
  markRead(runId: string): void {
    if (!unreadRunIds.delete(runId)) return
    onChange?.()
  },

  /** Clear all unread (called when the user opens History). No-op if already 0. */
  clear(): void {
    if (unreadRunIds.size === 0) return
    unreadRunIds.clear()
    onChange?.()
  },

  count(): number {
    return unreadRunIds.size
  }
}

/**
 * Pane → session binding, and the render key derived from it.
 *
 * A pane component is reused across conversations, so every switch used to require
 * hand-clearing session/timeline/input/busy inside an effect — which React runs a frame
 * AFTER it has already painted the new sessionId with the OLD conversation still in
 * state. That frame is why "new chat" flashed a previous conversation, and it's the one
 * thing no amount of clearing inside the effect can fix.
 *
 * So the switch is expressed as a remount instead. The catch: a pane's FIRST send flips
 * sessionId null→real mid-run (the pane created the session itself), and remounting
 * there would discard the live answer. bindGen separates the two — it counts only
 * USER-initiated rebinds, never the pane reporting an id it just minted.
 */

import type { ChatPaneRef } from '../../../shared/types'

/** React key for a pane. Stable across a first send, changes on every user switch. */
export function paneRenderKey(pane: Pick<ChatPaneRef, 'id' | 'bindGen'>): string {
  return `${pane.id}:${pane.bindGen ?? 0}`
}

/** The pane minted this session for its own in-flight send — record the id, no remount.
 *  The session now owns its projectId, so the pending one has done its job. */
export function recordCreatedSession(pane: ChatPaneRef, sessionId: string): ChatPaneRef {
  return { ...pane, sessionId, bindGen: pane.bindGen ?? 0, pendingProjectId: undefined }
}

/** The user pointed this pane at a different chat (or none) — remount it. */
export function switchBinding(
  pane: ChatPaneRef,
  sessionId: string | null,
  pendingProjectId?: string
): ChatPaneRef {
  return { ...pane, sessionId, agentLabel: undefined, agentCwd: undefined, bindGen: (pane.bindGen ?? 0) + 1, pendingProjectId }
}

export function setPendingProject(pane: ChatPaneRef, pendingProjectId?: string): ChatPaneRef {
  return { ...pane, pendingProjectId }
}

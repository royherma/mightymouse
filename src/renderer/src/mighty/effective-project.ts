import type { ChatPaneRef, MightySession } from '../../../shared/types'

export function effectiveProjectIdForPane(
  pane: ChatPaneRef,
  sessions: MightySession[]
): string | undefined {
  if (pane.sessionId) {
    return sessions.find((s) => s.id === pane.sessionId)?.projectId
  }
  return pane.pendingProjectId
}

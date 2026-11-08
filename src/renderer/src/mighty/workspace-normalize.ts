import type { ChatPaneRef, ChatWorkspaceTab } from '../../../shared/types'

/** Every tab needs at least one pane — empty panes[] crashes PaneGrid and makes
 *  sidebar open a no-op (planOpenSessionGlobal returns none). */
export function normalizeWorkspaceTabs(tabs: ChatWorkspaceTab[]): ChatWorkspaceTab[] {
  return tabs.map((t) => {
    if (t.panes.length > 0) return t
    const pane: ChatPaneRef = { id: crypto.randomUUID(), sessionId: null }
    return { ...t, panes: [pane] }
  })
}

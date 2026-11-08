/**
 * A restored pane's sessionId is a claim, not a fact.
 *
 * Workspaces persist `{ paneId, sessionId }` pairs, but the sessions store is a
 * separate file with its own lifetime — deleting a chat, or wiping the store, leaves
 * the pane pointing at an id that no longer resolves. The store's validator checks
 * shape only, so a dead id survives restore intact and the pane opens bound to
 * nothing, then mints a surprise session on its next send.
 */

import type { ChatWorkspaceTab } from '../../../shared/types'
import { switchBinding } from './pane-binding'

/** Which of `ids` still resolve to a real session. */
export async function keepLiveSessionIds(
  ids: string[],
  exists: (id: string) => Promise<boolean>
): Promise<Set<string>> {
  const live = new Set<string>()
  await Promise.all(
    ids.map(async (id) => {
      if (await exists(id)) live.add(id)
    })
  )
  return live
}

/** Null out every pane binding whose session is gone. Tabs and panes themselves are
 *  never removed — an empty pane is a usable pane, a missing one loses the layout. */
export function applyLivePaneBindings(
  tabs: ChatWorkspaceTab[],
  live: Set<string>
): ChatWorkspaceTab[] {
  return tabs.map((t) => ({
    ...t,
    panes: t.panes.map((p) => (p.sessionId && !live.has(p.sessionId) ? switchBinding(p, null) : p))
  }))
}

export async function pruneDeadPaneBindings(
  tabs: ChatWorkspaceTab[],
  exists: (id: string) => Promise<boolean>
): Promise<ChatWorkspaceTab[]> {
  const ids = [...new Set(tabs.flatMap((t) => t.panes.map((p) => p.sessionId).filter((id): id is string => !!id)))]
  if (ids.length === 0) return tabs
  return applyLivePaneBindings(tabs, await keepLiveSessionIds(ids, exists))
}

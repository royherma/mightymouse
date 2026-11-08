/**
 * The focused pane is THE cursor, and every surface reads that one value. The sidebar
 * used to derive its highlight independently of the grid, so a chat live in a
 * non-focused pane rendered identically to one that wasn't open at all.
 *
 * Full audit table: prds/active/2026-08-04-1785826838-chat-sidebar-open-behavior.md
 */

import type { ChatPaneRef, ChatWorkspaceTab } from '../../../shared/types'

export type ChatOpenState = 'focused' | 'elsewhere' | 'closed'

/** Falls back to the first pane: a tab always has a focused pane. */
export function focusedPaneId(
  tab: ChatWorkspaceTab | null,
  focusByTab: Record<string, string>
): string | null {
  if (!tab) return null
  const explicit = focusByTab[tab.id]
  if (explicit && tab.panes.some((p) => p.id === explicit)) return explicit
  return tab.panes[0]?.id ?? null
}

/** First unbound pane in tab order — sidebar open prefers this over replacing a live chat. */
export function firstEmptyPaneId(tab: ChatWorkspaceTab | null): string | null {
  if (!tab) return null
  return tab.panes.find((p) => !p.sessionId && !p.agentLabel)?.id ?? null
}

export function sessionsOpenElsewhere(
  tab: ChatWorkspaceTab | null,
  focusedId: string | null
): Set<string> {
  return new Set(
    (tab?.panes ?? [])
      .filter((p) => p.id !== focusedId && p.sessionId)
      .map((p) => p.sessionId as string)
  )
}

export function chatOpenState(
  sessionId: string,
  focusedPane: ChatPaneRef | null,
  elsewhere: Set<string>
): ChatOpenState {
  if (focusedPane?.sessionId === sessionId) return 'focused'
  return elsewhere.has(sessionId) ? 'elsewhere' : 'closed'
}

export type OpenSessionPlan =
  | { kind: 'focus'; tabId: string; paneId: string }
  | { kind: 'bind'; tabId: string; paneId: string }
  | { kind: 'add-pane'; tabId: string }
  | { kind: 'add-tab' }
  | { kind: 'none' }

/** Sidebar / palette open: find the session anywhere, or bind the best pane in the active tab. */
export function planOpenSessionGlobal(
  tabs: ChatWorkspaceTab[],
  activeTabId: string | null,
  focusByTab: Record<string, string>,
  sessionId: string,
  maxPanesPerTab: number
): OpenSessionPlan {
  return planOpenGlobal(tabs, activeTabId, focusByTab, (p) => p.sessionId === sessionId, maxPanesPerTab)
}

export function planOpenGlobal(
  tabs: ChatWorkspaceTab[],
  activeTabId: string | null,
  focusByTab: Record<string, string>,
  isTarget: (pane: ChatPaneRef) => boolean,
  maxPanesPerTab: number
): OpenSessionPlan {
  for (const t of tabs) {
    const already = t.panes.find(isTarget)
    if (already) return { kind: 'focus', tabId: t.id, paneId: already.id }
  }
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null
  const focusedId = focusedPaneId(activeTab, focusByTab)
  if (!activeTab || !focusedId) return { kind: 'none' }
  const emptyId = firstEmptyPaneId(activeTab)
  if (emptyId) return { kind: 'bind', tabId: activeTab.id, paneId: emptyId }
  if (activeTab.panes.length < maxPanesPerTab) return { kind: 'add-pane', tabId: activeTab.id }
  return { kind: 'add-tab' }
}

/** Single-tab helper — tests and any caller that already holds one tab. */
export function planOpenSession(
  tab: ChatWorkspaceTab | null,
  focusedId: string | null,
  sessionId: string,
  maxPanesPerTab: number = 6
): OpenSessionPlan {
  if (!tab) return { kind: 'none' }
  return planOpenSessionGlobal([tab], tab.id, { [tab.id]: focusedId ?? '' }, sessionId, maxPanesPerTab)
}

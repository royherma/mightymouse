import type { ChatWorkspaceTab, PaneViewMode } from '../../../shared/types'

/** User-selected layout only — never infer 'single' from pane count. Forcing single at
 *  one pane then flipping to grid on addPane remounted every ConversationPane and wiped
 *  in-flight sends (2026-08-04). */
export function tabDisplayViewMode(tab: Pick<ChatWorkspaceTab, 'viewMode'>): PaneViewMode {
  return tab.viewMode ?? 'grid'
}

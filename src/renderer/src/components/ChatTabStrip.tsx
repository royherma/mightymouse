import { useState, type JSX } from 'react'
import { Plus, X } from 'lucide-react'
import { Button } from './Button'
import type { ChatWorkspaceTab } from '../../../shared/types'

/**
 * Horizontal strip of chat-workspace tabs (each tab = one grid of up to 6 panes).
 * Purely controlled — same shape as MightyApp's own Chat/History/Jobs/Made/Settings
 * bar (see the `TABS.map` block in MightyApp.tsx): active tab gets the
 * `border-accent text-on-surface` underline, inactive tabs are `text-muted` with a
 * hover state, all diffed against THEME_TOKENS-backed CSS vars via Tailwind
 * classes — no raw hex, no new visual language. Double-click a label to rename it;
 * the auto-generated name is only ever a starting point.
 */
export function ChatTabStrip({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onNew,
  onRename
}: {
  tabs: ChatWorkspaceTab[]
  activeTabId: string | null
  onSelect: (tabId: string) => void
  onClose: (tabId: string) => void
  onNew: () => void
  onRename: (tabId: string, name: string) => void
}): JSX.Element {
  // Which tab is being renamed, and its in-progress text. Local because a rename is
  // transient UI state — only the committed name goes up to MightyApp to be persisted.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  const commit = (): void => {
    if (editingId === null) return
    const trimmed = draft.trim()
    // An empty name would render as an unclickable sliver, so blank = cancel and
    // keep whatever the tab was already called.
    if (trimmed !== '') onRename(editingId, trimmed)
    setEditingId(null)
  }

  return (
    <div className="flex items-center gap-1 border-b border-surface2 overflow-x-auto">
      {tabs.map((t) => {
        const active = t.id === activeTabId
        return (
          <div
            key={t.id}
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(t.id)}
            className={`group flex items-center gap-2 pl-3 pr-2 py-2 text-sm font-medium border-b-2 -mb-px cursor-pointer transition-colors whitespace-nowrap ${
              active
                ? 'border-on-surface text-on-surface'
                : 'border-transparent text-muted hover:text-on-surface'
            }`}
          >
            {editingId === t.id ? (
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commit()
                  if (e.key === 'Escape') {
                    e.stopPropagation()
                    setEditingId(null)
                  }
                }}
                // Selecting-to-edit inside the input must not re-trigger the tab's
                // own click/double-click handlers underneath it.
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                // Grows with the text so a long name isn't typed into a peephole,
                // with a floor so an emptied field stays big enough to click back into.
                size={Math.max(draft.length, 8)}
                className="bg-surface2 rounded px-1 -mx-1 py-0 text-sm font-medium text-on-surface outline-none focus:shadow-focus"
              />
            ) : (
              <span
                onDoubleClick={() => {
                  setEditingId(t.id)
                  setDraft(t.name)
                }}
                title="Double-click to rename"
              >
                {t.name}
              </span>
            )}
            <Button variant="bare"
              onClick={(e) => {
                // Closing must not also select the tab it's closing.
                e.stopPropagation()
                onClose(t.id)
              }}
              aria-label={`Close ${t.name}`}
              className="flex items-center justify-center w-4 h-4 rounded text-muted opacity-0 group-hover:opacity-100 hover:text-on-surface hover:bg-surface2 transition-opacity"
            >
              <X size={12} strokeWidth={2.5} />
            </Button>
          </div>
        )
      })}
      <Button variant="bare"
        onClick={onNew}
        title="New tab"
        aria-label="New tab"
        className="flex items-center justify-center w-7 h-7 rounded-md text-muted hover:text-on-surface hover:bg-surface2 transition-colors shrink-0"
      >
        <Plus size={15} strokeWidth={2} />
      </Button>
    </div>
  )
}

import { useEffect, useState, useSyncExternalStore, type JSX, type ReactNode } from 'react'
import { ChevronDown, X } from 'lucide-react'
import { CONFIG } from '../../../shared/config'
import { Button } from './Button'

export type SidebarNotice = {
  id: string
  title: string
  detail?: string
  action?: { label: string; run: () => void }
  body?: ReactNode
  sticky?: boolean
  version?: string
}

const posted = new Map<string, SidebarNotice>()
const listeners = new Set<() => void>()
let snapshot: SidebarNotice[] = []

function emit(): void {
  snapshot = [...posted.values()]
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function usePostNotice(notice: SidebarNotice | null): void {
  useEffect(() => {
    if (!notice) return
    posted.set(notice.id, notice)
    emit()
    return () => {
      if (posted.get(notice.id) !== notice) return
      posted.delete(notice.id)
      emit()
    }
  }, [notice])
}

const DISMISSED_KEY = 'sidebar-notices-dismissed'

function readDismissed(): Record<string, string> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '{}')
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? (saved as Record<string, string>) : {}
  } catch {
    return {}
  }
}

export function SidebarNotices(): JSX.Element | null {
  const all = useSyncExternalStore(subscribe, () => snapshot)
  const [dismissed, setDismissed] = useState(readDismissed)
  const [showAll, setShowAll] = useState(false)
  const [openBody, setOpenBody] = useState<string | null>(null)

  const dismiss = (notice: SidebarNotice): void => {
    const next = { ...dismissed, [notice.id]: notice.version ?? '' }
    setDismissed(next)
    try {
      localStorage.setItem(DISMISSED_KEY, JSON.stringify(next))
    } catch {
      return
    }
  }

  const visible = all
    .filter((n) => n.sticky || dismissed[n.id] !== (n.version ?? ''))
    .sort((a, b) => Number(Boolean(b.sticky)) - Number(Boolean(a.sticky)))
  if (visible.length === 0) return null
  const shown = showAll ? visible : visible.slice(0, 1)
  const more = visible.length - 1
  const L = CONFIG.UI_LABELS

  return (
    <div className="mb-2 flex flex-col gap-1.5">
      {shown.map((notice) => (
        <div
          key={notice.id}
          className="rounded-[9px] border border-surface3 bg-surface1 py-2 pl-3 pr-1.5 shadow-[0_1px_2px_rgba(var(--shadow-rgb),0.05)]"
        >
          <div className="flex items-center gap-1.5">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-[600] text-on-surface">{notice.title}</div>
              {notice.detail && <div className="truncate text-[12px] text-muted">{notice.detail}</div>}
            </div>
            {notice.action && (
              <Button
                variant="bare"
                className="shrink-0 rounded-[7px] bg-[rgba(var(--shadow-rgb),0.06)] px-2.5 py-1 text-[12px] font-[600] text-on-surface hover:bg-[rgba(var(--shadow-rgb),0.1)]"
                onClick={notice.action.run}
              >
                {notice.action.label}
              </Button>
            )}
            {notice.body && !notice.action && (
              <Button
                variant="bare"
                aria-expanded={openBody === notice.id}
                className="shrink-0 rounded-[7px] bg-[rgba(var(--shadow-rgb),0.06)] px-2.5 py-1 text-[12px] font-[600] text-on-surface hover:bg-[rgba(var(--shadow-rgb),0.1)]"
                onClick={() => setOpenBody((id) => (id === notice.id ? null : notice.id))}
              >
                {openBody === notice.id ? L.NOTICE_HIDE_BODY : L.NOTICE_SHOW_BODY}
              </Button>
            )}
            {!notice.sticky && (
              <Button variant="quiet" aria-label={L.NOTICE_DISMISS} title={L.NOTICE_DISMISS} onClick={() => dismiss(notice)}>
                <X size={13} />
              </Button>
            )}
          </div>
          {openBody === notice.id && notice.body && (
            <div className="mt-1 max-h-48 overflow-y-auto pr-1.5">{notice.body}</div>
          )}
        </div>
      ))}
      {more > 0 && (
        <Button
          variant="bare"
          aria-expanded={showAll}
          className="flex items-center gap-1 self-start rounded-[7px] px-2 py-0.5 text-[12px] text-muted hover:bg-[rgba(var(--shadow-rgb),0.04)] hover:text-on-surface"
          onClick={() => setShowAll((on) => !on)}
        >
          <ChevronDown size={12} className={showAll ? 'rotate-180' : ''} />
          {showAll ? L.NOTICE_SHOW_FEWER : `${more} ${more === 1 ? L.NOTICE_MORE_ONE : L.NOTICE_MORE_MANY}`}
        </Button>
      )}
    </div>
  )
}

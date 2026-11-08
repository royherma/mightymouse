import { ArrowLeft, PanelLeft } from 'lucide-react'
import { useEffect, useMemo, useState, type JSX } from 'react'
import { Button } from '../Button'
import {
  BUCKETS,
  BUCKET_TITLES,
  SECTIONS,
  ADMIN_ONLY_SECTIONS,
  SIMPLE_SECTIONS,
  SIDEBAR_WIDTH_PX,
  CONTENT_WIDTH_PX,
  sectionMatches,
  sectionDomId,
  type BucketKey,
  type SectionKey
} from './registry'

const BUCKET_ORDER = Object.keys(BUCKETS) as BucketKey[]

// The show/hide button. Lives in the title bar next to Search, so there's a way
// back when the nav is hidden — a toggle that only exists INSIDE the nav can't
// reopen it.
export function SidebarToggle({
  shown,
  onToggle
}: {
  shown: boolean
  onToggle: () => void
}): JSX.Element {
  return (
    <Button
      variant="icon"
      aria-label={shown ? 'Hide section list' : 'Show section list'}
      aria-pressed={shown}
      title={shown ? 'Hide section list' : 'Show section list'}
      onClick={onToggle}
      className={shown ? 'text-on-surface' : undefined}
    >
      <PanelLeft size={14} strokeWidth={2.25} />
    </Button>
  )
}

export function SettingsSidebar({
  query,
  page,
  onPage,
  advancedMenu,
  phoneRemoteSupported,
  simple,
  onJump,
  onBack
}: {
  query: string
  page: BucketKey | null
  onPage: (bucket: BucketKey) => void
  // False in "view as user" / non-admin — admin-only sections must not be
  // listed here either, or the nav advertises knobs the page won't render.
  advancedMenu: boolean
  phoneRemoteSupported: boolean
  simple: boolean
  onJump: (key: SectionKey) => void
  onBack?: () => void
}): JSX.Element {
  const [activeKey, setActiveKey] = useState<SectionKey | null>(null)

  const visibleBuckets = useMemo(() => {
    return BUCKET_ORDER.map((bucket) => {
      const keys = (BUCKETS[bucket] as readonly SectionKey[]).filter((k) => {
        if (!advancedMenu && ADMIN_ONLY_SECTIONS.includes(k)) return false
        if (k === 'phoneRemote' && !phoneRemoteSupported) return false
        if (simple && !SIMPLE_SECTIONS.includes(k)) return false
        return sectionMatches(query, SECTIONS[k].title, SECTIONS[k].keywords)
      })
      return { bucket, keys }
    }).filter((b) => b.keys.length > 0)
  }, [query, advancedMenu, phoneRemoteSupported, simple])

  useEffect(() => {
    const ids = new Map<string, SectionKey>()
    for (const { keys } of visibleBuckets) {
      for (const k of keys) ids.set(sectionDomId(k), k)
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const hit = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
        const key = hit && ids.get(hit.target.id)
        if (key) setActiveKey(key)
      },
      // Only the top slice of the viewport counts as "current" — without the
      // bottom inset every section below the fold also reports intersecting.
      { rootMargin: '-60px 0px -70% 0px' }
    )
    for (const id of ids.keys()) {
      const el = document.getElementById(id)
      if (el) observer.observe(el)
    }
    return () => observer.disconnect()
  }, [visibleBuckets, page])

  function jump(key: SectionKey): void {
    setActiveKey(key)
    onJump(key)
  }

  return (
    <nav
      aria-label="Settings pages"
      style={{
        width: SIDEBAR_WIDTH_PX,
        left: `max(0px, calc((100vw - ${SIDEBAR_WIDTH_PX + CONTENT_WIDTH_PX}px) / 2))`
      }}
      className="fixed top-11 bottom-0 z-[4] overflow-y-auto bg-bg py-5 pl-4 pr-1"
    >
      {onBack && (
        <Button
          variant="bare"
          onClick={onBack}
          title="Back (Esc)"
          className="w-full flex items-center gap-1.5 rounded-sm px-2 py-1.5 mb-3 text-sm font-semibold text-muted transition-colors hover:bg-surface2 hover:text-on-surface"
        >
          <ArrowLeft size={14} strokeWidth={2.25} className="shrink-0" />
          Back
        </Button>
      )}
      {visibleBuckets.map(({ bucket, keys }) => {
        const current = page === bucket
        const showKeys = (page === null || current) && keys.length > 1
        return (
          <div key={bucket} className="mb-0.5">
            <Button
              variant="bare"
              aria-current={current ? 'page' : undefined}
              onClick={() => (page === null ? jump(keys[0]) : onPage(bucket))}
              className={`w-full text-left rounded-sm px-2 py-1.5 text-sm font-semibold transition-colors select-none break-words ${
                current
                  ? 'bg-surface2 text-on-surface'
                  : 'text-muted hover:bg-surface2 hover:text-on-surface'
              }`}
            >
              {BUCKET_TITLES[bucket]}
            </Button>
            {showKeys && (
              <div className="ml-[13px] my-0.5 pl-2 border-l border-surface3">
                {keys.map((k) => (
                  <Button
                    variant="bare"
                    key={k}
                    onClick={() => jump(k)}
                    className={`w-full text-left rounded-sm px-2 py-1 text-sm transition-colors break-words ${
                      activeKey === k
                        ? 'text-on-surface font-semibold'
                        : 'text-muted hover:bg-surface2 hover:text-on-surface'
                    }`}
                  >
                    {SECTIONS[k].title}
                  </Button>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </nav>
  )
}

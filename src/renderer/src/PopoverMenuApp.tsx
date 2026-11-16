import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Check, MessageSquare, Plus } from 'lucide-react'
import type { PopoverMenuItem, PopoverMenuRequest } from '../../shared/types'
import { Button } from './components/Button'
import { ProjectPicture } from './ReplyApp'

type Pickable = Extract<PopoverMenuItem, { id: string }>

const isPickable = (item: PopoverMenuItem): item is Pickable => 'id' in item && item.enabled !== false

function matches(item: PopoverMenuItem, query: string): boolean {
  if (!query) return true
  if (!('id' in item)) return false
  return `${item.label} ${item.sublabel ?? ''}`.toLowerCase().includes(query.toLowerCase())
}

function Menu({ request }: { request: PopoverMenuRequest }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(-1)
  const rootRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const shown = useMemo(() => request.items.filter((item) => matches(item, query)), [request.items, query])
  const picks = useMemo(() => shown.filter(isPickable), [shown])

  useLayoutEffect(() => {
    const report = (): void => {
      const root = rootRef.current
      const scroll = scrollRef.current
      const list = listRef.current
      if (root && scroll && list) window.api.popoverMenuSize(root.scrollHeight - scroll.clientHeight + list.offsetHeight)
    }
    report()
    const observer = new ResizeObserver(report)
    if (listRef.current) observer.observe(listRef.current)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!request.search) rootRef.current?.focus()
  }, [request.search])
  useEffect(() => setActive(query ? 0 : -1), [query])
  useEffect(() => {
    listRef.current?.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') window.api.popoverMenuPick(null)
    else if (e.key === 'ArrowDown') setActive((i) => Math.min(picks.length - 1, i + 1))
    else if (e.key === 'ArrowUp') setActive((i) => Math.max(0, i - 1))
    else if (e.key === 'Enter' && picks[Math.max(0, active)]) window.api.popoverMenuPick(picks[Math.max(0, active)].id)
    else return
    e.preventDefault()
  }

  return (
    <div ref={rootRef} className="flex max-h-screen flex-col p-1 text-fg outline-none" onKeyDown={onKey} tabIndex={-1}>
      {request.search && (
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={request.search}
          aria-label={request.search}
          className="mb-1 w-full shrink-0 rounded-md bg-surface2 px-2 py-1.5 text-[13px] text-fg outline-none placeholder:text-muted"
        />
      )}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div ref={listRef} role="menu">
          {shown.map((item, i) => {
            if (!('id' in item)) {
              if (query) return null
              return item.type === 'separator' ? (
                <div key={i} className="my-1 border-t border-surface2" />
              ) : (
                <p key={i} className="px-2 pb-0.5 pt-1.5 text-[11px] text-muted">
                  {item.label}
                </p>
              )
            }
            const at = picks.indexOf(item)
            return (
              <Button
                key={item.id}
                variant="bare"
                role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
                aria-checked={item.checked}
                disabled={item.enabled === false}
                data-active={at === active ? '' : undefined}
                onMouseMove={() => at !== active && setActive(at)}
                onClick={() => window.api.popoverMenuPick(item.id)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left disabled:opacity-50 ${at === active ? 'bg-surface2' : ''}`}
              >
                {item.icon === 'project' && <ProjectPicture project={item.project} size={16} />}
                {item.icon === 'chat' && <MessageSquare size={14} className="mx-px shrink-0 text-muted" />}
                {item.icon === 'plus' && <Plus size={14} className="mx-px shrink-0 text-muted" />}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[13px] text-on-surface">{item.label}</span>
                  {item.sublabel && <span className="truncate text-[11px] text-muted">{item.sublabel}</span>}
                </span>
                {item.checked && <Check size={13} className="shrink-0 text-accent-text" />}
                {item.keys && <span className="shrink-0 text-[11px] text-muted">{item.keys}</span>}
              </Button>
            )
          })}
          {picks.length === 0 && <p className="px-2 py-3 text-center text-xs text-muted">Nothing matches “{query}”</p>}
        </div>
      </div>
    </div>
  )
}

export default function PopoverMenuApp(): React.JSX.Element | null {
  const [shown, setShown] = useState<{ request: PopoverMenuRequest; key: number } | null>(null)
  useEffect(() => window.api.onPopoverMenuShow((request) => setShown((s) => ({ request, key: (s?.key ?? 0) + 1 }))), [])
  if (!shown) return null
  return <Menu key={shown.key} request={shown.request} />
}

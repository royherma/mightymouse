import { createContext, JSX, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Brain, Check, ChevronDown, Download } from 'lucide-react'
import { Button, type ButtonVariant } from '../ui/Button'
import { ProviderIcon as BaseProviderIcon, type ProviderIconId } from '../provider-icon'
import './model-picker.css'

const MENU_GAP = 4
const MENU_MARGIN = 8

export const PickerIcon = createContext<(props: { id: ProviderIconId; size?: number }) => React.ReactElement>(BaseProviderIcon)

const MENU_MAX_H = 320
const MENU_W = 220
export const WIDE_MENU_W = 320
export const WIDE_MENU_MAX_H = 420
export const SIDE_W = 300

export interface MenuItem {
  id: string
  group: string
  label: string
  sub?: string
  section?: string
  hint?: string
  tier?: string
  muted?: boolean
  hero?: boolean
  thinks?: boolean
  icon?: ProviderIconId
}

export interface MenuGroup {
  key: string
  name: string
  icon?: ProviderIconId
  accessory?: React.ReactNode
}

export interface MenuSetupRow {
  key: string
  name: string
  icon: ProviderIconId
  sub: string
  busy: boolean
  onClick: () => void
}

export function usePopover(width: number, maxH: number, align: 'left' | 'right', remeasure: unknown): {
  open: boolean
  setOpen: (fn: (v: boolean) => boolean) => void
  btnRef: React.RefObject<HTMLButtonElement | null>
  menuRef: React.RefObject<HTMLDivElement | null>
  pos: { top: number; left: number; maxHeight: number; width: number }
} {
  const [open, setOpenState] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ top: 0, left: 0, maxHeight: maxH, width })

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return
    const r = btnRef.current.getBoundingClientRect()
    const w = Math.min(width, window.innerWidth - 2 * MENU_MARGIN)
    const menuH = Math.min(menuRef.current?.offsetHeight ?? maxH, maxH)
    const left = Math.min(
      Math.max(MENU_MARGIN, align === 'right' ? r.right - w : r.left),
      window.innerWidth - w - MENU_MARGIN
    )
    const below = window.innerHeight - MENU_MARGIN - r.bottom - MENU_GAP
    const above = r.top - MENU_GAP - MENU_MARGIN
    const up = (menuH > below && above > below) || (maxH === WIDE_MENU_MAX_H && above >= Math.min(menuH, maxH))
    const maxHeight = Math.min(maxH, up ? above : below)
    const top = up ? r.top - MENU_GAP - Math.min(menuH, maxHeight) : r.bottom + MENU_GAP
    setPos({ top, left, maxHeight, width: w })
  }, [open, remeasure, align, width, maxH])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (!menuRef.current?.contains(t) && !btnRef.current?.contains(t)) setOpenState(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setOpenState(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  return { open, setOpen: setOpenState, btnRef, menuRef, pos }
}

const COLLAPSED_KEY = 'mm.picker.collapsed'

function readCollapsed(): Set<string> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]')
    return new Set(Array.isArray(saved) ? saved.filter((k): k is string => typeof k === 'string') : [])
  } catch {
    return new Set()
  }
}

function GroupHead({ open, count, onToggle, sub = false, children }: {
  open: boolean
  count: number
  onToggle?: () => void
  sub?: boolean
  children: React.ReactNode
}): JSX.Element {
  return (
    <Button
      variant="bare"
      className={`mm-pick-head${sub ? ' is-sub' : ''}`}
      aria-expanded={open}
      disabled={!onToggle}
      onClick={onToggle}
    >
      {children}
      {!open && <span className="mm-pick-count">{count}</span>}
      {onToggle && <ChevronDown size={12} strokeWidth={2.5} className="mm-pick-caret" />}
    </Button>
  )
}

function MenuRow({ item, on, onPick }: { item: MenuItem; on: boolean; onPick: (id: string) => void }): JSX.Element {
  const ProviderIcon = useContext(PickerIcon)
  return (
    <Button
      variant="bare"
      role="option"
      aria-selected={on}
      onClick={() => onPick(item.id)}
      className={`mm-pick-row${item.hero ? ' mm-pick-hero' : ''}${item.muted ? ' is-muted' : ''}`}
    >
      {item.icon && <span className="mm-pick-logo"><ProviderIcon id={item.icon} size={item.hero ? 38 : 14} /></span>}
      <span className="mm-pick-name">
        <span className="mm-pick-label">{item.label}</span>
        {item.sub && <small>{item.sub}</small>}
      </span>
      {item.thinks && <Brain size={13} strokeWidth={2} className="mm-pick-thinks" />}
      {item.hint && <span className="mm-pick-tier" data-tier={item.tier}>{item.hint}</span>}
      {on && <span className="mm-pick-check"><Check size={10} strokeWidth={3.5} /></span>}
    </Button>
  )
}

export function MenuList({
  groups,
  items,
  selectedId,
  onPick,
  setupRows = [],
  searchable = true
}: {
  groups: MenuGroup[]
  items: MenuItem[]
  selectedId: string | null
  onPick: (id: string) => void
  setupRows?: MenuSetupRow[]
  searchable?: boolean
}): JSX.Element {
  const ProviderIcon = useContext(PickerIcon)
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const q = query.trim().toLowerCase()
  const searching = q !== ''
  const toggle = (key: string): void => {
    const next = new Set(collapsed)
    if (!next.delete(key)) next.add(key)
    setCollapsed(next)
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]))
    } catch {
      return
    }
  }
  const groupName = (key: string): string => groups.find((g) => g.key === key)?.name ?? key
  const shown =
    q === ''
      ? items
      : items.filter((o) => !o.hero && `${groupName(o.group)} ${o.label} ${o.id}`.toLowerCase().includes(q))
  const shownGroups = groups.filter((g) => shown.some((o) => o.group === g.key))
  const setupShown = setupRows.filter(
    (r) => q === '' || `${r.name} ${r.key} local`.toLowerCase().includes(q)
  )

  return (
    <>
      {searchable && <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && shown[0]) onPick(shown[0].id)
        }}
        placeholder="Search models"
        aria-label="Search models"
        className="mm-pick-search"
      />}
      <div className="mm-pick-list">
        {shown.length === 0 && setupShown.length === 0 && (
          <div className="px-3 py-3 text-sm text-muted">No model matches "{query}"</div>
        )}
        {shownGroups.map((g) => {
          const rows = shown.filter((o) => o.group === g.key)
          const rest = rows.filter((o) => !o.hero)
          return (
            <div key={g.key}>
              {rows.filter((o) => o.hero).map((o) => <MenuRow key={o.id} item={o} on={o.id === selectedId} onPick={onPick} />)}
              {rest.length > 0 && (
                <>
                  <div className="mm-pick-headrow">
                    <GroupHead
                      open={searching || !collapsed.has(g.key)}
                      count={rest.length}
                      onToggle={searching ? undefined : () => toggle(g.key)}
                    >
                      {g.icon && <ProviderIcon id={g.icon} size={11} />}
                      {g.name}
                    </GroupHead>
                    {!searching && !collapsed.has(g.key) && g.accessory}
                  </div>
                  {(searching || !collapsed.has(g.key)) && [...new Set(rest.map((o) => o.section))].map((section) => {
                    const key = `${g.key}/${section}`
                    const inSection = rest.filter((o) => o.section === section)
                    const open = searching || section === undefined || !collapsed.has(key)
                    return (
                      <div key={key}>
                        {section !== undefined && (
                          <GroupHead sub open={open} count={inSection.length} onToggle={searching ? undefined : () => toggle(key)}>
                            {section}
                          </GroupHead>
                        )}
                        {open && (
                          <div className="mm-pick-grid">
                            {inSection.map((o) => <MenuRow key={o.id} item={o} on={o.id === selectedId} onPick={onPick} />)}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </>
              )}
            </div>
          )
        })}
        {setupShown.length > 0 && (
          <>
            <div className="mm-pick-head">Add a provider</div>
            <div className="mm-pick-grid">
              {setupShown.map((r) => (
                <Button
                  variant="bare"
                  key={`setup:${r.key}`}
                  disabled={r.busy}
                  onClick={r.onClick}
                  className="mm-pick-row"
                >
                  <span className="mm-pick-logo"><ProviderIcon id={r.icon} size={14} /></span>
                  <span className="mm-pick-name">
                    <span className="truncate">Set up {r.name}</span>
                    <small>{r.sub}</small>
                  </span>
                  {!r.busy && <span className="mm-pick-setup"><Download size={12} strokeWidth={2.25} /></span>}
                </Button>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  )
}

export function PickerPop({ menuRef, pos, role, ariaLabel, children, side }: {
  menuRef: React.RefObject<HTMLDivElement | null>
  pos: { top: number; left: number; maxHeight: number; width: number }
  role: 'listbox' | 'dialog'
  ariaLabel: string
  children: React.ReactNode
  side?: React.ReactNode
}): JSX.Element {
  return createPortal(
    <div
      ref={menuRef}
      role={role}
      aria-label={ariaLabel}
      className="mm-pick fixed z-[200]"
      style={{ top: pos.top, left: pos.left, width: pos.width }}
    >
      <div className={`mm-pick-in${side ? ' has-side' : ''}`} style={{ maxHeight: pos.maxHeight - 3 }}>
        {side ? (
          <>
            <div className="mm-pick-main">{children}</div>
            <div className="mm-pick-side">{side}</div>
          </>
        ) : children}
      </div>
    </div>,
    document.body
  )
}

export interface ModelMenuProps {
  groups: MenuGroup[]
  items: MenuItem[]
  selectedId: string | null
  onPick: (id: string) => void
  setupRows?: MenuSetupRow[]
  trigger: JSX.Element
  title: string
  triggerClassName: string
  triggerVariant?: ButtonVariant
  align?: 'left' | 'right'
  ariaLabel?: string
  searchable?: boolean
  wide?: boolean
  footer?: React.ReactNode
  side?: React.ReactNode
}

export function ModelMenu({
  groups,
  items,
  selectedId,
  onPick,
  setupRows = [],
  trigger,
  title,
  triggerClassName,
  triggerVariant = 'bare',
  align = 'left',
  ariaLabel = 'Model',
  searchable = true,
  wide = false,
  footer,
  side
}: ModelMenuProps): JSX.Element {
  const { open, setOpen, btnRef, menuRef, pos } = usePopover(
    (wide ? WIDE_MENU_W : MENU_W) + (side ? SIDE_W : 0),
    wide ? WIDE_MENU_MAX_H : MENU_MAX_H,
    align,
    `${items.length}:${selectedId}`
  )
  const pick = (id: string): void => {
    if (!items.find((i) => i.id === id)?.thinks) setOpen(() => false)
    onPick(id)
  }

  return (
    <>
      <Button
        variant={triggerVariant}
        ref={btnRef}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={title}
        className={triggerClassName}
      >
        {trigger}
      </Button>
      {open && (
        <PickerPop menuRef={menuRef} pos={pos} role="listbox" ariaLabel={ariaLabel} side={side}>
          <MenuList
            groups={groups}
            items={items}
            selectedId={selectedId}
            onPick={pick}
            setupRows={setupRows}
            searchable={searchable}
          />
          {footer && <div className="mm-pick-foot">{footer}</div>}
        </PickerPop>
      )}
    </>
  )
}

import { JSX, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Check, Plus, Settings2 } from 'lucide-react'
import { CONFIG } from '../../../shared/config'
import { ProjectAvatar } from './ProjectIcon'
import { MOVE_MENU_GAP, MOVE_MENU_MARGIN, MOVE_MENU_W } from '../mighty/mighty-shared'
import type { MightyProject } from '../../../shared/types'
import { Button } from './Button'

const MENU_MAX_H = 256

export function ProjectScopePicker({
  projects,
  valueId,
  onChange,
  onNewProject,
  onEditProject,
  readOnly = false,
  disabled = false
}: {
  projects: MightyProject[]
  valueId?: string
  onChange?: (projectId: string | undefined) => void
  onNewProject?: () => void
  onEditProject?: (project: MightyProject) => void
  readOnly?: boolean
  disabled?: boolean
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 })

  const openProjects = projects.filter((p) => !p.archived)
  const selected = valueId ? openProjects.find((p) => p.id === valueId) : undefined
  const label = selected?.name ?? CONFIG.UI_LABELS.CODE_NO_PROJECT

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return
    const r = btnRef.current.getBoundingClientRect()
    const menuH = Math.min(menuRef.current?.offsetHeight ?? MENU_MAX_H, MENU_MAX_H)
    const left = Math.min(
      Math.max(MOVE_MENU_MARGIN, r.left),
      window.innerWidth - MOVE_MENU_W - MOVE_MENU_MARGIN
    )
    let top = r.bottom + MOVE_MENU_GAP
    if (top + menuH > window.innerHeight - MOVE_MENU_MARGIN) {
      top = Math.max(MOVE_MENU_MARGIN, r.top - MOVE_MENU_GAP - menuH)
    }
    setMenuPos({ top, left })
  }, [open, openProjects.length])

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent): void => {
      const t = e.target as Node
      if (!menuRef.current?.contains(t) && !btnRef.current?.contains(t)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  const pick = (id: string | undefined): void => {
    setOpen(false)
    onChange?.(id)
  }

  const canMenu = !disabled && (!readOnly ? Boolean(onChange) : Boolean(onEditProject && selected))

  return (
    <>
      <Button
        variant="bare"
        ref={btnRef}
        disabled={disabled || (readOnly && !selected)}
        onClick={() => canMenu && setOpen((v) => !v)}
        aria-expanded={canMenu ? open : undefined}
        title={CONFIG.UI_LABELS.CHAT_PROJECT_SCOPE_TITLE}
        className={`inline-flex w-fit max-w-[min(100%,13rem)] items-center gap-1.5 rounded-lg border border-surface3 bg-surface2 px-2 py-1 text-left text-xs font-medium text-on-surface hover:bg-surface1 disabled:opacity-60 ${
          canMenu ? '' : 'cursor-default'
        }`}
      >
        <ProjectAvatar icon={selected?.icon} imagePath={selected?.imagePath} size={14} />
        <span className="agent-chip-label min-w-0 truncate">{label}</span>
        {canMenu && <ChevronDown size={12} className="shrink-0 text-muted" strokeWidth={2.5} />}
      </Button>
      {canMenu &&
        open &&
        createPortal(
          <div
            ref={menuRef}
            className="fixed z-[200] max-h-[min(16rem,calc(100vh-1rem))] overflow-y-auto rounded-lg border border-surface3 bg-surface1 py-1 shadow-lg"
            style={{ top: menuPos.top, left: menuPos.left, width: MOVE_MENU_W }}
          >
            {!readOnly && onNewProject && (
              <Button
                variant="bare"
                onClick={() => {
                  setOpen(false)
                  onNewProject()
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-on-surface hover:bg-surface2"
              >
                <Plus size={13} className="text-muted" />
                <span className="flex-1 truncate">New project</span>
              </Button>
            )}
            {!readOnly && openProjects.length > 0 && onNewProject && (
              <div className="my-1 border-t border-surface3" />
            )}
            {!readOnly && (
              <Button
                variant="bare"
                onClick={() => pick(undefined)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-on-surface hover:bg-surface2"
              >
                <ProjectAvatar size={13} />
                <span className="flex-1 truncate">{CONFIG.UI_LABELS.CODE_NO_PROJECT}</span>
                {!valueId && <Check size={13} className="text-accent-text" />}
              </Button>
            )}
            {!readOnly &&
              openProjects.map((p) => (
                <Button
                  variant="bare"
                  key={p.id}
                  onClick={() => pick(p.id)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-on-surface hover:bg-surface2"
                >
                  <ProjectAvatar icon={p.icon} imagePath={p.imagePath} size={13} />
                  <span className="flex-1 truncate">{p.name}</span>
                  {valueId === p.id && <Check size={13} className="text-accent-text" />}
                </Button>
              ))}
            {selected && onEditProject && (
              <Button
                variant="bare"
                onClick={() => {
                  setOpen(false)
                  onEditProject(selected)
                }}
                className="flex w-full items-center gap-2 border-t border-surface3 px-3 py-1.5 text-left text-sm text-on-surface hover:bg-surface2"
              >
                <Settings2 size={13} className="text-muted" />
                <span className="flex-1 truncate">{CONFIG.UI_LABELS.CHAT_PROJECT_SETTINGS}</span>
              </Button>
            )}
          </div>,
          document.body
        )}
    </>
  )
}

import React, { useEffect, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { ProjectIcon } from '../../../shared/project-icons'
import type { MightyProject } from '../../../shared/types'
import { Button } from './Button'

export { PROJECT_ICONS, ProjectIcon } from '../../../shared/project-icons'

export function ProjectAvatar({
  icon,
  imagePath,
  size = 12,
  className = ''
}: {
  icon?: string
  imagePath?: string
  size?: number
  className?: string
}): React.ReactElement {
  const [imgFailed, setImgFailed] = useState(false)
  useEffect(() => setImgFailed(false), [imagePath])
  const showImg = imagePath !== undefined && imagePath !== '' && !imgFailed
  if (showImg) {
    return (
      <img
        src={window.api.mediaUrl(imagePath)}
        alt=""
        aria-hidden
        onError={() => setImgFailed(true)}
        className={`shrink-0 rounded object-cover ${className}`}
        style={{ width: size, height: size }}
      />
    )
  }
  return (
    <span
      className={`inline-grid shrink-0 place-items-center ${className}`}
      style={{ width: size, height: size }}
    >
      <ProjectIcon id={icon} size={size} />
    </span>
  )
}

export function ProjectGroupHeader({
  name,
  count,
  collapsed,
  onToggle,
  icon,
  imagePath,
  alertCount = 0,
  onAlertClick,
  alertFilterOn = false,
  active = false,
  actions
}: {
  name: string
  count: number
  collapsed: boolean
  onToggle: () => void
  icon?: string
  imagePath?: string
  alertCount?: number
  onAlertClick?: () => void
  alertFilterOn?: boolean
  active?: boolean
  actions?: ReactNode
}): React.ReactElement {
  return (
    <div className={`project-group-header group relative flex items-center ${active ? 'bg-surface2/80' : ''}`}>
      <Button
        variant="bare"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className="flex min-w-0 flex-1 items-center gap-2 p-0 text-left"
      >
        {collapsed ? (
          <ChevronRight size={13} className="project-group-chevron" />
        ) : (
          <ChevronDown size={13} className="project-group-chevron" />
        )}
        <ProjectAvatar icon={icon} imagePath={imagePath} size={16} className="rounded-[4px]" />
        <span className="min-w-0 flex-1 truncate">{name}</span>
        {count > 0 && <span className="project-group-count shrink-0 text-xs tabular-nums text-muted">{count}</span>}
        {(alertCount > 0 || (onAlertClick && alertFilterOn)) &&
          (onAlertClick ? (
            <span
              role="button"
              tabIndex={0}
              aria-pressed={alertFilterOn}
              title={alertFilterOn ? 'Show all again' : `Show the ${alertCount} waiting on you`}
              aria-label={alertFilterOn ? 'Show all again' : `Show the ${alertCount} waiting on you`}
              onClick={(e) => {
                e.stopPropagation()
                onAlertClick()
              }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return
                e.preventDefault()
                e.stopPropagation()
                onAlertClick()
              }}
              className={`-m-1.5 shrink-0 cursor-pointer rounded-md p-1.5 ${alertFilterOn ? 'bg-[rgba(var(--accent-rgb),0.18)]' : ''}`}
            >
              <span className="agent-projects-dot" />
            </span>
          ) : (
            <span className="agent-projects-dot" title={`${alertCount} waiting on you`} />
          ))}
      </Button>
      {actions}
    </div>
  )
}

const PROJECT_DRAG_TYPE = 'application/x-mightymouse-project'

type DropSpot = { id: string; after: boolean }

export function moveProject(projects: MightyProject[], dragged: string, target: string, after: boolean): MightyProject[] {
  const rest = projects.filter((p) => p.id !== dragged)
  const moving = projects.find((p) => p.id === dragged)
  const at = rest.findIndex((p) => p.id === target)
  if (!moving || at < 0) return projects
  rest.splice(after ? at + 1 : at, 0, moving)
  void window.api.mighty.reorderProjects(rest.map((p) => p.id))
  return rest
}

export function useProjectReorder(onMove: (dragged: string, target: string, after: boolean) => void): {
  handleProps: (id: string) => { draggable: true; onDragStart: (e: DragEvent) => void; onDragEnd: () => void }
  dropProps: (id: string) => {
    onDragOver: (e: DragEvent<HTMLElement>) => void
    onDragLeave: (e: DragEvent<HTMLElement>) => void
    onDrop: (e: DragEvent) => void
    style?: CSSProperties
  }
} {
  const [dragged, setDragged] = useState<string | null>(null)
  const [spot, setSpot] = useState<DropSpot | null>(null)
  const end = (): void => {
    setDragged(null)
    setSpot(null)
  }
  return {
    handleProps: (id) => ({
      draggable: true,
      onDragStart: (e) => {
        e.dataTransfer.setData(PROJECT_DRAG_TYPE, id)
        e.dataTransfer.effectAllowed = 'move'
        setDragged(id)
      },
      onDragEnd: end
    }),
    dropProps: (id) => ({
      onDragOver: (e) => {
        if (!dragged || !e.dataTransfer.types.includes(PROJECT_DRAG_TYPE)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        const box = e.currentTarget.getBoundingClientRect()
        const after = e.clientY > box.top + Math.min(box.height, 40) / 2
        if (spot?.id !== id || spot.after !== after) setSpot({ id, after })
      },
      onDragLeave: (e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null) && spot?.id === id) setSpot(null)
      },
      onDrop: (e) => {
        if (!dragged || !e.dataTransfer.types.includes(PROJECT_DRAG_TYPE)) return
        e.preventDefault()
        if (spot && dragged !== spot.id) onMove(dragged, spot.id, spot.after)
        end()
      },
      style:
        spot?.id === id && dragged !== id
          ? { boxShadow: `inset 0 ${spot.after ? -2 : 2}px 0 rgb(var(--accent-rgb))` }
          : dragged === id
            ? { opacity: 0.5 }
            : undefined
    })
  }
}

import React, { useEffect, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { ProjectIcon } from '../../../shared/project-icons'
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

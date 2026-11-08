import { useEffect, useState, type ReactElement } from 'react'
import {
  ArrowLeft,
  ArrowRightLeft,
  ChevronRight,
  ExternalLink,
  FolderPlus,
  Maximize2,
  MessagesSquare,
  Minus,
  Paperclip,
  Plus,
  Sparkles,
  StickyNote,
  Trash2,
  X
} from 'lucide-react'
import { Button } from '../components/Button'
import { CopyButton } from '../components/CopyButton'
import { ProjectAvatar } from '../components/ProjectIcon'
import type { Point } from './layout'

const TOAST_MS = 6000

export interface PickBarProps {
  at: Point
  count: number
  planets: Array<{ id: string; name: string }>
  onOpen?: () => void
  onMove?: (planet: string) => void
  onCopy?: () => Promise<boolean>
  onAsk?: () => void
  onRemove: () => void
  onClear: () => void
}

/** One bar over whatever is picked - the same for one bubble or twenty. */
export function PickBar(p: PickBarProps): ReactElement {
  const [moving, setMoving] = useState(false)
  useEffect(() => setMoving(false), [p.count, p.at.x, p.at.y])
  return (
    <div
      className="cv-pickbar"
      style={{ left: p.at.x, top: p.at.y }}
      data-no-drag
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <div className="cv-pickbar-in">
      <div className="cv-pickbar-row">
        <span className="cv-pickbar-count">{p.count} picked</span>
        {p.onOpen ? (
          <Button variant="bare" onClick={p.onOpen}>
            <ExternalLink size={13} /> Open
          </Button>
        ) : null}
        {p.onAsk ? (
          <Button variant="bare" className="cv-pickbar-ask" onClick={p.onAsk}>
            <Sparkles size={13} /> {p.count === 1 ? 'Ask about this' : 'Ask about these'}
          </Button>
        ) : null}
        {p.onMove && p.planets.length ? (
          <Button
            variant="bare"
            className={moving ? 'cv-on' : ''}
            onClick={() => setMoving((m) => !m)}
          >
            <ArrowRightLeft size={13} /> Move to
          </Button>
        ) : null}
        {p.onCopy ? (
          <CopyButton showLabel copy={p.onCopy} />
        ) : null}
        <Button variant="bare" className="cv-pickbar-bad" onClick={p.onRemove}>
          <Trash2 size={13} /> Remove
        </Button>
        <Button variant="bare" aria-label="Clear the pick" onClick={p.onClear}>
          <X size={13} />
        </Button>
      </div>
      {moving && p.onMove ? (
        <div className="cv-pickbar-row cv-pickbar-planets">
          {p.planets.map((pl) => (
            <Button
              key={pl.id}
              variant="bare"
              className="cv-chip"
              onClick={() => {
                setMoving(false)
                p.onMove?.(pl.id)
              }}
            >
              {pl.name}
            </Button>
          ))}
        </div>
      ) : null}
      </div>
    </div>
  )
}

export interface Toast {
  id: number
  text: string
}

/** Bottom toast after a remove or move; Undo puts the canvas back as it was. */
export function UndoToast({
  toast,
  onUndo,
  onGone
}: {
  toast: Toast
  onUndo: () => void
  onGone: () => void
}): ReactElement {
  useEffect(() => {
    const t = window.setTimeout(onGone, TOAST_MS)
    return () => clearTimeout(t)
  }, [toast.id, onGone])
  return (
    <div className="cv-toast" key={toast.id} onPointerDown={(e) => e.stopPropagation()}>
      {toast.text}
      <Button
        variant="bare"
        onClick={() => {
          onUndo()
          onGone()
        }}
      >
        Undo
      </Button>
    </div>
  )
}

/** Bottom-right zoom: out, the live %, in, and Fit. The % is written by the camera loop. */
export function ZoomPill({
  bindPercent,
  onZoom,
  onFit
}: {
  bindPercent: (el: HTMLSpanElement | null) => void
  onZoom: (factor: number) => void
  onFit: () => void
}): ReactElement {
  return (
    <div className="cv-zoom" onPointerDown={(e) => e.stopPropagation()}>
      <Button variant="bare" aria-label="Zoom out" onClick={() => onZoom(1 / 1.25)}>
        <Minus size={13} />
      </Button>
      <span ref={bindPercent} className="cv-zoom-pct" />
      <Button variant="bare" aria-label="Zoom in" onClick={() => onZoom(1.25)}>
        <Plus size={13} />
      </Button>
      <Button variant="bare" className="cv-zoom-fit" onClick={onFit} title="Fit everything (⇧1)">
        <Maximize2 size={12} /> Fit
      </Button>
    </div>
  )
}

export interface AddMenuProps {
  projects: Array<{ id: string; name: string; icon?: string; imagePath?: string }>
  onNote: () => void
  onChats: () => void
  onFiles: (files: File[]) => void
  onProject: (ids: string[]) => void
  onClose: () => void
}

/** The toolbar's + : a note, a chat or session, a file, or a project that isn't on the canvas yet. */
export function AddMenu(p: AddMenuProps): ReactElement {
  const [projects, setProjects] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopImmediatePropagation()
      p.onClose()
    }
    addEventListener('pointerdown', p.onClose)
    addEventListener('keydown', onKey, true)
    return () => {
      removeEventListener('pointerdown', p.onClose)
      removeEventListener('keydown', onKey, true)
    }
  }, [p.onClose])
  return (
    <div className="cv-add-menu" onPointerDown={(e) => e.stopPropagation()}>
      {projects ? (
        <>
          <Button variant="bare" className="cv-add-back" onClick={() => setProjects(false)}>
            <ArrowLeft size={13} /> Add a project
          </Button>
          <div className="cv-add-list">
            {p.projects.length > 1 ? (
              <Button variant="bare" onClick={() => p.onProject(p.projects.map((pr) => pr.id))}>
                <FolderPlus size={14} /> All {p.projects.length} projects
              </Button>
            ) : null}
            {p.projects.map((pr) => (
              <Button key={pr.id} variant="bare" onClick={() => p.onProject([pr.id])}>
                <ProjectAvatar icon={pr.icon} imagePath={pr.imagePath} size={16} /> {pr.name}
              </Button>
            ))}
          </div>
        </>
      ) : (
        <>
          <Button variant="bare" onClick={p.onNote}>
            <StickyNote size={14} /> Note
          </Button>
          <Button variant="bare" onClick={p.onChats}>
            <MessagesSquare size={14} /> Chat or Code session
          </Button>
          <label className="cv-add-file">
            <Paperclip size={14} /> File or photo
            <input
              type="file"
              multiple
              hidden
              onChange={(e) => {
                const files = [...(e.target.files ?? [])]
                if (files.length) p.onFiles(files)
              }}
            />
          </label>
          {p.projects.length ? (
            <Button variant="bare" onClick={() => setProjects(true)}>
              <FolderPlus size={14} /> Project
              <ChevronRight size={13} className="cv-add-more" />
            </Button>
          ) : null}
        </>
      )}
    </div>
  )
}

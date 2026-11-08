import { useEffect, useRef, useState, type ReactElement } from 'react'
import { ChevronDown, FileText, LayoutGrid, Lightbulb, Plus, X } from 'lucide-react'
import { Button } from '../components/Button'
import { ProjectAvatar } from '../components/ProjectIcon'
import { CANVAS_SANDBOX, SESSION_DRAG_TYPE, type CanvasBoardSummary } from '@shared/canvas'
import type { MediaAttachment, MightyProject, MightySession } from '@shared/types'
import type { PlanetSpot, Point } from './layout'
import { chatTitle } from './useDispatcher'
import { rulerTicks, type TimeMark } from './time-layout'

const EXAMPLE_MS = 3200
const CHATS_SHOWN = 14

export function PlanetView({
  spot,
  project,
  count,
  hot,
  more,
  dim,
  faded,
  connected,
  dragging,
  onDown,
  onPlus
}: {
  spot: PlanetSpot
  project?: MightyProject
  count: number
  hot: boolean
  more?: number
  dim: boolean
  faded: boolean
  connected: boolean
  dragging: boolean
  onDown: (e: React.PointerEvent) => void
  onPlus?: () => void
}): ReactElement {
  const sandbox = spot.id === CANVAS_SANDBOX
  return (
    <div
      className={`cv-planet ${sandbox ? 'cv-sandbox' : ''} ${hot ? 'cv-hot' : ''} ${connected ? 'cv-connected' : ''} ${dragging ? 'cv-planet-drag' : ''} ${faded ? 'cv-faded' : ''}`}
      style={{
        width: spot.r * 2,
        height: spot.r * 2,
        transform: `translate(${spot.x - spot.r}px,${spot.y - spot.r}px)`,
        opacity: dim ? 0 : undefined,
        pointerEvents: dim ? 'none' : undefined
      }}
      onPointerDown={onDown}
      onDragStart={(e) => e.preventDefault()}
    >
      {onPlus ? (
        <span className="cv-planet-plus">
          <Button
            variant="bare"
            aria-label={`Add to ${sandbox ? 'Sandbox' : (project?.name ?? 'this project')}`}
            title={`Add to ${sandbox ? 'Sandbox' : (project?.name ?? 'this project')}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              onPlus()
            }}
          >
            <Plus size={14} strokeWidth={2.4} />
          </Button>
        </span>
      ) : null}
      {sandbox ? (
        <Lightbulb size={spot.r * 0.8} strokeWidth={1.6} />
      ) : (
        <ProjectAvatar
          icon={project?.icon}
          imagePath={project?.imagePath}
          size={spot.r}
          className="rounded-full"
        />
      )}
      <div
        className="cv-planet-name"
        style={{ width: spot.nameW, left: spot.r - spot.nameW / 2, top: spot.r * 2 + 1 }}
      >
        <span>{sandbox ? 'Sandbox' : (project?.name ?? 'Project')}</span>
        {more ? (
          <small>
            {count - more} of {count}
          </small>
        ) : count ? (
          <em>{count}</em>
        ) : null}
      </div>
    </div>
  )
}

export function WriteBubble({
  at,
  seed,
  onDone
}: {
  at: Point
  seed?: string
  onDone: (text: string) => void
}): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  const finished = useRef(false)
  const finish = (text: string): void => {
    if (finished.current) return
    finished.current = true
    onDone(text)
  }
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    if (seed) {
      el.textContent = seed
      getSelection()?.selectAllChildren(el)
      getSelection()?.collapseToEnd()
    }
  }, [seed])
  return (
    <div
      className="cv-bubble cv-write"
      style={{ transform: `translate(${at.x - 140}px,${at.y - 22}px)` }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div
        ref={ref}
        className="cv-edit"
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        data-ph="Type a thought or a question"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            finish(ref.current?.textContent?.trim() ?? '')
          }
          if (e.key === 'Escape') finish('')
        }}
        onBlur={() => finish(ref.current?.textContent?.trim() ?? '')}
      />
    </div>
  )
}

export function HubInput({
  bindRef,
  dim,
  connected,
  examples,
  files,
  onRemoveFile,
  onSubmit
}: {
  bindRef: (el: HTMLDivElement | null) => void
  dim: boolean
  connected: boolean
  examples: string[]
  files: MediaAttachment[]
  onRemoveFile: (path: string) => void
  onSubmit: (text: string) => void
}): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  const [i, setI] = useState(0)
  useEffect(() => {
    bindRef(ref.current)
    ref.current?.focus()
  }, [bindRef])
  useEffect(() => {
    const t = setInterval(() => setI((n) => n + 1), EXAMPLE_MS)
    return () => clearInterval(t)
  }, [])
  return (
    <div
      className={`cv-bubble cv-hub ${dim ? 'cv-dim' : ''} ${connected ? 'cv-hub-on' : ''}`}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {files.length ? (
        <div className="cv-hub-files">
          {files.map((f) => (
            <span key={f.path} className="cv-hub-file" title={f.name}>
              {f.kind === 'image' ? (
                <img src={window.api.mediaUrl(f.path)} alt="" draggable={false} />
              ) : (
                <span className="cv-hub-doc">
                  <FileText size={14} />
                  {f.name}
                </span>
              )}
              <Button
                variant="icon"
                aria-label={`Remove ${f.name}`}
                onClick={() => onRemoveFile(f.path)}
              >
                <X size={12} />
              </Button>
            </span>
          ))}
        </div>
      ) : null}
      <div
        ref={ref}
        className="cv-edit"
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        data-ph={
          files.length ? 'Add a note, or press Enter to send' : examples[i % examples.length]
        }
        onKeyDown={(e) => {
          if (e.key === 'Backspace' && files.length && !e.currentTarget.textContent) {
            onRemoveFile(files[files.length - 1].path)
            return
          }
          if (e.key !== 'Enter' || e.shiftKey) return
          e.preventDefault()
          const el = e.currentTarget
          const text = el.textContent?.trim() ?? ''
          if (!text && !files.length) return
          el.textContent = ''
          onSubmit(text)
        }}
      />
    </div>
  )
}

const ago = (iso: string): string => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`
}

/** Top-left switcher: the open canvas, earlier ones, and a fresh one (⌘N). */
export function BoardPicker({
  boards,
  onOpen,
  onNew
}: {
  boards: CanvasBoardSummary[]
  onOpen: (id: string) => void
  onNew: () => void
}): ReactElement {
  const [open, setOpen] = useState(false)
  const current = boards.find((b) => b.current)
  useEffect(() => {
    if (!open) return
    const close = (): void => setOpen(false)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopImmediatePropagation()
      close()
    }
    addEventListener('pointerdown', close)
    addEventListener('keydown', onKey, true)
    return () => {
      removeEventListener('pointerdown', close)
      removeEventListener('keydown', onKey, true)
    }
  }, [open])
  return (
    <div className="cv-boards" onPointerDown={(e) => e.stopPropagation()}>
      <Button variant="secondary" title="Your canvases" onClick={() => setOpen((o) => !o)}>
        <LayoutGrid size={13} className="inline mr-1.5 -mt-px" />
        {current?.title ?? 'New canvas'}
        <ChevronDown size={13} className="inline ml-1 -mt-px" />
      </Button>
      {open ? (
        <div className="cv-boards-menu">
          <Button
            variant="bare"
            className="cv-boards-row"
            onClick={() => {
              setOpen(false)
              onNew()
            }}
          >
            <Plus size={13} />
            <b>New canvas</b>
            <span>⌘N</span>
          </Button>
          {boards.map((b) => (
            <Button
              key={b.id}
              variant="bare"
              className={`cv-boards-row ${b.current ? 'cv-boards-on' : ''}`}
              onClick={() => {
                setOpen(false)
                if (!b.current) onOpen(b.id)
              }}
            >
              <b>{b.title}</b>
              <span>
                {b.count} - {ago(b.updated)}
              </span>
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** Recent chats not on this canvas yet; click one or drag it onto the canvas. */
export function ChatsPicker({
  sessions,
  projectName,
  onAdd,
  onClose
}: {
  sessions: MightySession[]
  projectName: (id?: string) => string
  onAdd: (id: string) => void
  onClose: () => void
}): ReactElement {
  const [q, setQ] = useState('')
  const shown = sessions
    .filter((s) => !q || s.title.toLowerCase().includes(q.toLowerCase()))
    .slice(0, CHATS_SHOWN)
  return (
    <div className="cv-chats" onPointerDown={(e) => e.stopPropagation()}>
      <div className="cv-chats-head">
        <input
          autoFocus
          value={q}
          placeholder="Find a chat"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && onClose()}
        />
      </div>
      {shown.length ? (
        shown.map((s) => (
          <Button
            key={s.id}
            variant="bare"
            className="cv-chats-row"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(SESSION_DRAG_TYPE, s.id)
              e.dataTransfer.effectAllowed = 'copy'
            }}
            onClick={() => onAdd(s.id)}
          >
            <span>{chatTitle(s)}</span>
            <small>
              {projectName(s.projectId)} - {ago(s.updated)}
            </small>
          </Button>
        ))
      ) : (
        <p className="cv-chats-empty">
          {q ? 'No chat matches that.' : 'Every chat is already on this canvas.'}
        </p>
      )}
    </div>
  )
}

const clock = (t: number): string =>
  new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
const dayClock = (t: number): string =>
  `${new Date(t).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}, ${clock(t)}`

/** Time ruler pinned under the top bar; the animation loop moves it with the camera through --cx and --z. */
export function TimeRuler({
  marks,
  bind
}: {
  marks: TimeMark[]
  bind: (el: HTMLDivElement | null) => void
}): ReactElement {
  const ticks = rulerTicks(marks, 15)
  return (
    <div className="cv-ruler" ref={bind}>
      {ticks.map((k, i) => (
        <span
          key={i}
          className={`cv-tick ${k.gapLabel ? 'cv-tick-gap' : k.major || k.dated ? 'cv-tick-major' : 'cv-tick-minor'}`}
          style={{ ['--x' as string]: `${k.x}px` }}
        >
          {k.gapLabel ?? (k.dated ? dayClock(k.t) : clock(k.t))}
        </span>
      ))}
    </div>
  )
}

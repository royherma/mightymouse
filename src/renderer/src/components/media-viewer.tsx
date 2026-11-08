import { createContext, useContext, useEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FolderOpen,
  PenLine,
  X
} from 'lucide-react'
import { Button } from './Button'
import { CopyButton } from './CopyButton'
import { MarkupEditor } from './markup'
import './local-path.css'

const VIDEO = /\.(mp4|mov|webm)$/i

const ConversationMedia = createContext<string[]>([])
export const ConversationMediaProvider = ConversationMedia.Provider
export const useConversationMedia = (): string[] => useContext(ConversationMedia)

async function copyImage(path: string): Promise<void> {
  const img = new window.Image()
  img.crossOrigin = 'anonymous'
  img.src = window.api.mediaUrl(path)
  await img.decode()
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  canvas.getContext('2d')?.drawImage(img, 0, 0)
  const png = await new Promise<Blob | null>((done) => canvas.toBlob(done, 'image/png'))
  if (!png) throw new Error('could not encode image')
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
}

const fileName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

export function useMediaViewer(paths: string[]): {
  open: (path: string) => void
  viewer: ReactElement | null
} {
  const all = useConversationMedia()
  const [at, setAt] = useState<{ list: string[]; path: string } | null>(null)
  const viewer = at && (
    <MediaViewer list={at.list} start={at.path} onClose={() => setAt(null)} />
  )
  return { open: (path) => setAt({ list: all.includes(path) ? all : paths, path }), viewer }
}

function MediaViewer(props: { list: string[]; start: string; onClose: () => void }): ReactElement {
  return createPortal(
    <div className="media-viewer" role="dialog" aria-label="Media" onClick={props.onClose}>
      <MediaBrowser list={props.list} start={props.start} onClose={props.onClose} />
    </div>,
    document.body
  )
}

function useDrawings(): [string[], () => void] {
  const [drawings, setDrawings] = useState<string[]>([])
  const refresh = (): void => void window.api.markupList().then(setDrawings, () => undefined)
  useEffect(refresh, [])
  return [drawings, refresh]
}

export function MediaBrowser(props: {
  list: string[]
  start: string
  onClose?: () => void
  onPath?: (path: string) => void
}): ReactElement {
  const { onClose, onPath } = props
  const modal = Boolean(onClose)
  const [drawings, refreshDrawings] = useDrawings()
  const [path, setPath] = useState(props.start)
  const [tab, setTab] = useState<'chat' | 'drawings'>(() =>
    props.start.includes('-markup-') && !props.list.includes(props.start) ? 'drawings' : 'chat'
  )
  const [marking, setMarking] = useState(false)
  const stripRef = useRef<HTMLDivElement>(null)
  const chat = props.list.includes(props.start) || tab === 'drawings' ? props.list : [props.start, ...props.list]
  const items = tab === 'chat' ? chat : drawings.includes(path) ? drawings : [path, ...drawings]
  const index = Math.max(0, items.indexOf(path))
  const isVideo = VIDEO.test(path)

  const [start, setStart] = useState(props.start)
  if (start !== props.start) {
    setStart(props.start)
    setPath(props.start)
  }
  useEffect(() => {
    stripRef.current?.querySelector('[data-on]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [path, tab])

  const go = (next: string): void => {
    setPath(next)
    onPath?.(next)
  }
  const step = (by: number): void => {
    if (items.length > 1) go(items[(index + by + items.length) % items.length])
  }
  const onKey = (e: KeyboardEvent | React.KeyboardEvent): boolean => {
    if (marking) return false
    if (e.key === 'Escape' && onClose) onClose()
    else if (e.key === 'ArrowLeft') step(-1)
    else if (e.key === 'ArrowRight') step(1)
    else return false
    e.preventDefault()
    e.stopPropagation()
    return true
  }

  useEffect(() => {
    if (!modal) return
    const listener = (e: KeyboardEvent): void => void onKey(e)
    window.addEventListener('keydown', listener, true)
    return () => window.removeEventListener('keydown', listener, true)
  })

  const saved = (next: string, sent: boolean): void => {
    setMarking(false)
    refreshDrawings()
    setTab('drawings')
    go(next)
    if (sent) onClose?.()
  }

  if (marking)
    return (
      <div className="media-browser" data-frame={modal ? 'modal' : 'panel'} onClick={(e) => e.stopPropagation()}>
        <MarkupEditor path={path} onClose={() => setMarking(false)} onSaved={saved} />
      </div>
    )

  return (
    <div
      className="media-browser"
      data-frame={modal ? 'modal' : 'panel'}
      tabIndex={modal ? undefined : 0}
      onKeyDown={modal ? undefined : (e) => void onKey(e)}
    >
      <div className="media-viewer-top" onClick={(e) => e.stopPropagation()}>
        {modal && (
          <span className="media-viewer-name" title={path}>
            {fileName(path)}
          </span>
        )}
        {items.length > 1 && (
          <span className="media-viewer-count">
            {index + 1} of {items.length}
          </span>
        )}
        {!modal && <span className="media-viewer-name" />}
        {!isVideo && (
          <Button variant="ghost" className="media-viewer-markup" onClick={() => setMarking(true)} title="Draw on it, then save it or send it back">
            <PenLine size={13} strokeWidth={2.5} />
            Drawings
          </Button>
        )}
        {modal && (
          <Button variant="icon" onClick={onClose} title="Close (Esc)">
            <X size={16} strokeWidth={2.5} />
          </Button>
        )}
      </div>

      <div className="media-viewer-stage">
        {items.length > 1 && (
          <Button
            variant="icon"
            className="media-viewer-nav"
            title="Previous (←)"
            onClick={(e) => {
              e.stopPropagation()
              step(-1)
            }}
          >
            <ChevronLeft size={20} strokeWidth={2.5} />
          </Button>
        )}
        {isVideo ? (
          <video
            key={path}
            className="media-viewer-media"
            src={window.api.mediaUrl(path)}
            controls
            autoPlay={modal}
            playsInline
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <img
            key={path}
            className="media-viewer-media"
            src={window.api.mediaUrl(path)}
            alt={fileName(path)}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={() => setMarking(true)}
          />
        )}
        {items.length > 1 && (
          <Button
            variant="icon"
            className="media-viewer-nav"
            title="Next (→)"
            onClick={(e) => {
              e.stopPropagation()
              step(1)
            }}
          >
            <ChevronRight size={20} strokeWidth={2.5} />
          </Button>
        )}
      </div>

      <div className="media-strip" onClick={(e) => e.stopPropagation()}>
        <div className="media-strip-tabs" role="tablist">
          {(['chat', 'drawings'] as const).map((t) => (
            <Button
              key={t}
              variant="bare"
              role="tab"
              aria-selected={tab === t}
              data-on={tab === t ? '' : undefined}
              className="media-strip-tab"
              onClick={() => {
                setTab(t)
                const first = t === 'chat' ? chat[chat.length - 1] : drawings[0]
                if (first && !(t === 'chat' ? chat : drawings).includes(path)) go(first)
              }}
            >
              {t === 'chat' ? 'In this chat' : 'Drawings'}
              <span className="media-strip-n">{t === 'chat' ? chat.length : drawings.length}</span>
            </Button>
          ))}
        </div>
        <div ref={stripRef} className="media-strip-row">
          {tab === 'drawings' && drawings.length === 0 && (
            <span className="media-strip-empty">Nothing yet. Press Drawings on any image to draw on it.</span>
          )}
          {(tab === 'chat' ? chat : drawings).map((p) => (
            <Button
              key={p}
              variant="bare"
              className="media-strip-thumb"
              data-on={p === path ? '' : undefined}
              title={fileName(p)}
              onClick={() => go(p)}
            >
              {VIDEO.test(p) ? (
                <video src={window.api.mediaUrl(p)} muted playsInline preload="metadata" />
              ) : (
                <img src={window.api.mediaUrl(p)} alt="" loading="lazy" />
              )}
            </Button>
          ))}
        </div>
      </div>

      <div className="media-viewer-actions" onClick={(e) => e.stopPropagation()}>
        {modal && (
          <Button variant="ghost" onClick={() => void window.api.openMedia(path)}>
            <ExternalLink size={13} strokeWidth={2.5} />
            {isVideo ? 'Open' : 'Open in Preview'}
          </Button>
        )}
        {modal && (
          <Button variant="ghost" onClick={() => void window.api.openPath(path)}>
            <FolderOpen size={13} strokeWidth={2.5} />
            Show in Finder
          </Button>
        )}
        {!isVideo && (
          <CopyButton key={`image:${path}`} showLabel label="Copy image" copy={() => copyImage(path)} />
        )}
        <CopyButton key={`path:${path}`} showLabel label="Copy path" text={path} />
      </div>
    </div>
  )
}

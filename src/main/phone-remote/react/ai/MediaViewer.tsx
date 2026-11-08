import { useEffect, useRef, useState } from 'react'
import { Download, Grid3x3, ImageOff, Play, Share, X } from 'lucide-react'
import type { MediaRef } from './use-ai-session'
import { Button } from '@shared/ui/Button'

const MAX_SCALE = 5
const SWIPE_PX = 60
const CLOSE_PX = 110
const AXIS_LOCK_PX = 8
const DOUBLE_TAP_MS = 280
const EXT: Record<string, string> = { jpeg: 'jpg', quicktime: 'mov', 'svg+xml': 'svg', 'x-m4v': 'm4v' }

type View = { scale: number; x: number; y: number }
type Drag = { dx: number; dy: number }
type Gesture = { spread0: number; x0: number; y0: number; view0: View; axis: 'x' | 'y' | 'zoom' | null; moved: boolean }
const FIT: View = { scale: 1, x: 0, y: 0 }

function spread(t: React.TouchList): number {
  return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)
}

async function toFile(m: MediaRef): Promise<File> {
  const res = await fetch(m.src)
  if (!res.ok) throw new Error(String(res.status))
  const blob = await res.blob()
  const sub = blob.type.split('/')[1] ?? (m.video ? 'mp4' : 'png')
  const name = /\.\w{2,4}$/.test(m.name) ? m.name : `${m.name.replace(/\s+/g, '-')}.${EXT[sub] ?? sub}`
  return new File([blob], name, { type: blob.type })
}

async function shareMedia(m: MediaRef): Promise<string | null> {
  try {
    const file = await toFile(m)
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file] })
      return null
    }
    return saveFile(file)
  } catch (err) {
    return err instanceof DOMException && err.name === 'AbortError' ? null : `Could not share that ${m.video ? 'video' : 'image'}`
  }
}

function saveFile(file: File): null {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(file)
  a.download = file.name
  a.click()
  window.setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
  return null
}

async function downloadMedia(m: MediaRef): Promise<string | null> {
  try {
    return saveFile(await toFile(m))
  } catch {
    return `Could not download that ${m.video ? 'video' : 'image'}`
  }
}

function withBust(src: string, bust: number): string {
  return bust ? `${src}${src.includes('?') ? '&' : '?'}r=${bust}` : src
}

function Slide(props: { m: MediaRef; current: boolean; near: boolean; view: View }): React.JSX.Element {
  const [state, setState] = useState<'loading' | 'ok' | 'failed'>('loading')
  const [bust, setBust] = useState(0)
  const videoRef = useRef<HTMLVideoElement | null>(null)

  useEffect(() => {
    if (!props.current) videoRef.current?.pause()
  }, [props.current])

  if (!props.near) return <div className="aiViewerSlide" />
  const src = withBust(props.m.src, bust)
  const kind = props.m.video ? 'video' : 'image'
  return (
    <div className="aiViewerSlide">
      {state === 'loading' && <i className="aiRing aiViewerSpin" />}
      {state === 'failed' ? (
        <div className="aiViewerFailed">
          <ImageOff size={28} />
          <span>{`Couldn't load that ${kind}`}</span>
          <Button
            variant="bare"
            type="button"
            onClick={() => {
              setState('loading')
              setBust((n) => n + 1)
            }}
          >
            Retry
          </Button>
        </div>
      ) : props.m.video ? (
        <video
          ref={videoRef}
          src={src}
          controls={props.current}
          playsInline
          preload="metadata"
          hidden={state !== 'ok'}
          onLoadedMetadata={() => setState('ok')}
          onError={() => setState('failed')}
        />
      ) : (
        <img
          src={src}
          alt={props.m.name}
          draggable={false}
          hidden={state !== 'ok'}
          onLoad={() => setState('ok')}
          onError={() => setState('failed')}
          style={props.current ? { transform: `translate(${props.view.x}px, ${props.view.y}px) scale(${props.view.scale})` } : undefined}
        />
      )}
    </div>
  )
}

function Thumb({ m }: { m: MediaRef }): React.JSX.Element {
  return (
    <>
      {m.video ? <video src={m.src} muted playsInline preload="metadata" /> : <img src={m.src} alt="" loading="lazy" />}
      {m.video && (
        <span className="aiViewerThumbPlay" aria-hidden="true">
          <Play size={14} fill="currentColor" />
        </span>
      )}
    </>
  )
}

export function MediaViewer(props: { media: MediaRef[]; index: number; onClose: () => void }): React.JSX.Element | null {
  const { media, onClose } = props
  const [index, setIndex] = useState(props.index)
  const [view, setView] = useState<View>(FIT)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [chrome, setChrome] = useState(true)
  const [grid, setGrid] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const gesture = useRef<Gesture | null>(null)
  const lastTap = useRef(0)
  const tapTimer = useRef<number | undefined>(undefined)
  const stripRef = useRef<HTMLDivElement | null>(null)

  const last = media.length - 1
  const go = (i: number): void => setIndex(Math.max(0, Math.min(last, i)))

  useEffect(() => {
    setView(FIT)
    setError('')
    stripRef.current?.querySelector('[data-on]')?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' })
  }, [index])
  useEffect(() => () => window.clearTimeout(tapTimer.current), [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowRight') setIndex((i) => Math.min(i + 1, last))
      if (e.key === 'ArrowLeft') setIndex((i) => Math.max(i - 1, 0))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, last])

  const current = media[index]
  if (!current) return null

  const act = (run: (m: MediaRef) => Promise<string | null>): void => {
    if (busy) return
    setBusy(true)
    void run(current).then((msg) => {
      setBusy(false)
      setError(msg ?? '')
    })
  }

  const onTouchStart = (e: React.TouchEvent): void => {
    const t = e.touches
    if (t.length > 1 && !current.video) {
      if (gesture.current) gesture.current = { ...gesture.current, axis: 'zoom', spread0: spread(t), view0: view, moved: true }
      else gesture.current = { spread0: spread(t), x0: t[0].clientX, y0: t[0].clientY, view0: view, axis: 'zoom', moved: true }
      setDrag(null)
      return
    }
    gesture.current = { spread0: 0, x0: t[0].clientX, y0: t[0].clientY, view0: view, axis: null, moved: false }
  }

  const onTouchMove = (e: React.TouchEvent): void => {
    const g = gesture.current
    if (!g) return
    const t = e.touches
    if (g.axis === 'zoom') {
      if (t.length < 2) return
      const scale = Math.min(MAX_SCALE, Math.max(1, (g.view0.scale * spread(t)) / g.spread0))
      setView((v) => (scale === 1 ? FIT : { ...v, scale }))
      return
    }
    const dx = t[0].clientX - g.x0
    const dy = t[0].clientY - g.y0
    if (!g.moved && Math.hypot(dx, dy) < AXIS_LOCK_PX) return
    g.moved = true
    if (g.view0.scale > 1) {
      setView({ ...g.view0, x: g.view0.x + dx, y: g.view0.y + dy })
      return
    }
    g.axis ??= Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
    if (g.axis === 'x') {
      const pastEdge = (index === 0 && dx > 0) || (index === last && dx < 0)
      setDrag({ dx: pastEdge ? dx * 0.3 : dx, dy: 0 })
    } else {
      setDrag({ dx: 0, dy: Math.max(0, dy) })
    }
  }

  const onTouchEnd = (e: React.TouchEvent): void => {
    const g = gesture.current
    if (!g || e.touches.length > 0) return
    gesture.current = null
    const end = e.changedTouches[0]
    const dx = end.clientX - g.x0
    const dy = end.clientY - g.y0
    setDrag(null)
    if (g.axis === 'x') {
      if (Math.abs(dx) > SWIPE_PX) go(index + (dx < 0 ? 1 : -1))
      return
    }
    if (g.axis === 'y') {
      if (dy > CLOSE_PX) onClose()
      return
    }
    if (g.moved) return
    const now = Date.now()
    if (!current.video && now - lastTap.current < DOUBLE_TAP_MS) {
      window.clearTimeout(tapTimer.current)
      lastTap.current = 0
      setView((v) => (v.scale > 1 ? FIT : { scale: 2.5, x: 0, y: 0 }))
      return
    }
    lastTap.current = now
    if (current.video) return
    tapTimer.current = window.setTimeout(() => setChrome((c) => !c), DOUBLE_TAP_MS)
  }

  const fade = drag ? Math.max(0.2, 1 - drag.dy / 400) : 1
  const kind = current.video ? 'video' : 'image'

  return (
    <div className="aiViewer" role="dialog" aria-label="Media" style={{ background: `rgba(0, 0, 0, ${fade})` }}>
      <div className="aiViewerBar" data-hidden={!chrome || drag?.dy ? '' : undefined}>
        <Button variant="bare" type="button" className="aiIconBtn" aria-label="Close" onClick={onClose}>
          <X size={24} />
        </Button>
        <span className="aiViewerCount">{media.length > 1 ? `${index + 1} of ${media.length}` : ''}</span>
        <div className="aiViewerActions">
          {media.length > 1 && (
            <Button variant="bare" type="button" className="aiIconBtn" aria-label="All media" title="All media" onClick={() => setGrid(true)}>
              <Grid3x3 size={18} />
              All
            </Button>
          )}
          <Button variant="bare" type="button" className="aiIconBtn" aria-label={`Download ${kind}`} title={`Download ${kind}`} disabled={busy} onClick={() => act(downloadMedia)}>
            <Download size={18} />
            Save
          </Button>
          <Button variant="bare" type="button" className="aiIconBtn" aria-label={`Share or save ${kind}`} title={`Share or save ${kind}`} disabled={busy} onClick={() => act(shareMedia)}>
            <Share size={18} />
            Share
          </Button>
        </div>
      </div>
      {error && <div className="aiToast aiViewerToast">{error}</div>}
      <div className="aiViewerStage" onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
        <div
          className="aiViewerTrack"
          data-dragging={drag ? '' : undefined}
          style={{ transform: `translate3d(calc(${-index * 100}% + ${drag?.dx ?? 0}px), ${drag?.dy ?? 0}px, 0)` }}
        >
          {media.map((m, i) => (
            <Slide key={`${m.key}:${i}`} m={m} current={i === index} near={Math.abs(i - index) <= 1} view={view} />
          ))}
        </div>
      </div>
      {media.length > 1 && (
        <div className="aiViewerStrip" ref={stripRef} data-hidden={!chrome || drag?.dy ? '' : undefined}>
          {media.map((m, i) => (
            <Button
              variant="bare"
              key={`${m.key}:${i}`}
              type="button"
              aria-label={`Show ${m.name}`}
              data-on={i === index ? '' : undefined}
              onClick={() => setIndex(i)}
            >
              <Thumb m={m} />
            </Button>
          ))}
        </div>
      )}
      {grid && (
        <div className="aiViewerGrid" role="dialog" aria-label="All media">
          <div className="aiViewerBar">
            <Button variant="bare" type="button" className="aiIconBtn" aria-label="Back to viewer" onClick={() => setGrid(false)}>
              <X size={24} />
            </Button>
            <span className="aiViewerCount">{`All media · ${media.length}`}</span>
            <span className="aiViewerActions" />
          </div>
          <div className="aiViewerGridCells">
            {media.map((m, i) => (
              <Button
                variant="bare"
                key={`${m.key}:${i}`}
                type="button"
                aria-label={`Open ${m.name}`}
                data-on={i === index ? '' : undefined}
                onClick={() => {
                  setIndex(i)
                  setGrid(false)
                }}
              >
                <Thumb m={m} />
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

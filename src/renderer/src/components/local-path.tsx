import { useEffect, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { FileText, FolderOpen, Image } from 'lucide-react'
import { useMediaViewer } from './media-viewer'
import { hasRail, openFileInRail } from '../hooks/useRailMode'
import type { FileReadResult } from '../../../shared/types'
import './local-path.css'

const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i
const VIDEO = /\.(mp4|mov|webm)$/i
const ABSOLUTE =
  /(?<![\w/.~-])\/(?:Users|private|tmp|var|opt|Volumes|Applications|Library)\/(?:[\w.@%+~-]+\/)*[\w.@%+~-]+(?::\d+(?::\d+)?)?/g
const RELATIVE =
  /(?<![\w/.~:-])(?:[\w@-][\w.@-]*\/)+[\w.@-]+\.[A-Za-z][A-Za-z0-9]{0,7}(?::\d+(?::\d+)?)?/g
const PREVIEW_BYTES = 65535
const HIDE_DELAY_MS = 200
const CARD_MAX_H = 280

export interface FoundPath {
  start: number
  end: number
  path: string
}

function stripLine(raw: string): string {
  return raw.replace(/(?::\d+){1,2}$/, '')
}

export function findPaths(text: string, cwd?: string): FoundPath[] {
  const found: FoundPath[] = []
  const taken = (at: number): boolean => found.some((f) => at >= f.start && at < f.end)
  for (const m of text.matchAll(ABSOLUTE)) {
    const raw = m[0].replace(/[.,:]+$/, '')
    found.push({ start: m.index, end: m.index + raw.length, path: stripLine(raw) })
  }
  if (cwd) {
    const base = cwd.endsWith('/') ? cwd : `${cwd}/`
    for (const m of text.matchAll(RELATIVE)) {
      if (taken(m.index)) continue
      const raw = m[0].replace(/[.,:]+$/, '')
      found.push({
        start: m.index,
        end: m.index + raw.length,
        path: base + stripLine(raw).replace(/^\.\//, '')
      })
    }
  }
  return found.sort((a, b) => a.start - b.start)
}

export function isMediaPath(path: string): boolean {
  return IMAGE.test(path) || VIDEO.test(path)
}

export function mediaIn(said: { text: string; files?: string[] }[], cwd?: string): string[] {
  const all = said.flatMap((s) => [...(s.files ?? []), ...findPaths(s.text, cwd).map((f) => f.path)])
  return [...new Set(all.filter(isMediaPath))]
}

export function hrefToPath(href: string | undefined, cwd?: string): string | undefined {
  if (!href) return undefined
  if (href.startsWith('file://')) return stripLine(decodeURIComponent(href.slice('file://'.length)))
  if (href.startsWith('/')) return stripLine(decodeURIComponent(href))
  if (!cwd || /^[a-z][\w+.-]*:|^#/i.test(href)) return undefined
  return `${cwd.replace(/\/$/, '')}/${stripLine(decodeURIComponent(href)).replace(/^\.\//, '')}`
}

const MACHINE_SEGMENT = /^-|^[0-9a-f]{8}-[0-9a-f-]{27,}$|^[0-9a-f]{24,}$/i

function readableFolder(folder: string): string {
  return folder
    .split('/')
    .filter((segment) => segment && !MACHINE_SEGMENT.test(segment))
    .slice(-2)
    .join('/')
}

export function isFilePath(path: string): boolean {
  return /.\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(splitPath(path).name)
}

function splitPath(path: string): { name: string; folder: string } {
  const at = path.lastIndexOf('/')
  return { name: path.slice(at + 1), folder: path.slice(0, at) }
}

export function PathLabel(props: { path: string; raw: string }): ReactElement {
  const line = props.raw.match(/(?::\d+){1,2}$/)?.[0] ?? ''
  const Icon = isMediaPath(props.path) ? Image : isFilePath(props.path) ? FileText : FolderOpen
  return (
    <>
      <Icon size={12} strokeWidth={2} />
      <span className="link-chip-label">
        {splitPath(props.path.replace(/\/$/, '')).name}
        {line}
      </span>
    </>
  )
}

function Preview(props: {
  path: string
  anchor: DOMRect
  onEnter: () => void
  onLeave: () => void
  onOpen: (e: React.MouseEvent) => void
  hint: string
}): ReactElement {
  const { path, anchor } = props
  const kind = IMAGE.test(path) ? 'image' : VIDEO.test(path) ? 'video' : 'text'
  const [read, setRead] = useState<FileReadResult>()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (kind !== 'text') return
    let live = true
    void window.api.files.read(path, PREVIEW_BYTES).then(
      (r) => live && setRead(r),
      () => live && setFailed(true)
    )
    return () => {
      live = false
    }
  }, [path, kind])
  const text = read && !read.binary && !read.tooBig ? read.text : undefined

  const { name, folder } = splitPath(path)

  return (
    <div
      className="local-path-card"
      style={cardPlacement(anchor)}
      role="tooltip"
      onMouseEnter={props.onEnter}
      onMouseLeave={props.onLeave}
      onClick={props.onOpen}
    >
      {failed ? (
        <p className="local-path-card-empty">No preview for this file.</p>
      ) : kind === 'image' ? (
        <img
          className="local-path-card-media"
          src={window.api.mediaUrl(path)}
          alt=""
          onError={() => setFailed(true)}
        />
      ) : kind === 'video' ? (
        <video
          className="local-path-card-media"
          src={window.api.mediaUrl(path)}
          muted
          autoPlay
          loop
          playsInline
          onError={() => setFailed(true)}
        />
      ) : !read ? (
        <pre className="local-path-card-text">Loading…</pre>
      ) : text !== undefined ? (
        <pre className="local-path-card-text">{text}</pre>
      ) : read.error === 'secret' ? (
        <p className="local-path-card-empty">This file may hold passwords or keys, so it stays closed.</p>
      ) : read.error === 'missing' ? (
        <p className="local-path-card-empty">This file isn&apos;t there anymore.</p>
      ) : null}
      <div className="local-path-card-foot">
        {read?.error === 'directory' ? (
          <FolderOpen size={13} strokeWidth={2} />
        ) : (
          <FileText size={13} strokeWidth={2} />
        )}
        <span className="local-path-card-name">{name}</span>
        <span className="local-path-card-folder">{folder}</span>
      </div>
      <span className="local-path-card-hint">{props.hint}</span>
    </div>
  )
}

export function useHoverCard(): {
  anchor: DOMRect | null
  show: (el: HTMLElement) => void
  hide: () => void
  keep: () => void
  dismiss: () => void
} {
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const show = (el: HTMLElement): void => {
    window.clearTimeout(timer.current)
    if (anchor) return
    timer.current = window.setTimeout(() => setAnchor(el.getBoundingClientRect()), 250)
  }
  const hide = (): void => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setAnchor(null), HIDE_DELAY_MS)
  }
  const keep = (): void => window.clearTimeout(timer.current)
  const dismiss = (): void => {
    window.clearTimeout(timer.current)
    setAnchor(null)
  }
  useEffect(() => () => window.clearTimeout(timer.current), [])
  useEffect(() => {
    if (!anchor) return
    const onScroll = (e: Event): void => {
      if (!(e.target instanceof Element && e.target.closest('.local-path-card'))) setAnchor(null)
    }
    window.addEventListener('scroll', onScroll, true)
    return () => window.removeEventListener('scroll', onScroll, true)
  }, [anchor])
  return { anchor, show, hide, keep, dismiss }
}

export function cardPlacement(anchor: DOMRect): CSSProperties {
  const below = anchor.bottom + CARD_MAX_H + 12 < window.innerHeight
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - 348))
  return below
    ? { left, top: anchor.bottom + 6 }
    : { left, bottom: window.innerHeight - anchor.top + 6 }
}

export function LocalPathLink(props: {
  path: string
  children: ReactNode
  className?: string
  onOpen?: () => void
}): ReactElement {
  const { anchor, show, hide, keep, dismiss } = useHoverCard()
  const inRail = !props.onOpen && hasRail() && isFilePath(props.path)
  const open = (e: React.MouseEvent): void => {
    dismiss()
    if (props.onOpen) props.onOpen()
    else if (!inRail || e.metaKey || !openFileInRail(props.path)) void window.api.openPath(props.path)
  }
  return (
    <>
      <a
        href={props.path}
        className={`local-path ${props.className ?? ''}`}
        onMouseEnter={(e) => show(e.currentTarget)}
        onMouseLeave={hide}
        onFocus={(e) => show(e.currentTarget)}
        onBlur={hide}
        onClick={(e) => {
          e.preventDefault()
          open(e)
        }}
      >
        {props.children}
      </a>
      {anchor &&
        createPortal(
          <Preview
            path={props.path}
            anchor={anchor}
            onEnter={keep}
            onLeave={hide}
            onOpen={open}
            hint={inRail ? 'Click to open it - ⌘-click for Finder' : 'Click to show it in Finder'}
          />,
          document.body
        )}
    </>
  )
}

export function MediaTile(props: { path: string; onOpen?: () => void }): ReactElement | null {
  const [failed, setFailed] = useState(false)
  if (failed) return null
  const src = window.api.mediaUrl(props.path)
  return (
    <LocalPathLink path={props.path} className="local-media-tile" onOpen={props.onOpen}>
      {VIDEO.test(props.path) ? (
        <video src={src} muted playsInline preload="metadata" onError={() => setFailed(true)} />
      ) : (
        <img
          src={src}
          alt={splitPath(props.path).name}
          loading="lazy"
          onError={() => setFailed(true)}
        />
      )}
    </LocalPathLink>
  )
}

export function InlineMedia(props: { text: string; cwd?: string }): ReactElement | null {
  const media = [...new Set(findPaths(props.text, props.cwd).map((f) => f.path))]
    .filter(isMediaPath)
    .slice(0, 4)
  const { open, viewer } = useMediaViewer(media)
  if (media.length === 0) return null
  return (
    <div className="local-media">
      {media.map((path) => (
        <MediaTile key={path} path={path} onOpen={() => open(path)} />
      ))}
      {viewer}
    </div>
  )
}

export function fileFolder(path: string): string {
  return readableFolder(splitPath(path).folder)
}

export function FileRow(props: { path: string; inGroup?: boolean }): ReactElement {
  const { name, folder } = splitPath(props.path)
  return (
    <LocalPathLink path={props.path} className="local-path-row">
      {isMediaPath(props.path) ? (
        <Image size={13} strokeWidth={2} />
      ) : (
        <FileText size={13} strokeWidth={2} />
      )}
      <span className="local-path-row-name">{name}</span>
      {!props.inGroup && <span className="local-path-row-folder">{readableFolder(folder)}</span>}
    </LocalPathLink>
  )
}

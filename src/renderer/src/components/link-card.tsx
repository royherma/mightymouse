import { useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Globe } from 'lucide-react'
import type { LinkPreview } from '../../../shared/types'
import { currentLinkTarget, hasRail, linkMenu, openWeb } from '../hooks/useRailMode'
import { cardPlacement, useHoverCard } from './local-path'
import './link-card.css'

const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>()"'`\]]+/g
const MAX_CARDS = 4

export function findUrls(text: string): string[] {
  const urls = [...text.matchAll(URL_IN_TEXT)].map((m) => m[0].replace(/[.,:;!?*_]+$/, ''))
  return [...new Set(urls)].slice(0, MAX_CARDS)
}

function clickHint(): string {
  if (!hasRail()) return 'Click to open it in your browser'
  return currentLinkTarget() === 'app'
    ? 'Click to open it here, ⌘-click for your browser'
    : 'Click to open it in your browser, ⌘-click to open it here'
}

function usePreview(url: string): LinkPreview | null | undefined {
  const [preview, setPreview] = useState<LinkPreview | null | undefined>()
  useEffect(() => {
    let live = true
    window.api.linkPreview(url).then(
      (p) => live && setPreview(p),
      () => live && setPreview(null)
    )
    return () => {
      live = false
    }
  }, [url])
  return preview
}

function siteName(url: string, preview?: LinkPreview | null): string {
  if (preview?.site) return preview.site
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

function shortUrl(url: string): string {
  try {
    const { host, pathname } = new URL(url)
    const parts = pathname.split('/').filter(Boolean)
    const last = parts[parts.length - 1]
    const tail = parts.length === 0 ? '' : parts.length === 1 ? `/${last}` : `/…/${last}`
    return host.replace(/^www\./, '') + tail
  } catch {
    return url
  }
}

function ShortLabel(props: { url: string }): ReactElement {
  const preview = usePreview(props.url)
  return (
    <>
      {preview?.icon ? (
        <img src={window.api.mediaUrl(preview.icon)} alt="" />
      ) : (
        <Globe size={12} strokeWidth={2} />
      )}
      <span className="link-chip-label">{shortUrl(props.url)}</span>
    </>
  )
}

function SiteLine(props: { url: string; preview?: LinkPreview | null }): ReactElement {
  return (
    <span className="link-card-site">
      {props.preview?.icon ? (
        <img src={window.api.mediaUrl(props.preview.icon)} alt="" />
      ) : (
        <Globe size={12} strokeWidth={2} />
      )}
      {siteName(props.url, props.preview)}
    </span>
  )
}

function HoverPreview(props: {
  url: string
  anchor: DOMRect
  onEnter: () => void
  onLeave: () => void
  onOpen: (e: React.MouseEvent) => void
}): ReactElement {
  const preview = usePreview(props.url)
  const [imageFailed, setImageFailed] = useState(false)
  return (
    <div
      className="local-path-card link-hover"
      style={cardPlacement(props.anchor)}
      role="tooltip"
      onMouseEnter={props.onEnter}
      onMouseLeave={props.onLeave}
      onClick={props.onOpen}
    >
      {preview?.image && !imageFailed && (
        <img
          className="local-path-card-media"
          src={window.api.mediaUrl(preview.image)}
          alt=""
          onError={() => setImageFailed(true)}
        />
      )}
      <SiteLine url={props.url} preview={preview} />
      {(preview === undefined || preview?.title) && (
        <span className="link-card-title">{preview?.title ?? 'Loading preview…'}</span>
      )}
      {preview?.description && <span className="link-card-desc">{preview.description}</span>}
      <span className="link-card-url">{props.url}</span>
      <span className="local-path-card-hint">
        {clickHint()}
      </span>
    </div>
  )
}

export function WebLink(props: { href: string; children: ReactNode; short?: boolean }): ReactElement {
  const { anchor, show, hide, keep, dismiss } = useHoverCard()
  const open = (e: React.MouseEvent): void => {
    dismiss()
    void openWeb(props.href, e.metaKey)
  }
  return (
    <>
      <a
        href={props.href}
        className={props.short ? 'link-chip' : undefined}
        onMouseEnter={(e) => show(e.currentTarget)}
        onMouseLeave={hide}
        onFocus={(e) => show(e.currentTarget)}
        onBlur={hide}
        onClick={(e) => {
          e.preventDefault()
          open(e)
        }}
        onContextMenu={(e) => {
          dismiss()
          void linkMenu(e, props.href)
        }}
      >
        {props.short ? <ShortLabel url={props.href} /> : props.children}
      </a>
      {anchor &&
        createPortal(
          <HoverPreview url={props.href} anchor={anchor} onEnter={keep} onLeave={hide} onOpen={open} />,
          document.body
        )}
    </>
  )
}

function LinkCard(props: { url: string }): ReactElement | null {
  const preview = usePreview(props.url)
  const [imageFailed, setImageFailed] = useState(false)

  if (preview === null) return null
  const open = (e: React.MouseEvent): void => {
    e.preventDefault()
    void openWeb(props.url, e.metaKey)
  }
  const menu = (e: React.MouseEvent): void => void linkMenu(e, props.url)
  const image = preview?.image && !imageFailed ? window.api.mediaUrl(preview.image) : undefined

  if (preview?.isImage) {
    return image ? (
      <a href={props.url} className="link-card-image" onClick={open} onContextMenu={menu} title={props.url}>
        <img src={image} alt="" loading="lazy" onError={() => setImageFailed(true)} />
      </a>
    ) : null
  }

  return (
    <a
      href={props.url}
      className="link-card"
      data-loading={preview === undefined ? '' : undefined}
      onClick={open}
      onContextMenu={menu}
      title={props.url}
    >
      {image && <img className="link-card-thumb" src={image} alt="" onError={() => setImageFailed(true)} />}
      <span className="link-card-body">
        <SiteLine url={props.url} preview={preview} />
        <span className="link-card-title">
          {preview === undefined ? 'Loading preview…' : (preview.title ?? props.url)}
        </span>
        {preview?.description && <span className="link-card-desc">{preview.description}</span>}
      </span>
    </a>
  )
}

export function InlineLinks(props: { text: string }): ReactElement | null {
  const urls = findUrls(props.text)
  if (urls.length === 0) return null
  return (
    <div className="link-cards">
      {urls.map((url) => (
        <LinkCard key={url} url={url} />
      ))}
    </div>
  )
}

import { JSX, useEffect, useState } from 'react'
import { Monitor } from 'lucide-react'

// ── Real macOS app icon ─────────────────────────────────────────────────────
// Resolves an app name to its actual bundle icon (PNG via main's resolveAppIcon),
// rendered as an <img>. Shared by Media Library (capture rows) and Analytics (top
// apps / where-shown) so the icon pipeline + cache live in ONE place.
//
// Resolve once per app, module-scoped so every row/window shares the result. The
// PROMISE is cached (not just the value) so concurrent renders don't double-resolve.
const iconCache = new Map<string, Promise<string | null>>()
// Sync lookup so a row mounted mid-scroll paints its icon on the first frame.
const resolvedIcons = new Map<string, string>()

export function getAppIcon(app: string): Promise<string | null> {
  let p = iconCache.get(app)
  if (!p) {
    p = window.api.appIcon(app)
    iconCache.set(app, p)
  }
  return p
}

// Renders the app's real bundle icon; falls back to a neutral monitor glyph while
// loading or if the app can't be resolved (uninstalled, sandboxed name, etc).
export function AppIcon({
  app,
  size = 16,
  fallback
}: {
  app: string
  size?: number
  fallback?: JSX.Element
}): JSX.Element {
  const [src, setSrc] = useState<string | null>(() => resolvedIcons.get(app) ?? null)
  useEffect(() => {
    let live = true
    setSrc(resolvedIcons.get(app) ?? null)
    void getAppIcon(app).then((path) => {
      if (!path) return
      const url = window.api.mediaUrl(path)
      resolvedIcons.set(app, url)
      if (live) setSrc(url)
    })
    return () => {
      live = false
    }
  }, [app])

  if (src) return <img src={src} width={size} height={size} className="rounded-[3px] shrink-0" alt="" />
  if (fallback) return fallback
  return <Monitor size={size} className="text-muted shrink-0" />
}

// ── Site favicon ────────────────────────────────────────────────────────────
// Same promise-cache shape as the app icon above, keyed by URL. Main resolves the
// URL down to its host before fetching, so two paths on the same site share one
// disk cache entry — this map just avoids a redundant IPC round-trip per render.
const faviconCache = new Map<string, Promise<string | null>>()

export function getFavicon(url: string): Promise<string | null> {
  let p = faviconCache.get(url)
  if (!p) {
    p = window.api.favicon(url)
    faviconCache.set(url, p)
  }
  return p
}

/**
 * The panel context row's icon: the front app's real bundle icon, with the site's
 * favicon as a small badge on the bottom-right corner when the context is a web
 * page. Mirrors how a browser presents itself — the app is the container, the site
 * is what's actually in front of you.
 *
 * The badge is decorative and best-effort: no URL, a junk URL, or a failed fetch
 * simply renders the app icon alone. It never blocks or shifts the row.
 */
export function ContextIcon({
  app,
  url,
  size = 18
}: {
  app: string
  url?: string
  size?: number
}): JSX.Element | null {
  const [fav, setFav] = useState<string | null>(null)

  useEffect(() => {
    setFav(null)
    if (!url) return
    let live = true
    void getFavicon(url).then((path) => {
      if (live && path) setFav(window.api.mediaUrl(path))
    })
    return () => {
      live = false
    }
  }, [url])

  if (!app) return null

  // Badge is ~55% of the base icon and overhangs the corner slightly, so it reads
  // as a distinct mark rather than a smudge inside the app icon's artwork.
  const badge = Math.round(size * 0.55)
  return (
    <span className="ctx-icon" style={{ width: size, height: size }}>
      <AppIcon app={app} size={size} />
      {fav && (
        <img
          src={fav}
          width={badge}
          height={badge}
          className="ctx-icon-badge"
          alt=""
        />
      )}
    </span>
  )
}

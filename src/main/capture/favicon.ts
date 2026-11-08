/**
 * favicon.ts — resolve a URL's site favicon to a small cached PNG, for the panel
 * context row's site badge (the little glyph on the corner of the app icon).
 *
 * Sibling of app-icon.ts: same contract (name in → cached PNG path or null out,
 * never throws), same media:// serving path, same on-disk cache shape. The two
 * are deliberately separate modules because the pipelines share nothing — an app
 * icon comes from a local .app bundle, a favicon comes off the network.
 *
 * Why Google's s2 service and not `https://<host>/favicon.ico`: most modern sites
 * declare their icon via a <link rel="icon"> tag and 404 the well-known path, so a
 * direct fetch would need HTML parsing. s2 already does that resolution, returns a
 * normalized PNG at a requested size, and answers for hosts we've never seen.
 *
 * Failure is always silent-and-cached-never: offline, timeout, non-200, or an
 * empty body all return null so the renderer just omits the badge. We do NOT
 * write a placeholder on failure — the next call retries (a site that was
 * unreachable once should get a badge when the network comes back).
 */
import { writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { PATHS } from '../store/paths'
import { CONFIG } from '../../shared/config'
import { devLog } from '../../shared/env'

/** Filesystem-safe slug for a host → its cache filename. */
function slug(host: string): string {
  return host.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'site'
}

/**
 * Extract the bare host from a URL, or null when the URL carries no useful site
 * identity (junk scheme, unparseable, no hostname). Mirrors the junk-URL filter
 * in panel-state.ts — a `chrome://` page has no favicon worth showing.
 */
export function hostFromURL(url: string | null | undefined): string | null {
  if (!url || !url.trim()) return null
  try {
    const { protocol, hostname } = new URL(url)
    if (protocol !== 'http:' && protocol !== 'https:') return null
    return hostname || null
  } catch {
    return null
  }
}

/**
 * Resolve `url` to a cached favicon PNG path, fetching it on first request for
 * that host. Returns the absolute PNG path, or null if the URL has no host or the
 * fetch fails. Cached per host: a second call is a cheap existsSync hit, and the
 * cache is shared across every site path under the same domain.
 */
export async function resolveFavicon(url: string): Promise<string | null> {
  const host = hostFromURL(url)
  if (!host) return null

  const out = join(PATHS.FAVICONS, `${slug(host)}.png`)
  if (existsSync(out)) return out

  const endpoint = `${CONFIG.FAVICON_SERVICE_URL}?domain=${encodeURIComponent(host)}&sz=${CONFIG.FAVICON_PX}`
  try {
    const res = await fetch(endpoint, {
      signal: AbortSignal.timeout(CONFIG.FAVICON_TIMEOUT_MS)
    })
    if (!res.ok) return null
    const bytes = Buffer.from(await res.arrayBuffer())
    if (bytes.length === 0) return null
    await writeFile(out, bytes)
    return out
  } catch (err) {
    // Offline / DNS failure / timeout / write error. The badge is decorative —
    // degrade to none rather than surfacing anything to the user.
    devLog.warn('[favicon] resolve failed', host, err)
    return null
  }
}

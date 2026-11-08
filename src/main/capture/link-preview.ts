import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { writeFile } from 'fs/promises'
import { join } from 'path'
import { PATHS } from '../store/paths'
import { CONFIG } from '../../shared/config'
import { devLog } from '../../shared/env'
import type { LinkPreview } from '../../shared/types'
import { hostFromURL, resolveFavicon } from './favicon'

const PRIVATE_HOST =
  /^(localhost|.*\.local|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?$)/i
const IMAGE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg'
}
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,image/*;q=0.9,*/*;q=0.8'
}

const cache = new Map<string, Promise<LinkPreview | null>>()

function decode(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ')
    .trim()
}

function meta(html: string, keys: string[]): string | undefined {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = /\b(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase()
    if (!key || !keys.includes(key)) continue
    const content = /\bcontent\s*=\s*"([^"]*)"|\bcontent\s*=\s*'([^']*)'/i.exec(tag)
    const value = content?.[1] ?? content?.[2]
    if (value?.trim()) return decode(value)
  }
  return undefined
}

async function readCapped(res: Response, max: number): Promise<Buffer> {
  const reader = res.body?.getReader()
  if (!reader) return Buffer.alloc(0)
  const chunks: Buffer[] = []
  let size = 0
  while (size < max) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(Buffer.from(value))
    size += value.length
  }
  void reader.cancel().catch(() => undefined)
  return Buffer.concat(chunks)
}

async function saveImage(url: string, res?: Response): Promise<string | undefined> {
  const r =
    res ?? (await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(CONFIG.LINK_PREVIEW_TIMEOUT_MS) }))
  const ext = IMAGE_EXT[(r.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()]
  if (!r.ok || !ext) return undefined
  const bytes = await readCapped(r, CONFIG.LINK_PREVIEW_IMAGE_BYTES)
  if (bytes.length === 0 || bytes.length >= CONFIG.LINK_PREVIEW_IMAGE_BYTES) return undefined
  const out = join(PATHS.LINK_PREVIEWS, `${createHash('sha1').update(url).digest('hex')}.${ext}`)
  if (!existsSync(out)) await writeFile(out, bytes)
  return out
}

async function build(url: string): Promise<LinkPreview | null> {
  const host = hostFromURL(url)
  if (!host || PRIVATE_HOST.test(host)) return null
  const icon = resolveFavicon(url)
  try {
    const res = await fetch(url, {
      headers: HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(CONFIG.LINK_PREVIEW_TIMEOUT_MS)
    })
    const site = hostFromURL(res.url)?.replace(/^www\./, '') ?? host
    const type = (res.headers.get('content-type') ?? '').toLowerCase()
    if (type.startsWith('image/')) {
      return { url, site, image: await saveImage(res.url, res), isImage: true, icon: (await icon) ?? undefined }
    }
    if (!res.ok || !type.includes('html')) {
      return { url, site, icon: (await icon) ?? undefined }
    }
    const html = (await readCapped(res, CONFIG.LINK_PREVIEW_HTML_BYTES)).toString('utf8')
    const title =
      meta(html, ['og:title', 'twitter:title']) ??
      decode(/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] ?? '')
    const imageUrl = meta(html, ['og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image'])
    const image = imageUrl
      ? await saveImage(new URL(imageUrl, res.url).href).catch(() => undefined)
      : undefined
    return {
      url,
      site: meta(html, ['og:site_name']) ?? site,
      title: title || undefined,
      description: meta(html, ['og:description', 'twitter:description', 'description']),
      image,
      icon: (await icon) ?? undefined
    }
  } catch (err) {
    devLog.warn('[link-preview] failed', host, err)
    cache.delete(url)
    return null
  }
}

export function resolveLinkPreview(url: string): Promise<LinkPreview | null> {
  let hit = cache.get(url)
  if (!hit) {
    hit = build(url)
    cache.set(url, hit)
  }
  return hit
}

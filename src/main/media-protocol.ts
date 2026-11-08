/**
 * `media://` protocol — lets the renderer load capture artifacts (png/mp4/wav)
 * without disabling webSecurity or exposing the whole filesystem.
 *
 * Why a custom scheme: the renderer runs from http://localhost (dev) or a
 * file:// index (prod); neither can load arbitrary file:// paths. Rather than
 * read every image into a data URL over IPC (kills video/audio streaming), we
 * serve the file directly — but ONLY from under ~/MightyMouse/captures/, so a
 * crafted URL can never escape the captures dir.
 *
 * URL shape: `media://<absolute-path>`. A `standard` scheme REQUIRES a host, so
 * Chromium pulls the first path segment up into the host and lowercases it:
 * `media:///Users/x/a.png` → host `users`, pathname `/x/a.png`. We therefore
 * rebuild the absolute path as `/<host><pathname>` rather than trusting either
 * field alone — and the host is case-folded, so the rebuilt path won't match a
 * case-sensitive root. To stay robust we percent-encode the WHOLE path into a
 * single opaque segment under a fixed host (`media://file/<encoded-abs-path>`),
 * which Chromium leaves untouched. The renderer builds these via `mediaUrl()`.
 */
import { protocol } from 'electron'
import { createReadStream, existsSync, statSync } from 'fs'
import { homedir } from 'os'
import { basename, extname } from 'path'
import { Readable } from 'stream'
import { PATHS } from './store/paths'
import { PREFS } from './store/prefs'
import { screenshotDir } from './capture/os-screenshots'
import { listedAgentSessions } from './agent-relay/mcp/http-listener'

export const MEDIA_SCHEME = 'media'

// Capture artifacts are png / mp4 / wav only — map the extension to a MIME type
// so <img>/<video>/<audio> render instead of downloading. Default to octet.
const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.wav': 'audio/wav'
}

const AGENT_SCRATCH_ROOTS = ['/private/tmp/claude-', '/tmp/claude-']
export const SECRET_FILE = /(^\.env|\.pem$|\.key$|\.p8$|secret|credential|\.keychain)/i

function agentFolderRoots(withSlash: (p: string) => string): string[] {
  return listedAgentSessions()
    .map((s) => s.cwd)
    .filter((cwd): cwd is string => !!cwd && cwd.split('/').filter(Boolean).length >= 3)
    .map(withSlash)
    .concat(AGENT_SCRATCH_ROOTS)
}

/** Must run BEFORE app.whenReady — privileged so <video>/<audio> can stream + seek. */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        stream: true,
        supportFetchAPI: true,
        corsEnabled: true,
        bypassCSP: true
      }
    }
  ])
}

/** Wire the handler. Call after app.whenReady. */
export function registerMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, (request) => {
    // media://file/<encoded-absolute-path> → the path is one opaque segment, so
    // Chromium's standard-scheme host/case mangling can't touch it. Decode it back.
    const url = new URL(request.url)
    const filePath = decodeURIComponent(url.pathname.replace(/^\//, ''))
    const withSlash = (p: string): string => (p.endsWith('/') ? p : p + '/')
    // Hard boundary: only files under our own runs / captures / app-icons /
    // favicons dirs, no path-escape. All app-owned ~/MightyMouse subtrees. runs/ is
    // where every action (captures included) now lives; captures/ stays for
    // legacy/un-migrated folders.
    // NOTE: a new cached-asset dir must be added HERE too, or every request for it
    // 403s while the cache itself looks perfectly healthy on disk — which is
    // exactly how the favicon badge shipped invisible the first time.
    const roots = [
      withSlash(PATHS.RUNS),
      withSlash(PATHS.CAPTURES),
      withSlash(PATHS.APP_ICONS),
      withSlash(PATHS.FAVICONS),
      withSlash(PATHS.LINK_PREVIEWS),
      withSlash(PATHS.MIGHTY_PROJECT_IMAGES),
      // agent-relay `show --capture` screenshots land here (captureScreenshot
      // writes to PATHS.TMP), so a relay card's <img> 403s without this — the
      // failure this NOTE warns about, hit for real.
      withSlash(PATHS.TMP),
      withSlash(homedir())
    ]
    // Opt-in: the user's macOS screenshot folder is also serveable when OS
    // screenshots are enabled. Gated on the pref so the boundary only widens when
    // the user explicitly turned the feature on — never by default.
    if (PREFS.getOsScreenshots()) roots.push(withSlash(screenshotDir()))
    roots.push(...agentFolderRoots(withSlash))
    if (
      !roots.some((r) => filePath.startsWith(r)) ||
      filePath.includes('..') ||
      SECRET_FILE.test(basename(filePath))
    ) {
      return new Response('Forbidden', { status: 403 })
    }
    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      return new Response('Not found', { status: 404 })
    }

    // Read the file ourselves — net.fetch() rejects the file: scheme. A Node read
    // stream piped into a web Response keeps video/audio streaming (no full buffer).
    const size = statSync(filePath).size
    const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream'

    // The renderer runs on a different origin (http://localhost) than this scheme,
    // so a fetch()/XHR is a cross-origin read and is BLOCKED (status 0) unless we
    // opt in with CORS. The waveform decoder fetches the bytes itself, so this is
    // required — <video>/<audio> element loads succeed without it, fetch doesn't.
    const ACAO = 'Access-Control-Allow-Origin'

    // <video>/<audio> won't start until they can issue a Range request (seek +
    // progressive playback). Honor `Range: bytes=start-end` with a 206 partial
    // response; otherwise advertise range support and stream the whole file.
    const range = request.headers.get('range')
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
      if (match) {
        const start = match[1] ? parseInt(match[1], 10) : 0
        const end = match[2] ? parseInt(match[2], 10) : size - 1
        if (start > end || start >= size) {
          return new Response('Range Not Satisfiable', {
            status: 416,
            headers: { 'Content-Range': `bytes */${size}`, [ACAO]: '*' }
          })
        }
        const slice = Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream
        return new Response(slice, {
          status: 206,
          headers: {
            'Content-Type': type,
            'Content-Length': String(end - start + 1),
            'Content-Range': `bytes ${start}-${end}/${size}`,
            'Accept-Ranges': 'bytes',
            [ACAO]: '*'
          }
        })
      }
    }

    const body = Readable.toWeb(createReadStream(filePath)) as ReadableStream
    return new Response(body, {
      headers: {
        'Content-Type': type,
        'Content-Length': String(size),
        'Accept-Ranges': 'bytes',
        [ACAO]: '*'
      }
    })
  })
}

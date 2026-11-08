import type { IncomingMessage, ServerResponse } from 'http'
import { createServer as createHttpServer, type Server as HttpServer } from 'http'
import { readFileSync, existsSync } from 'fs'
import { createHash } from 'crypto'
import { join, dirname, extname, resolve, sep } from 'path'
import { app } from 'electron'
import { CONFIG } from '../../shared/config'
import { formatAttempt, parseConnectLogBody } from '../../shared/phone-connect-log'
import { IS_DEV, devLog } from '../../shared/env'
import { parseDeviceIdentity, formatDeviceLabel } from './device-identity'
import { recordJournal } from './connection-journal'
import { track, trackError } from '../analytics'
import { ANALYTICS_EVENT } from '../../shared/analytics-events'
import { getTunnelHostname, getTunnelReach } from './cloudflare-tunnel'
import { PHONE_IMAGE_MIMES, HOST_SHELLS } from '../../shared/types'
import {
  fetchRemoteSkinCatalog,
  installRemoteSkin,
  listInstalledRemoteSkins,
  resolveRemoteSkinAsset,
  uninstallRemoteSkin,
  type InstalledRemoteSkin
} from './remote-skins'
import { isRateLimited, recordFailedAttempt, rateLimitBucket } from './rate-limit'
import { loadDeviceCredentials, saveDeviceCredentials, isDeviceCredentialValid, deviceIdFor, isValidPushToken } from './device-credentials'
import { handlePair } from './pairing'
import { runIntentAction, describeFailure } from '../intent-actions'
import { routeSpokenIntent } from '../intent-router'
import {
  getIconServer,
  setIconServer,
  getLayoutPrefsProvider,
  getShareImageListener,
  getShareTextListener,
  withWornSkinLabel,
  type PhoneRemoteCallbacks
} from './server-runtime'
import {
  handleRelayRequest,
  handleRelayRespond,
  handleRelayImage,
  handleChatMedia,
  handleRelayAvatar,
  handleSessionWrap
} from './relay-http'

const PUBLIC_DIR_NAME = 'phone-remote-public'

export function resolvePublicDir(): string {
  if (IS_DEV) return join(app.getAppPath(), 'src/main/phone-remote/react/dist')
  const resourcesDir = join(dirname(app.getPath('exe')), '..', 'Resources')
  return join(resourcesDir, PUBLIC_DIR_NAME)
}

const STATIC_CACHE_HEADER: Record<string, string> = IS_DEV
  ? { 'Cache-Control': 'no-cache' }
  : { 'Cache-Control': 'public, max-age=3600' }

/** Immutable per URL, in dev too: a re-extract installs under a FRESH id. Not
 *  STATIC_CACHE_HEADER — its dev `no-cache` is for the bundle's fixed
 *  filenames, and re-downloaded every skin on every reload. */
const SKIN_ASSET_CACHE_HEADER: Record<string, string> = {
  'Cache-Control': 'public, max-age=31536000, immutable'
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  // onnxruntime-web's loader (hands-free dictation). Both are load-bearing:
  // a module script served as octet-stream is REFUSED by Safari, and
  // instantiateStreaming rejects any wasm that isn't application/wasm.
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.webmanifest': 'application/manifest+json; charset=utf-8'
}

// Files this side-channel will serve — an allowlist, not a general static
// server, since it has no TLS and no auth of its own (LAN-bind is its only
// gate, same as the main server).
const ICON_FILES = new Set(['apple-touch-icon.png'])

export function startIconServer(): void {
  if (getIconServer()) return
  const server = createHttpServer((req, res) => {
    const reqPath = (req.url || '/').replace(/^\//, '').split('?')[0]
    if (!ICON_FILES.has(reqPath)) {
      res.writeHead(404)
      res.end('Not found')
      return
    }
    try {
      const body = readFileSync(join(resolvePublicDir(), reqPath))
      res.writeHead(200, { 'Content-Type': 'image/png' })
      res.end(body)
    } catch (err) {
      devLog.error('Phone Remote icon serve failed:', err)
      res.writeHead(500)
      res.end('Server error')
    }
  })
  server.on('error', (err) => devLog.warn('Phone Remote: icon server failed to bind', err))
  server.listen(CONFIG.PHONE_REMOTE.ICON_PORT, '0.0.0.0')
  setIconServer(server as HttpServer)
}

export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path)] || 'application/octet-stream'
}

export function handleWhoami(req: IncomingMessage, res: ServerResponse): void {
  // Port comes from the socket this request actually arrived on, not a
  // closed-over value -- serveStatic is one shared callback across whichever
  // of PORT..PORT+PORT_RANGE_SIZE-1 this instance ended up bound to.
  const port = (req.socket.address() as { port?: number }).port ?? CONFIG.PHONE_REMOTE.PORT
  const tunnel = getTunnelHostname()
  const payload: Record<string, unknown> = { app: 'mightymouse', version: app.getVersion(), hostname: CONFIG.PHONE_REMOTE.MDNS_HOSTNAME, port }
  // Field only appears while the tunnel is actually up (a sync in-memory read,
  // no spawn/cache dance like the old Tailscale probe) -- the client never has
  // to special-case a "tunnel: null" it can't do anything with.
  if (tunnel) payload.tunnel = tunnel
  // Why there's no `tunnel` above. Without it, "signed out so no tunnel exists"
  // and "the tunnel is down" reach the phone as the same silence.
  payload.tunnelReach = getTunnelReach()
  const body = JSON.stringify(payload)
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(body)
}

export const connectLogAttempts = rateLimitBucket()
const CONNECT_LOG_MAX_PER_WINDOW = 20
const CONNECT_LOG_BODY_LIMIT_BYTES = 16_384

export function handleConnectLog(req: IncomingMessage, res: ServerResponse): void {
  const remoteIp = req.socket.remoteAddress || 'unknown'
  const reply = (status: number, body: Record<string, unknown>): void => {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    })
    res.end(JSON.stringify(body))
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    })
    res.end()
    return
  }
  if (req.method !== 'POST') {
    reply(405, { error: 'method-not-allowed' })
    return
  }
  if (isRateLimited(connectLogAttempts, remoteIp)) {
    reply(429, { error: 'rate-limited' })
    return
  }
  recordFailedAttempt(connectLogAttempts, remoteIp, CONNECT_LOG_MAX_PER_WINDOW)

  let body = ''
  let aborted = false
  req.on('data', (chunk) => {
    if (aborted) return
    body += chunk
    if (body.length > CONNECT_LOG_BODY_LIMIT_BYTES) {
      aborted = true
      reply(413, { error: 'too-large' })
      req.destroy()
    }
  })
  req.on('end', () => {
    if (aborted) return
    let parsed: unknown
    try {
      parsed = JSON.parse(body) as unknown
    } catch {
      reply(400, { error: 'bad-request' })
      return
    }
    const entries = parseConnectLogBody(parsed)
    if (!entries) {
      reply(400, { error: 'bad-request' })
      return
    }
    const uaHeader = req.headers['user-agent']
    const label = formatDeviceLabel(
      parseDeviceIdentity(typeof uaHeader === 'string' ? uaHeader : null)
    )
    for (const entry of entries) {
      recordJournal('phone-attempt', { label, detail: formatAttempt(entry) })
    }
    const last = entries.at(-1)
    if (last) {
      track(ANALYTICS_EVENT.phone_connect_failed, {
        last_outcome: last.outcome,
        last_detail: (last.detail ?? '').slice(0, 200),
        outcomes: [...new Set(entries.map((e) => e.outcome))].join(','),
        attempts: entries.length,
        device: label
      })
    }
    reply(200, { ok: true, n: entries.length })
  })
}

const clientErrorAttempts = rateLimitBucket()
const CLIENT_ERROR_KINDS = new Set(['window.onerror', 'window.unhandledrejection', 'react.render'])

export function handleClientError(req: IncomingMessage, res: ServerResponse): void {
  const remoteIp = req.socket.remoteAddress || 'unknown'
  const reply = (status: number): void => {
    res.writeHead(status)
    res.end()
  }
  if (req.method !== 'POST') {
    reply(405)
    return
  }
  if (isRateLimited(clientErrorAttempts, remoteIp)) {
    reply(429)
    return
  }
  recordFailedAttempt(clientErrorAttempts, remoteIp, CONNECT_LOG_MAX_PER_WINDOW)

  let body = ''
  let aborted = false
  req.on('data', (chunk) => {
    if (aborted) return
    body += chunk
    if (body.length > CONNECT_LOG_BODY_LIMIT_BYTES) {
      aborted = true
      reply(413)
      req.destroy()
    }
  })
  req.on('end', () => {
    if (aborted) return
    let parsed: { kind?: unknown; message?: unknown; stack?: unknown; shell?: unknown; where?: unknown }
    try {
      parsed = JSON.parse(body) as typeof parsed
    } catch {
      reply(400)
      return
    }
    const { kind, message, stack, shell, where } = parsed ?? {}
    if (typeof kind !== 'string' || !CLIENT_ERROR_KINDS.has(kind) || typeof message !== 'string' || !message) {
      reply(400)
      return
    }
    const uaHeader = req.headers['user-agent']
    trackError({
      kind,
      message,
      stack: typeof stack === 'string' ? stack : null,
      source: 'phone-remote',
      props: {
        shell: HOST_SHELLS.find((s) => s === shell) ?? 'safari',
        device: formatDeviceLabel(parseDeviceIdentity(typeof uaHeader === 'string' ? uaHeader : null)),
        ...(typeof where === 'string' ? { where: where.slice(0, 500) } : {})
      }
    })
    reply(204)
  })
}

function injectLayoutPrefs(html: string): string {
  let prefs: ReturnType<NonNullable<PhoneRemoteCallbacks['getLayoutPrefs']>> | undefined
  try {
    prefs = getLayoutPrefsProvider()?.()
  } catch (err) {
    devLog.error('Phone Remote layout pref inline failed:', err)
  }
  let installedSkinIds: string[] = []
  try {
    installedSkinIds = listInstalledRemoteSkins().map((s) => s.id)
  } catch (err) {
    devLog.error('Phone Remote installed-skin inline failed:', err)
  }
  const skinsJson = JSON.stringify(installedSkinIds).replace(/</g, '\\u003c')
  if (!prefs) {
    return html.replace(
      '<head>',
      `<head><script>window.__MM_INSTALLED_SKINS__=${skinsJson}</script>`
    )
  }
  const json = JSON.stringify(withWornSkinLabel(prefs)).replace(/</g, '\\u003c')
  return html.replace(
    '<head>',
    `<head><script>window.__MM_LAYOUT_PREFS__=${json};window.__MM_INSTALLED_SKINS__=${skinsJson}</script>`
  )
}

/** Max bytes accepted on a /push-token body -- a device token is ~64-100 hex
 *  chars, so this bounds memory before parsing the same way PAIR_BODY_LIMIT_BYTES
 *  does for /pair. */
const PUSH_TOKEN_BODY_LIMIT_BYTES = 512

export const pushTokenAttempts = rateLimitBucket()

/** A stable short id for an APNs token -- safe to log, useless to an attacker.
 *  Comparing ids across the phone's log and the Mac's is how a lost or
 *  overwritten token write becomes visible at all. */
function pushTokenId(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 8)
}

/** POST /push-token — iOS re-sends its APNs device token here on every launch
 *  (PRD §6c: a rotated token must self-heal invisibly). Authed by the SAME
 *  device credential /pair minted, carried in the body since this is a plain
 *  POST, not the WS upgrade. */
export function handlePushToken(req: IncomingMessage, res: ServerResponse): void {
  const remoteIp = req.socket.remoteAddress || 'unknown'
  const reply = (status: number, body: Record<string, unknown>): void => {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    })
    res.end(JSON.stringify(body))
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    })
    res.end()
    return
  }
  if (req.method !== 'POST') {
    reply(405, { error: 'method-not-allowed' })
    return
  }

  let body = ''
  let aborted = false
  req.on('data', (chunk) => {
    if (aborted) return
    body += chunk
    if (body.length > PUSH_TOKEN_BODY_LIMIT_BYTES) {
      aborted = true
      reply(413, { error: 'too-large' })
      req.destroy()
    }
  })
  req.on('end', () => {
    if (aborted) return
    let credential: unknown
    let deviceToken: unknown
    try {
      const parsed = JSON.parse(body) as { credential?: unknown; deviceToken?: unknown }
      credential = parsed.credential
      deviceToken = parsed.deviceToken
    } catch {
      reply(400, { error: 'bad-request' })
      return
    }
    // Every rejection below is logged: a silent 401 here is indistinguishable
    // on the Mac from the phone never having called at all, which is exactly
    // the pair of hypotheses a "no-token" push failure leaves you holding.
    if (typeof credential !== 'string' || !isDeviceCredentialValid(credential)) {
      if (isRateLimited(pushTokenAttempts, remoteIp)) {
        reply(429, { error: 'rate-limited' })
        return
      }
      recordFailedAttempt(pushTokenAttempts, remoteIp)
      devLog.warn('[phone-remote] push token rejected: malformed credential')
      reply(401, { error: 'invalid-credential' })
      return
    }
    if (!isValidPushToken(deviceToken)) {
      devLog.warn('[phone-remote] push token rejected: malformed token')
      reply(400, { error: 'invalid-token' })
      return
    }
    const rec = loadDeviceCredentials().get(credential)
    if (!rec) {
      devLog.warn('[phone-remote] push token rejected: credential not paired', {
        deviceId: deviceIdFor(credential)
      })
      reply(401, { error: 'invalid-credential' })
      return
    }
    rec.pushToken = deviceToken
    saveDeviceCredentials()
    // Token IDENTITY, never the token: enough to tell "the same token came
    // back" from "a different device wrote over it" when comparing the phone's
    // log against the Mac's, which is the only way to see a lost write.
    devLog.log('[phone-remote] push token registered', {
      deviceId: deviceIdFor(credential),
      tokenId: pushTokenId(deviceToken)
    })
    reply(200, { ok: true })
  })
}

/** Base64 inflates by 4/3, and the JSON envelope adds a little more. Derived
 *  from the shared image ceiling rather than restated, so raising one raises
 *  both -- a body that passes here and fails the decode check would be a
 *  confusing 200-then-nothing. */
const SHARE_BODY_LIMIT_BYTES = Math.ceil(CONFIG.PHONE_REMOTE.MAX_IMAGE_BYTES * 1.4)

export const shareAttempts = rateLimitBucket()

/** POST /share — the iOS Share Extension's one call. Takes a base64 image or a
 *  string of text and hands it to the same Mac-side handler the WS path uses;
 *  only the transport differs (share-to-mac PRD §4). No socket is opened, so
 *  the single-active-socket rule is never engaged and a share cannot evict the
 *  live deck. */
export function handleShare(req: IncomingMessage, res: ServerResponse): void {
  const remoteIp = req.socket.remoteAddress || 'unknown'
  const reply = (status: number, body: Record<string, unknown>): void => {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    })
    res.end(JSON.stringify(body))
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    })
    res.end()
    return
  }
  if (req.method !== 'POST') {
    reply(405, { error: 'method-not-allowed' })
    return
  }
  let body = ''
  let aborted = false
  req.on('data', (chunk) => {
    if (aborted) return
    body += chunk
    if (body.length > SHARE_BODY_LIMIT_BYTES) {
      aborted = true
      reply(413, { error: 'too-large' })
      req.destroy()
    }
  })
  req.on('end', () => {
    if (aborted) return
    let parsed: {
      credential?: unknown
      image?: unknown
      mime?: unknown
      name?: unknown
      text?: unknown
      submit?: unknown
    }
    try {
      parsed = JSON.parse(body) ?? {}
    } catch {
      reply(400, { error: 'bad-request' })
      return
    }
    const { credential } = parsed
    if (typeof credential !== 'string' || !isDeviceCredentialValid(credential)) {
      if (isRateLimited(shareAttempts, remoteIp)) {
        reply(429, { error: 'rate-limited' })
        return
      }
      recordFailedAttempt(shareAttempts, remoteIp)
      reply(401, { error: 'invalid-credential' })
      return
    }
    const submit = parsed.submit === true

    if (typeof parsed.text === 'string') {
      const text = parsed.text
      if (!text) {
        reply(400, { error: 'empty-text' })
        return
      }
      getShareTextListener()?.(text, submit)
      reply(200, { ok: true, kind: 'text' })
      return
    }

    if (typeof parsed.image !== 'string' || typeof parsed.mime !== 'string') {
      reply(400, { error: 'missing-content' })
      return
    }
    if (!PHONE_IMAGE_MIMES.has(parsed.mime)) {
      reply(415, { error: 'unsupported-type' })
      return
    }
    // Buffer.from silently DROPS invalid base64 rather than throwing, so a
    // truncated upload arrives as a short buffer, not an error. Decoded before
    // the size check for that reason -- the byte count is the only honest
    // signal we get.
    const data = Buffer.from(parsed.image, 'base64')
    if (!data.length) {
      reply(400, { error: 'bad-image' })
      return
    }
    if (data.length > CONFIG.PHONE_REMOTE.MAX_IMAGE_BYTES) {
      reply(413, { error: 'too-large' })
      return
    }
    const name = typeof parsed.name === 'string' ? parsed.name.slice(0, 64) : ''
    getShareImageListener()?.(data, parsed.mime, name, submit)
    reply(200, { ok: true, kind: 'image' })
  })
}

export const intentAttempts = rateLimitBucket()

/** An action name plus a credential and nothing else -- so this is orders of
 *  magnitude below /share's image ceiling. Sized to reject a flood outright
 *  rather than buffer it. */
const INTENT_BODY_LIMIT_BYTES = 2048

/** POST /intent -- the App Intent's one call (mac-as-an-intent-target PRD §5).
 *  Same authed-stateless-POST shape as handleShare: no socket is opened, so the
 *  single-active-socket rule is never engaged and Siri cannot evict the live
 *  deck. Its own rate-limit bucket, so a flood here can't starve /pair -- the
 *  one route that recovers a stranded phone. */
export function handleIntent(req: IncomingMessage, res: ServerResponse): void {
  const remoteIp = req.socket.remoteAddress || 'unknown'
  const reply = (status: number, body: Record<string, unknown>): void => {
    // Every non-200 here used to return silently, so a request that arrived and
    // was REFUSED (bad credential, rate limit) read exactly like one that never
    // arrived at all -- and those have opposite fixes. One line per rejection
    // is what tells "Siri never reached the Mac" from "the Mac said no".
    if (status !== 200) {
      devLog.log(
        `intent-reject ${JSON.stringify({ at: new Date().toISOString(), status, ip: remoteIp, ...body })}`
      )
    }
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    })
    res.end(JSON.stringify(body))
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    })
    res.end()
    return
  }
  if (req.method !== 'POST') {
    reply(405, { error: 'method-not-allowed' })
    return
  }
  let body = ''
  let aborted = false
  req.on('data', (chunk) => {
    if (aborted) return
    body += chunk
    if (body.length > INTENT_BODY_LIMIT_BYTES) {
      aborted = true
      reply(413, { error: 'too-large' })
      req.destroy()
    }
  })
  req.on('end', () => {
    if (aborted) return
    let parsed: { credential?: unknown; action?: unknown; text?: unknown }
    try {
      parsed = JSON.parse(body) ?? {}
    } catch {
      reply(400, { error: 'bad-request' })
      return
    }
    const { credential } = parsed
    if (typeof credential !== 'string' || !isDeviceCredentialValid(credential)) {
      if (isRateLimited(intentAttempts, remoteIp)) {
        reply(429, { error: 'rate-limited' })
        return
      }
      recordFailedAttempt(intentAttempts, remoteIp)
      reply(401, { error: 'invalid-credential' })
      return
    }
    if (typeof parsed.action !== 'string') {
      reply(400, { error: 'missing-action' })
      return
    }
    // The action name is validated by the table it looks up, not here -- there
    // is no default arm, so an unknown name answers 'unknown-action'.
    //
    // 'say' is the one action carrying free text: the phone could not name a
    // verb because the user spoke a sentence, so the Mac's model picks the verb
    // (intent-router.ts). It still lands in the same closed table -- the router
    // looks its answer up in VERBS -- so this widens who chooses, not what can
    // run.
    const run =
      parsed.action === 'say'
        ? routeSpokenIntent(typeof parsed.text === 'string' ? parsed.text : '')
        : runIntentAction(parsed.action)
    void run
      .then((result) => {
        // `meta` rides along on success AND failure: it is how a run that went
        // wrong on Roy's machine gets diagnosed without reproducing it (which
        // control was pressed, what confirmed it, how long it took).
        if (result.ok) {
          reply(200, { ok: true, spoken: result.spoken, meta: result.meta })
          return
        }
        // 200 with ok:false on purpose: the intent SPEAKS the reason, and a
        // non-2xx would surface to Siri as "MightyMouse isn't responding"
        // instead of the sentence that tells Roy what to fix.
        reply(200, {
          ok: false,
          reason: result.reason,
          spoken: describeFailure(result.reason),
          meta: result.meta
        })
      })
      // Chained, not a second `run.catch`: this has to cover the `.then` body
      // too, and a parallel catch would leave a throw in there unhandled.
      //
      // Without it the request gets NO response at all -- crash.ts logs the
      // unhandled rejection and does not rethrow, so Siri waits out its own
      // timeout and says "MightyMouse isn't responding", the one string the
      // ok:false branch above exists to avoid. Both arms reach it: `verb.run()`
      // (intent-router.ts:268) and `action()` (intent-actions.ts:432) each sit
      // outside their own try/catch, and on win32 the platform stubs behind
      // them throw PlatformNotSupportedError.
      .catch((err) => {
        devLog.warn('[phone-remote] intent threw:', (err as Error).message)
        // Guarded: a throw inside the `.then` body lands here with the headers
        // already written, and `reply` would throw ERR_HTTP_HEADERS_SENT on top.
        if (res.headersSent) return
        reply(200, { ok: false, reason: 'failed', spoken: describeFailure('failed') })
      })
  })
}

export async function handleSkinCatalog(res: ServerResponse): Promise<void> {
  let installed = listInstalledRemoteSkins()
  try {
    const catalog = await fetchRemoteSkinCatalog()
    if (catalog) {
      const known = new Set(installed.map((s) => s.catalogId))
      for (const entry of catalog.skins) {
        if (known.has(entry.id)) continue
        const result = await installRemoteSkin(entry, catalog.assetBaseUrl)
        if (result) installed.push(result)
      }
      const offered = new Set(catalog.skins.map((s) => s.id))
      const keep = (s: InstalledRemoteSkin): boolean => s.local === true || offered.has(s.catalogId)
      for (const gone of installed.filter((s) => !keep(s))) {
        uninstallRemoteSkin(gone.catalogId)
      }
      installed = installed.filter(keep)
    }
  } catch (err) {
    devLog.warn('[phone-remote] skin catalog refresh failed:', err)
  }
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(
    JSON.stringify({
      skins: installed.map(({ id, label, blurb, lightOnly, imageSkin }) => ({
        id,
        label,
        blurb,
        lightOnly,
        imageSkin: imageSkin === true
      }))
    })
  )
}

/** GET /_skins.css — every installed skin's sanitised CSS, concatenated. The
 *  phone links this once; a skin's tokens only apply when data-skin matches, so
 *  serving all of them costs nothing and avoids a reload on skin change. */
export function handleInstalledSkinCss(res: ServerResponse): void {
  const css = listInstalledRemoteSkins()
    .map((s) => {
      if (s.imageSkin !== true) return s.css
      return `${s.css}\n.proRoot[data-skin='${s.id}'] { --pro-is-image-skin: 1; }`
    })
    .join('\n')
  res.writeHead(200, {
    'Content-Type': 'text/css; charset=utf-8',
    // Installs mutate this at runtime, so a cached copy would leave a
    // just-installed skin unpainted until a hard reload.
    'Cache-Control': 'no-store'
  })
  res.end(css)
}

/** GET /_skin-assets/<skinId>/<file> — an image a skin declared. Both segments
 *  are re-validated inside resolveRemoteSkinAsset; this handler never builds a
 *  filesystem path itself. */
export function handleSkinAsset(reqPath: string, res: ServerResponse): void {
  const rest = reqPath.slice(CONFIG.PHONE_REMOTE.REMOTE_SKIN_ASSET_ROUTE.length + 1)
  const slash = rest.indexOf('/')
  const path =
    slash === -1 ? null : resolveRemoteSkinAsset(rest.slice(0, slash), rest.slice(slash + 1))
  if (!path) {
    res.writeHead(404)
    res.end('Not found')
    return
  }
  try {
    const body = readFileSync(path)
    res.writeHead(200, { 'Content-Type': contentTypeFor(path), ...SKIN_ASSET_CACHE_HEADER })
    res.end(body)
  } catch {
    res.writeHead(404)
    res.end('Not found')
  }
}

export function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  const publicDir = resolvePublicDir()
  // Collapse repeated slashes BEFORE the route table: an API path is matched
  // exactly, so a client joining a base ending in "/" with a path starting in
  // "/" sent "//push-token", missed every case below, and fell through to the
  // SPA handler -- which answers 200 with index.html. The phone read that as a
  // successful upload and stored nothing, with no error on either side.
  const reqPath = (req.url || '/').split('?')[0].replace(/\/{2,}/g, '/')
  if (reqPath === '/whoami') {
    handleWhoami(req, res)
    return
  }
  if (reqPath === CONFIG.PHONE_REMOTE.CONNECT_LOG_PATH) {
    handleConnectLog(req, res)
    return
  }
  if (reqPath === CONFIG.PHONE_REMOTE.CLIENT_ERROR_PATH) {
    handleClientError(req, res)
    return
  }
  if (reqPath === CONFIG.PHONE_REMOTE.PAIR_CODE_PATH) {
    handlePair(req, res)
    return
  }
  if (reqPath === CONFIG.PHONE_REMOTE.PUSH_TOKEN_PATH) {
    handlePushToken(req, res)
    return
  }
  if (reqPath === CONFIG.PHONE_REMOTE.RELAY_REQUEST_PATH) {
    handleRelayRequest(req, res)
    return
  }
  if (reqPath === CONFIG.PHONE_REMOTE.RELAY_RESPOND_PATH) {
    handleRelayRespond(req, res)
    return
  }
  if (reqPath === CONFIG.PHONE_REMOTE.RELAY_IMAGE_PATH) {
    handleRelayImage(req, res)
    return
  }
  if (reqPath === CONFIG.PHONE_REMOTE.CHAT_MEDIA_PATH) {
    handleChatMedia(req, res)
    return
  }
  if (reqPath === CONFIG.PHONE_REMOTE.RELAY_AVATAR_PATH) {
    void handleRelayAvatar(req, res)
    return
  }
  if (reqPath === CONFIG.PHONE_REMOTE.SHARE_PATH) {
    handleShare(req, res)
    return
  }
  if (reqPath === CONFIG.PHONE_REMOTE.INTENT_PATH) {
    handleIntent(req, res)
    return
  }
  if (reqPath === CONFIG.PHONE_REMOTE.SESSION_WRAP_PATH) {
    handleSessionWrap(req, res)
    return
  }
  if (reqPath === CONFIG.PHONE_REMOTE.REMOTE_SKIN_CATALOG_ROUTE) {
    void handleSkinCatalog(res)
    return
  }
  if (reqPath === CONFIG.PHONE_REMOTE.REMOTE_SKIN_CSS_ROUTE) {
    handleInstalledSkinCss(res)
    return
  }
  if (reqPath.startsWith(`${CONFIG.PHONE_REMOTE.REMOTE_SKIN_ASSET_ROUTE}/`)) {
    handleSkinAsset(reqPath, res)
    return
  }
  const candidate = resolve(publicDir, `.${reqPath === '/' ? '/index.html' : reqPath}`)
  const contained = candidate.startsWith(publicDir + sep)
  const path = contained && existsSync(candidate) ? candidate : join(publicDir, 'index.html')
  // An asset falling through to the SPA shell arrives as text/html and the
  // browser rejects it — invisible without this, since the 200 looks fine.
  if (path !== candidate && reqPath !== '/' && extname(reqPath)) {
    devLog.log(`[phone-remote] asset miss ${reqPath} -> index.html`)
  }
  if (!existsSync(path)) {
    res.writeHead(404)
    res.end('Not found')
    return
  }
  try {
    if (path.endsWith('index.html')) {
      res.writeHead(200, { 'Content-Type': contentTypeFor(path), ...STATIC_CACHE_HEADER })
      res.end(injectLayoutPrefs(readFileSync(path, 'utf-8')))
      return
    }
    const body = readFileSync(path)
    res.writeHead(200, { 'Content-Type': contentTypeFor(path), ...STATIC_CACHE_HEADER })
    res.end(body)
  } catch (err) {
    devLog.error('Phone Remote static serve failed:', err)
    res.writeHead(500)
    res.end('Server error')
  }
}

import type { IncomingMessage, ServerResponse } from 'http'
import { existsSync, readFileSync, statSync, createReadStream } from 'fs'
import { extname } from 'path'
import { CONFIG } from '../../shared/config'
import { IS_DEV, devLog } from '../../shared/env'
import { isRateLimited, recordFailedAttempt, rateLimitBucket } from './rate-limit'
import { isDeviceCredentialValid, deviceIdFor } from './device-credentials'
import { getTunnelHostname } from './cloudflare-tunnel'
import { relayRequestStore, type RelayResolvedVia } from '../agent-relay/store'
import { projectAvatarPng, relayProject } from '../agent-relay/project-avatar-png'
import { sendPaneText } from '../agent-relay/picker-keys'
import { resolveSessionRef, startSessionWrap } from '../agent-relay/session-control'
import { paramFromRequestUrl, decideObserver, isLoopbackAddress } from './server-runtime'
import { MIGHTY } from '../store/mighty'
import { turnMedia } from '../../shared/attachments'
import { codexThreadFor } from '../agent-relay/codex-threads'
import { rememberedSession } from '../agent-relay/session-archive'
import { readSessionTranscript } from '../agent-relay/session-transcript'
import type { AgentTranscriptTurn } from '../../shared/types'

export const relayRequestAttempts = rateLimitBucket()
export const relayRespondAttempts = rateLimitBucket()
export const RELAY_AVATAR_ATTEMPTS = rateLimitBucket()

/** GET /relay-request?requestId=&credential= — the Notification Service
 *  Extension's content-free push (agent-relay PRD §5 item 4: the payload
 *  carries only a request_id) resolves into real question/options/image data
 *  by calling this over the tunnel. Query params, not the WS, since the NSE
 *  process never opens the phone-remote socket. */
export function handleRelayRequest(req: IncomingMessage, res: ServerResponse): void {
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
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    })
    res.end()
    return
  }
  if (req.method !== 'GET') {
    reply(405, { error: 'method-not-allowed' })
    return
  }
  const credential = paramFromRequestUrl(req.url, 'credential')
  if (typeof credential !== 'string' || !isDeviceCredentialValid(credential)) {
    if (isRateLimited(relayRequestAttempts, remoteIp)) {
      devLog.warn('[phone-remote] relay-request rate-limited', { from: remoteIp })
      reply(429, { error: 'rate-limited' })
      return
    }
    recordFailedAttempt(relayRequestAttempts, remoteIp)
    // "extension absent" and "extension running on a bad credential" look
    // identical without this line, and have opposite fixes.
    devLog.warn('[phone-remote] relay-request rejected: invalid credential', {
      from: remoteIp,
      credentialPresent: Boolean(credential)
    })
    reply(401, { error: 'invalid-credential' })
    return
  }
  const requestId = paramFromRequestUrl(req.url, 'requestId')
  const request = requestId ? relayRequestStore.get(requestId) : null
  if (!request) {
    devLog.warn('[phone-remote] relay-request not found', { requestId: requestId || '(none)' })
    reply(404, { error: 'not-found' })
    return
  }
  devLog.log('[phone-remote] relay-request served', {
    requestId,
    verb: request.verb,
    status: request.status
  })
  // Delivery proof (docs/agent-relay.md gap #3): only a credential-valid fetch
  // of a real request reaches this line -- 404s and rate-limited attempts
  // return above and never count. markFetched dedupes internally, so a retry
  // (NSE + phone app both polling the same id) logs and tracks at most once.
  relayRequestStore.markFetched(request.id, deviceIdFor(credential))
  reply(200, { verb: request.verb, params: request.params, status: request.status })
}


/** GET /relay-avatar?requestId=&credential= -- the picture of the project the
 *  sender works in, keyed off the STORED request's cwd, never a query param. */
export async function handleRelayAvatar(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
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
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    })
    res.end()
    return
  }
  if (req.method !== 'GET') {
    reply(405, { error: 'method-not-allowed' })
    return
  }
  const credential = paramFromRequestUrl(req.url, 'credential')
  if (!isDeviceCredentialValid(credential)) {
    if (isRateLimited(RELAY_AVATAR_ATTEMPTS, remoteIp)) {
      devLog.warn('[phone-remote] relay-avatar rate-limited', { from: remoteIp })
      reply(429, { error: 'rate-limited' })
      return
    }
    recordFailedAttempt(RELAY_AVATAR_ATTEMPTS, remoteIp)
    devLog.warn('[phone-remote] relay-avatar rejected: invalid credential', {
      from: remoteIp,
      credentialPresent: Boolean(credential)
    })
    reply(401, { error: 'invalid-credential' })
    return
  }
  const requestId = paramFromRequestUrl(req.url, 'requestId')
  const request = requestId ? relayRequestStore.get(requestId) : null
  const project = request ? relayProject(request.params) : null
  const body = project ? await projectAvatarPng(project) : undefined
  if (!body) {
    devLog.warn('[phone-remote] relay-avatar not found', {
      requestId: requestId || '(none)',
      verb: request?.verb ?? '(no-such-request)',
      project: project?.name ?? '(none)'
    })
    reply(404, { error: 'not-found' })
    return
  }
  devLog.log('[phone-remote] relay-avatar served', {
    requestId,
    project: project?.name,
    bytes: body.length
  })
  res.writeHead(200, { 'Content-Type': 'image/png', 'Access-Control-Allow-Origin': '*' })
  res.end(body)
}

export const RELAY_IMAGE_ATTEMPTS = rateLimitBucket()

const RELAY_IMAGE_CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg'
}

/** GET /relay-image?requestId=&credential= -- the NSE's second fetch for a
 *  `show` verb (agent-relay PRD §5/§6 item 6). Deliberately keyed by
 *  request_id, never a client-supplied filesystem path: the store, not the
 *  wire, decides which file this credential is allowed to read. */
export function handleRelayImage(req: IncomingMessage, res: ServerResponse): void {
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
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    })
    res.end()
    return
  }
  if (req.method !== 'GET') {
    reply(405, { error: 'method-not-allowed' })
    return
  }
  const credential = paramFromRequestUrl(req.url, 'credential')
  if (!isDeviceCredentialValid(credential)) {
    if (isRateLimited(RELAY_IMAGE_ATTEMPTS, remoteIp)) {
      devLog.warn('[phone-remote] relay-image rate-limited', { from: remoteIp })
      reply(429, { error: 'rate-limited' })
      return
    }
    recordFailedAttempt(RELAY_IMAGE_ATTEMPTS, remoteIp)
    devLog.warn('[phone-remote] relay-image rejected: invalid credential', {
      from: remoteIp,
      credentialPresent: Boolean(credential)
    })
    reply(401, { error: 'invalid-credential' })
    return
  }
  const requestId = paramFromRequestUrl(req.url, 'requestId')
  const request = requestId ? relayRequestStore.get(requestId) : null
  // Any verb may carry an image, not just `show`: an `ask`/`approve` that ships
  // the screenshot ON the card is the difference between deciding in one tap and
  // needing two cards plus a context switch. The gate is the presence of an
  // imagePath the Mac itself resolved -- never a client-supplied path.
  const imagePath = request?.params.imagePath
  if (!imagePath || !existsSync(imagePath)) {
    // The three causes are indistinguishable on the phone (no picture, no
    // error), so they are told apart HERE or nowhere: an unknown/expired
    // requestId, a request that never carried an image, or a path the agent
    // sent that has since been deleted.
    devLog.warn('[phone-remote] relay-image not found', {
      requestId: requestId || '(none)',
      verb: request?.verb ?? '(no-such-request)',
      hasPath: Boolean(imagePath),
      fileMissing: imagePath ? !existsSync(imagePath) : false
    })
    reply(404, { error: 'not-found' })
    return
  }
  const contentType = RELAY_IMAGE_CONTENT_TYPES[extname(imagePath).toLowerCase()]
  if (!contentType) {
    devLog.warn('[phone-remote] relay-image unsupported type', { ext: extname(imagePath) })
    reply(415, { error: 'unsupported-type' })
    return
  }
  try {
    const body = readFileSync(imagePath)
    // Both surfaces hit this ONE route, so a bare "served" line proves a fetch
    // happened but never says by whom -- and three sessions were lost reading
    // the iOS extension's fetch as proof the web page had rendered. The UA is
    // the only thing that separates them: WebKit for the page, a bare
    // URLSession for the notification extension.
    const ua = String(req.headers['user-agent'] ?? '')
    devLog.log('[phone-remote] relay-image served', {
      requestId,
      bytes: body.length,
      surface: /AppleWebKit/.test(ua) ? 'phone-remote-page' : 'ios-notification'
    })
    res.writeHead(200, { 'Content-Type': contentType, 'Access-Control-Allow-Origin': '*' })
    res.end(body)
  } catch (err) {
    devLog.warn('[phone-remote] relay-image read failed', err)
    reply(404, { error: 'not-found' })
  }
}

/** Max bytes on a /relay-respond body -- an answer + note is short text, same
 *  ceiling class as the pair/push-token bodies. */
const RELAY_RESPOND_BODY_LIMIT_BYTES = 4_096

const RELAY_RESPOND_VIA_VALUES = new Set<RelayResolvedVia>(['chip', 'typed', 'note'])

/** Types a lock-screen reply into the terminal the card came from.
 *
 * Reads the origin off the STORED request rather than the wire: a notify is
 * settled and unanswerable, so `requestId` is the only thing a reply can be
 * addressed by, and letting the caller name a pane would let anything holding a
 * device credential type into any terminal on the Mac.
 *
 * A settled request is still in the store (it keeps a recent tail), so this
 * works for exactly as long as the card is worth replying to.
 */
async function replyToRelayRequest(requestId: string, text: unknown): Promise<boolean> {
  if (typeof text !== 'string') return false
  const body = text.trim().slice(0, CONFIG.PHONE_REMOTE.CHAT_MESSAGE_MAX_CHARS)
  if (!body) return false
  const request = relayRequestStore.get(requestId)
  if (!request) return false
  const via = await sendPaneText(request.params.origin, body)
  return via !== 'skipped'
}

/** POST /relay-respond — the answer path for a notification action tapped
 *  from the lock screen (agent-relay PRD §4). Stateless request/response, no
 *  new connection state in Swift (ios/CLAUDE.md) -- this is the one HTTP call
 *  a lock-screen tap makes, answered by relayRequestStore's own first-answer-
 *  wins + late-drop logic, same as any other surface that resolves a request. */
export function handleRelayRespond(req: IncomingMessage, res: ServerResponse): void {
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
    if (body.length > RELAY_RESPOND_BODY_LIMIT_BYTES) {
      aborted = true
      reply(413, { error: 'too-large' })
      req.destroy()
    }
  })
  req.on('end', () => {
    if (aborted) return
    let parsed: {
      credential?: unknown
      requestId?: unknown
      answer?: unknown
      questionIndex?: unknown
      picks?: unknown
      revise?: unknown
      approved?: unknown
      note?: unknown
      acked?: unknown
      dismissed?: unknown
      reply?: unknown
      via?: unknown
    }
    try {
      parsed = JSON.parse(body) ?? {}
    } catch {
      reply(400, { error: 'bad-request' })
      return
    }
    const { credential, requestId } = parsed
    if (typeof credential !== 'string' || !isDeviceCredentialValid(credential)) {
      if (isRateLimited(relayRespondAttempts, remoteIp)) {
        reply(429, { error: 'rate-limited' })
        return
      }
      recordFailedAttempt(relayRespondAttempts, remoteIp)
      reply(401, { error: 'invalid-credential' })
      return
    }
    if (typeof requestId !== 'string') {
      reply(400, { error: 'missing-request-id' })
      return
    }
    const via: RelayResolvedVia = RELAY_RESPOND_VIA_VALUES.has(parsed.via as RelayResolvedVia)
      ? (parsed.via as RelayResolvedVia)
      : 'typed'
    // Dismiss is its own store call, not a response shape: it must never carry
    // an answer, and routing it through resolve() would let a malformed body
    // clear a card AND answer it in the same request.
    if (parsed.dismissed === true) {
      const dismissResult = relayRequestStore.dismiss(requestId, deviceIdFor(credential))
      if (dismissResult === 'unknown') {
        reply(404, { error: 'not-found' })
        return
      }
      reply(200, { ok: true, status: dismissResult })
      return
    }
    // A reply is not an answer. A notify settles the instant it is minted
    // (store.ts mint()), so resolve() would report 'already-resolved' on every
    // one of them -- the text has to reach the agent's terminal instead, which
    // is what `reply` means and why it branches ahead of resolve().
    if (typeof parsed.reply === 'string') {
      void replyToRelayRequest(requestId, parsed.reply).then((sent) => {
        reply(sent ? 200 : 409, sent ? { ok: true, status: 'replied' } : { error: 'no-session' })
      })
      return
    }
    const result = relayRequestStore.resolve(
      requestId,
      {
        answer: typeof parsed.answer === 'string' ? parsed.answer : undefined,
        // Never trust a wire number: an out-of-range index would buffer an
        // answer the burst can't place. The store range-checks it too.
        questionIndex:
          typeof parsed.questionIndex === 'number' && Number.isInteger(parsed.questionIndex)
            ? parsed.questionIndex
            : undefined,
        picks: Array.isArray(parsed.picks) && parsed.picks.every((n) => Number.isInteger(n))
          ? (parsed.picks as number[])
          : undefined,
        revise: parsed.revise === true,
        approved: typeof parsed.approved === 'boolean' ? parsed.approved : undefined,
        note: typeof parsed.note === 'string' ? parsed.note : undefined,
        acked: typeof parsed.acked === 'boolean' ? parsed.acked : undefined
      },
      deviceIdFor(credential),
      via
    )
    if (result === 'unknown') {
      reply(404, { error: 'not-found' })
      return
    }
    reply(200, { ok: true, status: result })
  })
}

const sessionWrapAttempts = rateLimitBucket()

/** POST /session-wrap — ends one agent session (clear-a-session PRD §6).
 *
 *  On the credentialed port on purpose: 17781 takes no credential at all, so a
 *  kill verb there would let any local process close any terminal. This is the
 *  only surface in the product that CAUSES a session to end, so it gets the
 *  same device-credential + rate-limit posture as every other write here.
 *
 *  Answers immediately with `accepted` rather than awaiting: a wrap-up waits out
 *  the agent's current turn, which can run a minute, and no phone request should
 *  be held open that long. The row leaving the list is the real confirmation. */
export function handleSessionWrap(req: IncomingMessage, res: ServerResponse): void {
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
    if (body.length > RELAY_RESPOND_BODY_LIMIT_BYTES) {
      aborted = true
      reply(413, { error: 'too-large' })
      req.destroy()
    }
  })
  req.on('end', () => {
    if (aborted) return
    let parsed: { credential?: unknown; session?: unknown }
    try {
      parsed = JSON.parse(body) ?? {}
    } catch {
      reply(400, { error: 'bad-request' })
      return
    }
    // The dev-loopback exemption exists so `bin/mm-relay wrap` can drive this
    // with no phone: a device credential is safeStorage-sealed to the Electron
    // binary, so a terminal script has no way to hold one. Same posture the
    // observer socket already takes -- dev build, loopback, and refused on a
    // tunnel-forwarded Host, which is what keeps it off the internet.
    const devLoopback = decideObserver({
      observeRequested: true,
      isDev: IS_DEV,
      isLoopback: isLoopbackAddress(remoteIp),
      requestHost: req.headers.host ?? null,
      tunnelHostname: getTunnelHostname()
    })
    if (
      !devLoopback &&
      (typeof parsed.credential !== 'string' || !isDeviceCredentialValid(parsed.credential))
    ) {
      if (isRateLimited(sessionWrapAttempts, remoteIp)) {
        reply(429, { error: 'rate-limited' })
        return
      }
      recordFailedAttempt(sessionWrapAttempts, remoteIp)
      reply(401, { error: 'invalid-credential' })
      return
    }
    if (typeof parsed.session !== 'string' || !parsed.session) {
      reply(400, { error: 'missing-session' })
      return
    }
    const ref = parsed.session
    // Two-part answer on purpose. The refusals a caller can act on -- no such
    // row, too old a shim, nothing to type into -- are all decided before a
    // single key is sent, so they come back as a real error. Everything after
    // that is a wait that can run a minute, and no phone request stays open
    // that long: the row leaving the list is the confirmation.
    void startSessionWrap(ref, 'phone').then(
      (started) => {
        if (started.ok) {
          reply(202, { ok: true, status: 'accepted' })
          void started.done.then(
            (outcome) => devLog.log('[phone-remote] session wrap finished', { ref, outcome }),
            (err) => devLog.error('[phone-remote] session wrap failed', err)
          )
          return
        }
        reply(409, { error: started.reason })
      },
      (err) => {
        devLog.error('[phone-remote] session wrap failed', err)
        reply(500, { error: 'wrap-failed' })
      }
    )
  })
}

export const CHAT_MEDIA_ATTEMPTS = rateLimitBucket()

const CHAT_MEDIA_CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.webm': 'video/webm'
}

export function transcriptSession(label: unknown): ReturnType<typeof resolveSessionRef> {
  if (typeof label !== 'string' || label.trim() === '') return undefined
  return resolveSessionRef(label) ?? codexThreadFor(label) ?? rememberedSession(label)
}

export function transcriptMedia(turn: Pick<AgentTranscriptTurn, 'files'>): string[] {
  return (turn.files ?? []).filter((f) => CHAT_MEDIA_CONTENT_TYPES[extname(f).toLowerCase()])
}

function transcriptMediaPath(label: string, at: number, item: number): string | undefined {
  const session = transcriptSession(label)
  const turn = session ? readSessionTranscript(session).find((t) => t.at === at) : undefined
  return turn ? transcriptMedia(turn)[item] : undefined
}

/** GET /chat-media?sessionId=&turn=&item=&credential= -- one image or video a
 *  chat turn carries. Addressed by POSITION, never by path, for the same reason
 *  as /relay-image above: `turnMedia` on the Mac decides which file index N is,
 *  so a credential can only ever read a file some turn already recorded.
 *
 *  Streamed rather than read whole: a screen recording is the one attachment
 *  that can be hundreds of MB, and Safari will not scrub a <video> that cannot
 *  answer a Range request. */
export function handleChatMedia(req: IncomingMessage, res: ServerResponse): void {
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
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Range',
      'Access-Control-Max-Age': '86400'
    })
    res.end()
    return
  }
  if (req.method !== 'GET') {
    reply(405, { error: 'method-not-allowed' })
    return
  }
  const credential = paramFromRequestUrl(req.url, 'credential')
  if (!isDeviceCredentialValid(credential)) {
    if (isRateLimited(CHAT_MEDIA_ATTEMPTS, remoteIp)) {
      devLog.warn('[phone-remote] chat-media rate-limited', { from: remoteIp })
      reply(429, { error: 'rate-limited' })
      return
    }
    recordFailedAttempt(CHAT_MEDIA_ATTEMPTS, remoteIp)
    devLog.warn('[phone-remote] chat-media rejected: invalid credential', { from: remoteIp })
    reply(401, { error: 'invalid-credential' })
    return
  }
  const sessionId = paramFromRequestUrl(req.url, 'sessionId') ?? ''
  const label = paramFromRequestUrl(req.url, 'label') ?? ''
  const turnIdx = Number(paramFromRequestUrl(req.url, 'turn'))
  const itemIdx = Number(paramFromRequestUrl(req.url, 'item'))
  const at = Number(paramFromRequestUrl(req.url, 'at'))
  const session = sessionId ? MIGHTY.getSession(sessionId) : null
  const turn = session && Number.isInteger(turnIdx) ? session.turns[turnIdx] : undefined
  const codePath = label && Number.isFinite(at) ? transcriptMediaPath(label, at, itemIdx) : undefined
  const entry = codePath ? { path: codePath } : turn ? turnMedia(turn.sources, turn.artifacts)[itemIdx] : undefined
  if (!entry || !existsSync(entry.path)) {
    devLog.warn('[phone-remote] chat-media not found', {
      sessionId: sessionId || '(none)',
      turn: turnIdx,
      item: itemIdx,
      hasSession: Boolean(session),
      hasTurn: Boolean(turn),
      fileMissing: entry ? !existsSync(entry.path) : false
    })
    reply(404, { error: 'not-found' })
    return
  }
  const contentType = CHAT_MEDIA_CONTENT_TYPES[extname(entry.path).toLowerCase()]
  if (!contentType) {
    reply(415, { error: 'unsupported-type' })
    return
  }
  try {
    const total = statSync(entry.path).size
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''))
    const start = range && range[1] !== '' ? Number(range[1]) : 0
    const end = range && range[2] !== '' ? Math.min(Number(range[2]), total - 1) : total - 1
    if (start >= total || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` })
      res.end()
      return
    }
    res.writeHead(range ? 206 : 200, {
      'Content-Type': contentType,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${total}` } : {})
    })
    createReadStream(entry.path, { start, end }).pipe(res)
  } catch (err) {
    devLog.warn('[phone-remote] chat-media read failed', err)
    reply(404, { error: 'not-found' })
  }
}

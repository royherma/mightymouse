import type { IncomingMessage } from 'http'
import { WebSocket } from 'ws'
import { devLog } from '../../shared/env'
import { CONFIG } from '../../shared/config'
import { PHONE_AUDIO_TO, PHONE_IMAGE_MIMES } from '../../shared/types'
import type { PhoneRemoteEvent, PhoneRemoteMessage } from '../../shared/phone-remote-protocol'
import { getSupabase } from '../supabase'
import { withTimeout } from '../auth'
import { PREFS } from '../store/prefs'
import { SETTINGS } from '../store/settings'
import { recordJournal } from './connection-journal'
import { recordFailedAttempt, type AttemptEntry } from './rate-limit'
import { paramFromRequestUrl, type PhoneRemoteCallbacks } from './server-runtime'

const AUTH_TIMEOUT_MS = 8_000
const KEEPALIVE_MS = 30_000
const WEB_LABEL = 'web/browser'

const WEB_ALLOWED_MESSAGES = new Set<PhoneRemoteMessage['type']>([
  'relaySessionPeek',
  'relaySessionTranscript',
  'relaySessionUndo',
  'relaySessionReply',
  'relaySessionStop',
  'relaySessionSentGet',
  'relayRespond',
  'relayProjects',
  'relayProjectIdeas',
  'relayStartSession',
  'relayGetPushFilter',
  'relaySetPushFilter',
  'relaySetNotifyLevel',
  'relaySetTurnEndPing',
  'relaySessionInfo',
  'relaySessionGit',
  'relaySessionReveal',
  'pulseGet',
  'pulseScore',
  'pulseSetScope'
])

const WEB_EVENT_PREFIX = 'relay'
const WEB_EXTRA_EVENTS = new Set<PhoneRemoteEvent['type']>(['pulseState'])

const webSockets = new Set<WebSocket>()
let onFirstWebClient: (() => void) | null = null

export function isWebClientRequest(reqUrl: string | undefined): boolean {
  return paramFromRequestUrl(reqUrl, CONFIG.PHONE_REMOTE.WEB_CLIENT_PARAM) === '1'
}

export function webClients(): ReadonlySet<WebSocket> {
  return webSockets
}

export function sendToWebClients(event: PhoneRemoteEvent, payload: string): void {
  if (!event.type.startsWith(WEB_EVENT_PREFIX) && !WEB_EXTRA_EVENTS.has(event.type)) return
  for (const ws of webSockets) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload)
  }
}

export function setWebClientSeeder(seed: () => void): void {
  onFirstWebClient = seed
}

export function webAccessAllowed(): boolean {
  return !PREFS.getIncognito() && SETTINGS.get().webAccess !== false
}

async function macUserId(): Promise<string | null> {
  const session = await withTimeout(getSupabase().auth.getSession(), AUTH_TIMEOUT_MS, null)
  return session?.data.session?.user.id ?? null
}

async function tokenUserId(token: string): Promise<string | null> {
  const result = await withTimeout(getSupabase().auth.getUser(token), AUTH_TIMEOUT_MS, null)
  return result?.data.user?.id ?? null
}

export async function verifyWebToken(token: unknown): Promise<'ok' | 'off' | 'bad-token' | 'other-account' | 'mac-signed-out'> {
  if (!webAccessAllowed()) return 'off'
  if (typeof token !== 'string' || token.length < 20 || token.length > 8192) return 'bad-token'
  const [mac, web] = await Promise.all([macUserId(), tokenUserId(token)])
  if (!mac) return 'mac-signed-out'
  if (!web) return 'bad-token'
  return mac === web ? 'ok' : 'other-account'
}

export function admitWebClient(
  ws: WebSocket,
  req: IncomingMessage,
  callbacks: PhoneRemoteCallbacks,
  attempts: Map<string, AttemptEntry>
): void {
  const remoteIp = req.socket.remoteAddress || 'unknown'
  let authed = false
  let note: { id: string; durationMs: number } | null = null
  let photo: { mime: string; name: string; replyToLabel: string } | null = null
  let keepalive: ReturnType<typeof setInterval> | null = null
  const deadline = setTimeout(() => {
    if (!authed) ws.close(4401, 'auth-timeout')
  }, AUTH_TIMEOUT_MS * 2)

  const refuse = (reason: string): void => {
    recordFailedAttempt(attempts, remoteIp)
    recordJournal('rejected', { detail: `web: ${reason}` })
    ws.send(JSON.stringify({ type: 'webAuth', ok: false, reason }))
    ws.close(4401, reason)
  }

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      if (!authed) return
      if (photo) {
        const { mime, name, replyToLabel } = photo
        photo = null
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
        if (buf.length <= CONFIG.PHONE_REMOTE.MAX_IMAGE_BYTES) callbacks.onImage?.(buf, mime, name, false, undefined, replyToLabel)
        return
      }
      if (!note) return
      const { id, durationMs } = note
      note = null
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
      if (buf.length > CONFIG.PHONE_REMOTE.MAX_AUDIO_BYTES) {
        ws.send(JSON.stringify({ type: 'relayNoteDone', id, ok: false, reason: 'That recording is too long to send' } satisfies PhoneRemoteEvent))
        return
      }
      callbacks.onAudio?.(buf, durationMs, PHONE_AUDIO_TO.note, id, false)
      return
    }
    let msg: { type?: string; token?: unknown }
    try {
      msg = JSON.parse(data.toString()) ?? {}
    } catch {
      return
    }
    if (!authed) {
      if (msg.type !== 'webAuth') return refuse('auth-first')
      void verifyWebToken(msg.token).then((verdict) => {
        if (ws.readyState !== WebSocket.OPEN || authed) return
        if (verdict !== 'ok') return refuse(verdict)
        authed = true
        clearTimeout(deadline)
        webSockets.add(ws)
        keepalive = setInterval(() => ws.ping(), KEEPALIVE_MS)
        recordJournal('joined-as-viewer', { label: WEB_LABEL, detail: 'web tab joined' })
        ws.send(JSON.stringify({ type: 'webAuth', ok: true }))
        onFirstWebClient?.()
      }).catch((err) => devLog.warn('[phone-remote] web auth failed', err))
      return
    }
    if (!webAccessAllowed()) {
      ws.close(4403, 'off')
      return
    }
    const typed = msg as PhoneRemoteMessage
    if (typed.type === 'audioMeta') {
      const id = typeof typed.id === 'string' ? typed.id.slice(0, 64) : ''
      note = id !== '' && Number.isFinite(typed.durationMs) ? { id, durationMs: typed.durationMs } : null
      photo = null
      return
    }
    if (typed.type === 'imageMeta') {
      const replyToLabel = typeof typed.replyToLabel === 'string' ? typed.replyToLabel : ''
      photo = replyToLabel !== '' && PHONE_IMAGE_MIMES.has(typed.mime)
        ? { mime: typed.mime, name: typeof typed.name === 'string' ? typed.name.slice(0, 64) : '', replyToLabel }
        : null
      return
    }
    if (!WEB_ALLOWED_MESSAGES.has(typed.type)) {
      devLog.warn('[phone-remote] web tab sent a disallowed message, dropped', { type: typed.type })
      return
    }
    callbacks.onMessage?.(typed, WEB_LABEL)
  })

  const drop = (): void => {
    clearTimeout(deadline)
    if (keepalive) clearInterval(keepalive)
    webSockets.delete(ws)
  }
  ws.on('close', drop)
  ws.on('error', drop)
}

export function closeWebClients(reason: string): void {
  for (const ws of webSockets) ws.close(4403, reason)
  webSockets.clear()
}

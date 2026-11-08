import { WebSocket } from 'ws'
import { CONFIG } from '../../shared/config'
import { devLog } from '../../shared/env'
import { PHONE_AUDIO_TO, PHONE_IMAGE_MIMES } from '../../shared/types'
import type { PhoneAudioDestination } from '../../shared/types'
import type { PhoneRemoteMessage, PhoneRemoteEvent } from '../../shared/phone-remote-protocol'
import { isInkSendTarget, type InkSendTarget } from '../../shared/ink'
import {
  relayViewerZoom,
  relayViewerZoomChanged,
  relayViewerZoomRequest,
  relayViewerPan
} from './viewer-state'
import { sendToPhone } from './server-runtime'
import type { PhoneRemoteCallbacks } from './server-runtime'

/**
 * One connected socket's inbound frames.
 *
 * Split out of `startPhoneRemoteServer`, which was 543 lines with this handler as
 * its largest single piece. Everything it touches beyond its own per-socket buffer
 * arrives through `MessagePort` below, so the module-level `let`s it used to mutate
 * (mirrorPeerSocket, activeSocketLastInputAt) stay in server-runtime.ts where the
 * rest of their readers narrow them.
 */

/** The one-shot buffer a binary frame is interpreted against. Per socket. */
export interface PendingFrame {
  // One-shot buffer: the client sends 'audioMeta' as a JSON text frame
  // immediately before the binary audio blob for the same recording, since
  // WS has no way to attach metadata to a binary frame directly.
  audioDurationMs: number
  // Same one-shot lifetime as the duration above, and reset alongside it: a
  // recording that arrives without its meta frame falls back to 'paste', the
  // behavior every client had before chat dictation existed.
  audioTo: PhoneAudioDestination
  audioId: string
  // Diagnostic only -- whisper re-runs this same audio and wins (PRD §3b C2).
  audioPhoneText: string
  audioQueued: boolean
  // Which handler the NEXT binary frame belongs to. Defaults to 'audio' so a
  // cached phone bundle that sends audio without any meta frame still works.
  binaryKind: 'audio' | 'image'
  image: {
    mime: string
    name: string
    submit: boolean
    requestId?: string
    replyToLabel?: string
    ink?: InkSendTarget
  } | null
}

export function createPendingFrame(): PendingFrame {
  return {
    audioDurationMs: 0,
    audioTo: PHONE_AUDIO_TO.paste,
    audioId: '',
    audioPhoneText: '',
    audioQueued: false,
    binaryKind: 'audio',
    image: null
  }
}

/** Everything outside this socket that the handler may touch. */
export interface MessagePort {
  ws: WebSocket
  callbacks: PhoneRemoteCallbacks
  pending: PendingFrame
  /** True when this socket is the live controller, so its input counts as presence. */
  isControllerInput: () => boolean
  markInput: () => void
  mirrorHolder: () => WebSocket | null
  claimMirror: () => void
  releaseMirror: () => void
  requestControlSwap: () => void
  labelForSocket: (ws: WebSocket) => string
  isIdleMessage: (type: PhoneRemoteMessage['type']) => boolean
}

export function handleSocketMessage(
  data: unknown,
  isBinary: boolean,
  port: MessagePort
): void {
  const { ws, callbacks, pending } = port
  if (isBinary) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
    const kind = pending.binaryKind
    const image = pending.image
    pending.binaryKind = 'audio'
    pending.image = null
    if (kind === 'image') {
      if (!image) return
      if (buf.length > CONFIG.PHONE_REMOTE.MAX_IMAGE_BYTES) {
        devLog.warn(`[phone-remote] rejected oversize image blob: ${buf.length} bytes`)
        sendToPhone({ type: 'imageFailed', reason: 'That image is too large to send' })
        return
      }
      callbacks.onImage?.(
        buf,
        image.mime,
        image.name,
        image.submit,
        image.requestId,
        image.replyToLabel,
        image.ink
      )
      return
    }
    const id = pending.audioId
    const durationMs = pending.audioDurationMs
    const to = pending.audioTo
    // Reset BEFORE the handler runs, not after: onAudio is async and a
    // reset that trails an await would still be pending when the next
    // recording's meta frame lands, and would then wipe ITS values.
    const phoneText = pending.audioPhoneText
    const queued = pending.audioQueued
    pending.audioDurationMs = 0
    pending.audioTo = PHONE_AUDIO_TO.paste
    pending.audioId = ''
    pending.audioPhoneText = ''
    pending.audioQueued = false
    if (phoneText !== '') devLog.log(`[phone-remote] phone heard: ${phoneText}`)
    if (buf.length > CONFIG.PHONE_REMOTE.MAX_AUDIO_BYTES) {
      devLog.warn(`[phone-remote] rejected oversize audio blob: ${buf.length} bytes`)
      if (id !== '') {
        sendToPhone({
          type: 'transcribeFailed',
          id,
          reason: 'That recording is too long to send',
          retryable: false
        })
      }
      return
    }
    callbacks.onAudio?.(buf, durationMs, to, id, queued)
    return
  }
  try {
    const msg = JSON.parse(String(data)) as PhoneRemoteMessage
    // "In use" means the USER is on it, so only the live socket's real
    // input counts. The connect-time getSensitivity/getLayoutPrefs burst is
    // excluded -- counting it would let a reconnecting phone look busy.
    if (port.isControllerInput() && !port.isIdleMessage(msg.type)) {
      port.markInput()
    }
    if (msg.type === 'audioMeta') {
      // A meta whose blob never lands leaves nothing behind on its own, so
      // the whole failure is invisible from this side. Naming the one it
      // displaces is what makes a dropped clip readable in the log.
      if (pending.audioId) {
        devLog.warn(
          `[phone-remote] audioMeta ${pending.audioId} superseded — its blob never arrived`
        )
      }
      pending.audioDurationMs = msg.durationMs
      pending.audioTo = msg.to ?? PHONE_AUDIO_TO.paste
      pending.audioId = typeof msg.id === 'string' ? msg.id.slice(0, 64) : ''
      pending.audioPhoneText =
        typeof msg.phoneText === 'string' ? msg.phoneText.slice(0, 4096) : ''
      pending.audioQueued = msg.queued === true
      return
    }
    if (msg.type === 'imageMeta') {
      if (!PHONE_IMAGE_MIMES.has(msg.mime)) {
        sendToPhone({ type: 'imageFailed', reason: "That image type isn't supported" })
        return
      }
      pending.binaryKind = 'image'
      pending.image = {
        mime: msg.mime,
        name: typeof msg.name === 'string' ? msg.name.slice(0, 64) : '',
        submit: msg.submit === true,
        requestId: typeof msg.requestId === 'string' ? msg.requestId : undefined,
        replyToLabel: typeof msg.replyToLabel === 'string' ? msg.replyToLabel : undefined,
        ink: isInkSendTarget(msg.ink) ? msg.ink : undefined
      }
      return
    }
    // Claimed HERE rather than in the ipc handler because this is the only
    // layer that knows which socket a message arrived on -- the alternative
    // is threading `ws` through onMessage and every one of its callers.
    if (msg.type === 'mirrorStart') {
      // startScreenStream reuses the ONE capture window, so a newcomer
      // claiming this slot tears down the incumbent's encoder mid-stream.
      // Same socket re-starting is a renegotiation, not a steal.
      const holder = port.mirrorHolder()
      if (holder && holder !== ws && holder.readyState === WebSocket.OPEN) {
        devLog.warn('[phone-remote] mirrorStart refused, another device is mirroring')
        ws.send(
          JSON.stringify({
            type: 'mirrorError',
            // Rendered verbatim to the user as `Mirror: <reason>`.
            reason: 'your other device is already sharing this screen'
          } satisfies PhoneRemoteEvent)
        )
        return
      }
      port.claimMirror()
    } else if (msg.type === 'mirrorStop') {
      port.releaseMirror()
    }
    // Relayed HERE for the same reason as the mirror claim and the role
    // swap: the routing is defined by which socket asked, and this is the
    // only layer that knows. It never reaches the ipc handler because the
    // Mac is not the target -- the other device is.
    if (msg.type === 'mirrorViewerZoom') {
      relayViewerZoom(ws, msg.scale)
      return
    }
    if (msg.type === 'mirrorViewerZoomChanged') {
      relayViewerZoomChanged(ws, msg.scale)
      return
    }
    if (msg.type === 'mirrorViewerZoomRequest') {
      relayViewerZoomRequest(ws)
      return
    }
    if (msg.type === 'mirrorViewerPan') {
      relayViewerPan(ws, msg.x, msg.y)
      return
    }
    // Handled HERE and not in the ipc layer for the same reason as the
    // mirror claim: the swap is defined by which socket asked.
    if (msg.type === 'requestControl') {
      port.requestControlSwap()
      return
    }
    // revokeActiveDevice() deletes the CONTROLLER's credential, whoever sent this.
    if (msg.type === 'unpairSelf' && !port.isControllerInput()) return
    callbacks.onMessage?.(msg, port.labelForSocket(ws))
  } catch (err) {
    devLog.warn('Phone Remote: malformed message', err)
  }
}

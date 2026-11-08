/**
 * Phone Remote — screen mirroring (start/stop, ICE, audio toggle) and the PiP
 * side-channel it can spawn. mirrorStart owns the pipChunk/pipAudioChunk
 * counters (moved here with it, they exist only to breadcrumb that channel).
 */
import { devLog } from '../../shared/env'
import { CONFIG } from '../../shared/config'
import { recordMirrorConfig } from '../phone-remote/mirror-tuning-ledger'
import { completeSwitchProbe } from '../phone-remote/mirror-switch-latency'
import { classifyMirrorError } from '../capture/screen-permission'
import { recordJournal } from '../phone-remote/connection-journal'
import { MIRROR_PREFERRED_CODEC } from '../phone-remote/react/mirror-quality'
import {
  getMirrorIceServers,
  getCachedMirrorIceServers,
  getMirrorCapState
} from '../phone-remote/ice-servers'
import { startVirtualDisplay, stopVirtualDisplay } from '../capture/virtual-display'
import {
  startScreenStream,
  addScreenStreamIceCandidate,
  pauseScreenStream,
  setScreenStreamAudio,
  setPhoneMicOpen,
  startPipStream,
  stopPipStream
} from '../capture/screen-stream'
import { whenInputClaimed } from '../capture/phone-mic-device'
import { startChatGptVoice, type IntentActionFailure } from '../intent-actions'
import { extendDisplaySize, startCursorStream, stopCursorStream } from './phone-remote-pointer'
import {
  sendToPhone,
  sendBinaryToPhone,
  markMirrorMediaEnded,
  type PhoneRemoteMessage
} from '../phone-remote/server'
import { PIP_BINARY_KIND } from '../../shared/phone-remote-keys'

type Msg<T extends PhoneRemoteMessage['type']> = Extract<PhoneRemoteMessage, { type: T }>

let pipChunkCount = 0
let pipChunkBytes = 0
let pipAudioChunkCount = 0
let pipAudioChunkBytes = 0

export function handleMirrorStart(msg: Msg<'mirrorStart'>): void {
  const wantsExtended = msg.mode === 'extended'
  devLog.log(
    `[phone-remote] mirrorStart quality=${msg.quality} ` +
      `shareAudio=${msg.shareAudio === true} mode=${msg.mode ?? 'mirror'}`
  )
  // The knob set that the bench lines after this one are measuring. Read
  // from CONFIG at session start rather than listed by hand, so a knob
  // added later still lands in the ledger without anyone remembering to
  // add it here.
  recordMirrorConfig({
    quality: msg.quality,
    mode: msg.mode ?? 'mirror',
    codec: MIRROR_PREFERRED_CODEC,
    ...Object.fromEntries(
      Object.entries(CONFIG.PHONE_REMOTE).filter(([k]) => k.startsWith('MIRROR_'))
    )
  })
  const startIce = getCachedMirrorIceServers()
  const beginStream = (): void => {
    // Older phone clients (a cached PWA that predates this field) send no
    // shareAudio at all -- default OFF so they behave exactly as before.
    startScreenStream(
      msg.sdp,
      msg.quality,
      startIce,
      msg.shareAudio === true,
      msg.mode === 'audio',
      {
        onAnswer: (sdp) => {
          devLog.log('[phone-remote] mirror onAnswer')
          sendToPhone({ type: 'mirrorAnswer', sdp })
        },
        onIceCandidate: (candidate, sdpMid, sdpMLineIndex) =>
          sendToPhone({ type: 'mirrorIceCandidate', candidate, sdpMid, sdpMLineIndex }),
        onAudioError: (reason) => {
          // Video is unaffected -- the phone clears its audio toggle and
          // keeps the picture. Sending 'mirrorError' here would tear a
          // working mirror down over a missing SCK helper.
          devLog.log('[phone-remote] mirror onAudioError', reason)
          sendToPhone({ type: 'mirrorAudioError', reason })
        },
        onError: (reason) => {
          devLog.log('[phone-remote] mirror onError', reason)
          // The phone cannot report this one: the Mac is the side that knows,
          // and it tears the picture down on the phone via mirrorError.
          recordJournal('mirror-ended', { detail: `mac-stopped: ${reason}` })
          // Decline reasons (the ones this app can classify) get plain-
          // language copy; everything else passes through as-is — see
          // classifyMirrorError's doc comment for why it's not a blanket swap.
          sendToPhone({ type: 'mirrorError', reason: classifyMirrorError(reason) })
          // A failed mirror has no pane to zoom, so the anchor stream is dead
          // weight — stop it here too, not just on an explicit mirrorStop.
          stopCursorStream()
          // The picture is genuinely gone, so the ring's zoom track must go
          // dark. A socket drop deliberately does NOT do this.
          markMirrorMediaEnded()
          // The virtual display deliberately SURVIVES a failed mirror -- see
          // the persistence note on 'mirrorStop' below.
        },
        onStalled: () => {
          devLog.log('[phone-remote] mirror onStalled')
          sendToPhone({ type: 'mirrorStalled' })
        },
        onRecovered: () => {
          devLog.log('[phone-remote] mirror onRecovered')
          sendToPhone({ type: 'mirrorRecovered' })
        },
        onSwitchProbe: (id) => sendToPhone({ type: 'mirrorSwitchProbe', id }),
        onPipConfig: (width, height, frameRate) => {
          devLog.log(`[phone-remote] pip config ${width}x${height}@${frameRate}`)
          sendToPhone({ type: 'pipStreamConfig', width, height, frameRate })
        },
        onPipChunk: (chunk) => {
          // One line every ~5s at 20fps. The pipe is silent by design, so
          // without this a dead encoder and a dead socket look identical.
          pipChunkCount += 1
          pipChunkBytes += chunk.length
          if (pipChunkCount % 100 === 0) {
            devLog.log(`[phone-remote] pip sent ${pipChunkCount} frames, ${pipChunkBytes} bytes`)
          }
          sendBinaryToPhone(PIP_BINARY_KIND.video, chunk)
        },
        onPipAudioConfig: (sampleRate, channels) => {
          devLog.log(`[phone-remote] pip audio config ${sampleRate}Hz ${channels}ch`)
          sendToPhone({ type: 'pipAudioConfig', sampleRate, channels })
        },
        onPipAudioChunk: (chunk) => {
          // AAC frames run ~47/s at 48kHz, so this lands every ~4s -- the same
          // "is the pipe alive" breadcrumb the video counter gives.
          pipAudioChunkCount += 1
          pipAudioChunkBytes += chunk.length
          if (pipAudioChunkCount % 200 === 0) {
            devLog.log(
              `[phone-remote] pip audio sent ${pipAudioChunkCount} frames, ${pipAudioChunkBytes} bytes`
            )
          }
          sendBinaryToPhone(PIP_BINARY_KIND.audio, chunk)
        },
        onPipEnded: (reason) => {
          devLog.log('[phone-remote] pip ended', reason)
          sendToPhone({ type: 'pipStreamEnded', reason })
        }
      }
    )
    // Cursor anchor only matters while there's a mirror to zoom into.
    startCursorStream()
  }

  if (!wantsExtended) {
    stopVirtualDisplay()
    beginStream()
    return
  }

  const extend = extendDisplaySize()
  void startVirtualDisplay(extend.width, extend.height)
    .then(beginStream)
    .catch((err: Error) => {
      devLog.warn('[phone-remote] extended display failed:', err.message)
      recordJournal('mirror-ended', { detail: 'mac-stopped: virtual display failed' })
      sendToPhone({ type: 'mirrorError', reason: "This Mac can't add a second screen" })
    })
}

export function handleMirrorSetAudio(msg: Msg<'mirrorSetAudio'>): void {
  // Toggle-without-renegotiation: the audio m-line is already negotiated,
  // so this only decides whether the SCK helper is running. The phone
  // handles its own playback state locally.
  devLog.log(`[phone-remote] mirrorSetAudio on=${msg.on}`)
  setScreenStreamAudio(msg.on)
}

function voiceStartFailure(reason: IntentActionFailure): string {
  if (reason === 'app-missing') return "ChatGPT isn't open on your Mac"
  if (reason === 'control-missing') return "Couldn't find ChatGPT's voice button"
  return "Couldn't start voice mode on your Mac"
}

export function handlePhoneMicSet(msg: Msg<'phoneMicSet'>): void {
  if (typeof msg.on !== 'boolean') return
  devLog.log(`[phone-remote] phoneMicSet on=${msg.on} chatgpt=${msg.startChatGptVoice === true}`)
  setPhoneMicOpen(msg.on)
  if (!msg.on || msg.startChatGptVoice !== true) return
  // Strictly after the claim resolves: ChatGPT reads its input device at
  // session open, so a press that overtakes the switch opens the call on the
  // built-in mic -- the one failure this whole path exists to avoid.
  void whenInputClaimed()
    .then(() => startChatGptVoice())
    .then((r) => {
      devLog.log(`[phone-remote] chatgpt voice from phone mic: ${JSON.stringify(r)}`)
      // A failed press used to end here, in a dev-only log. The phone was left
      // saying "Your phone is the mic" with a live microphone and no call on the
      // other end, and nothing on screen said so.
      if (!r.ok) sendToPhone({ type: 'voiceCallEnded', reason: voiceStartFailure(r.reason) })
    })
}

export function handleMirrorIceCandidate(msg: Msg<'mirrorIceCandidate'>): void {
  addScreenStreamIceCandidate(msg.candidate, msg.sdpMid, msg.sdpMLineIndex)
}

export function handleMirrorStop(msg: Msg<'mirrorStop'>): void {
  // Journalled, not devLog'd: devLog is IS_DEV-only and `make restart`
  // truncates it, so the usual "it dropped, I restarted, now it works"
  // report used to leave no trace of the drop. A bare toggle sends no
  // cause and is not worth an entry.
  if (msg.cause && msg.cause !== 'user') {
    recordJournal('mirror-ended', { detail: msg.cause })
  }
  pauseScreenStream()
  stopCursorStream()
}

export function handlePipStreamStart(): void {
  pipChunkCount = 0
  pipChunkBytes = 0
  // Only the native iOS app sends this, and only while already mirroring.
  if (!startPipStream()) {
    devLog.log('[phone-remote] pipStreamStart ignored, no capture running')
    sendToPhone({ type: 'pipStreamEnded', reason: 'no mirror running' })
  }
}

export function handlePipStreamStop(): void {
  stopPipStream()
}

export function handlePipStreamSetPlaying(msg: Msg<'pipStreamSetPlaying'>): void {
  // Resume re-runs the encoder start, which emits a fresh keyframe --
  // without one the phone's layer has nothing decodable to resume from.
  if (typeof msg.playing !== 'boolean') return
  if (msg.playing) {
    if (!startPipStream()) {
      devLog.log('[phone-remote] pip resume ignored, no capture running')
      sendToPhone({ type: 'pipStreamEnded', reason: 'no mirror running' })
    }
  } else {
    stopPipStream()
  }
  devLog.log(`[phone-remote] pip ${msg.playing ? 'resumed' : 'paused'} from the PiP window`)
}

export function handleMirrorDiag(msg: Msg<'mirrorDiag'>): void {
  // The switch probe's echo rides this channel rather than its own variant:
  // the viewer's only job is to hand the id straight back, and the Mac does
  // every part that needs a trustworthy clock. Matched before the log line
  // so a probe echo doesn't read as an ordinary diagnostic.
  const echo = /^switch-painted (\d+)$/.exec(msg.detail)
  if (echo) {
    completeSwitchProbe(Number(echo[1]))
    return
  }
  // Debug-only passthrough to the dev log (devLog is silent in prod).
  devLog.log('[mirror] phone', msg.detail)
}

export function handleMirrorGetIceServers(): void {
  // Never rejects (falls back to STUN internally), so the phone always
  // gets a usable list and can proceed unconditionally.
  void getMirrorIceServers().then((iceServers) => {
    // Read the cap AFTER the fetch resolves — it's set by that same call, so
    // reading it first would report the previous attempt's verdict.
    sendToPhone({ type: 'mirrorIceServers', iceServers, cap: getMirrorCapState() ?? undefined })
  })
}

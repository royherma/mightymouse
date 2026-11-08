import { BrowserWindow, ipcMain } from 'electron'
import { loadavg, cpus } from 'os'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { CHANNELS } from '../../shared/ipc'
import { CONFIG } from '../../shared/config'
import { devLog } from '../../shared/env'
import type { UserInputSource } from '../../shared/types'
import { beginSwitchProbe, resetSwitchLatency } from '../phone-remote/mirror-switch-latency'
import { isCapturingSystemAudio, startSystemAudio, stopSystemAudio } from './system-audio'
import {
  startPhoneMicDevice,
  stopPhoneMicDevice,
  writePhoneMicPcm
} from './phone-mic-device'

// Screen mirror (prds/active/2026-07-18-1784360957-phone-remote-screen-mirror.md):
// a small HIDDEN window (?window=webrtc-capture) whose sole job is running
// getDisplayMedia + RTCPeerConnection in a renderer context -- the main process
// cannot call WebRTC capture APIs directly. This module owns its lifecycle
// (create on first phone mirrorStart, destroy on phone disconnect / toggle-off)
// and relays SDP/ICE between this window and src/main/ipc/phone-remote.ts, which
// in turn relays to/from the phone over the existing WS (see server.ts). Mirrors
// companion-window.ts's singleton show:false pattern.

let captureWindow: BrowserWindow | null = null

// Phone mic (prds/active/2026-08-01-1785560393-phone-mic-as-mac-input.md).
// Audio goes to the HAL device so other apps can select it as a microphone;
// the peak log stays because silence and a dead stream are indistinguishable
// without one, and that ambiguity has already cost a debugging session.
const MIC_LEVEL_LOG_MS = 1000
let micPeak = 0
let micFrames = 0
let micLastLogAt = 0

function onMicPcm(chunk: Buffer): void {
  // Only forwards. Starting the writer here would tie it to the mirror rather
  // than the mic: the track is attached up front and parked disabled, so PCM
  // (silence) flows from the moment a screen share connects.
  writePhoneMicPcm(chunk)

  const samples = new Float32Array(chunk.buffer, chunk.byteOffset, chunk.byteLength / 4)
  for (let i = 0; i < samples.length; i++) {
    const abs = Math.abs(samples[i])
    if (abs > micPeak) micPeak = abs
  }
  micFrames += samples.length

  const now = Date.now()
  if (micLastLogAt === 0) micLastLogAt = now
  if (now - micLastLogAt < MIC_LEVEL_LOG_MS) return
  const dbfs = micPeak > 0 ? (20 * Math.log10(micPeak)).toFixed(1) : '-inf'
  devLog.log(`[phone-mic] ${micFrames} frames, peak ${micPeak.toFixed(3)} (${dbfs} dBFS)`)
  micPeak = 0
  micFrames = 0
  micLastLogAt = now
}

// Registered once (module load), not per-window -- ipcMain.handle/.on survive
// across create/destroy cycles of the underlying BrowserWindow.
let handlersRegistered = false

// Set once the CURRENT captureWindow's renderer has confirmed (via
// webrtcCaptureReady) that its onWebrtcCaptureStart listener is actually
// registered. did-finish-load fires once the document + top-level scripts
// load, which is NOT the same moment React has rendered and its useEffect has
// subscribed -- sending webrtcCaptureStart right on did-finish-load can race
// ahead of that subscription and get silently dropped (confirmed via logs: a
// cold window's did-finish-load fired and the send went out, but the
// renderer's handleStart was never invoked). A pending start is queued here
// until ready arrives, instead of firing blind.
let rendererReady = false

// Phone ICE candidates that arrived before the capture window's peer
// connection existed. See addScreenStreamIceCandidate for why dropping these
// silently broke every cold-start mirror.
let pendingIceCandidates: Array<{
  candidate: string
  sdpMid: string | null
  sdpMLineIndex: number | null
}> = []

let pendingStart: {
  offerSdp: string
  quality: 'capped' | 'native' | 'glasses'
  iceServers: unknown[]
  shareAudio: boolean
  audioOnly: boolean
} | null = null

/** Callbacks wired by phone-remote.ts so this module stays free of any
 *  knowledge of the phone/WS transport, same domain-split as server.ts. */
export interface ScreenStreamCallbacks {
  onAnswer: (sdp: string) => void
  onIceCandidate: (candidate: string, sdpMid: string | null, sdpMLineIndex: number | null) => void
  /** Terminal failure of the MIRROR itself -- the phone tears down and resets
   *  its toggle on this. Never use it for an audio-only fault. */
  onError: (reason: string) => void
  /** Share-computer-audio failed while video is unaffected. Separate because
   *  onError kills the whole mirror, and audio is an enhancement. */
  onAudioError: (reason: string) => void
  /** Capture stalled (display sleep) and the renderer is re-acquiring it.
   *  Non-fatal, unlike onError -- the peer connection stays up. */
  onStalled: () => void
  onRecovered: () => void
  /** The screen is about to change: ask the viewer to echo `id` back on its next
   *  painted frame, so the switch's paint latency can be measured. Diagnostic
   *  only -- a consumer that does not care about the number omits nothing, it
   *  simply never sends the probe. */
  onSwitchProbe: (id: number) => void
  /** Native-PiP pipe. Only the iOS app asks for it, so these fire nowhere else. */
  onPipConfig: (width: number, height: number, frameRate: number) => void
  onPipChunk: (chunk: Buffer) => void
  onPipAudioConfig: (sampleRate: number, channels: number) => void
  onPipAudioChunk: (chunk: Buffer) => void
  onPipEnded: (reason: string) => void
}

let callbacks: ScreenStreamCallbacks | null = null

// TEMP instrumentation (phone-connect-degrades-glasses-mirror PRD): the 30-on-10-cores
// question — was the Mac starved during the stall, or was the estimator frozen on a
// quiet machine? limMs cpu:0 only watches the encode thread, so log the whole box.
let loadTimer: NodeJS.Timeout | null = null
function startLoadSampler(): void {
  if (loadTimer) return
  loadTimer = setInterval(() => {
    devLog.log(`[mirror] LOADAVG ${loadavg().map((n) => n.toFixed(1)).join(' ')} cores=${cpus().length}`)
  }, 5000)
}
function stopLoadSampler(): void {
  if (loadTimer) clearInterval(loadTimer)
  loadTimer = null
}

function buildWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 320,
    height: 200,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      // This window is never shown, and Electron throttles hidden windows'
      // frame pump -- which starves the encoder feeding the phone (0 fps).
      backgroundThrottling: false
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=webrtc-capture`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'webrtc-capture' }
    })
  }

  win.on('closed', () => {
    captureWindow = null
    rendererReady = false
    stopLoadSampler()
  })
  startLoadSampler()

  // This window is never shown, so its devtools console is otherwise
  // unreachable -- a thrown getDisplayMedia()/RTCPeerConnection error inside
  // it would fail completely silently. Forward it to the main log instead.
  win.webContents.on('console-message', (e) => {
    devLog.log('[webrtc-capture]', e.message)
  })

  return win
}

function registerRelayHandlers(): void {
  if (handlersRegistered) return
  handlersRegistered = true

  ipcMain.on(CHANNELS.webrtcCaptureAnswer, (_e, sdp: string) => {
    callbacks?.onAnswer(sdp)
  })
  ipcMain.on(
    CHANNELS.webrtcCaptureIceCandidateOut,
    (_e, candidate: string, sdpMid: string | null, sdpMLineIndex: number | null) => {
      callbacks?.onIceCandidate(candidate, sdpMid, sdpMLineIndex)
    }
  )
  ipcMain.on(CHANNELS.webrtcCaptureError, (_e, reason: string) => {
    callbacks?.onError(reason)
  })
  ipcMain.on(CHANNELS.webrtcCaptureStalled, () => {
    callbacks?.onStalled()
  })
  ipcMain.on(CHANNELS.webrtcCaptureRecovered, () => {
    callbacks?.onRecovered()
  })
  ipcMain.on(CHANNELS.webrtcCaptureMicPcm, (e, chunk: Uint8Array) => {
    if (e.sender !== captureWindow?.webContents) return
    onMicPcm(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))
  })
  ipcMain.on(CHANNELS.webrtcCapturePipConfig, (e, width: number, height: number, frameRate: number) => {
    if (e.sender !== captureWindow?.webContents) return
    callbacks?.onPipConfig(width, height, frameRate)
  })
  ipcMain.on(CHANNELS.webrtcCapturePipChunk, (e, chunk: Uint8Array) => {
    if (e.sender !== captureWindow?.webContents) return
    callbacks?.onPipChunk(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))
  })
  ipcMain.on(CHANNELS.webrtcCapturePipAudioConfig, (e, sampleRate: number, channels: number) => {
    if (e.sender !== captureWindow?.webContents) return
    callbacks?.onPipAudioConfig(sampleRate, channels)
  })
  ipcMain.on(CHANNELS.webrtcCapturePipAudioChunk, (e, chunk: Uint8Array) => {
    if (e.sender !== captureWindow?.webContents) return
    callbacks?.onPipAudioChunk(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))
  })
  ipcMain.on(CHANNELS.webrtcCapturePipEnded, (e, reason: string) => {
    if (e.sender !== captureWindow?.webContents) return
    callbacks?.onPipEnded(reason)
  })
  ipcMain.on(CHANNELS.webrtcCaptureReady, (e) => {
    if (e.sender !== captureWindow?.webContents) return
    devLog.log('[screen-stream] renderer ready')
    rendererReady = true
    if (pendingStart) {
      const { offerSdp, quality, iceServers, shareAudio, audioOnly } = pendingStart
      pendingStart = null
      devLog.log('[screen-stream] flushing pending start')
      captureWindow?.webContents.send(
        CHANNELS.webrtcCaptureStart,
        offerSdp,
        quality,
        iceServers,
        shareAudio,
        audioOnly
      )
      if (shareAudio) void startAudioCapture()
      // AFTER the start: the renderer needs the offer set as its remote
      // description before addIceCandidate will accept anything.
      flushPendingIceCandidates()
    }
  })
}

/** Start (or reuse) the hidden capture window and hand it the phone's SDP
 *  offer to answer. Idempotent-ish: a second call while a window is already up
 *  reuses it (tearDown() first if you actually want a clean renegotiation). */
export function startScreenStream(
  offerSdp: string,
  quality: 'capped' | 'native' | 'glasses',
  // Same list the phone is using (TURN-backed when available, plain STUN
  // otherwise). Passed in rather than read here so main stays the single
  // owner of credential fetching — see phone-remote/ice-servers.ts.
  iceServers: unknown[],
  // Share computer audio (computer-audio PRD). When on, the native SCK helper
  // is spawned here and its PCM piped to the capture renderer, which turns it
  // into an audio track on the SAME peer connection as video.
  shareAudio: boolean,
  // Audio-only mirror mode (Siri -> ChatGPT voice PRD): the capture renderer
  // must skip getDisplayMedia and video entirely -- no screen-recording
  // prompt, no frames -- while still answering the offer so the phone's mic
  // transceiver negotiates. Same boolean-flag shape as shareAudio above.
  audioOnly: boolean,
  cb: ScreenStreamCallbacks
): void {
  registerRelayHandlers()
  callbacks = cb
  liveQuality = quality

  if (captureWindow && !captureWindow.isDestroyed() && rendererReady) {
    devLog.log('[screen-stream] reusing existing capture window, sending start')
    captureWindow.webContents.send(
      CHANNELS.webrtcCaptureStart,
      offerSdp,
      quality,
      iceServers,
      shareAudio,
      audioOnly
    )
    if (shareAudio) void startAudioCapture()
    flushPendingIceCandidates()
    return
  }

  if (captureWindow && !captureWindow.isDestroyed()) {
    // Window exists but hasn't confirmed ready yet (e.g. a start fired while
    // still loading) -- queue it, the webrtcCaptureReady handler flushes it.
    devLog.log('[screen-stream] window exists but not ready yet, queuing start')
    pendingStart = { offerSdp, quality, iceServers, shareAudio, audioOnly }
    return
  }

  devLog.log('[screen-stream] building new capture window')
  pendingStart = { offerSdp, quality, iceServers, shareAudio, audioOnly }
  captureWindow = buildWindow()
}

/** Start or stop system audio on a LIVE mirror, with no renegotiation. The
 *  audio m-line is always negotiated (see the phone's App.tsx), so toggling is
 *  purely "is the SCK helper running" -- the peer connection never changes.
 *  This is what makes the phone's audio badge instant instead of a ~1s mirror
 *  rebuild. */
export function setScreenStreamAudio(on: boolean): void {
  audioWanted = on
  if (on && !(DUCKS_AUDIO && micOpen)) {
    void startAudioCapture()
  } else if (!on) {
    stopSystemAudio()
  }
}

const DUCKS_AUDIO = CONFIG.PHONE_REMOTE.PHONE_MIC_DUCKS_SYSTEM_AUDIO

// The user's own audio choice, kept separate from the duck's. Without this the
// duck would restore audio the user had switched off, or leave it off after
// they switched it on mid-call.
let audioWanted = false
let micOpen = false

/** The phone's mic opened or closed. This is the ONLY thing that starts the
 *  audio device, and the timing matters: PCM flows from the moment a screen
 *  share connects (the track is attached up front, parked disabled), so
 *  triggering off audio data asked for the admin password during screen
 *  sharing, before the user had touched the mic.
 *
 *  Ducks the Mac→phone audio leg only when PHONE_MIC_DUCKS_SYSTEM_AUDIO is on. */
export function setPhoneMicOpen(open: boolean): void {
  if (micOpen === open) return
  micOpen = open
  if (open) {
    startPhoneMicDevice()
    if (DUCKS_AUDIO && isCapturingSystemAudio()) stopSystemAudio()
  } else {
    stopPhoneMicDevice()
    if (DUCKS_AUDIO && audioWanted) void startAudioCapture()
  }
}

/** Spawn the native system-audio helper and pipe its PCM to the capture
 *  renderer. Failure is reported to the phone but never throws: audio is an
 *  enhancement to the mirror, so a missing/failed helper must degrade to a
 *  silent-but-working video mirror rather than killing the whole session. */
async function startAudioCapture(): Promise<void> {
  if (isCapturingSystemAudio()) return
  try {
    await startSystemAudio({
      onPcm: (chunk) => {
        // The window can be torn down between chunks; a send to a destroyed
        // webContents throws and would take down the SCK reader with it.
        if (!captureWindow || captureWindow.isDestroyed()) return
        captureWindow.webContents.send(CHANNELS.webrtcCapturePcm, chunk)
      },
      onError: (reason) => callbacks?.onAudioError(reason)
    })
    devLog.log('[screen-stream] system audio capturing')
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    devLog.warn('[screen-stream] system audio failed:', reason)
    callbacks?.onAudioError(reason)
  }
}

/** Trickle one ICE candidate from the phone into the capture window's
 *  RTCPeerConnection, QUEUEING any that arrive before the window is ready.
 *
 *  The queue is load-bearing, not defensive. On a cold start the phone
 *  gathers and sends its full candidate set (host, srflx, relay) while this
 *  side is still building the capture window -- so every one of them used to
 *  arrive at a window that didn't exist yet and get dropped on the floor. The
 *  Mac's peer connection then had NO remote candidates to pair against: it
 *  never even entered `checking`, emitted zero ICE state changes, and the
 *  phone sat in `checking` until it gave up with `failed`. Confirmed from the
 *  logs 2026-07-19 -- the phone's candidates all predate the capture window's
 *  creation, and the Mac logged not one state transition.
 *
 *  This masqueraded as a NAT/TURN problem for several rounds because the
 *  symptom (ICE never completes off-LAN) is identical, and the old comment
 *  here asserted the drop was safe. It was only safe for the teardown race it
 *  was written for, never for the cold-start case. */
export function addScreenStreamIceCandidate(
  candidate: string,
  sdpMid: string | null,
  sdpMLineIndex: number | null
): void {
  if (!captureWindow || captureWindow.isDestroyed() || !rendererReady) {
    pendingIceCandidates.push({ candidate, sdpMid, sdpMLineIndex })
    devLog.log(`[screen-stream] queued ICE candidate (${pendingIceCandidates.length} pending)`)
    return
  }
  captureWindow.webContents.send(CHANNELS.webrtcCaptureIceCandidate, candidate, sdpMid, sdpMLineIndex)
}

/** Flush queued candidates once the renderer has a peer connection. Called
 *  after the start message, so the offer is always set before candidates
 *  land -- addIceCandidate rejects if it arrives before a remote description. */
function flushPendingIceCandidates(): void {
  if (!captureWindow || captureWindow.isDestroyed() || pendingIceCandidates.length === 0) return
  devLog.log(`[screen-stream] flushing ${pendingIceCandidates.length} queued ICE candidates`)
  for (const c of pendingIceCandidates) {
    captureWindow.webContents.send(
      CHANNELS.webrtcCaptureIceCandidate,
      c.candidate,
      c.sdpMid,
      c.sdpMLineIndex
    )
  }
  pendingIceCandidates = []
}

/** Tear the peer connection + capture stream down but keep the hidden window
 *  alive (cheap to keep loaded; avoids a fresh getDisplayMedia() permission
 *  round-trip cost on the next mirrorStart). Call stopScreenStream() instead
 *  to fully destroy the window (e.g. phone-remote server itself stopping). */
export function pauseScreenStream(): void {
  // Without this a mirror paused mid-scroll resumes with motionOn still true,
  // so the next input sends nothing and it stays at half resolution forever.
  clearMotionState()
  // Drop queued candidates -- they belong to the session being torn down, and
  // replaying them into the NEXT peer connection would pair against a dead
  // generation.
  pendingIceCandidates = []
  // The audio helper is a SUBPROCESS, not part of the renderer -- tearing the
  // peer connection down doesn't stop it. Leaving it running would hold an
  // SCK stream open (and keep the recording indicator lit) with nowhere for
  // the bytes to go.
  stopSystemAudio()
  stopPhoneMicDevice()
  if (!captureWindow || captureWindow.isDestroyed()) return
  captureWindow.webContents.send(CHANNELS.webrtcCaptureStop)
}

// Glasses motion hinting. A 1200-wide keyframe against a low estimate takes
// seconds to push, so the panel goes glacial the moment the screen changes --
// but ONLY while it is changing. The renderer can drop resolution before the
// first changed frame is even encoded, so the whole job here is to learn about
// the change EARLIER than the pixels do.
//
// The screen changes for two independent reasons and each needs its own herald:
// a phone input (which reaches main before it reaches the screen) and a Mac-side
// app activation (which NSWorkspace publishes before the repaint lands). Only
// the first was wired originally, which is why switching apps at the Mac met a
// full-size keyframe against a collapsed estimate -- the mechanism was right and
// simply never heard about half of what moves the screen.
let liveQuality: 'capped' | 'native' | 'glasses' | null = null
let motionIdleTimer: NodeJS.Timeout | null = null
let motionOn = false
function sendMotion(userDriving: boolean, source: UserInputSource): void {
  if (!captureWindow || captureWindow.isDestroyed()) return
  captureWindow.webContents.send(CHANNELS.webrtcCaptureMotion, userDriving, source)
}

/** Something is about to change the screen. Cheap enough to call on every phone
 *  message: the renderer is only told on the TRANSITION, because a setParameters
 *  per event is exactly the churn that flattened the bandwidth estimator to
 *  ~180k in the first place.
 *
 *  The `liveQuality !== 'glasses'` guard is also what keeps this off the startup
 *  path -- quality is only set once a mirror is actually running, so a stream
 *  still negotiating (`0x0@0`, `sent=0`) cannot reach the transition below. */
export function noteScreenStreamInput(source: UserInputSource = 'input'): void {
  if (liveQuality !== 'glasses') return
  if (!captureWindow || captureWindow.isDestroyed()) return
  // A bare cursor move never downscales -- at worst it pans the follow-view,
  // and the physical Mac mouse already does exactly that with no herald at
  // all, at full resolution, and looks fine. Downscaling only the phone's
  // moves bought nothing but blur (2026-08-12).
  if (source === 'cursor') return
  if (!motionOn) {
    motionOn = true
    sendMotion(true, source)
    // Rising edge only. The probe measures the latency of the change this onset
    // announces, so re-arming it while motion is already on would time a repaint
    // that was already in flight.
    const probeId = beginSwitchProbe(source)
    if (probeId !== null) callbacks?.onSwitchProbe(probeId)
  }
  if (motionIdleTimer) clearTimeout(motionIdleTimer)
  motionIdleTimer = setTimeout(() => {
    motionIdleTimer = null
    motionOn = false
    sendMotion(false, source)
  }, CONFIG.PHONE_REMOTE.MIRROR_GLASSES_MOTION_IDLE_MS)
}

function clearMotionState(): void {
  if (motionIdleTimer) clearTimeout(motionIdleTimer)
  motionIdleTimer = null
  motionOn = false
  // An in-flight probe belongs to the session being torn down. Left pending, the
  // next session's echo would match it and report the gap across a reconnect as
  // one switch's latency.
  resetSwitchLatency()
}

/** Fully destroy the hidden capture window. */
export function stopScreenStream(): void {
  clearMotionState()
  liveQuality = null
  pendingIceCandidates = []
  stopSystemAudio()
  stopPhoneMicDevice()
  if (captureWindow && !captureWindow.isDestroyed()) {
    captureWindow.close()
  }
  captureWindow = null
  callbacks = null
}

/** A no-op unless capture is already up: PiP is a second view of the mirror,
 *  never a reason to start capturing. */
export function startPipStream(): boolean {
  if (!captureWindow || captureWindow.isDestroyed() || !rendererReady) return false
  captureWindow.webContents.send(CHANNELS.webrtcCapturePipStart)
  return true
}

export function stopPipStream(): void {
  if (!captureWindow || captureWindow.isDestroyed()) return
  captureWindow.webContents.send(CHANNELS.webrtcCapturePipStop)
}

export function isScreenStreamRunning(): boolean {
  return captureWindow !== null && !captureWindow.isDestroyed()
}

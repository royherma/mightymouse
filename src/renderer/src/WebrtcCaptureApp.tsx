import { useEffect, useRef } from 'react'
import { CONFIG } from '../../shared/config'
import type { UserInputSource } from '../../shared/types'
import type { MirrorQuality } from '../../main/phone-remote/react/mirror-quality'
import { mungeGlassesBitrate } from '../../main/phone-remote/react/mirror-quality'
import { stamp } from '../../main/phone-remote/react/mirror-bench'
// ?url so Vite serves this as a real module in dev and emits a hashed asset on
// build -- audioWorklet.addModule() needs a URL, and the worklet runs in its
// own global scope so it can never be part of the app bundle.
import pcmPlayerUrl from './pcm-player-worklet?url'
import pcmRecorderUrl from './pcm-recorder-worklet?url'
import { PipEncoder } from './pip-encoder'
import { PipAudioEncoder } from './pip-audio-encoder'

// Screen mirror hidden capture window (?window=webrtc-capture) — see
// prds/active/2026-07-18-1784360957-phone-remote-screen-mirror.md and
// src/main/capture/screen-stream.ts (the main-side half of this relay). This
// window is never shown (BrowserWindow show:false) — its only job is running
// getDisplayMedia + RTCPeerConnection, APIs the main process cannot call
// directly. The phone is the WebRTC OFFERER: main hands this renderer the
// phone's SDP offer (via onWebrtcCaptureStart), this renderer creates a
// getDisplayMedia stream, attaches it to a new RTCPeerConnection, sets the
// offer as the remote description, creates an answer, and relays the answer +
// trickled ICE candidates back up through main to the phone.
//
// No React state/UI needed — this is a headless controller component; all
// state lives in refs since nothing here is ever rendered.
// Every video setParameters write, stamped with its payload. target=30k at a
// healthy estimate means SOMETHING asked for it -- this line is how the caller
// gets named instead of guessed (three knobs were guessed wrong in one day).
let setParamsSeq = 0
function logSetParams(site: string, p: RTCRtpSendParameters): void {
  const e = p.encodings?.[0]
  console.log(
    `[${stamp()}] [mirror] SETPARAMS #${++setParamsSeq} site=${site} ` +
      `max=${e?.maxBitrate ?? '-'} scale=${e?.scaleResolutionDownBy ?? '-'} ` +
      `degrade=${p.degradationPreference ?? '-'}`
  )
}

export default function WebrtcCaptureApp(): null {
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  // Share-computer-audio graph (computer-audio PRD). Kept in refs and rebuilt
  // per session: PCM arrives from a native SCK subprocess via IPC, gets pushed
  // into the worklet, and comes back out as a real MediaStreamTrack.
  const audioCtxRef = useRef<AudioContext | null>(null)
  const pcmNodeRef = useRef<AudioWorkletNode | null>(null)
  const audioDestRef = useRef<MediaStreamAudioDestinationNode | null>(null)
  // Inbound phone-mic graph (phone-mic-as-mac-input PRD). The mirror image of
  // the three refs above: the phone's mic track feeds a recorder worklet whose
  // batches go up to main, instead of PCM from main feeding a player worklet.
  const micCtxRef = useRef<AudioContext | null>(null)
  const micNodeRef = useRef<AudioWorkletNode | null>(null)
  const micSrcRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const micSinkRef = useRef<HTMLAudioElement | null>(null)
  // Inbound phone candidates received before the peer connection exists.
  // Drained in handleStart once the remote description is set.
  const pendingIceRef = useRef<
    Array<{ candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }>
  >([])
  // Which start attempt is current. Bumped by every teardown, so an in-flight
  // attempt that gets superseded stays silent instead of reporting its abort
  // as a mirror failure.
  const startGenerationRef = useRef(0)

  // Native PiP's second encode of the same track. Starts when the PHONE asks
  // and survives renegotiation, so it sits outside the generation dance below.
  const pipRef = useRef<PipEncoder | null>(null)
  const pipAudioRef = useRef<PipAudioEncoder | null>(null)

  const stallGuardRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Consecutive zero-delta polls -- MIRROR_STALL_THRESHOLD_POLLS of these in a
  // row is what actually declares a stall, so one slow tick can't false-positive.
  const stalledPollsRef = useRef(0)
  // A recovery is already re-acquiring getDisplayMedia -- the stall guard's
  // next tick must not start a second one on top of it.
  const recoveringRef = useRef(false)

  // What the live mirror was started with, so the motion hint (which arrives
  // outside handleStart's closure) can re-write the same encoding rather than
  // a stale one. Null whenever no mirror is up.
  // generation + sender ride along so the video-mode flip can re-acquire the
  // capture at the other profile's width/fps without reaching into handleStart.
  const liveEncodingRef = useRef<{
    quality: string
    maxBitrate: number
    generation: number
    sender: RTCRtpSender
  } | null>(null)
  // Whether the last motion hint said "moving", so a repeated hint in the same
  // direction is a no-op: a per-event setParameters is what flattened the
  // estimator before.
  const motionOnRef = useRef(false)
  // The one writer of the encoding's degradation preference, published so the
  // frame-delta sampler inside handleStart can reach it -- it is defined in the
  // effect below, which handleStart's closure cannot see.
  const applyMotionScaleRef = useRef<((moving: boolean, source: UserInputSource) => void) | null>(null)
  // When the source frame rate first crossed the promote threshold, or null when
  // it is back under. The whole auto-detect: a film sustains frames, a desk does
  // not.
  const movingSinceRef = useRef<number | null>(null)
  // The mirror of it while video mode is ON: when the rate first fell under the
  // demote threshold. Separate so a dark scene has to stay dark to demote.
  const idleSinceRef = useRef<number | null>(null)
  const videoPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Whether auto-detect has concluded "this is video". Separate from the config
  // value so a forced true/false never consults it.
  const videoDetectedRef = useRef(false)

  useEffect(() => {
    function teardown(): void {
      // Invalidate any start still in flight before anything is closed, so the
      // close() below can't be mistaken for a real failure by the attempt that
      // opened it.
      startGenerationRef.current++
      if (stallGuardRef.current) {
        clearInterval(stallGuardRef.current)
        stallGuardRef.current = null
      }
      stalledPollsRef.current = 0
      recoveringRef.current = false
      liveEncodingRef.current = null
      motionOnRef.current = false
      movingSinceRef.current = null
      idleSinceRef.current = null
      videoDetectedRef.current = false
      if (videoPollRef.current) {
        clearInterval(videoPollRef.current)
        videoPollRef.current = null
      }
      // Queued candidates belong to the session being torn down -- replaying
      // them into the next peer connection would pair a dead generation.
      pendingIceRef.current = []
      pcRef.current?.close()
      pcRef.current = null
      // Reads the track we are about to stop, so it goes first. The phone is
      // told because a dead stream and a stalled one look identical there.
      if (pipRef.current?.running) {
        pipRef.current.stop()
        window.api.webrtcCapturePipEnded('mirror stopped')
      }
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
      pcmNodeRef.current?.disconnect()
      pcmNodeRef.current = null
      audioDestRef.current?.disconnect()
      audioDestRef.current = null
      // Close the context too: an AudioContext left open holds an audio device
      // handle, and a new one is built per session anyway.
      void audioCtxRef.current?.close().catch(() => {})
      audioCtxRef.current = null
      micSrcRef.current?.disconnect()
      micSrcRef.current = null
      if (micSinkRef.current) {
        micSinkRef.current.pause()
        micSinkRef.current.srcObject = null
        micSinkRef.current = null
      }
      micNodeRef.current?.disconnect()
      micNodeRef.current = null
      void micCtxRef.current?.close().catch(() => {})
      micCtxRef.current = null
    }

    /** Build the PCM -> worklet -> MediaStreamTrack graph and return the audio
     *  track to attach to the peer connection. Returns null on failure so a
     *  broken audio path degrades to a silent-but-working video mirror. */
    async function buildAudioTrack(): Promise<MediaStreamTrack | null> {
      try {
        // Pin the context rate to the helper's capture rate. If they differ the
        // browser resamples the graph output, but the worklet itself reads
        // frames 1:1 -- a mismatch would play back at the wrong pitch.
        const ctx = new AudioContext({ sampleRate: CONFIG.PHONE_REMOTE.SYSTEM_AUDIO_SAMPLE_RATE })
        audioCtxRef.current = ctx
        await ctx.audioWorklet.addModule(pcmPlayerUrl)

        const channels = CONFIG.PHONE_REMOTE.SYSTEM_AUDIO_CHANNELS
        const maxBufferFrames = Math.round(
          (CONFIG.PHONE_REMOTE.SYSTEM_AUDIO_SAMPLE_RATE *
            CONFIG.PHONE_REMOTE.SYSTEM_AUDIO_MAX_BUFFER_MS) /
            1000
        )
        const node = new AudioWorkletNode(ctx, 'pcm-player', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [channels],
          processorOptions: { channels, maxBufferFrames }
        })
        pcmNodeRef.current = node

        const dest = ctx.createMediaStreamDestination()
        audioDestRef.current = dest
        node.connect(dest)
        // Deliberately NOT connected to ctx.destination: that would play the
        // Mac's own audio back out of the Mac's speakers on top of itself.

        const [track] = dest.stream.getAudioTracks()
        console.log('[mirror] mac audio graph ready')
        // Guarded: the graph is built by now, so a PiP-encoder throw must not
        // reach the catch below and cost the mirror its audio track entirely.
        if (pipRef.current?.running) attachPipAudioSafely()
        return track ?? null
      } catch (err) {
        console.log(`[mirror] mac audio graph failed: ${String(err)}`)
        return null
      }
    }

    /** Drain the phone's inbound mic track into main as float32 PCM. Failure is
     *  non-fatal: the mirror keeps working without a mic. */
    async function consumeMicTrack(track: MediaStreamTrack): Promise<void> {
      try {
        const ctx = new AudioContext({ sampleRate: CONFIG.PHONE_REMOTE.SYSTEM_AUDIO_SAMPLE_RATE })
        micCtxRef.current = ctx
        await ctx.audioWorklet.addModule(pcmRecorderUrl)

        const channels = CONFIG.PHONE_REMOTE.PHONE_MIC_CHANNELS
        const node = new AudioWorkletNode(ctx, 'pcm-recorder', {
          numberOfInputs: 1,
          numberOfOutputs: 0,
          processorOptions: {
            channels,
            batchFrames: CONFIG.PHONE_REMOTE.PHONE_MIC_BATCH_FRAMES
          }
        })
        micNodeRef.current = node
        node.port.onmessage = (e: MessageEvent): void => {
          window.api.webrtcCaptureMicPcm(e.data as ArrayBuffer)
        }

        const stream = new MediaStream([track])
        // Chromium delivers a remote WebRTC track to Web Audio as SILENCE
        // unless the stream is also sunk by a media element -- the worklet runs
        // and every sample is 0.0, which is indistinguishable from a muted mic.
        // Muted + never in the DOM, so nothing reaches the Mac's speakers.
        const sink = new Audio()
        sink.srcObject = stream
        sink.muted = true
        void sink.play().catch(() => {})
        micSinkRef.current = sink

        const src = ctx.createMediaStreamSource(stream)
        micSrcRef.current = src
        src.connect(node)
        console.log('[mirror] mac mic graph ready')
      } catch (err) {
        console.log(`[mirror] mac mic graph failed: ${String(err)}`)
      }
    }

    function displayMediaConstraints(quality: MirrorQuality): MediaStreamConstraints {
      if (quality === 'native') return { video: true, audio: false }
      const [width, height, frameRate] =
        quality === 'glasses'
          ? videoModeOn()
            ? [
                CONFIG.PHONE_REMOTE.MIRROR_GLASSES_VIDEO_WIDTH,
                CONFIG.PHONE_REMOTE.MIRROR_GLASSES_VIDEO_WIDTH,
                CONFIG.PHONE_REMOTE.MIRROR_GLASSES_VIDEO_FRAME_RATE
              ]
            : [
                CONFIG.PHONE_REMOTE.MIRROR_GLASSES_WIDTH,
                CONFIG.PHONE_REMOTE.MIRROR_GLASSES_HEIGHT,
                CONFIG.PHONE_REMOTE.MIRROR_GLASSES_FRAME_RATE
              ]
          : [
              CONFIG.PHONE_REMOTE.MIRROR_CAPPED_WIDTH,
              CONFIG.PHONE_REMOTE.MIRROR_CAPPED_HEIGHT,
              CONFIG.PHONE_REMOTE.MIRROR_CAPPED_FRAME_RATE
            ]
      // No `min` on any of these. getDisplayMedia REJECTS a min constraint
      // outright -- "min constraints are not supported", the whole call throws
      // and capture never starts. It is not ignored the way an unsupported
      // ideal is, so a keepalive cannot be requested at capture time; a trickle
      // has to come from the sender side instead. This cost a live mirror.
      return {
        video: { width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: frameRate } },
        audio: false
      }
    }

    /** Bias the encoder toward smooth motion over per-frame sharpness. A
     *  getDisplayMedia track defaults to 'detail', which preserves text at the
     *  cost of frames -- the wrong half of that trade for a 600px panel that
     *  cannot resolve the detail being paid for. Applied at every acquisition,
     *  including recovery, because it is a property of the TRACK: a
     *  replaceTrack'd stream silently reverts to 'detail' otherwise. */
    function applyContentHint(track: MediaStreamTrack, quality: MirrorQuality): void {
      // 'text', not 'motion'. The glasses are read, not watched: the complaint
      // that drove this was illegibility, and 'motion' explicitly authorises the
      // encoder to spend resolution on framerate -- which is how a 600px panel
      // ended up being fed a 300x192 stream and upscaling it 2x.
      //
      // Video mode inverts exactly that: watching a film, spending resolution
      // to buy frames is the trade the user wants, and 'text' is what makes
      // VP9's screen-content tooling (QP capping, palette mode) apply to
      // photographic content it was never meant for.
      if (quality === 'glasses') {
        track.contentHint = videoModeOn() ? 'motion' : 'text'
        console.log(
          `[mirror] VIDEOMODE capture hint=${track.contentHint}` +
            ` (video=${videoModeOn()} mode=${String(CONFIG.PHONE_REMOTE.MIRROR_GLASSES_VIDEO_MODE)})`
        )
      }
    }

    /** Re-acquire getDisplayMedia at the CURRENT constraints and swap it into the
     *  live sender via replaceTrack -- no renegotiation needed. A superseded
     *  generation (stop/newer start already landed) is a no-op, not a failure.
     *
     *  Shared by the stall recovery and the video-mode flip: both need exactly
     *  this swap, and the only difference is the telemetry around it. Throws on
     *  failure so each caller reports it in its own terms. */
    async function swapCapture(
      generation: number,
      sender: RTCRtpSender,
      quality: MirrorQuality
    ): Promise<void> {
      const newStream = await navigator.mediaDevices.getDisplayMedia(
        displayMediaConstraints(quality)
      )
      if (startGenerationRef.current !== generation) {
        newStream.getTracks().forEach((t) => t.stop())
        return
      }
      const [newTrack] = newStream.getVideoTracks()
      if (!newTrack) {
        newStream.getTracks().forEach((t) => t.stop())
        throw new Error('re-acquired stream had no video track')
      }
      applyContentHint(newTrack, quality)
      await sender.replaceTrack(newTrack)
      attachStallFastPath(newTrack, generation, sender, quality)

      // The old stream's track(s) belong to the dead capture surface --
      // stop them so macOS releases the capture handle, then track the new
      // stream so teardown() stops the right one.
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = newStream

      // replaceTrack only re-points the SENDER. Without this the PiP encoder
      // keeps reading the stopped track and freezes on the pre-sleep frame.
      if (pipRef.current?.running) pipRef.current.attach(newTrack)
    }

    async function recoverCapture(
      generation: number,
      sender: RTCRtpSender,
      quality: MirrorQuality
    ): Promise<void> {
      if (recoveringRef.current) return
      if (startGenerationRef.current !== generation) return
      recoveringRef.current = true
      window.api.webrtcCaptureStalled()
      console.log('[webrtc-capture] stall detected, re-acquiring capture')
      try {
        await swapCapture(generation, sender, quality)
        stalledPollsRef.current = 0
        window.api.webrtcCaptureRecovered()
        console.log('[webrtc-capture] recovered, framesSent resuming')
      } catch (err) {
        console.log(`[webrtc-capture] recovery failed: ${String(err)}`)
      } finally {
        recoveringRef.current = false
      }
    }

    /** Fast path only -- onmute/onended are unreliable for getDisplayMedia
     *  tracks on some Chromium capture backends, so the stall poll in
     *  handleStart is the mechanism this fix actually relies on. */
    function attachStallFastPath(
      track: MediaStreamTrack,
      generation: number,
      sender: RTCRtpSender,
      quality: MirrorQuality
    ): void {
      track.onmute = () => {
        console.log('[webrtc-capture] track muted')
        void recoverCapture(generation, sender, quality)
      }
      track.onended = () => {
        console.log('[webrtc-capture] track ended')
        void recoverCapture(generation, sender, quality)
      }
    }

    async function handleStart(
      offerSdp: string,
      quality: MirrorQuality,
      iceServers: unknown[],
      shareAudio: boolean,
      // Audio-only mirror mode (Siri -> ChatGPT voice PRD): skip screen capture
      // entirely -- no getDisplayMedia call (so no screen-recording permission
      // prompt) and no video track -- while still answering the phone's offer
      // so its mic transceiver negotiates normally.
      audioOnly: boolean
    ): Promise<void> {
      console.log(
        '[webrtc-capture] handleStart',
        quality,
        `shareAudio=${shareAudio}`,
        `audioOnly=${audioOnly}`
      )
      teardown()
      // Claim this attempt. Every await below (getDisplayMedia, createAnswer)
      // is a window in which a stop or a newer start can arrive, and those
      // begin by bumping this -- so a stale attempt can tell "I was aborted"
      // from "I failed". A pc-identity check can't do it: the first await
      // happens before there IS a pc.
      const generation = ++startGenerationRef.current
      try {
        // Electron's setDisplayMediaRequestHandler (main/index.ts) answers this
        // with the primary display's source, no picker dialog — see that file's
        // comment for why this resolves headlessly. Skipped entirely in
        // audio-only mode: calling getDisplayMedia at all is what triggers the
        // screen-recording permission prompt.
        const stream = audioOnly
          ? null
          : await navigator.mediaDevices.getDisplayMedia(displayMediaConstraints(quality))
        streamRef.current = stream
        const captureTrack = stream?.getVideoTracks()[0]
        if (captureTrack) {
          applyContentHint(captureTrack, quality)
          const s = captureTrack.getSettings()
          console.log(`[mirror] mac capture ${s.width}x${s.height}@${s.frameRate} (${quality})`)
        }

        // Servers come from main (phone-remote/ice-servers.ts) so this end and
        // the phone use the IDENTICAL list -- TURN allocations are tied to the
        // credentials that created them, so mismatched lists can't reach each
        // other's relay candidates. Falls back to the static STUN list if main
        // somehow sent nothing, which keeps LAN mirroring working.
        const pc = new RTCPeerConnection({
          iceServers: (iceServers?.length
            ? iceServers
            : [...CONFIG.PHONE_REMOTE.MIRROR_ICE_SERVERS]) as RTCIceServer[]
        })
        console.log(`[mirror] mac using ${iceServers?.length ?? 0} ICE entries from main`)
        pcRef.current = pc

        // The phone's mic arrives here. Its m-line is always negotiated (the
        // phone offers sendrecv with a muted track), so a track shows up even
        // when the mic is off -- it just carries silence until the user unmutes.
        pc.ontrack = (e) => {
          if (e.track.kind !== 'audio') return
          console.log('[mirror] mac inbound mic track')
          void consumeMicTrack(e.track)
        }

        stream?.getTracks().forEach((track) => pc.addTrack(track, stream))

        // Audio track must be added BEFORE createAnswer -- a track added after
        // the answer isn't in the SDP and needs a full renegotiation the phone
        // isn't listening for. Same peer connection as video, so A/V share one
        // RTCP clock and stay in sync for free.
        //
        // Added unconditionally (not gated on shareAudio) so the phone can mute
        // and unmute LOCALLY by flipping track.enabled instead of forcing a
        // reconnect per toggle. The Mac still only spawns the ScreenCaptureKit
        // helper when audio is actually wanted, so an untoggled session
        // captures nothing -- the track just carries silence until then.
        {
          const audioTrack = await buildAudioTrack()
          const audioStream = audioDestRef.current?.stream
          if (audioTrack && audioStream) {
            pc.addTrack(audioTrack, audioStream)
            console.log('[mirror] mac audio track added')
          }
        }

        // Diagnostics: everything below console.log's into the main dev log via
        // this window's console-message forwarder (screen-stream.ts). Mirror
        // failures were previously invisible past onAnswer -- the handshake
        // logged fine and then nothing, so a NAT failure and a code bug looked
        // identical. Candidate TYPE is the signal that matters:
        //   host  = same-LAN direct
        //   srflx = STUN worked, public address discovered (off-LAN hope)
        //   relay = TURN relay allocated (the off-LAN fallback when srflx
        //           candidates can't actually reach each other)
        // No srflx at all off-LAN => STUN didn't get through. srflx present but
        // stuck in `checking` => symmetric NAT; that's the case relay fixes.
        pc.onicecandidate = (e) => {
          if (e.candidate) {
            // candidate line format: "candidate:<foundation> <comp> <proto> <pri> <ip> <port> typ <TYPE> ..."
            const type = e.candidate.candidate.split(' typ ')[1]?.split(' ')[0] ?? 'unknown'
            console.log(`[mirror] mac ICE candidate typ=${type}`)
            window.api.webrtcCaptureIceCandidateOut(
              e.candidate.candidate,
              e.candidate.sdpMid,
              e.candidate.sdpMLineIndex
            )
          } else {
            console.log('[mirror] mac ICE gathering complete')
          }
        }

        pc.oniceconnectionstatechange = () => {
          console.log(`[mirror] mac iceConnectionState=${pc.iceConnectionState}`)
        }

        pc.onconnectionstatechange = () => {
          console.log(`[mirror] mac connectionState=${pc.connectionState}`)
          // Only the CURRENT peer connection may report a failure. A deliberate
          // teardown (mirrorStop, or the restart every quality/mode switch and
          // WS reconnect performs) closes the old pc, and close() drives it to
          // 'failed' on its way out -- so the stale generation fired
          // webrtcCaptureError and the phone showed "Mirror: connection failed"
          // for a mirror the user had just turned off or successfully
          // restarted. The error also reset the pane to disconnected, which is
          // how a normal toggle looked like a crash.
          if (startGenerationRef.current !== generation) return
          if (pc.connectionState === 'failed') {
            window.api.webrtcCaptureError('connection failed')
          }
        }

        // What the RECEIVER asked for, before we answer. Three sender-side fixes
        // were spent on a chronic 184k outgoing estimate on a LAN route at 0.5%
        // loss -- all of them assuming goog-cc was mis-estimating. A `b=` line in
        // the offer would mean it is not estimating at all, just obeying, and no
        // sender knob can beat it. 184320 is exactly 180 * 1024, the shape a
        // runtime writing b=TIAS as kbps*1024 produces.
        const bLines = offerSdp.match(/^b=.*$/gm) ?? []
        const fbLines = offerSdp.match(/^a=rtcp-fb:.*$/gm) ?? []
        console.log(
          `[mirror] mac offer b=[${bLines.join('|') || 'none'}] ` +
            `fb=[${[...new Set(fbLines.map((l) => l.split(' ').slice(1).join(' ')))].join('|')}]`
        )

        // fmtp params in an SDP state what its AUTHOR wants to receive, so the
        // knobs steering OUR encoder ride the phone's offer -- munging only the
        // answer delivered nothing to the sender, which is why the VP9 floor
        // still measured inert on 2026-08-12 (target=30k under min-bitrate=800).
        const remoteSdp = quality === 'glasses' ? mungeGlassesBitrate(offerSdp) : offerSdp
        await pc.setRemoteDescription({ type: 'offer', sdp: remoteSdp })
        const answer = await pc.createAnswer()
        const sdp =
          quality === 'glasses' && answer.sdp ? mungeGlassesBitrate(answer.sdp) : answer.sdp
        await pc.setLocalDescription({ type: 'answer', sdp })
        if (sdp) window.api.webrtcCaptureAnswer(sdp)

        // One-time read of which BWE feedback goog-cc negotiated for video.
        // transport-cc (TWCC) = sender-side estimation with probing, can
        // re-grow after a collapse; goog-remb only = receiver-side estimation
        // capped by acked bitrate, which parks low forever -- the two produce
        // the SAME flat-estimate symptom and only the SDP says which one runs.
        {
          const videoSection = (s: string): string =>
            s.split(/\r?\nm=/).find((m) => m.startsWith('video')) ?? ''
          const fb = (s: string): string =>
            `twcc=${/a=rtcp-fb:\S+ transport-cc/.test(s)} remb=${/a=rtcp-fb:\S+ goog-remb/.test(s)} ` +
            `twccExt=${s.includes('transport-wide-cc')} absSendTime=${s.includes('abs-send-time')} ` +
            `minBr=${(s.match(/x-google-min-bitrate/g) ?? []).length}`
          // iv= bumps on every instrumentation edit: the hidden capture window
          // does not reliably hot-reload, and one run already executed stale
          // code silently -- the stamp is what makes a run's logs trustworthy.
          console.log(
            `[${stamp()}] [mirror] mac bwe-fb iv=10 offer: ${fb(videoSection(remoteSdp))} | answer: ${fb(videoSection(sdp ?? ''))}`
          )
        }

        // Drain queued candidates now: setRemoteDescription has run, which is
        // the precondition addIceCandidate requires.
        if (pendingIceRef.current.length > 0) {
          console.log(`[mirror] mac draining ${pendingIceRef.current.length} queued ICE candidates`)
          const queued = pendingIceRef.current
          pendingIceRef.current = []
          for (const c of queued) {
            pc.addIceCandidate({
              candidate: c.candidate,
              sdpMid: c.sdpMid ?? undefined,
              sdpMLineIndex: c.sdpMLineIndex ?? undefined
            }).catch((err) => console.log(`[mirror] mac queued addIceCandidate failed: ${String(err)}`))
          }
        }

        // Bitrate ceiling -- see MIRROR_MAX_BITRATE_* for why this is a cost
        // guardrail, not a quality knob. Applied AFTER setLocalDescription
        // because a sender has no encodings to modify until the media section
        // is negotiated; setting it earlier silently no-ops. Best-effort: if
        // the browser rejects the parameters we log and carry on rather than
        // failing the whole mirror over a bitrate hint.
        const maxBitrate =
          quality === 'capped'
            ? CONFIG.PHONE_REMOTE.MIRROR_MAX_BITRATE_CAPPED
            : quality === 'glasses'
              ? CONFIG.PHONE_REMOTE.MIRROR_MAX_BITRATE_GLASSES
              : CONFIG.PHONE_REMOTE.MIRROR_MAX_BITRATE_NATIVE
        const sender = pc.getSenders().find((s) => s.track?.kind === 'video')
        if (sender) {
          const params = sender.getParameters()
          if (!params.encodings || params.encodings.length === 0) params.encodings = [{}]
          params.encodings[0].maxBitrate = maxBitrate
          // Under bandwidth/CPU pressure a screen-share track defaults to
          // maintain-resolution: it holds full size and starves the framerate,
          // which is the correct trade for a spreadsheet and exactly wrong on
          // the glasses, where the panel is already discarding resolution and
          // the user is watching a live cursor move. Trade pixels for frames.
          // GLASSES ONLY -- the phone has the panel to resolve the detail it is
          // paying for, and shipped this unconditionally by mistake.
          // 'balanced', after both extremes were measured and both failed.
          // 'maintain-framerate' shrank the picture to 300x192 on a 600px panel
          // (unreadable); 'maintain-resolution' held 600x386 and paid the whole
          // shortfall in frames -- measured 600x386@6 with the estimate stuck
          // at 180k and the phone reporting freeze=26/27.3s over 99s while
          // scrolling Chrome. Static content never showed it because a still
          // screen needs no bitrate. 'balanced' splits the loss, so motion
          // costs some pixels AND some frames instead of all of one.
          // Video mode is the exception both of those measurements missed: both
          // were taken scrolling Chrome, a BURST. 'balanced' lets the encoder
          // resize, and under loss it hunts -- measured 800x516 -> 600x387 ->
          // 800x516 -> 600x387 across 89s of Streamio with lost=7.2% decaying
          // to 1.7%. Every swing costs a keyframe, the keyframe is a burst on a
          // link already dropping packets, and that feeds the next resize. The
          // choppiness IS the resizing, not the frame rate. Pinning the size
          // makes it pay in frames only, which a film tolerates and a
          // re-keyframe does not.
          if (quality === 'glasses') {
            params.degradationPreference = videoModeOn() ? 'maintain-resolution' : 'balanced'
          }
          liveEncodingRef.current = { quality, maxBitrate, generation, sender }
          // A reused window keeps its refs across mirrors; a fresh start is
          // always full resolution regardless of how the last one ended.
          motionOnRef.current = false
          params.encodings[0].scaleResolutionDownBy = 1
          try {
            logSetParams('acquire', params)
            await sender.setParameters(params)
            console.log(
              `[mirror] mac maxBitrate=${maxBitrate} (${quality}) degradation=${params.degradationPreference ?? 'default'}`
            )
          } catch (err) {
            console.log(`[mirror] mac setParameters failed (uncapped): ${String(err)}`)
          }
        }

        // Same treatment for audio: Opus gains nothing audible past the cap and
        // every byte is metered when the connection falls back to a TURN relay.
        const audioSender = pc.getSenders().find((s) => s.track?.kind === 'audio')
        if (audioSender) {
          const aParams = audioSender.getParameters()
          if (!aParams.encodings || aParams.encodings.length === 0) aParams.encodings = [{}]
          aParams.encodings[0].maxBitrate = CONFIG.PHONE_REMOTE.SYSTEM_AUDIO_MAX_BITRATE
          try {
            await audioSender.setParameters(aParams)
          } catch (err) {
            console.log(`[mirror] mac audio setParameters failed (uncapped): ${String(err)}`)
          }
        }

        // onmute/onended are a known-unreliable Chromium path for
        // getDisplayMedia tracks -- fast path only, the stall poll below is
        // what the fix actually depends on.
        if (sender && stream?.getVideoTracks()[0]) {
          attachStallFastPath(stream.getVideoTracks()[0], generation, sender, quality)
        }
        if (sender) {
          let lastFrames = 0
          // Diagnostic only. The receive-side bench shows the glasses stream
          // degrading to ~36% of the requested size at 1.2% packet loss, which
          // rules out the network but not WHICH end is the wall.
          // qualityLimitationReason names it in one field: 'cpu' = the Mac
          // cannot encode what we asked for, 'bandwidth' = congestion control
          // backed off. Logged on CHANGE only -- it is steady-state for whole
          // runs, so per-tick logging would bury the transition that matters.
          let lastLimitation = ''
          // Change-only logging hid the number that mattered: the reason never
          // changed for a whole run, so framesSent printed once and could not
          // be diffed against the bench's framesDecoded over any window. Print
          // on change OR every Nth poll, so both a transition and a rate are
          // always readable.
          let pollCount = 0
          // bytesSent delta -> actual send rate. target= is what the allocator
          // ASKED for; this is what left the encoder. The floor test needs both:
          // delivered-but-ignored (target stays 30k) and honored-but-not-met
          // (target 800k, sendK 200k) are different verdicts in one run.
          let lastBytes = 0
          let lastPollAt = 0
          // Edge state for the low-estimate re-assert below: true while the
          // estimate is under the threshold, so the write happens once on the
          // way down rather than every poll.
          let estimateWasLow = false
          stallGuardRef.current = setInterval(() => {
            void sender.getStats().then((stats) => {
              stats.forEach((r) => {
                if (r.type !== 'outbound-rtp' || r.kind !== 'video') return
                const frames = (r.framesSent as number | undefined) ?? 0
                const delta = frames - lastFrames
                lastFrames = frames

                pollCount++
                // Read every poll, not just on a log tick: the re-assert below
                // decides on it and logging is throttled to every Nth.
                let estimateForReassert = 0
                // Read off the SAME pair as the estimate, in the same walk. A
                // parked estimate has two unrelated causes -- a genuinely thin
                // link, or a relayed route -- and rtt/route are what tell them
                // apart. Reading them from a different pair than the estimate
                // came from would attribute the number to the wrong path.
                let rttMs = -1
                let route = 'unknown'
                // Whether the estimate below is a MEASUREMENT or just its
                // initializer. Without this, 0 means both.
                let estimateRead = false
                // Nominated pair only -- an unfiltered walk lands on whichever
                // pair iterates last (rtt read 24ms..9614ms). `nominated` is
                // optional in the spec, hence the any-pair fallback.
                let sawNominated = false
                // Counted so `estimate=0k` can never again read as "the link
                // died" when it actually means "no pair was readable": the two
                // were indistinguishable and cost four wrong diagnoses.
                let pairCount = 0
                const readPair = (s: Record<string, unknown>): void => {
                  // rtt/route are read INDEPENDENTLY of the bitrate -- a pair
                  // mid-recovery carries both while omitting the estimate, and
                  // returning early here blanked all three at once.
                  const rtt = s.currentRoundTripTime
                  if (typeof rtt === 'number') rttMs = Math.round(rtt * 1000)
                  const typeOf = (id: unknown): string => {
                    if (typeof id !== 'string') return '?'
                    const c = stats.get(id) as Record<string, unknown> | undefined
                    return (c?.candidateType as string | undefined) ?? '?'
                  }
                  route = `${typeOf(s.localCandidateId)}/${typeOf(s.remoteCandidateId)}`
                  if (typeof s.availableOutgoingBitrate === 'number') {
                    estimateForReassert = s.availableOutgoingBitrate as number
                    estimateRead = true
                  }
                }
                stats.forEach((s) => {
                  if (s.type !== 'candidate-pair') return
                  pairCount++
                  if (s.nominated !== true || s.state !== 'succeeded') return
                  sawNominated = true
                  readPair(s as Record<string, unknown>)
                })
                if (!sawNominated) {
                  stats.forEach((s) => {
                    if (s.type !== 'candidate-pair') return
                    readPair(s as Record<string, unknown>)
                  })
                }
                const limitation = (r.qualityLimitationReason as string | undefined) ?? 'unknown'
                // qualityLimitationReason is INSTANTANEOUS and has already lied
                // by omission here: it read 'none' on polls where the estimate
                // sat at 184k and the picture was visibly degraded, because
                // whatever caused the drop had already stopped being true by the
                // time the poll landed. The durations are CUMULATIVE seconds per
                // reason, so they cannot be missed between polls -- diffing them
                // says what actually held the stream back over the window, not
                // what happened to be true at the instant it was sampled.
                const lim = (r.qualityLimitationDurations ?? {}) as Record<string, number>
                const limMs = (k: string): number => Math.round((lim[k] ?? 0) * 1000)
                // What the encoder was ASKED for vs what it produced. If target
                // tracks the 184k estimate then goog-cc is driving the collapse;
                // if target stays high while output sits low, the encoder is not
                // meeting its target and the estimate is a symptom, not a cause.
                // That distinction is the whole open question as of 2026-08-12.
                const targetK = Math.round(((r.targetBitrate as number | undefined) ?? 0) / 1000)
                const bytes = (r.bytesSent as number | undefined) ?? 0
                const now = Date.now()
                const sendK =
                  lastPollAt > 0 && now > lastPollAt
                    ? Math.round(((bytes - lastBytes) * 8) / (now - lastPollAt))
                    : 0
                lastBytes = bytes
                lastPollAt = now
                // What the RECEIVER reported back via RTCP: fractionLost is the
                // loss over the last report interval (the bench's lost= is
                // cumulative), and this rtt is the media path's own, not the
                // candidate pair's smoothed one. The 5-12s pair rtt during
                // collapses says packets are QUEUEING; these say how much is
                // being dropped right now while they do.
                let rrLostPct = -1
                let rrJitMs = -1
                let rrRttMs = -1
                stats.forEach((s) => {
                  if (s.type !== 'remote-inbound-rtp' || s.kind !== 'video') return
                  if (typeof s.fractionLost === 'number') rrLostPct = Math.round(s.fractionLost * 100)
                  if (typeof s.jitter === 'number') rrJitMs = Math.round(s.jitter * 1000)
                  if (typeof s.roundTripTime === 'number') rrRttMs = Math.round(s.roundTripTime * 1000)
                })
                if (
                  limitation !== lastLimitation ||
                  pollCount % CONFIG.PHONE_REMOTE.MIRROR_MAC_STATS_LOG_EVERY_N === 0
                ) {
                  lastLimitation = limitation
                  const w = (r.frameWidth as number | undefined) ?? 0
                  const h = (r.frameHeight as number | undefined) ?? 0
                  const fps = (r.framesPerSecond as number | undefined) ?? 0
                  // The codec is never set anywhere, so it is whatever SDP
                  // negotiation picked -- and a limitation='cpu' verdict means
                  // something different for software VP8 than for hardware
                  // H.264. Reported together so the pair is one fact.
                  const codecStat = r.codecId ? stats.get(r.codecId as string) : undefined
                  const codec = (codecStat?.mimeType as string | undefined) ?? 'unknown'
                  // availableOutgoingBitrate IS the congestion controller's own
                  // estimate -- the number that decides every resolution
                  // collapse. Without it, 'limitation=bandwidth' says a limit
                  // was hit but never how much link there was, which is how
                  // three bitrate caps got set against guesses.
                  const estimate = estimateForReassert
                  // framesSent is here so the Mac's send rate can be diffed
                  // against the bench's framesDecoded over the same window:
                  // screen capture emits nothing while the screen is static, so
                  // a freeze the bench reports may be an idle desktop rather
                  // than the encoder. Equal rates = the bench saw idle content.
                  console.log(
                    `[${stamp()}] [mirror] mac limitation=${limitation} sending ${w}x${h}@${fps} ` +
                      `sent=${frames} codec=${codec} estimate=${Math.round(estimate / 1000)}k ` +
                      `target=${targetK}k sendK=${sendK}k limMs=bw:${limMs('bandwidth')}/cpu:${limMs('cpu')}/` +
                      `oth:${limMs('other')}/none:${limMs('none')} ` +
                      `rtt=${rttMs}ms route=${route} ` +
                      // estRaw un-rounded: 'estimate=354k' for minutes is the
                      // parked-controller tell ONLY if the raw value is truly
                      // frozen -- rounding to k would fake that.
                      `rr=lost:${rrLostPct}%/jit:${rrJitMs}ms/rtt:${rrRttMs}ms ` +
                      `estRaw=${estimateRead ? Math.round(estimate) : 'unread'} ` +
                      `pairs=${pairCount}${sawNominated ? '' : '/none-nominated'} (${quality})`
                  )
                }
                // Re-assert the encoding on the glasses when the estimate dips.
                // A sender that has ridden a collapsed estimate down does not
                // climb back on its own -- it sat at 180k for minutes with
                // limitation=none, i.e. nothing was asking for more -- and
                // writing the same parameters back is the one supported nudge.
                //
                // EDGE-triggered, once per dip. The first version fired every
                // poll while below the threshold, which is a setParameters
                // write per second: that churn is itself suspected of pinning
                // the rate controller (the estimate went from oscillating
                // 180k<->900k to flat 184k for three minutes). One write on the
                // way down, then silence until it recovers and dips again.
                const low =
                  estimateForReassert > 0 &&
                  estimateForReassert < CONFIG.PHONE_REMOTE.MIRROR_GLASSES_REASSERT_BELOW
                if (
                  quality === 'glasses' &&
                  CONFIG.PHONE_REMOTE.MIRROR_GLASSES_REASSERT_ENABLED &&
                  low &&
                  !estimateWasLow
                ) {
                  const p = sender.getParameters()
                  if (p.encodings && p.encodings.length > 0) {
                    p.encodings[0].maxBitrate = maxBitrate
                    // Must match the acquire-time choice above: this fired 4x in
                    // one 89s film (estimate 225k/340k/393k/332k), so a hardcoded
                    // 'balanced' here silently un-pins the size mid-playback.
                    p.degradationPreference = videoModeOn() ? 'maintain-resolution' : 'balanced'
                    // Explicit, not inherited from the read above: a partial
                    // encoding object drops whatever it omits, and full
                    // resolution is now the only size this stream ever uses.
                    p.encodings[0].scaleResolutionDownBy = 1
                    logSetParams('re-assert', p)
                    void sender
                      .setParameters(p)
                      .catch((err) => console.log(`[mirror] mac re-assert setParameters failed: ${String(err)}`))
                    console.log(`[mirror] mac re-assert on dip estimate=${Math.round(estimateForReassert / 1000)}k`)
                  }
                }
                // Latch unconditionally. Gating this on `> 0` was the bug: a
                // poll reading estimate=0 (19 of them in one session) left the
                // latch stale, so the next real dip re-fired -- 320 firings in
                // one run, i.e. a setParameters write per second, which is the
                // churn the comment above says pins the rate controller. Flat
                // estimate=184k and target floored at 30k are that pin.
                // A 0 reading is "no estimate yet", which is not low, so
                // holding the previous latch is also wrong -- clear it.
                estimateWasLow = low
                // Trickle: keep the radio awake while the screen is still.
                //
                // The glasses' Wi-Fi power-saves between frames -- measured
                // rtt=81ms while frames flow, 2785-3406ms once the send rate
                // falls to ~1fps, same route both sides. So the first update
                // after any pause pays a 1-3s radio wake before a byte of it
                // moves, which is most of what "slow to start" is.
                //
                // setParameters is the lever because it is the only one already
                // PROVEN on device to reach the encoder: the dip re-assert above
                // writes parameters and the estimate visibly recovers (180k ->
                // 214k in the 13:20 run). requestFrame() is canvas-only and a
                // capture constraint is fatal (see MIRROR_GLASSES_TRICKLE_FPS).
                //
                // Same values, deliberately: a changed scaleResolutionDownBy
                // would cost a keyframe, which is the exact cost this whole
                // section is built to avoid. Only while genuinely idle -- during
                // motion the frames themselves keep the radio up.
                // Gated on frames HAVING FLOWED (`sent` > 0), not just on
                // delta === 0. Those two look alike and are opposite states:
                // delta === 0 is also true throughout startup, before the first
                // frame exists, and trickling there wrote setParameters on every
                // poll of a connection still negotiating -- the mirror looped
                // onStalled/re-acquire at `sending 0x0@0 sent=0` and never
                // connected. A still screen is only a still screen after it has
                // been a moving one.
                const trickleFps = CONFIG.PHONE_REMOTE.MIRROR_GLASSES_TRICKLE_FPS
                if (
                  quality === 'glasses' &&
                  trickleFps > 0 &&
                  frames > 0 &&
                  delta === 0 &&
                  !motionOnRef.current
                ) {
                  const p = sender.getParameters()
                  if (p.encodings && p.encodings.length > 0) {
                    logSetParams('trickle', p)
                    void sender
                      .setParameters(p)
                      .catch((err) => console.log(`[mirror] mac trickle setParameters failed: ${String(err)}`))
                  }
                }
                // A still screen is NOT a dead capture, and conflating them is
                // expensive. getDisplayMedia emits only when pixels change, so
                // delta === 0 is the NORMAL state of an idle desktop -- and of a
                // stream still negotiating, which is how a bare delta === 0
                // trigger tore capture down mid-connect on repeat and stopped
                // the mirror connecting at all (`sending 0x0@0 sent=0`, four
                // re-acquires, never connected).
                //
                // Each false fire is not free either: re-acquire resets the
                // encoder and forces a full-size keyframe through a ~180k
                // estimate, i.e. seconds of late picture exactly when the user
                // comes back -- and periodic keyframe bursts into an otherwise
                // idle link look like congestion to goog-cc, so this is a
                // suspect in the chronic 180k itself.
                //
                // So: require the TRACK to actually be unhealthy. readyState
                // leaving 'live' (or the track muting/ending) is capture really
                // dying -- a screen nobody is touching never does that.
                const capture = streamRef.current?.getVideoTracks()[0]
                const trackDead = !capture || capture.readyState !== 'live' || capture.muted
                if (delta === 0 && trackDead) {
                  stalledPollsRef.current++
                  if (stalledPollsRef.current >= CONFIG.PHONE_REMOTE.MIRROR_STALL_THRESHOLD_POLLS) {
                    console.log(
                      `[mirror] mac re-acquire reason=track-${!capture ? 'missing' : capture.muted ? 'muted' : capture.readyState}` +
                        ` sent=${frames} polls=${stalledPollsRef.current}`
                    )
                    void recoverCapture(generation, sender, quality)
                  }
                } else {
                  stalledPollsRef.current = 0
                }
              })
            })
          }, CONFIG.PHONE_REMOTE.MIRROR_STALL_POLL_MS)

          // Video-mode detection. This IS a frame sampler, which the note below
          // rejects -- the difference is what it writes. That note is about the
          // motion DOWNSCALE, where every decision costs a keyframe and reacting
          // late is worse than not reacting. This only ever writes contentHint:
          // no keyframe, no resolution change, no re-acquire, so being a couple
          // of seconds late costs nothing and the objection does not carry over.
          videoPollRef.current = setInterval(
            pollSourceFrameRate,
            CONFIG.PHONE_REMOTE.MIRROR_GLASSES_VIDEO_POLL_MS
          )

          // No frame-delta motion sampler here, deliberately. Two designs were
          // tried and measured on the glasses, and both lose to the keyframe
          // they cost: every scaleResolutionDownBy change forces a fresh full
          // frame, which at the measured rtt=2168ms takes seconds to transmit.
          // Reacting to motion fires the downscale AFTER the burst it meant to
          // cheapen; pre-arming on idle fired 12 times in 39s, i.e. 12 keyframes
          // to save bandwidth on frames that were never going to be sent. The
          // resolution stays put, and the phone's input edge (applyMotionScale)
          // remains the only thing allowed to move it.
        }

      } catch (err) {
        // A NEWER start (or a stop) landed while this one was still awaiting
        // getDisplayMedia/createAnswer and tore our stream down underneath us
        // -- that's an abort, not a failure, and reporting it would toast an
        // error over a mirror that is currently coming up fine.
        if (startGenerationRef.current !== generation) return
        teardown()
        window.api.webrtcCaptureError(err instanceof Error ? err.message : String(err))
      }
    }

    const unsubStart = window.api.onWebrtcCaptureStart(
      (sdp, quality, iceServers, shareAudio, audioOnly) =>
        void handleStart(sdp, quality, iceServers, shareAudio, audioOnly)
    )
    // Raw PCM from the native SCK helper -> the worklet's ring buffer. Chunks
    // arriving before the graph exists are dropped rather than queued: audio is
    // live, and replaying a stale backlog would start the stream behind.
    const unsubPcm = window.api.onWebrtcCapturePcm((chunk) => {
      const node = pcmNodeRef.current
      if (!node) return
      // Transfer, don't copy -- this fires many times a second and the buffer
      // is never touched again on this side.
      node.port.postMessage(chunk, [chunk])
    })
    const unsubIce = window.api.onWebrtcCaptureIceCandidate((candidate, sdpMid, sdpMLineIndex) => {
      if (!pcRef.current) {
        // QUEUE, don't drop. The phone finishes gathering (host, srflx, relay)
        // before getDisplayMedia resolves on this side, so its candidates
        // routinely arrive while pcRef is still null. Dropping them left the
        // peer connection with nothing to pair against -- it never entered
        // `checking`, logged zero state changes, and the phone timed out in
        // `failed`. Main queues for the window-not-built case; this queues for
        // the window-built-but-no-peer-connection-yet case. Both are needed:
        // `rendererReady` (main's gate) only means the listeners are wired,
        // NOT that a peer connection exists.
        pendingIceRef.current.push({ candidate, sdpMid, sdpMLineIndex })
        console.log(`[mirror] mac queued inbound ICE (${pendingIceRef.current.length} pending)`)
        return
      }
      pcRef.current
        .addIceCandidate({ candidate, sdpMid: sdpMid ?? undefined, sdpMLineIndex: sdpMLineIndex ?? undefined })
        .catch((err) => {
          // A candidate arriving after teardown (race with mirrorStop) is safe
          // to drop, but a REJECTED candidate on a live connection is a real
          // failure -- never swallow it silently again.
          console.log(`[mirror] mac addIceCandidate failed: ${String(err)}`)
        })
    })
    const unsubStop = window.api.onWebrtcCaptureStop(() => teardown())

    // Trade resolution for SPEED while the user is actually driving.
    //
    // The metric is latency to the first updated frame after motion starts;
    // quality during motion is explicitly not wanted (Roy: update immediately at
    // low quality, sharpen after settle). At the measured ~180k estimate a
    // 1200-wide keyframe takes seconds to push, which is the entire complaint --
    // so motion drops the encoder far enough that the first frame is a few KB
    // and transits in a fraction of a second.
    //
    // Two things move together here and neither works alone:
    //  - scaleResolutionDownBy goes DEEP (not 2x): a 2x frame is still ~30KB at
    //    1200-wide, i.e. over a second at 180k.
    //  - degradationPreference flips to 'maintain-framerate', so when the
    //    encoder has to give something up mid-motion it gives up pixels rather
    //    than frames. 'balanced' is right for reading and wrong for driving.
    //
    // Two heralds reach this, and both fire AHEAD of the pixels they announce:
    // the phone's input edge, and a Mac-side app activation (NSWorkspace
    // publishes the switch before the repaint lands). That ordering is the whole
    // reason either works. A frame-delta sampler was tried twice and removed
    // both times (see the stall-guard comment above): it infers motion from
    // frames already sent, so its downscale always lands AFTER the keyframe it
    // was meant to shrink.
    /** Log what the capture source and encoder were doing across a switch.
     *
     *  The baseline said 3157ms and 4149ms with estimate=349k and the downscale
     *  correctly applied -- so the frame was not slow because it was big, and
     *  the bandwidth theory does not survive its own number. The BENCH line in
     *  the same window read freeze=9/14.8s, which points at the source going
     *  dark rather than the encoder running behind. These two samples separate
     *  those: if framesSent is flat and muted=true across the gap, the capture
     *  is dark and no encoder knob can help; if framesSent climbs the whole
     *  time, the frames are being sent and the delay is downstream. */
    function traceSwitchWindow(tag: string): void {
      const sender = pcRef.current?.getSenders().find((s) => s.track?.kind === 'video')
      const capture = streamRef.current?.getVideoTracks()[0]
      if (!sender) return
      void sender.getStats().then((stats) => {
        let sent = 0
        let encoded = 0
        let limitation = 'n/a'
        // media-source is the control for the cloned src= counter: it is
        // Chromium's own count of frames the source produced ON THE SENDER'S
        // path, so it cannot differ from the encoder's input the way a clone's
        // sink can. srcFrames (clone) and srcReal (media-source) agreeing is
        // what makes either trustworthy; disagreeing means the clone is
        // adapting separately and only srcReal counts.
        let srcReal = 0
        let srcFps = 0
        let keyFrames = 0
        let dims = '?'
        // Frames the source produced that the encoder never got. Non-zero here
        // is the whole "produced then dropped" case, stated directly rather
        // than inferred from two counters drifting apart.
        let dropped = 0
        stats.forEach((r) => {
          if (r.type === 'outbound-rtp' && r.kind === 'video') {
            sent = (r.framesSent as number | undefined) ?? 0
            encoded = (r.framesEncoded as number | undefined) ?? 0
            limitation = (r.qualityLimitationReason as string | undefined) ?? 'n/a'
            // A mid-stream resolution change forces a keyframe, so a keyframe
            // landing exactly where the drops start is what would convict the
            // downscale. The encoded dimensions come along to show WHICH size
            // the encoder actually settled on -- setParameters asking for 4x and
            // the encoder honouring it are different claims.
            keyFrames = (r.keyFramesEncoded as number | undefined) ?? 0
            dims = `${(r.frameWidth as number | undefined) ?? 0}x${(r.frameHeight as number | undefined) ?? 0}`
          }
          if (r.type === 'media-source' && r.kind === 'video') {
            srcReal = (r.frames as number | undefined) ?? 0
            srcFps = (r.framesPerSecond as number | undefined) ?? 0
          }
        })
        dropped = srcReal > 0 ? srcReal - encoded : 0
        console.log(
          `[mirror] SWITCHTRACE ${tag} srcReal=${srcReal} srcFps=${srcFps.toFixed(1)}` +
            ` encoded=${encoded} sent=${sent}` +
            ` dropped=${dropped} kf=${keyFrames} dims=${dims} limit=${limitation}` +
            ` muted=${capture?.muted ?? 'no-track'} state=${capture?.readyState ?? 'none'}`
        )
      })
    }

    /** Is video mode on right now? The forced values answer without consulting
     *  the detector, so pinning one for a bisect cannot be overridden by it. */
    function videoModeOn(): boolean {
      const mode = CONFIG.PHONE_REMOTE.MIRROR_GLASSES_VIDEO_MODE
      return mode === 'auto' ? videoDetectedRef.current : mode
    }

    /** Flip the detector and re-acquire the capture at the new profile.
     *
     *  The re-acquire is the whole point, not an extra: contentHint alone made
     *  it WORSE. 'motion' authorises the encoder to spend resolution to buy
     *  frames, and on a capture still pinned to the desk profile's 10fps there
     *  are no extra frames to buy -- so it paid sharpness for nothing and the
     *  picture went soft and laggy. The hint and the capture rate have to move
     *  together or not at all.
     *
     *  Costs one visible hitch per flip (a fresh getDisplayMedia + replaceTrack),
     *  which is why the thresholds carry a 2s dwell and hysteresis -- the flip
     *  has to be rare enough that the hitch is worth it. */
    function setVideoDetected(on: boolean, why: string): void {
      if (videoDetectedRef.current === on) return
      videoDetectedRef.current = on
      console.log(`[mirror] VIDEOMODE ${on ? 'ON' : 'OFF'} (${why}) re-acquiring capture`)
      const live = liveEncodingRef.current
      if (!live) return
      swapCapture(live.generation, live.sender, live.quality as MirrorQuality)
        .then(() => {
          const track = streamRef.current?.getVideoTracks()[0]
          console.log(
            `[mirror] VIDEOMODE ${on ? 'ON' : 'OFF'} capture swapped` +
              ` hint=${track?.contentHint ?? 'no-track'}` +
              ` ${on ? CONFIG.PHONE_REMOTE.MIRROR_GLASSES_VIDEO_WIDTH : CONFIG.PHONE_REMOTE.MIRROR_GLASSES_WIDTH}px/` +
              `${on ? CONFIG.PHONE_REMOTE.MIRROR_GLASSES_VIDEO_FRAME_RATE : CONFIG.PHONE_REMOTE.MIRROR_GLASSES_FRAME_RATE}fps`
          )
        })
        .catch((err) => {
          // Leave the flag flipped: the hint half did land via applyContentHint
          // on the next successful acquisition, and flipping back here would
          // fight the poller, which would immediately re-promote.
          console.log(`[mirror] VIDEOMODE re-acquire failed: ${String(err)}`)
        })
    }

    /** Poll how fast the CAPTURE SOURCE is producing frames, and promote to video
     *  mode while that stays high.
     *
     *  media-source.framesPerSecond, not the input herald: UserInputSource fires
     *  on a keypress or an app switch and is silent for a film playing with hands
     *  off the trackpad, which is exactly the case this has to catch. A first
     *  version keyed on that herald and could never fire -- 120s of Streamio
     *  logged one 1286ms burst. media-source is Chromium's own count of frames
     *  the source produced, so it sees the film and ignores the still desktop.
     *
     *  Two thresholds, deliberately apart: promoting needs sustained high fps,
     *  demoting needs sustained low fps, so a film's dark scene or a dropped
     *  window cannot flap the mode. */
    function pollSourceFrameRate(): void {
      if (CONFIG.PHONE_REMOTE.MIRROR_GLASSES_VIDEO_MODE !== 'auto') return
      const live = liveEncodingRef.current
      if (!live || live.quality !== 'glasses') return
      const sender = pcRef.current?.getSenders().find((s) => s.track?.kind === 'video')
      if (!sender) return
      void sender.getStats().then((stats) => {
        let fps = 0
        stats.forEach((r) => {
          if (r.type === 'media-source' && r.kind === 'video') {
            fps = (r.framesPerSecond as number | undefined) ?? 0
          }
        })
        const onFps = CONFIG.PHONE_REMOTE.MIRROR_GLASSES_VIDEO_ON_FPS
        const offFps = CONFIG.PHONE_REMOTE.MIRROR_GLASSES_VIDEO_OFF_FPS
        const needMs = CONFIG.PHONE_REMOTE.MIRROR_GLASSES_VIDEO_SUSTAIN_MS
        const now = Date.now()
        // Every tick, not just on an edge: a run that logs nothing is
        // indistinguishable from a poller that never started, which is exactly
        // the confusion that cost a round here. No frontmost app on the line --
        // it is main-side only, and the ledger already stamps it onto the BENCH
        // lines interleaved in this same log.
        // vt= stamps THIS CLOSURE, not the build. pollSourceFrameRate runs on
        // an interval started at capture time: HMR swaps the module but never
        // clears that interval, so this line keeps printing the pre-reload vt=
        // while connection-scoped lines (iv= at the bwe-fb log) are already
        // current. A stale vt= next to a fresh iv= means "old interval still
        // alive", NOT "stale build" -- three sessions read it the wrong way and
        // discarded good runs. Trust the wall-clock stamp; held= dates the
        // interval, so held >> session age is the tell.
        console.log(
          `[${stamp()}] [mirror] VIDEOTICK vt=8 srcFps=${fps.toFixed(1)} mode=${videoDetectedRef.current ? 'video' : 'text'}` +
            ` deg=${liveEncodingRef.current?.sender.getParameters().degradationPreference ?? 'default'}` +
            ` on>=${onFps} off<${offFps} askFps=${CONFIG.PHONE_REMOTE.MIRROR_GLASSES_VIDEO_FRAME_RATE}` +
            ` held=${movingSinceRef.current === null ? 0 : now - movingSinceRef.current}ms`
        )
        const busy = fps >= onFps
        const idle = fps < offFps
        // One clock, read in whichever direction the mode is not already in.
        if (videoDetectedRef.current ? !idle : busy) {
          if (movingSinceRef.current === null) {
            movingSinceRef.current = now
            console.log(
              `[mirror] VIDEOMODE srcFps=${fps.toFixed(1)} crossed ${videoDetectedRef.current ? `${offFps} (staying video)` : `${onFps}, ${needMs}ms to video`}`
            )
          }
          const heldMs = now - movingSinceRef.current
          if (!videoDetectedRef.current && heldMs >= needMs) {
            setVideoDetected(true, `srcFps=${fps.toFixed(1)} >= ${onFps} for ${heldMs}ms`)
          }
          return
        }
        // Crossed back. Reset the clock, and demote only after the same dwell.
        if (movingSinceRef.current !== null) {
          const heldMs = now - movingSinceRef.current
          movingSinceRef.current = null
          console.log(
            `[mirror] VIDEOMODE srcFps=${fps.toFixed(1)} fell below ${videoDetectedRef.current ? offFps : onFps} after ${heldMs}ms`
          )
          if (!videoDetectedRef.current) return
          idleSinceRef.current = now
          return
        }
        if (!videoDetectedRef.current) return
        if (idleSinceRef.current === null) idleSinceRef.current = now
        if (now - idleSinceRef.current >= needMs) {
          idleSinceRef.current = null
          setVideoDetected(false, `srcFps=${fps.toFixed(1)} < ${offFps} for ${needMs}ms`)
        }
      })
    }

    function applyMotionScale(moving: boolean, source: UserInputSource): void {
      const live = liveEncodingRef.current
      if (!live || live.quality !== 'glasses') return
      if (source === 'switch') {
        traceSwitchWindow(moving ? 'onset' : 'idle-end')
        // Sampled again mid-gap because the baseline's paint landed ~2.3s after
        // onset, which is after the idle timer has already fired -- the two
        // edges alone straddle the interesting part without ever landing in it.
        // Sampled densely across the whole window, not at two fixed marks: at
        // ~1 frame/1.5s a +1500/+3000 pair can straddle the arrival and show
        // nothing moving on either side of it. 250ms for 6s covers the measured
        // 6218ms worst case, and getStats is a read -- no setParameters here.
        if (moving) {
          for (let t = 250; t <= 6_000; t += 250) {
            setTimeout(() => traceSwitchWindow(`t+${t}`), t)
          }
        }
      }
      // Motion flips degradationPreference ONLY -- a scaleResolutionDownBy write
      // blanked the encoder ~1s per edge, measured (docs/gotchas.md, 2026-08-18).
      if (motionOnRef.current === moving) return
      const sender = pcRef.current?.getSenders().find((s) => s.track?.kind === 'video')
      if (!sender) return
      const p = sender.getParameters()
      if (!p.encodings || p.encodings.length === 0) return
      // Re-stated because a dip re-assert may have overwritten them, and a
      // partial encoding object drops whatever it omits.
      p.encodings[0].scaleResolutionDownBy = 1
      p.encodings[0].maxBitrate = live.maxBitrate
      p.degradationPreference = videoModeOn()
        ? 'maintain-resolution'
        : moving
          ? 'maintain-framerate'
          : 'balanced'
      const want = p.degradationPreference
      motionOnRef.current = moving
      logSetParams('motion', p)
      sender
        .setParameters(p)
        .then(() => {
          // Verify instrument for the degradation-only write (PRD
          // phone-connect-degrades-glasses-mirror): kf must NOT bump on a motion
          // edge and encoded must keep advancing across all three samples.
          const seq = setParamsSeq
          for (const delay of [0, 400, 800]) {
            setTimeout(() => {
              void sender.getStats().then((stats) => {
                stats.forEach((r) => {
                  if (r.type === 'outbound-rtp' && r.kind === 'video') {
                    console.log(
                      `[${stamp()}] [mirror] MOTIONSTATS after#${seq} +${delay}ms ` +
                        `encoded=${r.framesEncoded} kf=${r.keyFramesEncoded} ` +
                        `dims=${r.frameWidth}x${r.frameHeight} limit=${r.qualityLimitationReason}`
                    )
                  }
                })
              })
            }, delay)
          }
          console.log(`[mirror] mac motion=${moving ? 'on' : 'off'} degrade=${want} via=${source}`)
        })
        .catch((err) => {
          // Put it back: the encoder is still on the old preference, and a ref
          // that disagrees would make the next hint a no-op and strand it there.
          motionOnRef.current = !moving
          console.log(`[mirror] mac motion setParameters failed: ${String(err)}`)
        })
    }
    applyMotionScaleRef.current = applyMotionScale

    const unsubMotion = window.api.onWebrtcCaptureMotion((moving, source) =>
      applyMotionScale(moving, source)
    )

    /** Attach the PiP audio encoder to the graph's output track, if there is
     *  one. Called on PiP start AND whenever share-computer-audio builds the
     *  graph later, because the track does not exist until audio is switched
     *  on -- a PiP window opened with audio off must still gain sound when the
     *  user flips it, without restarting the picture. */
    function attachPipAudio(): void {
      const track = audioDestRef.current?.stream.getAudioTracks()[0]
      if (!track) return
      if (!pipAudioRef.current) {
        pipAudioRef.current = new PipAudioEncoder({
          onConfig: (rate, ch) => window.api.webrtcCapturePipAudioConfig(rate, ch),
          onChunk: (bytes) => window.api.webrtcCapturePipAudioChunk(bytes),
          // Never webrtcCapturePipEnded: that tears down the PICTURE, and a
          // dead audio encoder must degrade to a silent mirror, not a black one.
          onError: (reason) => console.log(`[webrtc-capture] pip audio ended: ${reason}`)
        })
      }
      pipAudioRef.current.attach(track)
      console.log('[webrtc-capture] pip audio encoder attached')
    }

    /** `onError` only covers an encoder that dies while RUNNING. A throw from
     *  the constructor or `attach` escapes into the calling handler, aborting
     *  PiP start -- the "no audio AND no PiP" symptom. */
    function attachPipAudioSafely(): void {
      try {
        attachPipAudio()
      } catch (err) {
        console.log(`[webrtc-capture] pip audio attach failed (silent mirror): ${String(err)}`)
      }
    }

    const unsubPipStart = window.api.onWebrtcCapturePipStart(() => {
      const track = streamRef.current?.getVideoTracks()[0]
      if (!track) {
        window.api.webrtcCapturePipEnded('no capture track')
        return
      }
      if (!pipRef.current) {
        pipRef.current = new PipEncoder({
          onConfig: (w, h, fps) => window.api.webrtcCapturePipConfig(w, h, fps),
          onChunk: (bytes) => window.api.webrtcCapturePipChunk(bytes),
          onError: (reason) => window.api.webrtcCapturePipEnded(reason)
        })
      }
      pipRef.current.attach(track)
      console.log('[webrtc-capture] pip encoder attached')
      attachPipAudioSafely()
    })
    const unsubPipStop = window.api.onWebrtcCapturePipStop(() => {
      pipRef.current?.stop()
      pipAudioRef.current?.stop()
      console.log('[webrtc-capture] pip encoder stopped')
    })

    // Tell main this window's listeners are actually registered -- see
    // CHANNELS.webrtcCaptureReady's doc for why did-finish-load alone isn't a
    // safe signal to send webrtcCaptureStart on.
    window.api.webrtcCaptureReady()

    return () => {
      unsubStart()
      unsubPcm()
      unsubIce()
      unsubStop()
      unsubMotion()
      unsubPipStart()
      unsubPipStop()
      teardown()
    }
  }, [])

  return null
}

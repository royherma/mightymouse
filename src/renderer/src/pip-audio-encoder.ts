import { CONFIG } from '../../shared/config'

// Native PiP audio pipe (prds/active/2026-08-09-*-pip-audio-native-transport.md).
// The picture's twin: pip-encoder.ts encodes the display, this encodes the Mac's
// system audio, and both ride one WebSocket so Swift owns playback end to end.
// Until this existed the sound reached the phone as a WebRTC track a WebKit
// <video> played, which no code in Swift could see -- two processes owning one
// session, which is what silenced PiP audio.

// Real in Chromium 140 (this Electron), absent from lib.dom.
declare class MediaStreamTrackProcessor {
  constructor(init: { track: MediaStreamTrack })
  readable: ReadableStream<AudioData>
}

/** AAC-LC. Verified supported in this Electron alongside opus; AAC wins because
 *  AudioToolbox decodes it natively on iOS with no unpacking step. */
const AAC_CODEC = 'mp4a.40.2'

export interface PipAudioEncoderCallbacks {
  onConfig: (sampleRate: number, channels: number) => void
  onChunk: (bytes: ArrayBuffer) => void
  /** Terminal -- no resumption without a fresh attach(). */
  onError: (reason: string) => void
}

export class PipAudioEncoder {
  private encoder: AudioEncoder | null = null
  private reader: ReadableStreamDefaultReader<AudioData> | null = null
  private configSent = false
  private stopped = false
  /** Bumped by stop() and by every attach, so a read loop whose track was
   *  swapped underneath it exits instead of racing the new one. */
  private generation = 0

  constructor(private readonly cb: PipAudioEncoderCallbacks) {}

  get running(): boolean {
    return this.encoder !== null
  }

  /** Safe to call on a LIVE encoder -- the old track's loop is abandoned and the
   *  encoder reused. Share-computer-audio toggling mid-session lands here. */
  attach(track: MediaStreamTrack): void {
    this.stopped = false
    const generation = ++this.generation

    if (!this.encoder) {
      if (typeof AudioEncoder === 'undefined' || typeof MediaStreamTrackProcessor === 'undefined') {
        this.cb.onError('WebCodecs audio unavailable')
        return
      }
      const encoder = new AudioEncoder({
        output: (chunk) => this.emit(chunk),
        error: (err) => this.fail(String(err))
      })
      const sampleRate = CONFIG.PHONE_REMOTE.SYSTEM_AUDIO_SAMPLE_RATE
      const channels = CONFIG.PHONE_REMOTE.SYSTEM_AUDIO_CHANNELS
      try {
        encoder.configure({
          codec: AAC_CODEC,
          sampleRate,
          numberOfChannels: channels,
          bitrate: CONFIG.PHONE_REMOTE.SYSTEM_AUDIO_MAX_BITRATE
        })
      } catch (err) {
        this.cb.onError(`audio encoder configure failed: ${String(err)}`)
        return
      }
      this.encoder = encoder
      this.cb.onConfig(sampleRate, channels)
      this.configSent = true
    }

    void this.pump(track, generation)
  }

  stop(): void {
    this.stopped = true
    this.generation++
    void this.reader?.cancel().catch(() => {})
    this.reader = null
    // close() throws if an error already closed it; same end state either way.
    try {
      this.encoder?.close()
    } catch {
      /* already closed */
    }
    this.encoder = null
    this.configSent = false
  }

  private async pump(track: MediaStreamTrack, generation: number): Promise<void> {
    let reader: ReadableStreamDefaultReader<AudioData>
    try {
      const processor = new MediaStreamTrackProcessor({ track })
      reader = processor.readable.getReader()
    } catch (err) {
      this.fail(`audio track processor failed: ${String(err)}`)
      return
    }
    this.reader = reader

    for (;;) {
      let data: AudioData | undefined
      try {
        const { done, value } = await reader.read()
        if (done) break
        data = value
      } catch {
        break
      }
      // Even a superseded generation must CLOSE its AudioData, for the same
      // reason pip-encoder.ts closes VideoFrames: the pool is finite.
      if (!data) continue
      if (generation !== this.generation || this.stopped || !this.encoder) {
        data.close()
        if (generation !== this.generation) return
        break
      }
      try {
        // No drop-on-backpressure twin to the video path: dropping an audio
        // packet is an audible click, and AAC frames are ~400 bytes against a
        // keyframe's tens of KB, so the queue cannot run away the same way.
        this.encoder.encode(data)
      } catch (err) {
        data.close()
        this.fail(`audio encode failed: ${String(err)}`)
        return
      }
      data.close()
    }

    if (generation === this.generation && !this.stopped) {
      this.fail('audio track ended')
    }
  }

  private emit(chunk: EncodedAudioChunk): void {
    if (this.stopped || !this.configSent) return
    const bytes = new ArrayBuffer(chunk.byteLength)
    chunk.copyTo(new Uint8Array(bytes))
    this.cb.onChunk(bytes)
  }

  private fail(reason: string): void {
    if (this.stopped) return
    this.stop()
    this.cb.onError(reason)
  }
}

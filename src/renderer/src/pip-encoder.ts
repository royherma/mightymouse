import { CONFIG } from '../../shared/config'

// Native PiP video pipe. Must run HERE
// -- reaching these pixels from anywhere else means a second screen capture.

// Real in Chromium 140 (this Electron), absent from lib.dom.
declare class MediaStreamTrackProcessor {
  constructor(init: { track: MediaStreamTrack })
  readable: ReadableStream<VideoFrame>
}

/** Annex-B, so the phone can hand bytes to VTDecompressionSession after a
 *  start-code scan. `avc` length-prefixed would need the extradata out-of-band. */
const H264_FORMAT = 'annexb'

/** Baseline level 4.0. NOT 3.1: its 921600 coded-area cap rejects a 1236x800
 *  mirror outright (padded to 1248x800 = 998400), and configure() throws. */
const H264_CODEC = 'avc1.420028'

/** A phone starting mid-stream shows nothing until a keyframe, so this IS the
 *  worst-case delay before first picture. */
const KEYFRAME_INTERVAL_MS = 1500

export interface PipEncoderCallbacks {
  onConfig: (width: number, height: number, frameRate: number) => void
  onChunk: (bytes: ArrayBuffer) => void
  /** Terminal -- no resumption without a fresh attach(). */
  onError: (reason: string) => void
}

export class PipEncoder {
  private encoder: VideoEncoder | null = null
  private reader: ReadableStreamDefaultReader<VideoFrame> | null = null
  private lastKeyframeAt = 0
  private configSent = false
  private stopped = false
  /** Bumped by stop() and by every attach, so a read loop whose track was
   *  swapped underneath it exits instead of racing the new one. */
  private generation = 0

  constructor(private readonly cb: PipEncoderCallbacks) {}

  get running(): boolean {
    return this.encoder !== null
  }

  /** Safe to call on a LIVE encoder -- the old track's loop is abandoned and the
   *  encoder reused. That is the whole of stall recovery. */
  attach(track: MediaStreamTrack): void {
    this.stopped = false
    const generation = ++this.generation

    if (!this.encoder) {
      if (typeof VideoEncoder === 'undefined' || typeof MediaStreamTrackProcessor === 'undefined') {
        this.cb.onError('WebCodecs unavailable')
        return
      }
      const encoder = new VideoEncoder({
        output: (chunk) => this.emit(chunk),
        error: (err) => this.fail(String(err))
      })
      const settings = track.getSettings()
      const width = settings.width ?? CONFIG.PHONE_REMOTE.MIRROR_CAPPED_WIDTH
      const height = settings.height ?? CONFIG.PHONE_REMOTE.MIRROR_CAPPED_HEIGHT
      // 4:2:0 chroma is subsampled 2x, so configure() rejects odd dimensions.
      const evenWidth = width - (width % 2)
      const evenHeight = height - (height % 2)
      try {
        encoder.configure({
          codec: H264_CODEC,
          width: evenWidth,
          height: evenHeight,
          bitrate: CONFIG.PHONE_REMOTE.MIRROR_MAX_BITRATE_CAPPED,
          framerate: CONFIG.PHONE_REMOTE.MIRROR_CAPPED_FRAME_RATE,
          latencyMode: 'realtime',
          avc: { format: H264_FORMAT }
        })
      } catch (err) {
        this.cb.onError(`encoder configure failed: ${String(err)}`)
        return
      }
      this.encoder = encoder
      this.cb.onConfig(evenWidth, evenHeight, CONFIG.PHONE_REMOTE.MIRROR_CAPPED_FRAME_RATE)
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
    this.lastKeyframeAt = 0
  }

  private async pump(track: MediaStreamTrack, generation: number): Promise<void> {
    let reader: ReadableStreamDefaultReader<VideoFrame>
    try {
      const processor = new MediaStreamTrackProcessor({ track })
      reader = processor.readable.getReader()
    } catch (err) {
      this.fail(`track processor failed: ${String(err)}`)
      return
    }
    this.reader = reader

    for (;;) {
      let frame: VideoFrame | undefined
      try {
        const { done, value } = await reader.read()
        if (done) break
        frame = value
      } catch {
        break
      }
      // Even a superseded generation must CLOSE its frame: VideoFrames hold GPU
      // memory and an exhausted pool presents as "the stream just froze".
      if (!frame) continue
      if (generation !== this.generation || this.stopped || !this.encoder) {
        frame.close()
        if (generation !== this.generation) return
        break
      }
      try {
        const now = performance.now()
        const keyFrame = now - this.lastKeyframeAt >= KEYFRAME_INTERVAL_MS
        if (keyFrame) this.lastKeyframeAt = now
        // Drop, don't queue -- a late frame costs more latency than it's worth.
        if (this.encoder.encodeQueueSize < 2) this.encoder.encode(frame, { keyFrame })
      } catch (err) {
        frame.close()
        this.fail(`encode failed: ${String(err)}`)
        return
      }
      frame.close()
    }

    if (generation === this.generation && !this.stopped) {
      this.fail('capture track ended')
    }
  }

  private emit(chunk: EncodedVideoChunk): void {
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

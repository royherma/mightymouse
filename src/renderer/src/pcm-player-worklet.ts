// pcm-player-worklet.ts — AudioWorkletProcessor that plays raw float32 PCM
// pushed in from the main thread.
//
// Why a worklet at all: the system-audio path delivers
// bytes from a native ScreenCaptureKit subprocess, NOT from a MediaStream.
// WebRTC has no addTrack(rawBytes) — a track can only come from a real audio
// graph node. So we push PCM here, this processor drains it into the graph,
// and a MediaStreamAudioDestinationNode downstream turns the graph output back
// into a MediaStreamTrack that RTCPeerConnection will accept.
//
// This file is loaded with `?url` and added via audioWorklet.addModule(), so it
// runs on the audio thread in its own global scope — it can't import anything
// from the app bundle, which is why the constants below are passed in via
// processorOptions rather than imported from CONFIG.
//
// Ring buffer, not an unbounded queue: audio arriving faster than the render
// quantum drains it (a stalled tab, a slow frame) would otherwise accumulate
// into permanent, growing A/V desync that never recovers. Dropping the OLDEST
// frames keeps playback pinned to now — a brief glitch beats a stream that
// drifts further behind for the rest of the session.

interface PcmPlayerOptions {
  processorOptions?: { channels?: number; maxBufferFrames?: number }
}

class PcmPlayerProcessor extends AudioWorkletProcessor {
  private readonly channels: number
  private readonly capacity: number
  /** One planar Float32Array per channel; interleaved input is split on push
   *  so `process` can copy straight out without per-sample math. */
  private readonly ring: Float32Array[]
  private writeIdx = 0
  private readIdx = 0
  private available = 0

  constructor(options?: PcmPlayerOptions) {
    super()
    this.channels = options?.processorOptions?.channels ?? 2
    this.capacity = options?.processorOptions?.maxBufferFrames ?? 19_200
    this.ring = Array.from({ length: this.channels }, () => new Float32Array(this.capacity))

    this.port.onmessage = (e: MessageEvent): void => {
      const data = e.data as ArrayBuffer | { reset: true }
      if (!(data instanceof ArrayBuffer)) {
        // Reset on renegotiation: stale frames from the previous session would
        // otherwise play as a burst of old audio before the new stream starts.
        this.writeIdx = 0
        this.readIdx = 0
        this.available = 0
        return
      }
      this.push(new Float32Array(data))
    }
  }

  /** De-interleave one chunk into the ring, dropping oldest on overflow. */
  private push(interleaved: Float32Array): void {
    const frames = Math.floor(interleaved.length / this.channels)
    for (let f = 0; f < frames; f++) {
      for (let c = 0; c < this.channels; c++) {
        this.ring[c][this.writeIdx] = interleaved[f * this.channels + c]
      }
      this.writeIdx = (this.writeIdx + 1) % this.capacity
      if (this.available < this.capacity) {
        this.available++
      } else {
        // Full: the write just overwrote the oldest unread frame, so advance
        // the read cursor to stay behind the writer.
        this.readIdx = (this.readIdx + 1) % this.capacity
      }
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]
    if (!out || out.length === 0) return true
    const frames = out[0].length

    for (let f = 0; f < frames; f++) {
      if (this.available === 0) {
        // Underrun: output silence rather than repeating the last frame, which
        // would ring audibly. Brief underruns are normal at stream start.
        for (let c = 0; c < out.length; c++) out[c][f] = 0
        continue
      }
      for (let c = 0; c < out.length; c++) {
        // A mono source feeding a stereo output reuses channel 0 rather than
        // going silent on the right.
        const src = this.ring[Math.min(c, this.channels - 1)]
        out[c][f] = src[this.readIdx]
      }
      this.readIdx = (this.readIdx + 1) % this.capacity
      this.available--
    }

    // Never return false: that permanently ends the processor, and this node
    // must survive quiet stretches between audio chunks.
    return true
  }
}

registerProcessor('pcm-player', PcmPlayerProcessor)

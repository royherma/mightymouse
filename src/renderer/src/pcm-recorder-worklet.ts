// pcm-recorder-worklet.ts — AudioWorkletProcessor that drains the phone's
// inbound mic track out of the audio graph as raw float32 PCM.
//
// The exact inverse of pcm-player-worklet.ts: that one accepts pushed bytes and
// renders them into the graph so WebRTC can send them; this one reads what
// WebRTC received and posts the bytes out, because the destination is a HAL
// device in the main process, not a speaker.
//
// Loaded with `?url` and added via audioWorklet.addModule(), so it runs on the
// audio thread in its own global scope with no access to the app bundle — the
// constants below arrive through processorOptions rather than an import.
//
// Batching, not per-quantum posting: `process` fires every 128 frames (~2.7ms
// at 48k), and one postMessage per quantum would be ~375 IPC hops a second for
// 1KB each. Frames accumulate until BATCH_FRAMES, which trades a few ms of
// latency for an order of magnitude fewer hops.

interface PcmRecorderOptions {
  processorOptions?: { channels?: number; batchFrames?: number }
}

class PcmRecorderProcessor extends AudioWorkletProcessor {
  private readonly channels: number
  private readonly batchFrames: number
  /** Interleaved scratch buffer, flushed and reused so the steady state makes
   *  no garbage on the audio thread. */
  private batch: Float32Array
  private filled = 0

  constructor(options?: PcmRecorderOptions) {
    super()
    this.channels = options?.processorOptions?.channels ?? 1
    this.batchFrames = options?.processorOptions?.batchFrames ?? 480
    this.batch = new Float32Array(this.batchFrames * this.channels)
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0]
    // No input yet (track not flowing) is normal at stream start and between
    // renegotiations -- keep the processor alive and wait.
    if (!input || input.length === 0) return true
    const frames = input[0]?.length ?? 0
    if (frames === 0) return true

    for (let f = 0; f < frames; f++) {
      for (let c = 0; c < this.channels; c++) {
        // A mono track feeding a stereo request reuses channel 0 rather than
        // writing silence to the right, matching the player's behavior.
        const src = input[Math.min(c, input.length - 1)]
        this.batch[this.filled * this.channels + c] = src?.[f] ?? 0
      }
      this.filled++
      if (this.filled === this.batchFrames) this.flush()
    }
    // Never return false: that permanently ends the processor, and this node
    // must survive quiet stretches and a muted track.
    return true
  }

  /** Post the batch as a transferable and start a fresh one. */
  private flush(): void {
    this.port.postMessage(this.batch.buffer, [this.batch.buffer])
    this.batch = new Float32Array(this.batchFrames * this.channels)
    this.filled = 0
  }
}

registerProcessor('pcm-recorder', PcmRecorderProcessor)

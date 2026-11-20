import type { InferenceSession, Tensor } from 'onnxruntime-web'

// openWakeWord's streaming pipeline: 80ms chunks -> melspectrogram -> speech embedding -> wake head.
const CHUNK = 1280
const MEL_CONTEXT = 480
const MEL_BINS = 32
const MEL_WINDOW = 76
const EMBEDDING = 96
const FEATURE_FRAMES = 16
const MAX_QUEUED_CHUNKS = 32
// 2s of audio: enough to rebuild the 76 mel frames and 16 embeddings before the name lands.
const CATCH_UP_CHUNKS = 25
const VOICE_HOLD_MS = 2000
const REFIRE_GAP_MS = 1500

export const WAKE_THRESHOLD = 0.5

export interface WakeOrt {
  InferenceSession: { create(model: Uint8Array): Promise<InferenceSession> }
  Tensor: new (type: 'float32', data: Float32Array, dims: number[]) => Tensor
}

export type WakeModelLoader = (name: string) => Promise<Uint8Array>

export class WakeWordDetector {
  private history = new Float32Array(CHUNK + MEL_CONTEXT)
  private pending = new Float32Array(0)
  private mel = new Float32Array(MEL_WINDOW * MEL_BINS).fill(1)
  private features: Float32Array[] = []
  private queue: Float32Array[] = []
  private backlog: Float32Array[] = []
  private voiceAt = 0
  private running = false
  private lastFiredAt = 0
  private peak = 0
  private inferMs = 0
  private chunks = 0

  private readonly ort: WakeOrt
  private readonly melSession: InferenceSession
  private readonly embedSession: InferenceSession
  private readonly wakeSession: InferenceSession
  private readonly onScore: (score: number, fired: boolean) => void

  private constructor(
    ort: WakeOrt,
    melSession: InferenceSession,
    embedSession: InferenceSession,
    wakeSession: InferenceSession,
    onScore: (score: number, fired: boolean) => void
  ) {
    this.ort = ort
    this.melSession = melSession
    this.embedSession = embedSession
    this.wakeSession = wakeSession
    this.onScore = onScore
  }

  static async create(
    ort: WakeOrt,
    load: WakeModelLoader,
    wakeModel: string,
    onScore: (score: number, fired: boolean) => void
  ): Promise<WakeWordDetector> {
    const [mel, embed, wake] = await Promise.all(
      ['melspectrogram', 'embedding_model', wakeModel].map(async (n) =>
        ort.InferenceSession.create(await load(n))
      )
    )
    return new WakeWordDetector(ort, mel, embed, wake, onScore)
  }

  feed(samples: Float32Array, voiced = true): void {
    if (voiced) this.voiceAt = Date.now()
    const joined = new Float32Array(this.pending.length + samples.length)
    joined.set(this.pending)
    joined.set(samples, this.pending.length)
    let at = 0
    for (; at + CHUNK <= joined.length; at += CHUNK) this.backlog.push(joined.slice(at, at + CHUNK))
    this.pending = joined.slice(at)
    if (Date.now() - this.voiceAt > VOICE_HOLD_MS) {
      if (this.backlog.length > CATCH_UP_CHUNKS) this.backlog.splice(0, this.backlog.length - CATCH_UP_CHUNKS)
      return
    }
    this.queue.push(...this.backlog)
    this.backlog = []
    // Inference fell behind (tab throttled, CPU pegged): drop old audio rather than lag forever.
    if (this.queue.length > MAX_QUEUED_CHUNKS)
      this.queue.splice(0, this.queue.length - MAX_QUEUED_CHUNKS)
    if (!this.running) void this.drain()
  }

  async process(chunk: Float32Array): Promise<number | null> {
    const started = performance.now()
    this.history.copyWithin(0, CHUNK)
    // openWakeWord's models expect int16-scaled samples, not [-1, 1] floats.
    for (let i = 0; i < CHUNK; i++) this.history[MEL_CONTEXT + i] = chunk[i] * 32767

    const melOut = await this.melSession.run({
      [this.melSession.inputNames[0]]: new this.ort.Tensor('float32', this.history, [
        1,
        this.history.length
      ])
    })
    const spec = melOut[this.melSession.outputNames[0]].data as Float32Array
    const frames = spec.length / MEL_BINS
    const next = new Float32Array(MEL_WINDOW * MEL_BINS)
    next.set(this.mel.subarray(frames * MEL_BINS))
    for (let i = 0; i < spec.length; i++)
      next[(MEL_WINDOW - frames) * MEL_BINS + i] = spec[i] / 10 + 2
    this.mel = next

    const embedOut = await this.embedSession.run({
      [this.embedSession.inputNames[0]]: new this.ort.Tensor('float32', this.mel, [
        1,
        MEL_WINDOW,
        MEL_BINS,
        1
      ])
    })
    this.features.push(
      Float32Array.from(embedOut[this.embedSession.outputNames[0]].data as Float32Array)
    )
    if (this.features.length > FEATURE_FRAMES) this.features.shift()
    this.chunks += 1
    if (this.features.length < FEATURE_FRAMES) {
      this.inferMs += performance.now() - started
      return null
    }

    const stacked = new Float32Array(FEATURE_FRAMES * EMBEDDING)
    this.features.forEach((f, i) => stacked.set(f, i * EMBEDDING))
    const wakeOut = await this.wakeSession.run({
      [this.wakeSession.inputNames[0]]: new this.ort.Tensor('float32', stacked, [
        1,
        FEATURE_FRAMES,
        EMBEDDING
      ])
    })
    const score = (wakeOut[this.wakeSession.outputNames[0]].data as Float32Array)[0]
    this.peak = Math.max(this.peak, score)
    this.inferMs += performance.now() - started
    const now = Date.now()
    const fired = score >= WAKE_THRESHOLD && now - this.lastFiredAt > REFIRE_GAP_MS
    if (fired) this.lastFiredAt = now
    this.onScore(score, fired)
    return score
  }

  takePeak(): number {
    const peak = this.peak
    this.peak = 0
    return peak
  }

  takeLoad(): { chunks: number; msPerChunk: number } {
    const load = { chunks: this.chunks, msPerChunk: this.chunks ? this.inferMs / this.chunks : 0 }
    this.chunks = 0
    this.inferMs = 0
    return load
  }

  private async drain(): Promise<void> {
    this.running = true
    try {
      while (this.queue.length) await this.process(this.queue.shift()!)
    } finally {
      this.running = false
    }
  }

  async release(): Promise<void> {
    this.queue = []
    this.backlog = []
    await Promise.all(
      [this.melSession, this.embedSession, this.wakeSession].map((s) => s.release())
    )
  }
}

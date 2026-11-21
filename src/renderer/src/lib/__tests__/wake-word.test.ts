import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WakeWordDetector, WAKE_THRESHOLD, type WakeOrt } from '../wake-word'

const CHUNK = 1280
const MEL_FRAMES_PER_CHUNK = 8

function fakeOrt(scores: number[]) {
  const runs = { mel: 0, embed: 0, wake: 0 }
  const session = (name: keyof typeof runs, out: () => Float32Array) => ({
    inputNames: ['in'],
    outputNames: ['out'],
    run: async () => {
      runs[name] += 1
      return { out: { data: out() } }
    },
    release: async () => {}
  })
  const sessions = {
    melspectrogram: session('mel', () => new Float32Array(MEL_FRAMES_PER_CHUNK * 32)),
    embedding_model: session('embed', () => new Float32Array(96)),
    hey_mighty: session('wake', () => Float32Array.of(scores.shift() ?? 0))
  }
  const ort = {
    InferenceSession: { create: async (model: Uint8Array) => sessions[new TextDecoder().decode(model) as keyof typeof sessions] },
    Tensor: class {
      constructor(
        readonly type: string,
        readonly data: Float32Array,
        readonly dims: number[]
      ) {}
    }
  } as unknown as WakeOrt
  return { ort, runs }
}

async function detector(scores: number[] = []) {
  const { ort, runs } = fakeOrt(scores)
  const fired: number[] = []
  const d = await WakeWordDetector.create(ort, async (n) => new TextEncoder().encode(n), 'hey_mighty', (score, f) => {
    if (f) fired.push(score)
  })
  return { d, runs, fired }
}

const chunks = (n: number) => new Float32Array(n * CHUNK)
const settle = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(1_000_000)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('WakeWordDetector sleeps while nobody is talking', () => {
  it('runs no model on silence', async () => {
    const { d, runs } = await detector()
    for (let i = 0; i < 40; i++) d.feed(chunks(1), false)
    await settle()
    expect(runs.mel).toBe(0)
  })

  it('when speech starts it replays only the last 2s of the silence before it, plus the new audio', async () => {
    const { d, runs } = await detector()
    for (let i = 0; i < 40; i++) d.feed(chunks(1), false)
    d.feed(chunks(1), true)
    await settle()
    expect(runs.mel).toBe(25 + 1)
  })

  it('keeps listening for 2s after the voice stops, then sleeps again', async () => {
    const { d, runs } = await detector()
    d.feed(chunks(1), true)
    await settle()
    vi.setSystemTime(Date.now() + 1900)
    d.feed(chunks(1), false)
    await settle()
    expect(runs.mel).toBe(2)
    vi.setSystemTime(Date.now() + 200)
    d.feed(chunks(1), false)
    await settle()
    expect(runs.mel).toBe(2)
  })

  it('a feed shorter than a chunk waits for the rest before it runs', async () => {
    const { d, runs } = await detector()
    d.feed(new Float32Array(CHUNK - 100), true)
    await settle()
    expect(runs.mel).toBe(0)
    d.feed(new Float32Array(100), true)
    await settle()
    expect(runs.mel).toBe(1)
  })

  it('drops the oldest audio when inference falls behind, never more than 32 chunks queued', async () => {
    const { d, runs } = await detector()
    d.feed(chunks(50), true)
    await settle()
    expect(runs.mel).toBe(32)
  })
})

describe('WakeWordDetector scoring', () => {
  it('waits for 16 embeddings before asking the wake model', async () => {
    const { d, runs } = await detector()
    d.feed(chunks(15), true)
    await settle()
    expect(runs.wake).toBe(0)
    d.feed(chunks(1), true)
    await settle()
    expect(runs.wake).toBe(1)
  })

  it('fires at the threshold, not again within 1.5s, and again after', async () => {
    const { d, fired } = await detector([WAKE_THRESHOLD, 0.9, 0.9])
    d.feed(chunks(16), true)
    await settle()
    vi.setSystemTime(Date.now() + 1000)
    d.feed(chunks(1), true)
    await settle()
    vi.setSystemTime(Date.now() + 600)
    d.feed(chunks(1), true)
    await settle()
    expect(fired).toEqual([WAKE_THRESHOLD, Math.fround(0.9)])
  })

  it('takePeak reports the highest score since the last read, then resets', async () => {
    const { d } = await detector([0.2, 0.4, 0.1])
    d.feed(chunks(18), true)
    await settle()
    expect(d.takePeak()).toBeCloseTo(0.4)
    expect(d.takePeak()).toBe(0)
  })
})

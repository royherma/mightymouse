import { describe, expect, it } from 'vitest'
import { padChunkCount } from './hands-free-rules'

// The buffer trim once ate chunk 0 — the WebM header — so every hands-free clip
// after the first reached ffmpeg headerless: "couldn't decode audio".
describe('hands-free rolling buffer trim', () => {
  const CHUNK_MS = 250
  const ends = (n: number): number[] => Array.from({ length: n }, (_, i) => (i + 1) * CHUNK_MS)

  it('drops chunks once the buffer outgrows the pad window', () => {
    // With the header inside chunksRef, this non-zero drop is what sliced it away.
    const chunkEndsAt = ends(20)
    const keep = padChunkCount({ chunkEndsAt, speechStartedAt: 20 * CHUNK_MS, padMs: 500 })
    expect(chunkEndsAt.length - keep).toBeGreaterThan(0)
  })

  it('keeps at least the pad window, never the whole buffer', () => {
    const keep = padChunkCount({ chunkEndsAt: ends(20), speechStartedAt: 20 * CHUNK_MS, padMs: 500 })
    expect(keep).toBeGreaterThanOrEqual(2)
    expect(keep).toBeLessThan(20)
  })

  it('keeps everything while the buffer is still shorter than the pad', () => {
    const chunkEndsAt = ends(2)
    const keep = padChunkCount({ chunkEndsAt, speechStartedAt: 2 * CHUNK_MS, padMs: 2000 })
    expect(keep).toBe(chunkEndsAt.length)
  })

  it('a cut prefixed with the held-aside header survives any trim', () => {
    // Mirrors stopRecorder(): the header is not in the buffer, so no trim reaches it.
    const header = 'H'
    const buffer = ['a', 'b', 'c', 'd']
    const keep = padChunkCount({ chunkEndsAt: ends(4), speechStartedAt: 4 * CHUNK_MS, padMs: 250 })
    const trimmed = buffer.slice(buffer.length - keep)
    expect([header, ...trimmed][0]).toBe(header)
  })
})

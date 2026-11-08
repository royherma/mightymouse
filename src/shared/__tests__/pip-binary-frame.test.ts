import { describe, it, expect } from 'vitest'
import { PIP_BINARY_KIND, readPipBinary } from '../phone-remote-keys'

/** The Mac's half of the contract (server.ts sendBinaryToPhone). Duplicated
 *  deliberately: if the real sender changes shape, this fails and says so,
 *  which is the whole point of a wire test. */
function tag(kind: number, payload: number[]): ArrayBuffer {
  const out = new Uint8Array(payload.length + 1)
  out[0] = kind
  out.set(payload, 1)
  return out.buffer
}

describe('pip binary frame tagging', () => {
  it('round-trips a video frame back to the exact payload bytes', () => {
    const frame = readPipBinary(tag(PIP_BINARY_KIND.video, [0x00, 0x00, 0x01, 0x65]))
    expect(frame?.kind).toBe(PIP_BINARY_KIND.video)
    expect(Array.from(frame!.payload)).toEqual([0x00, 0x00, 0x01, 0x65])
  })

  it('keeps audio and video distinguishable on the one socket', () => {
    const audio = readPipBinary(tag(PIP_BINARY_KIND.audio, [0xff]))
    expect(audio?.kind).toBe(PIP_BINARY_KIND.audio)
    expect(PIP_BINARY_KIND.audio).not.toBe(PIP_BINARY_KIND.video)
  })

  // An untagged frame from an older Mac starts with H.264's 0x00 start code,
  // so "unknown kind" is the realistic case, not a hypothetical one.
  it('drops an unknown kind rather than passing it to a decoder', () => {
    expect(readPipBinary(tag(0x00, [0x00, 0x01]))).toBeNull()
    expect(readPipBinary(tag(0x7f, [0x01]))).toBeNull()
  })

  it('drops a frame too short to hold a kind and a payload', () => {
    expect(readPipBinary(new ArrayBuffer(0))).toBeNull()
    expect(readPipBinary(new ArrayBuffer(1))).toBeNull()
  })
})

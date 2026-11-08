import { describe, expect, it } from 'vitest'
import {
  MIRROR_PREFERRED_CODEC,
  MIRROR_PREFERRED_CODEC,
  mungeGlassesBitrate,
  preferCodecOrder,
  qualityForHost
} from './mirror-quality'

describe('qualityForHost', () => {
  it('leaves a phone on whatever the user picked', () => {
    expect(qualityForHost('capped', false)).toBe('capped')
    expect(qualityForHost('native', false)).toBe('native')
  })

  it('overrides the picker on a cursorless host', () => {
    expect(qualityForHost('capped', true)).toBe('glasses')
  })

  it("overrides 'native' too -- a 600px panel must never be sent 1280x800", () => {
    // The regression this guards: Settings IS reachable on the glasses (the
    // deck is swipe-navigable), so a user can pick native there.
    expect(qualityForHost('native', true)).toBe('glasses')
  })
})

describe('preferCodecOrder', () => {
  const c = (mimeType: string): { mimeType: string } => ({ mimeType })

  it('ships VP9 as the glasses default', () => {
    // Not a tautology: the default is the whole A/B, so a silent revert to
    // H.264 has to fail here rather than only show up in a bench window.
    expect(MIRROR_PREFERRED_CODEC).toBe('video/VP9')
  })

  it('moves the preferred codec to the front', () => {
    const out = preferCodecOrder([c('video/VP8'), c('video/H264'), c('video/VP9')])
    expect(out.map((x) => x.mimeType)).toEqual(['video/VP9', 'video/VP8', 'video/H264'])
  })

  it('keeps every codec -- dropping one would fail negotiation, not just quality', () => {
    const input = [c('video/VP8'), c('video/H264'), c('video/VP9'), c('video/AV1')]
    expect(preferCodecOrder(input)).toHaveLength(input.length)
  })

  it('preserves relative order of the non-preferred codecs', () => {
    const out = preferCodecOrder([c('video/H264'), c('video/VP9'), c('video/VP8')])
    expect(out.map((x) => x.mimeType)).toEqual(['video/VP9', 'video/H264', 'video/VP8'])
  })

  it('promotes every matching profile, not just the first', () => {
    const out = preferCodecOrder([c('video/VP8'), c('video/VP9'), c('video/VP9')])
    expect(out.slice(0, 2).map((x) => x.mimeType)).toEqual(['video/VP9', 'video/VP9'])
  })

  it('matches case-insensitively -- browsers report video/VP9 and video/vp9', () => {
    const out = preferCodecOrder([c('video/VP8'), c('video/vp9')])
    expect(out[0].mimeType).toBe('video/vp9')
  })

  it('returns the list unchanged when the preferred codec is absent', () => {
    const out = preferCodecOrder([c('video/VP8'), c('video/H264')])
    expect(out.map((x) => x.mimeType)).toEqual(['video/VP8', 'video/H264'])
  })

  it('still orders H.264 first when asked -- the revert path must keep working', () => {
    const out = preferCodecOrder([c('video/VP8'), c('video/H264')], 'video/H264')
    expect(out.map((x) => x.mimeType)).toEqual(['video/H264', 'video/VP8'])
  })
})

describe('mungeGlassesBitrate', () => {
  const sdp = (...lines: string[]): string => lines.join('\r\n')

  it('appends both hints to the preferred codec fmtp line', () => {
    const out = mungeGlassesBitrate(sdp('a=rtpmap:98 VP9/90000', 'a=fmtp:98 profile-id=0', ''))
    expect(out).toContain('profile-id=0;x-google-min-bitrate=800')
    expect(out).toContain('x-google-start-bitrate=1200')
  })

  it('leaves another codec fmtp line alone', () => {
    const out = mungeGlassesBitrate(
      sdp('a=rtpmap:98 VP9/90000', 'a=rtpmap:96 H264/90000', 'a=fmtp:96 packetization-mode=1', '')
    )
    expect(out).toContain('a=fmtp:96 packetization-mode=1')
    expect(out).not.toContain('packetization-mode=1;x-google')
  })

  it('adds an fmtp line for a preferred payload that has none', () => {
    const out = mungeGlassesBitrate(sdp('a=rtpmap:98 VP9/90000', ''))
    expect(out).toContain('a=fmtp:98 x-google-min-bitrate=800;x-google-start-bitrate=1200')
  })

  // A malformed answer fails negotiation outright, so no-match must be a no-op
  // rather than a best-effort edit.
  it('returns the sdp unchanged when the preferred codec has no payload', () => {
    const input = sdp('a=rtpmap:96 H264/90000', 'a=fmtp:96 packetization-mode=1', '')
    expect(mungeGlassesBitrate(input)).toBe(input)
  })

  // The regression that made this whole function inert: it hardcoded H264
  // payloads while setCodecPreferences negotiated something else, so the hints
  // were written onto a codec nothing was encoding with. Neither half was
  // wrong on its own, which is why a green suite kept shipping a dead knob.
  it('targets whatever codec the glasses actually negotiate', () => {
    const name = MIRROR_PREFERRED_CODEC.replace(/^.*\//, '')
    const out = mungeGlassesBitrate(sdp(`a=rtpmap:99 ${name}/90000`, ''))
    expect(out).toContain('a=fmtp:99 x-google-min-bitrate=800')
  })

  it('is idempotent', () => {
    const once = mungeGlassesBitrate(sdp('a=rtpmap:98 VP9/90000', 'a=fmtp:98 profile-id=0', ''))
    expect(mungeGlassesBitrate(once)).toBe(once)
  })

  it('preserves CRLF line endings', () => {
    const out = mungeGlassesBitrate(sdp('a=rtpmap:98 VP9/90000', 'a=fmtp:98 profile-id=0', ''))
    expect(out).toContain('\r\n')
    expect(out).not.toMatch(/[^\r]\n/)
  })
})

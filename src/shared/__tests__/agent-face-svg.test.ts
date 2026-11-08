import { describe, expect, it } from 'vitest'
import { AGENT_FACE_COLORS, AGENT_SHAPES, avatarFor } from '../agent-face'
import { agentFaceSvg, faceColorLiteral } from '../agent-face-svg'

/** Ids chosen so the set covers every shape -- `avatarFor` hashes, so this is
 *  found by probing, not by construction. */
function idsCoveringEveryShape(): string[] {
  const seen = new Map<string, string>()
  for (let i = 0; i < 500 && seen.size < AGENT_SHAPES.length; i++) {
    const id = `probe-${i}`
    const { shape } = avatarFor(id)
    if (!seen.has(shape)) seen.set(shape, id)
  }
  return [...seen.values()]
}

describe('agentFaceSvg', () => {
  it('never emits rgba(), which SVG 1.1 drops silently', () => {
    // The bug this locks: `THEME_TOKENS` is all `rgba()`, and `sips` responds to
    // an invalid fill by painting nothing rather than failing -- so the face
    // rasterized as two white bars on transparency and looked like a blank icon.
    for (const color of AGENT_FACE_COLORS) {
      expect(faceColorLiteral(color)).not.toContain('rgba')
    }
    for (const id of idsCoveringEveryShape()) {
      expect(agentFaceSvg(id)).not.toContain('rgba')
    }
  })

  it('resolves every palette token to a literal colour', () => {
    for (const color of AGENT_FACE_COLORS) {
      expect(faceColorLiteral(color)).toMatch(/^rgb\(/)
    }
  })

  it('draws a filled shape plus both eyes for every shape', () => {
    for (const id of idsCoveringEveryShape()) {
      const svg = agentFaceSvg(id)
      expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
      expect(svg).toContain('fill="rgb(')
      expect(svg.match(/fill="white"/g)).toHaveLength(2)
    }
  })

  it('is stable for one id and size', () => {
    expect(agentFaceSvg('sess-a', 128)).toBe(agentFaceSvg('sess-a', 128))
    expect(agentFaceSvg('sess-a', 128)).toContain('width="128"')
  })
})

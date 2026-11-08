import { describe, expect, it } from 'vitest'
import { stripFancyDashes } from '../fast-rewrite'

// The prompt bans em/en dashes, but the model ignored that once already: asked
// for no em dash it returned U+2013 instead. These lock the code-side guarantee.
describe('stripFancyDashes', () => {
  it('replaces the en dashes the model actually returned', () => {
    expect(stripFancyDashes('mislabeling real content – photos, videos – as AI-generated.')).toBe(
      'mislabeling real content, photos, videos, as AI-generated.'
    )
  })

  it('replaces em dashes used as an aside', () => {
    expect(stripFancyDashes('It shipped Tuesday — finally — after three delays.')).toBe(
      'It shipped Tuesday, finally, after three delays.'
    )
  })

  it('leaves a compound hyphen alone', () => {
    const s = 'Keep the AI-generated hyphen and the well-known compound intact.'
    expect(stripFancyDashes(s)).toBe(s)
  })

  it('catches a dash hugging one side only', () => {
    expect(stripFancyDashes('real content– photos')).toBe('real content, photos')
  })

  it('normalises a spaced ASCII dash used as a pause', () => {
    expect(stripFancyDashes('a - b -- c')).toBe('a, b, c')
  })
})

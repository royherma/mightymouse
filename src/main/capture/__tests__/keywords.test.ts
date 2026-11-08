import { describe, it, expect } from 'vitest'
import { extractKeywords } from '../keywords'

describe('extractKeywords (RAKE)', () => {
  it('returns [] for empty / whitespace input', () => {
    expect(extractKeywords('')).toEqual([])
    expect(extractKeywords('   \n  ')).toEqual([])
  })

  it('drops stopwords and keeps content phrases', () => {
    const tags = extractKeywords('I would like to open the project settings panel')
    // Stopwords (i, would, to, the) must not appear as standalone tags.
    for (const stop of ['i', 'would', 'to', 'the']) {
      expect(tags).not.toContain(stop)
    }
    expect(tags.some((t) => t.includes('project settings panel') || t.includes('settings'))).toBe(true)
  })

  it('ranks multi-word phrases above isolated common words', () => {
    const text =
      'machine learning pipeline. the machine learning pipeline runs nightly. monitor the machine learning pipeline.'
    const tags = extractKeywords(text, 5)
    expect(tags[0]).toBe('machine learning pipeline')
  })

  it('caps phrase length so sentences do not become tags', () => {
    const tags = extractKeywords('alpha beta gamma delta epsilon zeta eta theta', 8)
    // No tag should exceed 4 words (MAX_PHRASE_WORDS).
    for (const t of tags) expect(t.split(' ').length).toBeLessThanOrEqual(4)
  })

  it('respects the limit', () => {
    const text = 'apple. banana. cherry. date. elderberry. fig. grape. honeydew. kiwi.'
    expect(extractKeywords(text, 3)).toHaveLength(3)
  })

  it('de-duplicates repeated phrases', () => {
    const tags = extractKeywords('budget report. budget report. budget report.')
    expect(tags).toEqual(['budget report'])
  })

  it('is lowercase and ignores punctuation', () => {
    const tags = extractKeywords('Quarterly Revenue Forecast!!!')
    expect(tags).toContain('quarterly revenue forecast')
  })
})

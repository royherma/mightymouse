import { describe, it, expect } from 'vitest'
import { levenshtein, editRatio, classifyEdit } from '../edit-distance'

describe('levenshtein', () => {
  it('is 0 for identical strings', () => {
    expect(levenshtein('hello', 'hello')).toBe(0)
  })

  it('equals the other length when one side is empty', () => {
    expect(levenshtein('', 'abc')).toBe(3)
    expect(levenshtein('abc', '')).toBe(3)
  })

  it('counts single-char edits', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3) // classic example
    expect(levenshtein('cat', 'cot')).toBe(1)
  })
})

describe('editRatio', () => {
  it('is 0 for identical, 0 for both empty', () => {
    expect(editRatio('same', 'same')).toBe(0)
    expect(editRatio('', '')).toBe(0)
  })

  it('is 1 for fully disjoint same-length strings', () => {
    expect(editRatio('abcd', 'wxyz')).toBe(1)
  })

  it('normalizes by the longer side', () => {
    // 1 edit over a 4-char max = 0.25
    expect(editRatio('abcd', 'abce')).toBeCloseTo(0.25, 5)
  })
})

describe('classifyEdit', () => {
  it('unchanged when exactly equal', () => {
    expect(classifyEdit('ship it', 'ship it')).toBe('unchanged')
  })

  it('edited for a small tweak (below the rewrite ratio)', () => {
    // one char changed in a long body — tiny ratio
    const draft = 'Thanks so much for reaching out, I will get back to you today.'
    const final = 'Thanks so much for reaching out, I will get back to you tomorrow.'
    expect(classifyEdit(draft, final)).toBe('edited')
  })

  it('rewritten when most of the body changes', () => {
    expect(classifyEdit('lets grab coffee thursday', 'no thanks, not interested')).toBe(
      'rewritten'
    )
  })

  it('treats an empty final against a real draft as rewritten', () => {
    expect(classifyEdit('a real draft body here', '')).toBe('rewritten')
  })
})

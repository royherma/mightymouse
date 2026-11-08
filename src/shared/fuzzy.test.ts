import { describe, it, expect } from 'vitest'
import { fuzzyMatch, fuzzyMatches, buildSnippet, MATCH_SCORE } from './fuzzy'

describe('fuzzyMatch', () => {
  it('finds an exact substring', () => {
    expect(fuzzyMatches('give me the gist', 'gist')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(fuzzyMatches('Gist of the roadmap', 'gist')).toBe(true)
    expect(fuzzyMatches('give me the GIST', 'gist')).toBe(true)
  })

  it('tolerates a transposition', () => {
    expect(fuzzyMatches('give me the gist', 'gsit')).toBe(true)
  })

  it('tolerates a missing, extra, or wrong letter', () => {
    expect(fuzzyMatches('give me the gist', 'gst')).toBe(true)
    expect(fuzzyMatches('give me the gist', 'giist')).toBe(true)
    expect(fuzzyMatches('give me the gist', 'gost')).toBe(true)
  })

  it('does NOT match scattered letters across words', () => {
    // The whole point of word-anchoring: fzf-style subsequence matching would
    // let these through and drown the sidebar in noise.
    expect(fuzzyMatches('go sit down', 'gsit')).toBe(false)
    expect(fuzzyMatches('getting started with it', 'gsit')).toBe(false)
  })

  it('does not match an unrelated word', () => {
    expect(fuzzyMatches('what time is it', 'gist')).toBe(false)
  })

  it('ranks an exact hit above a typo hit', () => {
    const exact = fuzzyMatch('the gist of it', 'gist').score
    const typo = fuzzyMatch('the gist of it', 'gsit').score
    expect(exact).toBeGreaterThan(typo)
  })

  it('ranks a word-start hit above a mid-word hit', () => {
    const prefix = fuzzyMatch('gist of the roadmap', 'gist').score
    const mid = fuzzyMatch('the elongated word', 'longat').score
    expect(prefix).toBe(MATCH_SCORE.exactPrefix)
    expect(mid).toBe(MATCH_SCORE.exactSubstring)
    expect(prefix).toBeGreaterThan(mid)
  })

  it('reports where the match starts and how long it is', () => {
    const m = fuzzyMatch('give me the gist', 'gist')
    expect(m.index).toBe(12)
    expect(m.length).toBe(4)
  })

  it('ignores trailing punctuation when fuzzing a word', () => {
    expect(fuzzyMatches('give me the gist, please', 'gsit')).toBe(true)
  })

  it('requires short queries to be exact', () => {
    // 2 edits on a 3-char word would match nearly anything.
    expect(fuzzyMatches('the cat sat', 'cat')).toBe(true)
    expect(fuzzyMatches('the cat sat', 'dog')).toBe(false)
  })

  it('does not let a short word match a different short word', () => {
    // Two 3-char words are nearly always within 2 edits, so fuzzing them would
    // turn every filler word in a message body into a hit.
    expect(fuzzyMatches('the cat sat', 'xyz')).toBe(false)
    expect(fuzzyMatches('what time is it', 'gist')).toBe(false)
    expect(fuzzyMatches('the dog ran', 'cat')).toBe(false)
  })

  it('requires the first letter to match when fuzzing', () => {
    // A typo rarely lands on a word's first letter, and this is what keeps
    // "gsit" off "sit" while still finding "gist".
    expect(fuzzyMatches('go sit down', 'gsit')).toBe(false)
    expect(fuzzyMatches('give me the gist', 'gsit')).toBe(true)
  })

  it('handles a multi-word query as a verbatim search only', () => {
    expect(fuzzyMatches('give me the gist of it', 'the gist')).toBe(true)
    expect(fuzzyMatches('give me the gist of it', 'teh gist')).toBe(false)
  })

  it('returns no match for empty input', () => {
    expect(fuzzyMatch('', 'gist').score).toBe(MATCH_SCORE.none)
    expect(fuzzyMatch('gist', '').score).toBe(MATCH_SCORE.none)
  })

  it('does not match on a length gap alone', () => {
    expect(fuzzyMatches('a', 'gist')).toBe(false)
    expect(fuzzyMatches('gist', 'gistttttt')).toBe(false)
  })
})

describe('buildSnippet', () => {
  it('collapses newlines into one line', () => {
    const src = 'first line\n\nthe gist is here\n\nlast line'
    const snip = buildSnippet(src, fuzzyMatch(src, 'gist'))
    expect(snip.text).not.toContain('\n')
    expect(snip.text).toContain('the gist is here')
  })

  it('ellipses a long body around the match', () => {
    const src = `${'x'.repeat(200)} gist ${'y'.repeat(200)}`
    const snip = buildSnippet(src, fuzzyMatch(src, 'gist'))
    expect(snip.text.startsWith('…')).toBe(true)
    expect(snip.text.endsWith('…')).toBe(true)
    expect(snip.text).toContain('gist')
  })

  it('does not ellipse a short body', () => {
    const src = 'the gist'
    const snip = buildSnippet(src, fuzzyMatch(src, 'gist'))
    expect(snip.text).toBe('the gist')
  })

  it('points at the match within the snippet, not the source', () => {
    const src = `${'x'.repeat(200)} gist tail`
    const snip = buildSnippet(src, fuzzyMatch(src, 'gist'))
    expect(snip.text.slice(snip.index, snip.index + snip.length)).toBe('gist')
  })

  it('points at the match after whitespace collapsing shifts it', () => {
    const src = 'lots   of    space\n\n\nbefore the gist here'
    const snip = buildSnippet(src, fuzzyMatch(src, 'gist'))
    expect(snip.text.slice(snip.index, snip.index + snip.length)).toBe('gist')
  })
})

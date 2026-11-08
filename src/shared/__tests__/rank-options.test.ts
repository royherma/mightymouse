/**
 * Which on-screen control the executor presses. rankOptions feeds decide.ts,
 * so a wrong winner here is a click on the wrong button -- the failure mode the
 * duplicate-label guard exists to stop. The scoring branches worth pinning are
 * the ones the comments in the module name as past bugs: coverage beating raw
 * hit count, habit added rather than multiplied, and typed prefixes reaching a
 * label that whole-word overlap scores zero.
 */

import { describe, it, expect } from 'vitest'
import {
  words,
  normalizeLabel,
  overlapScore,
  filterOptions,
  rankOptions
} from '../rank-options'

const opt = (value: string, label: string) => ({ value, label })

describe('words', () => {
  it('drops stopwords, punctuation and one-character tokens', () => {
    expect(words('Bookmark this tab!')).toEqual(['bookmark', 'tab'])
    expect(words('Can I go to the Settings page')).toEqual(['settings', 'page'])
  })

  it('returns nothing when the text is all stopwords', () => {
    expect(words('can you please do it')).toEqual([])
  })
})

describe('normalizeLabel', () => {
  it('collapses the newline Chrome puts in extension labels', () => {
    expect(normalizeLabel('LastPass\nHas access to this site')).toBe(
      'LastPass Has access to this site'
    )
  })
})

describe('overlapScore', () => {
  it('scores zero when no word is shared', () => {
    expect(overlapScore(words('open settings'), 'Delete account')).toBe(0)
  })

  it('scores zero for a label with no scorable words', () => {
    expect(overlapScore(words('open the'), 'the a')).toBe(0)
  })

  it('ranks a fully covered short label above a long one with the same hit count', () => {
    // The named regression: a 20-word page title sharing one word outscored the
    // 3-word button the user actually meant.
    const said = words('bookmark this post')
    const button = overlapScore(said, 'Bookmark post')
    const headline = overlapScore(
      said,
      'Bookmark your favourite reading material and revisit every saved post later today'
    )
    expect(button).toBeGreaterThan(headline)
  })

  it('pays both a per-hit and a coverage component', () => {
    // 2 hits over 2 label words: 2*20 + (2/2)*100.
    expect(overlapScore(words('bookmark post'), 'Bookmark post')).toBe(140)
    // 1 hit over 2 label words: 1*20 + (1/2)*100.
    expect(overlapScore(words('bookmark'), 'Bookmark post')).toBe(70)
  })
})

describe('rankOptions', () => {
  it('puts the spoken match first', () => {
    const options = [opt('a', 'Delete account'), opt('b', 'Bookmark post'), opt('c', 'Share link')]
    expect(rankOptions(options, 'bookmark the post', 3).map((o) => o.value)).toEqual([
      'b',
      'a',
      'c'
    ])
  })

  it('keeps source order among equal scores', () => {
    const options = [opt('a', 'Alpha'), opt('b', 'Beta'), opt('c', 'Gamma')]
    expect(rankOptions(options, 'nothing matches', 3).map((o) => o.value)).toEqual(['a', 'b', 'c'])
  })

  it('drops every copy of an unscored duplicate label', () => {
    // Delete the guard and one of these reaches the executor, which presses an
    // arbitrary match -- the whole reason the guard exists.
    const options = [opt('a', 'Open'), opt('b', 'Open'), opt('c', 'Bookmark post')]
    expect(rankOptions(options, 'bookmark post', 5).map((o) => o.value)).toEqual(['c'])
  })

  it('keeps a duplicate label once it actually scores', () => {
    const options = [opt('a', 'Open'), opt('b', 'Open')]
    const ranked = rankOptions(options, 'open', 5)
    expect(ranked).toHaveLength(1)
    expect(ranked[0].value).toBe('a')
  })

  it('treats labels differing only in whitespace as the same duplicate', () => {
    const options = [opt('a', 'Open\nnow'), opt('b', 'Open now'), opt('c', 'Bookmark')]
    expect(rankOptions(options, 'bookmark', 5).map((o) => o.value)).toEqual(['c'])
  })

  it('respects the limit', () => {
    const options = [opt('a', 'Alpha'), opt('b', 'Beta'), opt('c', 'Gamma')]
    expect(rankOptions(options, '', 2)).toHaveLength(2)
  })

  it('lets a learned favourite climb over an unmentioned option', () => {
    // Added, not multiplied: a value the transcript never mentions scores 0, and
    // any multiplier on 0 leaves it at 0.
    const options = [opt('a', 'Alpha'), opt('b', 'Beta')]
    const boost = (value: string) => (value === 'b' ? 3 : 1)
    expect(rankOptions(options, 'nothing matches', 2, boost).map((o) => o.value)).toEqual([
      'b',
      'a'
    ])
  })

  it('does not let a habit boost override a strong spoken match', () => {
    const options = [opt('a', 'Bookmark post'), opt('b', 'Beta')]
    const boost = (value: string) => (value === 'b' ? 3 : 1)
    expect(rankOptions(options, 'bookmark post', 2, boost)[0].value).toBe('a')
  })

  it('scores everything zero when the transcript has no scorable words', () => {
    const options = [opt('a', 'Alpha'), opt('b', 'Beta')]
    expect(rankOptions(options, 'can you please', 2).map((o) => o.value)).toEqual(['a', 'b'])
  })
})

describe('filterOptions', () => {
  it('returns the head of the list when nothing is typed', () => {
    const options = [opt('a', 'Alpha'), opt('b', 'Beta'), opt('c', 'Gamma')]
    expect(filterOptions(options, '   ', 2).map((o) => o.value)).toEqual(['a', 'b'])
  })

  it('reaches a label a whole-word overlap scores zero', () => {
    // "spar" must find Spark; overlapScore is built for a transcript and
    // gives this 0.
    const options = [opt('a', 'Spark'), opt('b', 'Terminal')]
    expect(overlapScore(words('spar'), 'Spark')).toBe(0)
    expect(filterOptions(options, 'spar', 5).map((o) => o.value)).toEqual(['a'])
  })

  it('ranks a label prefix above an inner-word prefix above a bare substring', () => {
    const options = [
      opt('substring', 'Oxen and carts'),
      opt('wordprefix', 'Open xen files'),
      opt('labelprefix', 'Xenon reactor')
    ]
    expect(filterOptions(options, 'xen', 5).map((o) => o.value)).toEqual([
      'labelprefix',
      'wordprefix',
      'substring'
    ])
  })

  it('excludes an option the needle does not appear in at all', () => {
    const options = [opt('a', 'Spark'), opt('b', 'Terminal')]
    expect(filterOptions(options, 'zzz', 5)).toEqual([])
  })

  it('matches case-insensitively and through the newline normalizer', () => {
    const options = [opt('a', 'LastPass\nHas access')]
    expect(filterOptions(options, 'lastpass h', 5).map((o) => o.value)).toEqual(['a'])
  })

  it('respects the limit', () => {
    const options = [opt('a', 'Alpha one'), opt('b', 'Alpha two'), opt('c', 'Alpha three')]
    expect(filterOptions(options, 'alpha', 2)).toHaveLength(2)
  })
})

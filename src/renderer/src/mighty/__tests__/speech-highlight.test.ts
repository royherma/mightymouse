import { describe, it, expect } from 'vitest'
import { alignWords, tokenIndexAt, tokenizeForHighlight } from '../speech-highlight'
import type { SpokenWord } from '../../../../shared/types'

/** Real Kokoro output for "The config lives in shared config." — captured from
 *  resources/kokoro-speak.py, so the fixture can't drift from the actual shape. */
const WORDS: SpokenWord[] = [
  { w: 'The', s: 0.25, e: 0.325 },
  { w: 'config', s: 0.325, e: 0.825 },
  { w: 'lives', s: 0.825, e: 1.1 },
  { w: 'in', s: 1.1, e: 1.275 },
  { w: 'shared', s: 1.275, e: 1.6 },
  { w: 'config', s: 1.6, e: 2.375 }
]

describe('tokenizeForHighlight', () => {
  it('round-trips the source text exactly', () => {
    const text = 'Hello  world\nand   more.'
    expect(tokenizeForHighlight(text).join('')).toBe(text)
  })
})

describe('alignWords', () => {
  it('times every spoken word and leaves punctuation untimed', () => {
    const tokens = alignWords('The config lives in shared config.', WORDS)
    const timed = tokens.filter((t) => t.start !== null)
    expect(timed.map((t) => t.text)).toEqual([
      'The',
      'config',
      'lives',
      'in',
      'shared',
      'config.'
    ])
    // The trailing "." rides on its word, and takes that word's timing.
    expect(timed[5].start).toBe(1.6)
  })

  it('matches through markdown syntax the voice never speaks', () => {
    const tokens = alignWords('The **config** lives in shared config.', WORDS)
    const bold = tokens.find((t) => t.text === '**config**')
    expect(bold?.start).toBe(0.325)
  })

  it('leaves whitespace untimed so it never highlights', () => {
    const tokens = alignWords('The config', WORDS)
    expect(tokens.find((t) => t.text === ' ')?.start).toBeNull()
  })

  it('skips a source word the voice never said, without desyncing the rest', () => {
    // "https://x.co" is in the text but absent from WORDS — everything after it
    // must still line up rather than shifting by one.
    const tokens = alignWords('The config https://x.co lives in shared config.', WORDS)
    expect(tokens.find((t) => t.text === 'https://x.co')?.start).toBeNull()
    expect(tokens.find((t) => t.text === 'lives')?.start).toBe(0.825)
  })

  it('returns all-untimed tokens when nothing matches', () => {
    const tokens = alignWords('completely different text', WORDS)
    expect(tokens.every((t) => t.start === null)).toBe(true)
  })
})

describe('tokenIndexAt', () => {
  const tokens = alignWords('The config lives in shared config.', WORDS)
  const textAt = (time: number): string | undefined => tokens[tokenIndexAt(tokens, time)]?.text

  it('is -1 before the first word', () => {
    expect(tokenIndexAt(tokens, 0)).toBe(-1)
  })

  it('finds the word at a time inside it', () => {
    expect(textAt(0.5)).toBe('config')
    expect(textAt(1.3)).toBe('shared')
  })

  it('holds the previous word through a gap, so it does not strobe', () => {
    // 0.2s sits after "The" ends (0.325)? No — before it starts. Use the real
    // gap: nothing is spoken between 0 and 0.25.
    expect(tokenIndexAt(tokens, 0.1)).toBe(-1)
    // After the last word ends, the highlight stays on it rather than vanishing
    // mid-playback while the clip's trailing silence runs out.
    expect(textAt(2.4)).toBe('config.')
  })

  it('picks the word at its exact start boundary', () => {
    expect(textAt(0.325)).toBe('config')
  })
})

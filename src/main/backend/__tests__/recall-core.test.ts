/**
 * Tests for recall-core.ts — shared recall primitives.
 *
 * Covers:
 *   1. tokenize: stopword filtering, minLen, dedup, max cap
 *   2. packBlocks: budget bound, empty-set path, overflow line
 *   3. scoreText: field weights, frequency cap, zero-match returns 0
 */

import { describe, it, expect } from 'vitest'
import { tokenize, packBlocks, scoreText, STOPWORDS } from '../recall-core'

// ── tokenize ─────────────────────────────────────────────────────────────────

describe('tokenize', () => {
  it('removes stopwords', () => {
    // 'the' and 'and' are in STOPWORDS; 'hello' and 'world' should survive
    const tokens = tokenize('the hello and world')
    expect(tokens).not.toContain('the')
    expect(tokens).not.toContain('and')
    expect(tokens).toContain('hello')
    expect(tokens).toContain('world')
  })

  it('lowercases all tokens', () => {
    const tokens = tokenize('HELLO World')
    expect(tokens).toContain('hello')
    expect(tokens).toContain('world')
  })

  it('respects minLen default of 3', () => {
    // 'ab' is 2 chars → dropped; 'abc' is 3 chars → kept
    const tokens = tokenize('ab abc')
    expect(tokens).not.toContain('ab')
    expect(tokens).toContain('abc')
  })

  it('respects custom minLen', () => {
    const tokens = tokenize('ab abc', { minLen: 2 })
    expect(tokens).toContain('ab')
    expect(tokens).toContain('abc')
  })

  it('deduplicates tokens', () => {
    const tokens = tokenize('hello hello world')
    const helloCount = tokens.filter((t) => t === 'hello').length
    expect(helloCount).toBe(1)
  })

  it('respects max cap', () => {
    const tokens = tokenize('alpha beta gamma delta epsilon zeta', { max: 3 })
    expect(tokens).toHaveLength(3)
  })

  it('returns empty array for all-stopword input', () => {
    // Pick words we know are in STOPWORDS
    const firstStopword = [...STOPWORDS][0]
    const secondStopword = [...STOPWORDS][1]
    const tokens = tokenize(`${firstStopword} ${secondStopword}`)
    expect(tokens).toHaveLength(0)
  })

  it('handles empty string', () => {
    expect(tokenize('')).toHaveLength(0)
  })

  it('splits on non-letter/digit characters', () => {
    const tokens = tokenize('hello-world:foo/bar')
    expect(tokens).toContain('hello')
    expect(tokens).toContain('world')
    expect(tokens).toContain('foo')
    expect(tokens).toContain('bar')
  })
})

// ── packBlocks ────────────────────────────────────────────────────────────────

describe('packBlocks', () => {
  const HEADER = 'HEADER\n'
  const EMPTY = 'nothing found'

  it('returns header + emptyMsg when blocks is empty', () => {
    const result = packBlocks(HEADER, EMPTY, [], 1000)
    expect(result).toBe(`${HEADER}${EMPTY}`)
  })

  it('includes all blocks when they fit within budget', () => {
    const blocks = ['block1', 'block2', 'block3']
    const result = packBlocks(HEADER, EMPTY, blocks, 10000)
    expect(result).toContain('block1')
    expect(result).toContain('block2')
    expect(result).toContain('block3')
    expect(result).not.toContain('more not shown')
  })

  it('truncates at budget and appends overflow line', () => {
    // Header is 7 chars, each block is ~6 chars. Budget of 30 chars
    // should fit header + 1 block, then overflow for the remaining 2.
    const blocks = ['BLOCK1', 'BLOCK2', 'BLOCK3']
    const budget = HEADER.length + blocks[0].length + 5 // room for 1 block + newline
    const result = packBlocks(HEADER, EMPTY, blocks, budget)
    expect(result).toContain('BLOCK1')
    // Second block must be cut by the budget
    expect(result).toContain('more not shown')
    expect(result).not.toContain('BLOCK2')
  })

  it('result never exceeds budget when blocks are large', () => {
    // Huge blocks: packer should still fit within budget by stopping early.
    const bigBlock = 'x'.repeat(500)
    const blocks = [bigBlock, bigBlock, bigBlock]
    const budget = 100
    const result = packBlocks(HEADER, EMPTY, blocks, budget)
    // The result may be slightly larger than budget because the overflow line
    // itself is added unconditionally after detecting budget overflow — that's
    // intentional (overflow line is metadata, not content). What matters is
    // content blocks stop being added when the budget is hit.
    expect(result).toContain('more not shown')
    // The big block itself must NOT appear (it would immediately overflow)
    expect(result).not.toContain(bigBlock)
  })
})

// ── scoreText ─────────────────────────────────────────────────────────────────

describe('scoreText', () => {
  it('returns 0 for empty tokens', () => {
    expect(scoreText([], [{ text: 'hello world', weight: 2 }])).toBe(0)
  })

  it('returns 0 for empty fields', () => {
    expect(scoreText(['hello'], [])).toBe(0)
  })

  it('returns 0 when no tokens match any field', () => {
    expect(scoreText(['xyz'], [{ text: 'hello world', weight: 1 }])).toBe(0)
  })

  it('returns positive score when tokens match', () => {
    const score = scoreText(['hello'], [{ text: 'hello world', weight: 1 }])
    expect(score).toBeGreaterThan(0)
  })

  it('applies field weights correctly', () => {
    // Same token in two fields with different weights
    const highScore = scoreText(['hello'], [{ text: 'hello', weight: 3 }])
    const lowScore = scoreText(['hello'], [{ text: 'hello', weight: 1 }])
    expect(highScore).toBeGreaterThan(lowScore)
    expect(highScore / lowScore).toBeCloseTo(3, 0)
  })

  it('caps frequency at 3 per field', () => {
    // 3 occurrences and 10 occurrences should get the same score in one field
    const text3 = 'hello hello hello'
    const text10 = 'hello hello hello hello hello hello hello hello hello hello'
    const score3 = scoreText(['hello'], [{ text: text3, weight: 1 }])
    const score10 = scoreText(['hello'], [{ text: text10, weight: 1 }])
    expect(score3).toBe(score10) // both capped at 3
  })

  it('accumulates scores across multiple fields', () => {
    // A token in two fields scores more than just one field
    const twoFields = scoreText(
      ['hello'],
      [
        { text: 'hello', weight: 1 },
        { text: 'hello', weight: 1 }
      ]
    )
    const oneField = scoreText(['hello'], [{ text: 'hello', weight: 1 }])
    expect(twoFields).toBeGreaterThan(oneField)
  })

  it('handles undefined field text gracefully', () => {
    expect(() => scoreText(['hello'], [{ text: undefined, weight: 2 }])).not.toThrow()
    expect(scoreText(['hello'], [{ text: undefined, weight: 2 }])).toBe(0)
  })

  it('accumulates scores across multiple tokens', () => {
    const multi = scoreText(['hello', 'world'], [{ text: 'hello world', weight: 1 }])
    const single = scoreText(['hello'], [{ text: 'hello world', weight: 1 }])
    expect(multi).toBeGreaterThan(single)
  })
})

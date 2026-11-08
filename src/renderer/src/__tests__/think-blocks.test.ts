import { describe, it, expect } from 'vitest'
import { splitThinkBlocks } from '../think-blocks'

// Regression: a Qwen3.5 9B answer rendered its reasoning as prose with a bare `</think>`
// sitting in the middle of it (screenshot, 2026-07-17). Nothing in src/ stripped think
// blocks. The unclosed case is the one that actually produced that stray tag.
describe('splitThinkBlocks', () => {
  it('leaves ordinary text alone', () => {
    expect(splitThinkBlocks('just an answer')).toEqual({ reasoning: '', answer: 'just an answer' })
  })

  it('splits a well-formed block', () => {
    const { reasoning, answer } = splitThinkBlocks('<think>hmm, local?</think>No, not really.')
    expect(reasoning).toBe('hmm, local?')
    expect(answer).toBe('No, not really.')
  })

  it('handles an UNCLOSED block — the case that leaked </think> on screen', () => {
    const { reasoning, answer } = splitThinkBlocks('<think>still reasoning about RAM')
    expect(reasoning).toBe('still reasoning about RAM')
    expect(answer).toBe('')
  })

  it('swallows a stray close whose opener was upstream', () => {
    // Exactly the screenshot's shape: reasoning text, a lone </think>, then the reply.
    const { reasoning, answer } = splitThinkBlocks('needs a GPU\n</think>\nThe answer is: no.')
    expect(reasoning).toBe('needs a GPU')
    expect(answer).toBe('The answer is: no.')
    expect(answer).not.toContain('</think>')
  })

  it('joins multiple blocks and keeps the text between them', () => {
    const { reasoning, answer } = splitThinkBlocks('<think>one</think>A<think>two</think>B')
    expect(reasoning).toBe('one\n\ntwo')
    expect(answer).toBe('AB')
  })

  it('never leaves a tag in the answer', () => {
    for (const s of [
      '<think>a</think>b',
      '<think>a',
      'a</think>b',
      '<think>a</think>',
      '<think></think>plain'
    ]) {
      const { answer } = splitThinkBlocks(s)
      expect(answer).not.toContain('<think>')
      expect(answer).not.toContain('</think>')
    }
  })
})

import { describe, it, expect } from 'vitest'
import { stripEchoedInstruction } from '../fast-rewrite'

// The real failure: a long Ask instruction came back at the top of the rewrite,
// separator and all, and the preview offered to paste it into the document.
const INSTRUCTION = 'Make it more amazing, more in depth. Explain the logic clearly, and give a prompt that’s thorough.'
const REWRITE = 'Send this to your agents.\n\nTell them to flag the "stupid things".'

describe('stripEchoedInstruction', () => {
  it('cuts an echoed instruction and the separator under it', () => {
    const echoed = `${INSTRUCTION}\n\n---\n${REWRITE}`
    expect(stripEchoedInstruction(echoed, INSTRUCTION)).toBe(REWRITE)
  })

  it('cuts an echo that arrived without a separator', () => {
    expect(stripEchoedInstruction(`${INSTRUCTION}\n\n${REWRITE}`, INSTRUCTION)).toBe(REWRITE)
  })

  it('leaves a clean rewrite untouched', () => {
    expect(stripEchoedInstruction(REWRITE, INSTRUCTION)).toBe(REWRITE)
  })

  it('keeps a rewrite that merely opens with similar words', () => {
    const text = 'Make it clearer for the team, then send it on.'
    expect(stripEchoedInstruction(text, INSTRUCTION)).toBe(text)
  })

  // Returning '' here would paste nothing over the selection, which reads to the
  // user as the bar having deleted their text.
  it('keeps the original when the echo was the whole answer', () => {
    expect(stripEchoedInstruction(INSTRUCTION, INSTRUCTION)).toBe(INSTRUCTION)
  })

  it('does nothing for a chip, which has no typed instruction to echo', () => {
    expect(stripEchoedInstruction(REWRITE, '')).toBe(REWRITE)
  })
})

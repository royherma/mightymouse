/** The bind effect keyed on proxies (deckMode/splitConcept), which a gate
 *  unmounting the deck never changes — mic dead all session. */
import { describe, it, expect } from 'vitest'
import { MIC_SELECTOR, MIC_CHROME_SELECTOR, findMicNodes, sameMicNodes } from './mic-nodes'

/** Enough of ParentNode to drive findMicNodes. No jsdom in this suite. */
function fakeRoot(nodes: unknown[]): ParentNode {
  return { querySelectorAll: () => nodes } as unknown as ParentNode
}

const A = { id: 'a' } as unknown as HTMLButtonElement
const B = { id: 'b' } as unknown as HTMLButtonElement

describe('MIC_SELECTOR', () => {
  it('matches the mic button and nothing else mic-prefixed', () => {
    expect(MIC_SELECTOR).toContain('.proMicBtn')
    // .micWaveform / .micTranscribeAction / .micInputBadge must not match.
    expect(MIC_SELECTOR).not.toContain('.micWaveform')
    expect(MIC_SELECTOR).not.toContain('.micTranscribe')
  })
})

describe('MIC_CHROME_SELECTOR', () => {
  it('includes Cancel/Stop, which the leftover pointerdown also hits', () => {
    expect(MIC_CHROME_SELECTOR).toContain(MIC_SELECTOR)
    expect(MIC_CHROME_SELECTOR).toContain('.micSideBtn')
  })
})

describe('findMicNodes', () => {
  it('returns a real array, not a live NodeList', () => {
    expect(Array.isArray(findMicNodes(fakeRoot([A, B])))).toBe(true)
  })

  it('finds every mic, so the split deck cannot leave one dead', () => {
    expect(findMicNodes(fakeRoot([A, B]))).toEqual([A, B])
  })
})

describe('sameMicNodes', () => {
  it('sees a gate mounting the deck as a change', () => {
    // THE regression: equal here means the effect never re-runs.
    expect(sameMicNodes([], [A])).toBe(false)
  })

  it('sees a gate unmounting the deck as a change', () => {
    expect(sameMicNodes([A], [])).toBe(false)
  })

  it('holds steady across an unrelated re-render', () => {
    // Must be true, or setState loops on every render.
    expect(sameMicNodes([A, B], [A, B])).toBe(true)
  })

  it('rebinds when the split deck swaps which mic is which', () => {
    expect(sameMicNodes([A, B], [B, A])).toBe(false)
  })

  it('rebinds when a second mic appears', () => {
    expect(sameMicNodes([A], [A, B])).toBe(false)
  })
})

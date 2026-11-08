import { describe, expect, it } from 'vitest'
import type { Suggestion } from '../../../shared/types'
import { instructionStem, rerankWithRates } from '../ranker'
import type { StemRate } from '../outcome-store'

describe('instructionStem', () => {
  it('normalizes punctuation and keeps the configured leading words', () => {
    expect(instructionStem('Reply: yes, this works for me tomorrow morning.')).toBe(
      'reply yes this works for me'
    )
  })
})

describe('rerankWithRates', () => {
  it('boosts accepted stems above dismissed stems', () => {
    const suggestions: Suggestion[] = [
      { label: 'Summarize', instruction: 'Summarize this email thread', mode: 'ask' },
      { label: 'Reply', instruction: 'Reply yes and confirm the time', mode: 'rewrite' }
    ]
    const rates = new Map<string, StemRate>([
      [
        'reply yes and confirm the time',
        {
          stem: 'reply yes and confirm the time',
          accepted: 4,
          dismissed: 0,
          rate: 1,
          lastTs: Date.now()
        }
      ],
      [
        'summarize this email thread',
        {
          stem: 'summarize this email thread',
          accepted: 0,
          dismissed: 4,
          rate: 0,
          lastTs: Date.now()
        }
      ]
    ])

    expect(rerankWithRates(suggestions, rates)[0].label).toBe('Reply')
  })
})

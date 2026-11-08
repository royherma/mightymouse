import { describe, it, expect } from 'vitest'
import { tallestBanner } from './useTopBannerOffset'

describe('tallestBanner', () => {
  it('is 0 when no banner is mounted', () => {
    expect(tallestBanner([])).toBe(0)
  })

  it('reports a single banner height', () => {
    expect(tallestBanner([44])).toBe(44)
  })

  it('takes the tallest when two are up at once, not their sum', () => {
    // .awayPill and .handsFreePill share one anchor and overlap -- adding them
    // would push the deck down by a banner that is not visible.
    expect(tallestBanner([30, 44])).toBe(44)
    expect(tallestBanner([44, 30])).toBe(44)
  })

  it('ignores a collapsing zero-box banner mid-transition', () => {
    expect(tallestBanner([2])).toBe(0)
  })

  it('rounds to a whole pixel', () => {
    expect(tallestBanner([43.6])).toBe(44)
  })
})

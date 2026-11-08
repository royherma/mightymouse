import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, it, expect } from 'vitest'
import {
  REFUSAL_CODE,
  UPGRADE_CTA,
  isRemoteRefusal,
  refusalCopy,
  type RemoteRefusal
} from '../remote-refusal'

const EDGE_MIRROR = join(__dirname, '../../../supabase/functions/_shared/refusal.ts')

const capped = (window: 'daily' | 'weekly' | 'monthly'): RemoteRefusal => ({
  code: REFUSAL_CODE.remoteLimitReached,
  message: "You've used all your off-Wi-Fi access on the free plan.",
  usage: {
    used: { day: 15, week: 45, month: 90 },
    limits: { day: 15, week: 45, month: 90 },
    window
  }
})

describe('the Deno mirror', () => {
  // Deno can't import src/shared, so the codes exist twice. This is the only
  // thing keeping the copies honest -- a renamed code that drifts silently means
  // the app stops recognising a refusal and prints the raw enum again.
  it('declares exactly the same codes', () => {
    const src = readFileSync(EDGE_MIRROR, 'utf8')
    for (const code of Object.values(REFUSAL_CODE)) {
      expect(src).toContain(`'${code}'`)
    }
  })
})

describe('isRemoteRefusal', () => {
  it('accepts a stated refusal', () => {
    expect(isRemoteRefusal(capped('daily'))).toBe(true)
  })

  // The whole point of the code field: an opaque failure must NOT be mistaken
  // for a refusal, or a 502 would render an upgrade prompt.
  it('rejects a plain error body', () => {
    expect(isRemoteRefusal({ error: 'Tunnel setup failed' })).toBe(false)
    expect(isRemoteRefusal({ code: 'something_else', message: 'hi' })).toBe(false)
    expect(isRemoteRefusal(null)).toBe(false)
  })
})

describe('refusalCopy', () => {
  it('names the window that resets soonest, with real numbers', () => {
    const copy = refusalCopy(capped('daily'))
    expect(copy.headline).toContain('today')
    expect(copy.detail).toContain('15 of 15 minutes')
    expect(copy.detail).toContain('Resets tomorrow.')
    expect(copy.cta).toBe(UPGRADE_CTA)
  })

  // Roy's staging account is capped on all three windows at once. A hardcoded
  // "back tomorrow" would be a lie for exactly the users who hit this most, so
  // the sentence is rendered from the window the server named.
  it('reads the monthly cap when monthly is what ran out', () => {
    const copy = refusalCopy(capped('monthly'))
    expect(copy.headline).toContain('this month')
    expect(copy.detail).toContain('90 of 90 minutes')
    expect(copy.detail).toContain('Resets next month.')
  })

  it('still says something useful with no usage block', () => {
    const copy = refusalCopy({
      code: REFUSAL_CODE.remoteLimitReached,
      message: 'nope'
    })
    expect(copy.headline).toContain('free plan')
    expect(copy.detail).toBeNull()
    expect(copy.cta).toBe(UPGRADE_CTA)
  })

  // The abuse ceiling isn't a tier limit -- Pro wouldn't lift it, so offering an
  // upgrade here would take money for something that doesn't fix the problem.
  it('offers no upgrade for the abuse cap', () => {
    const copy = refusalCopy({
      code: REFUSAL_CODE.dailyCapExceeded,
      message: 'paused'
    })
    expect(copy.cta).toBeNull()
  })
})

import { describe, it, expect } from 'vitest'
import { spendableCents, shouldShowBucketBreakdown } from '../billing-math'

// spendableCents is the single sum every gate/display must use (packs +
// subscription, migration 0016). The bug this design fixes — settings.ts's `ok:`
// gate denying a subscriber with $0 packs and a funded monthly bucket — is
// exactly this arithmetic used wrong. Locking it here means any future caller
// that reads only balance_cents is a visible regression, not a repeat incident.
describe('spendableCents', () => {
  it('sums packs + subscription', () => {
    expect(spendableCents(1000, 500)).toBe(1500)
  })

  it('the denial-of-service case: $0 packs, funded subscription still counts', () => {
    // This is 2c in the design — settings.ts used to gate on balance_cents alone
    // (0), refusing a subscriber whose subscription_cents (2000) made them
    // fully able to spend. ok: cents > 0 must see the combined total.
    const cents = spendableCents(0, 2000)
    expect(cents).toBe(2000)
    expect(cents > 0).toBe(true)
  })

  it('packs only (no subscription)', () => {
    expect(spendableCents(1500, 0)).toBe(1500)
  })

  it('subscription only (no packs)', () => {
    expect(spendableCents(0, 1500)).toBe(1500)
  })

  it('both zero → zero, gate fails as expected', () => {
    expect(spendableCents(0, 0)).toBe(0)
  })

  it('treats null/undefined as zero (fresh row, no balance yet)', () => {
    expect(spendableCents(null, undefined)).toBe(0)
    expect(spendableCents(undefined, 500)).toBe(500)
    expect(spendableCents(500, null)).toBe(500)
  })
})

// shouldShowBucketBreakdown drives whether the portal's Credit Balance card
// shows the "$X packs, never expires / $Y monthly, resets <date>" split. This
// is the exact boolean both Membership.tsx and visual-harness.tsx call — no
// jsdom/@testing-library in this repo, so this predicate (not a rendered DOM)
// is what proves the breakdown hides for one-bucket users, per the design's test
// requirement.
describe('shouldShowBucketBreakdown', () => {
  it('both buckets non-zero → shows the breakdown', () => {
    expect(shouldShowBucketBreakdown(1000, 500)).toBe(true)
  })

  it('packs only → hides the breakdown (nothing to split)', () => {
    expect(shouldShowBucketBreakdown(1500, 0)).toBe(false)
  })

  it('subscription only → hides the breakdown', () => {
    expect(shouldShowBucketBreakdown(0, 1500)).toBe(false)
  })

  it('both zero (e.g. lifetime owner with no packs/sub) → hides the breakdown', () => {
    expect(shouldShowBucketBreakdown(0, 0)).toBe(false)
  })
})

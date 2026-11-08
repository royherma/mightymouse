import { describe, expect, it } from 'vitest'
import { BAR_TAP_GRACE_MS, focusWasStolenByBar } from './focus-stolen'

// This rule decides whether a blur hands focus BACK to the hidden input. It no
// longer decides teardown -- the visualViewport reconciler owns that, so a
// scroll can blur the input without closing the keyboard (see focus-stolen.ts).
// Getting it wrong still costs the dead-tap bug (four failed fixes) in one
// direction; in the other it just means the input sits unfocused until the next
// tap, which is why the boundary cases below stay locked.
describe('focusWasStolenByBar', () => {
  it('treats a blur 1ms after a bar tap as stolen -- the exact on-device race', () => {
    // The measured gap: bar:tap +3269ms, input:blur +3270ms, with the sheet
    // still uncommitted (false). This is the case every previous fix missed.
    expect(focusWasStolenByBar(false, 1)).toBe(true)
  })

  it('still trusts a committed open sheet after the grace window', () => {
    // Scrolling a long dropdown: the last tap is old, but focus is the sheet's.
    expect(focusWasStolenByBar(true, BAR_TAP_GRACE_MS * 10)).toBe(true)
  })

  it('does not refocus after a blur unrelated to the bar', () => {
    // A trackpad scroll is the common case. Refocusing here would fight iOS for
    // the caret on every drag; the keyboard survives regardless, because only
    // the viewport reconciler can close it now.
    expect(focusWasStolenByBar(false, BAR_TAP_GRACE_MS + 1)).toBe(false)
  })

  it('does not refocus when no bar tap has ever happened', () => {
    // Cold start: the ref is 0, so the elapsed time is epoch-sized.
    expect(focusWasStolenByBar(false, Date.now())).toBe(false)
  })

  it('does not fire on a negative elapsed time', () => {
    // Clock skew / a tap stamped in the future must not latch the keyboard on.
    expect(focusWasStolenByBar(false, -5)).toBe(false)
  })

  it('is exclusive at the boundary so the window has one definition', () => {
    expect(focusWasStolenByBar(false, BAR_TAP_GRACE_MS - 1)).toBe(true)
    expect(focusWasStolenByBar(false, BAR_TAP_GRACE_MS)).toBe(false)
  })
})

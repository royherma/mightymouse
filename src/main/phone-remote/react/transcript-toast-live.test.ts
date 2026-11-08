import { describe, it, expect } from 'vitest'
import { toastIsLive } from './TranscriptToast'

// The transcript toast is the only element that parks a tap target over the
// trackpad, so "is it a live target" has to stay a two-term answer. Shipping it
// as `tappable` alone made every tap in that strip open History, because the
// toast hides on opacity (box intact) and `toastHistoryId` deliberately outlives
// the auto-hide. The truth table is locked here so the `shown` term can't be
// dropped again as a redundant-looking guard.
describe('toastIsLive', () => {
  it('is live for a shown toast the Mac linked to a history entry', () => {
    expect(toastIsLive(true, true)).toBe(true)
  })

  it('is inert once an actionable toast auto-hides', () => {
    // The regression: `tappable` stays true for the rest of the session because
    // the history id is kept, so this case is exactly the invisible tap target.
    expect(toastIsLive(true, false)).toBe(false)
  })

  it('is inert for a plain ack that is on screen', () => {
    // "Pasted" / "Stopping…" have no history id -- nothing to open.
    expect(toastIsLive(false, true)).toBe(false)
  })

  it('is inert when hidden and unlinked', () => {
    expect(toastIsLive(false, false)).toBe(false)
  })
})

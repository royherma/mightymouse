import { describe, it, expect } from 'vitest'
import { accessoryBarVisible } from './KeyboardAccessoryBar'

/**
 * The native keyboard's strip must survive its own dropdowns.
 *
 * Tapping a control in AppContextBar blurs the hidden input, so `keyboardFocused`
 * goes false and iOS begins collapsing the keyboard. Both used to unmount this
 * strip -- and the sheet renders inside it, so the dropdown vanished mid-tap and
 * the keyboard went down instead. It only ever reproduced on the native board;
 * VirtualKeyboard's header row has no focus gate, which is why "it works on our
 * keyboard, not the native one" was the reported shape twice.
 */
describe('accessoryBarVisible', () => {
  const TOP = 400

  it('shows while the keyboard has focus', () => {
    expect(accessoryBarVisible({ keyboardFocused: true, sheetOpen: false, top: TOP })).toBe(true)
  })

  it('stays up when a dropdown steals focus -- the regression', () => {
    expect(accessoryBarVisible({ keyboardFocused: false, sheetOpen: true, top: TOP })).toBe(true)
  })

  it('hides once focus is gone and no sheet is open', () => {
    expect(accessoryBarVisible({ keyboardFocused: false, sheetOpen: false, top: TOP })).toBe(false)
  })

  it('hides with no measurement, even holding a sheet open', () => {
    // Nowhere to draw it: a strip guessed into the wrong place is worse than none.
    expect(accessoryBarVisible({ keyboardFocused: true, sheetOpen: true, top: null })).toBe(false)
  })
})

/**
 * Did a keyboard-bar control steal focus, or did the user dismiss the keyboard?
 *
 * The hidden input's blur is the ONLY signal iOS gives that its keyboard
 * closed, so the blur handler has to tell two identical-looking events apart:
 * a real dismissal (tear the keyboard down) and a tap on the bar's own
 * dropdown (leave it standing and hand focus back). Guessing wrong either
 * strands a keyboard that is gone, or closes one the user was still using --
 * the dead-tap bug.
 *
 * The obvious test -- "is a sheet open?" -- cannot work, because the blur
 * arrives BEFORE React commits the sheet. From the device:
 *
 *   +3269ms bar:tap target=bbCount cancelable=true
 *   +3270ms input:blur sheet=false      <- 1ms after the tap, sheet still false
 *   +3273ms openSheet next=items
 *   +3279ms sheet open=false            <- setOpen discarded with the unmount
 *
 * So the question is asked of the TAP, which is recorded synchronously in the
 * pointerdown handler and is therefore always already true by the time any
 * blur it caused is delivered.
 */

/**
 * How recently a bar tap still explains an incoming blur.
 *
 * The real gap measured on-device is ~1ms (pointerdown -> blur). This is set
 * far above that on purpose: too LOW resurrects the dead tap, while too high
 * costs only that a deliberate dismissal within the window keeps the keyboard
 * up for one extra blur -- and the user's next tap dismisses it. Asymmetric
 * failure modes, so the threshold sits well clear of the racing edge rather
 * than close to the measurement.
 */
export const BAR_TAP_GRACE_MS = 350

export function focusWasStolenByBar(sheetOpen: boolean, msSinceBarTap: number): boolean {
  // A committed open sheet is still authoritative -- it covers scrolling a long
  // dropdown, where the last tap is older than the grace window but focus is
  // very much still the sheet's.
  if (sheetOpen) return true
  return msSinceBarTap >= 0 && msSinceBarTap < BAR_TAP_GRACE_MS
}

/**
 * BLUR NEVER DISMISSES THE KEYBOARD. The viewport decides that.
 *
 * This is the rule that makes the whole focus-stealing question go away, and it
 * is worth stating plainly because the code spent four rounds not believing it.
 *
 * Blur means "focus left the hidden input", which happens for many reasons:
 * a bar dropdown opening, a trackpad scroll, a sheet, the app backgrounding,
 * and -- occasionally -- the user actually dismissing the keyboard. Treating
 * blur as dismissal meant subtracting those causes one at a time, each
 * subtraction a fresh guess with its own timing window. Every new surface added
 * another one, and the trackpad (scroll while typing, the product's whole
 * point) was simply the next in line.
 *
 * `window.visualViewport` answers the real question directly and does not care
 * WHY focus moved: if iOS's keyboard is on screen it occludes the viewport, and
 * if it is gone it does not. That covers swipe-to-dismiss and the `Done` button
 * -- the two ways a user actually puts the native board away -- without
 * enumerating anything.
 *
 * So blur's only remaining job is flushing the typed text. `reconcileNative` in
 * keyboard-state.ts owns teardown, and NOTHING needs to know about the
 * trackpad: a scroll blurs the input, the viewport stays occluded, the keyboard
 * stays up. focusWasStolenByBar survives only to keep focus IN the input across
 * a dropdown tap, which is a refocus concern, not a dismissal one.
 */

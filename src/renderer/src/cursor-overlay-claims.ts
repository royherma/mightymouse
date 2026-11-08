// Refcounted claims on the cursor overlay's "catch clicks / take focus" state.
//
// The overlay is a fullscreen click-through window. Two independent owners can
// want it interactive at the same time: the suggestion bubble (while the pointer
// is over it) and any open suggestion preview (for the panel's whole life). A
// plain boolean toggle lost this — moving the pointer from a chip onto its preview
// fires the bubble's onMouseLeave, which flipped click-through back ON and dropped
// the next click (e.g. Confirm) into the app behind the overlay.
//
// Refcount instead: each owner calls claimClickable()/claimFocusable() to acquire
// and runs the returned release fn when done. The window only goes back to
// click-through (or non-focusable) once EVERY owner has released. Module-level
// state is fine — there is exactly one cursor overlay window/renderer.
//
// Why the clickable side is DEBOUNCED on release: flipping the window's
// setIgnoreMouseEvents while the pointer is over it makes macOS re-hit-test, which
// fires a synthetic DOM mouseleave→mouseenter pair. With a bare toggle that becomes
// an oscillation — enter→clickable ON→re-hit-test fires leave→clickable OFF→re-hit-
// test fires enter→… — and every flip repaints the transparent overlay, so the
// whole bubble + preview visibly flickers hidden/shown while you just hover. Holding
// the OFF for a short delay (a re-acquire cancels it) collapses the oscillation:
// the window stays interactive for the whole hover and only goes click-through once
// the pointer has genuinely been gone for OFF_DELAY_MS.

import { CONFIG } from '../../shared/config'

const OFF_DELAY_MS = CONFIG.SUGGESTIONS.CLICKABLE_OFF_DELAY_MS

let clickableClaims = 0
let focusableClaims = 0
let pendingOff: ReturnType<typeof setTimeout> | null = null

function applyClickable(on: boolean): void {
  // A fresh acquire cancels a queued release; a release schedules one. The window
  // call only fires for a transition that survives the delay — no flip-flop.
  if (on) {
    if (pendingOff) {
      clearTimeout(pendingOff)
      pendingOff = null
    } else {
      window.api.cursorSetClickable(true)
    }
  } else if (!pendingOff) {
    pendingOff = setTimeout(() => {
      pendingOff = null
      if (clickableClaims === 0) window.api.cursorSetClickable(false)
    }, OFF_DELAY_MS)
  }
}

/** Acquire a clickable claim; returns an idempotent release fn. */
export function claimClickable(): () => void {
  if (clickableClaims++ === 0) applyClickable(true)
  let released = false
  return () => {
    if (released) return
    released = true
    // Clamp at 0: resetOverlayClaims() can zero the counter out from under a live
    // claim (the bubble force-resets on hide), so a later release must not drive it
    // negative — that would make the NEXT acquire's 0→1 edge never fire.
    if (clickableClaims > 0 && --clickableClaims === 0) applyClickable(false)
  }
}

/** Acquire a focusable claim; returns an idempotent release fn. */
export function claimFocusable(): () => void {
  if (focusableClaims++ === 0) window.api.cursorSetFocusable(true)
  let released = false
  return () => {
    if (released) return
    released = true
    if (focusableClaims > 0 && --focusableClaims === 0) window.api.cursorSetFocusable(false)
  }
}

/**
 * Hard-reset both refcounts + the overlay to its idle (click-through, non-focusable)
 * state. Call this when the bubble HIDES: the bubble force-flips the window
 * click-through on hide, which bypasses the refcount — leaving clickableClaims stuck
 * above 0 (a hover/preview claim whose release never ran). The next bubble's
 * claimClickable() then increments to 2, never hits the 0→1 edge, and never re-arms
 * the window — so the new preview is un-clickable and looks "stuck". Resetting to 0
 * on hide makes every new bubble start from a known-clean state.
 */
export function resetOverlayClaims(): void {
  if (pendingOff) {
    clearTimeout(pendingOff)
    pendingOff = null
  }
  clickableClaims = 0
  focusableClaims = 0
  window.api.cursorSetClickable(false)
  window.api.cursorSetFocusable(false)
}

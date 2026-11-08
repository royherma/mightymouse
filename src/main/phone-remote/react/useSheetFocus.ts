/**
 * Moves focus into a sheet when it opens, for hosts where focus IS the cursor.
 *
 * A sheet renders over the deck but does not take focus, so on Meta Ray-Ban
 * Display (and any TV/remote host) opening Settings left the focus ring parked
 * on the deck button BEHIND the sheet: every swipe walked the hidden deck while
 * the user watched a sheet that never highlighted anything. Reported as
 * "settings and the modals aren't supported" -- they render and their buttons
 * work, nothing ever aimed focus at them.
 *
 * Runs on EVERY host, because the gate it used to carry (`isPointerlessHost`)
 * is evaluated before first paint and latches false on any host that resizes
 * after load -- so on the glasses simulator this hook silently did nothing and
 * a swipe inside Settings walked the deck behind it.
 *
 * The cost the gate was avoiding on a phone is real but narrower than it looks:
 * focusing a text input would raise iOS's keyboard unasked. So the target is
 * the first NON-INPUT control instead, which a finger-driven user never
 * notices -- a tap does not care where focus sat -- and which gives a swipe
 * somewhere to start.
 */

import { useEffect, type RefObject } from 'react'

/** Same set the browser treats as tabbable, minus anything explicitly removed
 *  from the order (`tabindex="-1"` -- e.g. the hidden keyboard input). */
const FOCUSABLE =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Focuses the first control inside `ref` whenever `open` turns true, and
 *  restores the previous focus on close -- otherwise focus drops to <body> and
 *  the next swipe restarts from the top of the deck. */
export function useSheetFocus(open: boolean, ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    // A frame late on purpose: the sheet animates in, and focusing a node that
    // is still mid-transition scrolls the container to a position it is about
    // to leave.
    const raf = requestAnimationFrame(() => {
      // Never a text field: focusing one raises iOS's keyboard over a sheet the
      // user only opened to read. Any other control is a safe landing spot.
      const all = ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE)
      const first = all && [...all].find((el) => !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))
      first?.focus()
    })
    return () => {
      cancelAnimationFrame(raf)
      // Only if the sheet still owns focus -- if something else claimed it in
      // the meantime, yanking it back is the bug this is meant to prevent.
      if (ref.current?.contains(document.activeElement)) previous?.focus()
    }
  }, [open, ref])
}

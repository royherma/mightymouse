// Shared by useAppRing (which sizes the arc to clear the buttons) and
// useScrollRail (whose island stops at their top edge). Both anchor to the same
// cluster on the same side, so a second copy would drift.

/** Union of the BUTTONS, not the rows holding them: the cell is a flex column
 *  with no align-items, so each row stretches to its full width and reports the
 *  pad's width however narrow the buttons are. Null until they have laid out.
 *
 *  DELIBERATELY EXCLUDES the floating context bar, which it used to swallow.
 *  The bar now parks itself above the arc's own outer edge (`ringClearanceTop`),
 *  so measuring it here would be a feedback loop: bar moves up, cluster measures
 *  taller, radius grows, bar moves up again. Only the buttons are fixed geometry,
 *  so only the buttons set the radius.
 *
 *  Excluding it is also what makes the arc FIT. A circle enclosing the buttons
 *  AND the bar needs ~259px on a 393pt portrait pad that offers ~227, so the
 *  pad-edge cap won and the arc's icons sat behind the tab chips.
 *  Sizing to the buttons alone clears them at r=204 with room to
 *  spare, and the bar gets out of the way instead. */
export function controlsRect(cluster: HTMLElement): DOMRect | null {
  const btns = cluster.querySelectorAll<HTMLElement>('.proKeyPill, .proMicBtn, .proIconBtn')
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  btns.forEach((el) => {
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return
    left = Math.min(left, r.left)
    top = Math.min(top, r.top)
    right = Math.max(right, r.right)
    bottom = Math.max(bottom, r.bottom)
  })
  if (!Number.isFinite(left)) return null
  return new DOMRect(left, top, right - left, bottom - top)
}

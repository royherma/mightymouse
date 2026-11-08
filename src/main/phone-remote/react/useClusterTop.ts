import { useEffect, useState, type RefObject } from 'react'
import type { PhoneRemoteKeysPosition } from '@shared/types'

// Where the floating app-context bar parks itself: the edge of the button
// cluster that faces open deck, and the cluster's own left/right edges.
//
// WHY MEASURED AND NOT CSS. The cluster's own position is spread across five
// rules in theme.css -- portrait pins `bottom: var(--pro-safe-bottom)` with
// `height: var(--pro-row)` (a PERCENTAGE of the card), landscape overrides the
// height to 46% and the bottom to a bare env() inset, `data-vpos='top'` sets
// `bottom: auto` and moves the whole cell to the TOP, and split mode adds two
// more cells. A `bottom: calc(var(--pro-safe-bottom) + var(--pro-row))` sibling
// would therefore be right in exactly one of those five states. The cluster's
// real rect is the one expression that holds in all of them.
//
// WHY THE KEYS AND NOT THE CELL. `.proControlsCell` is `height: var(--pro-row)`
// -- 33.333% OF THE CARD -- with `justify-content: flex-end`, deliberately, so
// the leftover height collects ABOVE the buttons where the pad can use it. That
// makes the cell's box top ~130px of open cork above the topmost key, and a bar
// anchored to it floats in the middle of the trackpad.
// The cell is the right ref to hold
// -- it is the node the five rules move -- but the edge to measure is its FIRST
// ELEMENT CHILD, the key grid, which is where the cluster visually starts.
//
// Returns VIEWPORT coordinates in the same space .kbAccessory uses, so the
// floating host can share that container's `translateY(-100%)` placement rule
// rather than inventing a second one.
const GAP = 8

/**
 * Which edge the bar hangs off, given the cluster's and (optionally) the arc's.
 *
 * Pure so the rule can be locked without a DOM: the hook around it is all
 * measurement, and this one comparison is the whole behavior.
 *
 * `keysTop`/`ringTop` are both already gap-inset, in the same space.
 * `ringTop` is null when no ring is painted, which must reproduce the
 * cluster-only rule EXACTLY -- the ring is off by default, so a regression here
 * would move the bar for every user who never enabled it.
 */
export function barTopFor(
  keysPosition: PhoneRemoteKeysPosition,
  keysTop: number,
  cellBottom: number,
  ringTop: number | null
): number {
  // Keys at the TOP: the bar hangs DOWNWARD into open deck, away from the corner
  // the arc sweeps from, so the arc can never be in its way and a floor here
  // would push it the wrong direction.
  if (keysPosition !== 'bottom') return cellBottom
  return Math.min(keysTop, ringTop ?? Infinity)
}

/** The measured edge plus the cluster's horizontal span. */
export interface ClusterEdge {
  /** Viewport y the bar's facing edge sits on. */
  top: number
  /** The KEYS' left/right, so the bar tracks the handedness side instead of
   *  spanning the screen. Clamped to the cell's padded box. A `left: 10px;
   *  right: 10px` container put the chips against the far gutter, on the
   *  opposite side from the thumb the cluster is positioned for. */
  left: number
  right: number
  /** Viewport width AT MEASURE TIME. Carried here rather than read in the
   *  host's render: a `right` inset is derived from it, and reading
   *  window.innerWidth during render means rotation updates the rect and the
   *  width in two different passes -- one frame with landscape edges against a
   *  portrait width is exactly the mismatch that clipped the notch carve. */
  viewportWidth: number
}

/**
 * The gap-inset edge of the cluster, or null when there is nothing to measure.
 *
 * `null` means "do not render the bar", never "render it at 0" -- a bar pinned
 * to the viewport top while the cluster is merely unmounted is the same class of
 * failure as the empty clipPath that clipped the whole trackpad away
 * (`canCarveNotch`). Callers must treat null as absent.
 */
export function useClusterTop(
  clusterRef: RefObject<HTMLDivElement | null>,
  // Landscape moves the cluster to whichever edge `keysPosition` names, so the
  // bar has to flip which of its edges it measures. Portrait collapses this to
  // 'bottom' upstream, exactly as .proControlsCell's own rules assume.
  keysPosition: PhoneRemoteKeysPosition,
  // CARD-LOCAL y of the arc's outer edge, or null when no ring is painted. The
  // bar is pushed above it so the two never overlap.
  //
  // WHY A FLOOR AND NOT A SECOND ANCHOR. The arc can only be cleared by moving
  // the bar, never by growing the circle: enclosing both needs ~259px on a
  // 393pt portrait pad that offers ~227, so `ringBand` caps at the pad edge and
  // the icons sit behind the tab chips. With the ring off this
  // is null and the cluster's own edge wins, which is the only rule that
  // existed before.
  ringClearanceTop: number | null,
  // Passed for the DEPS ALONE -- the effect reads it only through keysPosition.
  //
  // This is the `useNotchPath` trap, and it is not hypothetical here: portrait
  // collapses keysPosition to 'bottom', so rotating a bottom-keys deck changes
  // not one value this effect watches. Without this dep the ResizeObserver is
  // still attached to the OLD cluster node after a rotation remounts it, and the
  // bar freezes at the previous orientation's edge. A ResizeObserver alone does
  // not save you: it fires for a resize of the node it observes, not for React
  // swapping in a different node.
  isLandscape: boolean
): ClusterEdge | null {
  const [edge, setEdge] = useState<ClusterEdge | null>(null)

  useEffect(() => {
    const el = clusterRef.current
    if (!el) {
      setEdge(null)
      return
    }

    const measure = (): void => {
      // The keys, not the cell -- the cell's top is dead space by design. See
      // the header. Falls back to the cell only if the grid has not mounted,
      // which is the same frame the zero-box guard below catches anyway.
      const keys = el.firstElementChild ?? el
      const r = keys.getBoundingClientRect()
      // A zero box is a cluster mid-remount, not a cluster at the origin.
      if (r.width === 0 || r.height === 0) return setEdge(null)
      // The cell's PADDED CONTENT box, not its border box. `.proControlsCell`
      // carries `padding: 0 10px 8px`, so its border box runs 10px past the
      // keycaps on each side and 8px below the icon row -- and a bar aligned to
      // that ran flush to the screen edge while the buttons beneath it stopped
      // short. The buttons' own edge is the line to match.
      const cell = el.getBoundingClientRect()
      const pad = getComputedStyle(el)
      const padLeft = parseFloat(pad.paddingLeft) || 0
      const padRight = parseFloat(pad.paddingRight) || 0
      const padBottom = parseFloat(pad.paddingBottom) || 0
      // The arc's outer edge in VIEWPORT space. `ringClearanceTop` is card-local
      // (the arc paints in .proCard, not the pad -- the pad's notch clip-path
      // would trim it), so it needs the card's own offset to compare against a
      // getBoundingClientRect y.
      const card = el.closest('.proCard')?.getBoundingClientRect()
      const ringTop =
        ringClearanceTop !== null && card ? card.top + ringClearanceTop - GAP : null

      setEdge({
        // Keys at the TOP means open deck is BELOW the cluster, so the bar hangs
        // off its bottom edge; the host's translateY(-100%) is cancelled by the
        // same data-vpos attribute in CSS. The BOTTOM edge comes from the cell,
        // not the grid: below the grid sits the icon row, and the bar has to
        // clear the whole cluster rather than just its first row.
        top: barTopFor(keysPosition, r.top - GAP, cell.bottom - padBottom + GAP, ringTop),
        // Horizontal span comes from the KEYS, not the cell. The cell is only
        // cluster-shaped in portrait; in landscape it spans the whole pad
        // column (and the ENTIRE viewport with the mirror off), packing its
        // rows to one side with align-items instead of its own box. Measuring
        // it there put the bar's outer edge at the far gutter, which read as
        // "the bar is on the wrong side" -- it was on the cell's side, and the
        // cell had no side. The keys are the box that actually hugs the
        // handedness corner in every mode.
        left: Math.max(r.left, cell.left + padLeft),
        right: Math.min(r.right, cell.right - padRight),
        // visualViewport when available: with nothing occluding, it is the same
        // number, and it is the box getBoundingClientRect's x values live in.
        viewportWidth: window.visualViewport?.width ?? window.innerWidth
      })
    }
    measure()

    const ro = new ResizeObserver(measure)
    ro.observe(el)
    // The cluster's rect moves without the cluster resizing: iOS panning the
    // visual viewport, and the mirror pane settling in landscape (which shifts
    // the cell's left/right edges and, with them, its measured box).
    const vv = window.visualViewport
    vv?.addEventListener('resize', measure)
    vv?.addEventListener('scroll', measure)
    window.addEventListener('resize', measure)
    window.addEventListener('orientationchange', measure)
    return () => {
      ro.disconnect()
      vv?.removeEventListener('resize', measure)
      vv?.removeEventListener('scroll', measure)
      window.removeEventListener('resize', measure)
      window.removeEventListener('orientationchange', measure)
    }
  }, [clusterRef, keysPosition, isLandscape, ringClearanceTop])

  return edge
}

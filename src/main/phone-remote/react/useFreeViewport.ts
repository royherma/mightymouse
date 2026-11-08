import { useEffect, useState } from 'react'

/** Breathing room kept between a centered modal and the free band's edges, PER EDGE. */
export const FREE_VIEWPORT_MARGIN_PX = 32

/**
 * The band of screen a centered modal can actually use, in layout-viewport
 * coordinates that `position: fixed` understands.
 *
 * Two DIFFERENT things obstruct the screen here and only one of them is visible
 * to CSS:
 *
 *   - The NATIVE keyboard shrinks the VISUAL viewport and leaves `innerHeight`
 *     (and `100dvh`) untouched. So a modal centered with `top: 50%` centers on
 *     the full screen and lands behind the keyboard — which is what clipped the
 *     app switcher grid.
 *   - The VIRTUAL keyboard is an ordinary fixed element. It obstructs nothing
 *     as far as the viewport APIs are concerned, so it has to be measured.
 *
 * Returns the top edge and height of what's left, so a caller can center inside
 * that band instead of the screen. `obstructedBy` is a selector for the
 * in-page obstruction, measured only while `active`.
 *
 * The band's TOP is inset by the safe area too. The visual viewport starts at
 * the physical top of the screen, notch included, so a band measured from it
 * lets a tall modal grow up under the status bar — which is what a keyboard
 * exposed: it halves the band, the midpoint rises, and a list tall enough to
 * use the full height overruns an edge that was never subtracted.
 */
/**
 * The top safe-area inset in px, resolved through CSS.
 *
 * `env(safe-area-inset-top)` has no JS equivalent, so the value is read back
 * from the --safe-top custom property theme.css declares on :root. Reading the
 * token rather than re-deriving the inset keeps the two from drifting -- the
 * bug that duplicated bottom-edge term caused ten times over.
 */
function readSafeAreaTop(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--safe-top')
  const px = Number.parseFloat(raw)
  return Number.isFinite(px) ? px : 0
}

/**
 * The free band, as pure arithmetic over already-measured numbers.
 *
 * Split out from the hook so the geometry is testable without a DOM (the suite
 * runs on the `node` environment, no jsdom). Every term here is a measurement
 * taken by the caller; this function reads nothing global.
 *
 * @param vvTop     visualViewport.offsetTop — non-zero when iOS pans the page
 * @param vvHeight  visualViewport.height — already shrunk by a NATIVE keyboard
 * @param safeTop   top safe-area inset, the notch/status bar
 * @param obstructionTop  top edge of an in-page obstruction (the virtual
 *                        keyboard), or null when none is up
 */
export function computeFreeBand(
  vvTop: number,
  vvHeight: number,
  safeTop: number,
  obstructionTop: number | null
): { top: number; height: number } {
  const top = vvTop + safeTop
  let height = vvHeight - safeTop
  // Only an obstruction that actually overlaps the band's bottom counts; one
  // already off-screen (mid slide-out) would otherwise shrink it to zero.
  if (obstructionTop !== null && obstructionTop < top + height) {
    height = Math.max(0, obstructionTop - top)
  }
  return { top, height: Math.max(0, height) }
}

export function useFreeViewport(obstructedBy: string | null): { top: number; height: number } {
  // Seeded inset-aware, not as the full screen: the first paint happens before
  // the effect runs, and a band one notch too tall shows as the modal jumping
  // down after open.
  const [box, setBox] = useState(() =>
    computeFreeBand(0, window.innerHeight, readSafeAreaTop(), null)
  )

  useEffect(() => {
    const measure = (): void => {
      const vv = window.visualViewport
      let obstructionTop: number | null = null
      if (obstructedBy) {
        const rect = document.querySelector(obstructedBy)?.getBoundingClientRect()
        // A zero-height rect is an element that isn't really there (unmounted
        // mid-transition); it obstructs nothing.
        if (rect && rect.height > 0) obstructionTop = rect.top
      }
      setBox(
        computeFreeBand(
          vv?.offsetTop ?? 0,
          vv?.height ?? window.innerHeight,
          readSafeAreaTop(),
          obstructionTop
        )
      )
    }

    measure()
    const vv = window.visualViewport
    // `resize` catches the keyboard opening/closing; `scroll` catches iOS
    // panning the visual viewport, which moves offsetTop without a resize.
    vv?.addEventListener('resize', measure)
    vv?.addEventListener('scroll', measure)
    window.addEventListener('resize', measure)
    // The virtual keyboard slides in over ~200ms, so its first rect is mid
    // transition; re-measure once it has landed.
    const settle = window.setTimeout(measure, 260)
    return () => {
      vv?.removeEventListener('resize', measure)
      vv?.removeEventListener('scroll', measure)
      window.removeEventListener('resize', measure)
      window.clearTimeout(settle)
    }
  }, [obstructedBy])

  return box
}

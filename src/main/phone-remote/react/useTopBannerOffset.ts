import { useEffect, useRef } from 'react'

/** Every top banner is `position: fixed` at the same anchor as the header row
 *  (brand mark, status, Chat, History), so a mounted banner paints straight over
 *  those buttons. They stay tappable -- the banners are pointer-events: none --
 *  but they are invisible, which on device reads as the buttons disappearing.
 *
 *  This measures whichever banner is up and publishes it as --top-banner-h, the
 *  single value the header row, the touchpad and the mirror pane all offset by.
 *  Fixed children contribute nothing to a wrapper's box, so the host element
 *  cannot be measured directly -- the banners are found by class instead, which
 *  is also what lets a NEW banner inherit this for free by reusing one of them. */
const BANNER_SELECTOR = '.awayPill, .reconnectBanner, .handsFreePill'

/** Below this a "banner" is a collapsing/zero-box element mid-transition, not
 *  something worth shoving the whole deck down for. */
const MIN_BANNER_H = 4

/** Takes heights rather than the DOM so it is testable under the project's
 *  `node` vitest environment. They stack at one anchor and overlap, so the
 *  offset is the TALLEST box -- summing them would push the deck down by a
 *  banner nobody can see. */
export function tallestBanner(heights: readonly number[]): number {
  const tallest = heights.reduce((max, h) => (h > max ? h : max), 0)
  return tallest < MIN_BANNER_H ? 0 : Math.round(tallest)
}

function measureTopBanner(root: ParentNode): number {
  const els = Array.from(root.querySelectorAll(BANNER_SELECTOR))
  return tallestBanner(els.map((el) => el.getBoundingClientRect().height))
}

/** Writes --top-banner-h on <html> whenever a top banner mounts, unmounts or
 *  reflows. Call once, at App level -- a second caller would fight this one. */
export function useTopBannerOffset(enabled = true): void {
  // Skips the style write when the value is unchanged: this runs from a
  // MutationObserver on the whole subtree, so it fires on unrelated renders.
  const lastRef = useRef<number>(-1)

  useEffect(() => {
    if (!enabled) return
    const root = document.documentElement

    const apply = (): void => {
      const h = measureTopBanner(document)
      if (h === lastRef.current) return
      lastRef.current = h
      root.style.setProperty('--top-banner-h', `${h}px`)
    }

    apply()

    // Both observers are needed: mounting/unmounting a banner is a DOM
    // mutation, while a banner that stays put and reflows (text wrapping to a
    // second line on rotation) is only ever a resize. The mutation pass also
    // re-subscribes the ResizeObserver, since a banner that mounts later never
    // existed at the time this effect ran.
    const ro = new ResizeObserver(apply)
    const mo = new MutationObserver(() => {
      ro.disconnect()
      for (const el of document.querySelectorAll(BANNER_SELECTOR)) ro.observe(el)
      apply()
    })
    for (const el of document.querySelectorAll(BANNER_SELECTOR)) ro.observe(el)
    mo.observe(document.body, { childList: true, subtree: true })

    window.addEventListener('resize', apply)
    window.addEventListener('orientationchange', apply)

    return () => {
      mo.disconnect()
      ro.disconnect()
      window.removeEventListener('resize', apply)
      window.removeEventListener('orientationchange', apply)
      root.style.removeProperty('--top-banner-h')
      lastRef.current = -1
    }
  }, [enabled])
}

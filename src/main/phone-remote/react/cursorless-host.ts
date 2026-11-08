/**
 * Is this host driven by swipes instead of a finger? Answered LIVE.
 *
 * The problem with the `isPointerlessHost` const this replaces was timing, not
 * the test: it ran at import, before first paint, so a host that sizes its
 * frame after load latched the wrong answer forever and every fix gated on it
 * silently did nothing on the one device it was written for.
 *
 * Recomputes on resize and publishes to a `data-cursorless` attribute for CSS
 * and a subscription for React -- one source, two consumers.
 */

import { useSyncExternalStore } from 'react'

/** Meta Ray-Ban Display's viewport is a documented, fixed 600x600 CSS px, and
 *  geometry is the detector because the glasses identify as desktop Chrome --
 *  the UA and every pointer query say "laptop". A host can lie about both; not
 *  about the box it hands us to paint in. A tolerance rather than equality
 *  because a scrollbar would put us a few px off and disable everything. */
const EDGE_PX = 600
const EDGE_TOLERANCE_PX = 40

const OVERRIDE_KEY = 'mm-remote-cursorless'

function readOverride(): boolean | null {
  try {
    const q = new URLSearchParams(window.location.search).get('cursorless')
    if (q === '1') {
      localStorage.setItem(OVERRIDE_KEY, 'on')
      return true
    }
    if (q === '0') {
      localStorage.removeItem(OVERRIDE_KEY)
      return false
    }
    return localStorage.getItem(OVERRIDE_KEY) === 'on' ? true : null
  } catch {
    return null
  }
}

/** The verdict for the viewport as it is RIGHT NOW. */
export function detectCursorless(): boolean {
  if (typeof window === 'undefined') return false
  const override = readOverride()
  if (override !== null) return override
  const near = (n: number): boolean => Math.abs(n - EDGE_PX) <= EDGE_TOLERANCE_PX
  if (near(window.innerWidth) && near(window.innerHeight)) return true
  // Kept as a secondary signal: a host that honestly reports no pointer is
  // cursorless whatever its size. It just cannot be the only signal, since the
  // glasses answer it wrong.
  return window.matchMedia('(any-pointer: none)').matches
}

let current = false
const listeners = new Set<() => void>()

export function isCursorless(): boolean {
  return current
}

export function subscribeCursorless(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Recomputes, and publishes only on a real change -- a resize fires in bursts
 *  and re-rendering the deck on every frame of one would cost more than the
 *  feature. Returns whether the verdict moved. */
export function refreshCursorless(): boolean {
  const next = detectCursorless()
  if (next === current) return false
  current = next
  document.documentElement.dataset.cursorless = next ? 'on' : 'off'
  for (const fn of listeners) fn()
  return true
}

/** Re-renders the caller whenever the verdict flips. The whole reason this
 *  module exists is that a component reading a frozen const could never do
 *  this. */
export function useCursorless(): boolean {
  return useSyncExternalStore(subscribeCursorless, isCursorless, () => false)
}

/** Starts watching. Called once at boot, before React renders. */
export function installCursorlessWatch(): void {
  refreshCursorless()
  window.addEventListener('resize', refreshCursorless)
  // The simulator applies its frame after load without always firing resize on
  // the inner document, and iOS settles its viewport a beat after orientation
  // changes. Two cheap re-checks cover both without a polling loop.
  requestAnimationFrame(refreshCursorless)
  window.setTimeout(refreshCursorless, 500)
}

/** Short host label for the dev log: "glasses" (or whatever else drives this
 *  build without a pointer) vs "phone". Recomputed per call, never cached. */
export function hostTag(): string {
  return detectCursorless() ? 'glasses' : 'phone'
}

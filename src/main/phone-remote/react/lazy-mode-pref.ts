// lazy-mode-pref.ts -- "the phone is lying on my desk, make it one big button".
//
// Lazy mode paints a large mic in the middle of the trackpad. The pad keeps
// tracking underneath it, so this only decides whether the button is painted --
// never whether the pad works.
//
// Phone-local like the other display prefs (see the prefs split in CLAUDE.md):
// which phone is acting as a desk recorder is that phone's business, and the
// Mac has nothing to do with it.

import { useSyncExternalStore } from 'react'

const LAZY_MODE_PREF_KEY = 'mm-remote-lazy-mode'

export function getLazyModeEnabled(): boolean {
  try {
    // Default OFF -- absence of the key means "never turned on", and a mic
    // appearing over the pad unasked would read as a bug.
    return localStorage.getItem(LAZY_MODE_PREF_KEY) === 'on'
  } catch {
    return false
  }
}

// The Settings sheet renders OVER a live deck, so the button has to appear the
// moment the switch flips -- a useState seeded from the getter goes stale
// behind the sheet. Same reason debug-layout.ts carries a store rather than a
// plain read: localStorage is not something React can subscribe to, and a
// JSX-gated surface that misses the change stays unmounted until a reload.
const listeners = new Set<() => void>()

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function setLazyModeEnabled(value: boolean): void {
  try {
    localStorage.setItem(LAZY_MODE_PREF_KEY, value ? 'on' : 'off')
  } catch {
    /* private mode -- the pref just doesn't persist */
  }
  // Outside the try: a phone that can't persist should still flip for this
  // session, or the switch reads as broken rather than as not-remembered.
  listeners.forEach((fn) => fn())
}

/** Re-renders the caller whenever lazy mode flips. */
export function useLazyMode(): boolean {
  return useSyncExternalStore(subscribe, getLazyModeEnabled, () => false)
}

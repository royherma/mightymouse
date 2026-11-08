import { useSyncExternalStore } from 'react'

export type ScreenShareLayout = 'full' | 'trackpad' | 'mac'

const KEY = 'mm-remote-screen-share-layout'

const listeners = new Set<() => void>()

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getScreenShareLayout(): ScreenShareLayout {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'trackpad' || v === 'mac' ? v : 'full'
  } catch {
    return 'full'
  }
}

export function setScreenShareLayout(value: ScreenShareLayout): void {
  try {
    localStorage.setItem(KEY, value)
  } catch {
    /* private mode */
  }
  listeners.forEach((fn) => fn())
}

export function useScreenShareLayout(): ScreenShareLayout {
  return useSyncExternalStore(subscribe, getScreenShareLayout, () => 'full' as const)
}

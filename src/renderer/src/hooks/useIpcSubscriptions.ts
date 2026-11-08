import { useEffect } from 'react'

type Unsubscribe = () => void

/**
 * Subscribe to one or more IPC channels for the lifetime of a component.
 * Each entry returns its own unsubscribe fn (the shape every `window.api.onX`
 * already returns); this hook calls them all on unmount. Replaces the
 * copy-pasted "subscribe N channels, return cleanup that unsubs all" effect.
 *
 * Pass a `deps` array when any subscriber closes over changing values.
 */
export function useIpcSubscriptions(
  subscribe: () => Unsubscribe[],
  deps: React.DependencyList = []
): void {
  useEffect(() => {
    const unsubs = subscribe()
    return () => unsubs.forEach((off) => off())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}

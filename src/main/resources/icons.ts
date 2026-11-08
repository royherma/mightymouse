import { app } from 'electron'

const cache = new Map<string, string>()
const inFlight = new Set<string>()

export function iconDataUrlFor(bundlePath: string | undefined): string | undefined {
  if (!bundlePath) return undefined
  const hit = cache.get(bundlePath)
  if (hit) return hit
  if (!inFlight.has(bundlePath)) {
    inFlight.add(bundlePath)
    app
      .getFileIcon(bundlePath, { size: 'small' })
      .then((img) => cache.set(bundlePath, img.toDataURL()))
      .catch(() => {})
      .finally(() => inFlight.delete(bundlePath))
  }
  return undefined
}

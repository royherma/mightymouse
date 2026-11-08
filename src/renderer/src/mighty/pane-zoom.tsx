import { useEffect, useSyncExternalStore, type JSX, type ReactNode } from 'react'
import { Search } from 'lucide-react'
import { Button } from '../components/Button'
import { CONFIG } from '../../../shared/config'
import { zoomLevelToPercent } from '../../../shared/zoom'
import type { ZoomKey } from '../../../shared/types'

const STORAGE_KEY = 'mm.paneZoomLevel'
const { STEP, MIN_LEVEL, MAX_LEVEL, DEFAULT_LEVEL } = CONFIG.MIGHTY.ZOOM

function load(): number {
  try {
    const saved = Number(localStorage.getItem(STORAGE_KEY))
    return Number.isFinite(saved) ? saved : DEFAULT_LEVEL
  } catch {
    return DEFAULT_LEVEL
  }
}

let paneLevel = load()
const listeners = new Set<() => void>()

function setPaneLevel(level: number): void {
  paneLevel = Math.min(Math.max(level, MIN_LEVEL), MAX_LEVEL)
  try {
    localStorage.setItem(STORAGE_KEY, String(paneLevel))
  } catch {
    // zoom still applies for this session
  }
  listeners.forEach((l) => l())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

async function applyZoomKey(key: ZoomKey): Promise<void> {
  const delta = key === 'in' ? STEP : key === 'out' ? -STEP : null
  const panesShowing = [...document.querySelectorAll<HTMLElement>('[data-pane-zoom]')].some(
    (el) => el.offsetParent
  )
  if (panesShowing) return setPaneLevel(delta === null ? DEFAULT_LEVEL : paneLevel + delta)
  const level = delta === null ? DEFAULT_LEVEL : (await window.api.mighty.getZoomLevel()) + delta
  await window.api.mighty.setZoomLevel(level)
}

export function usePaneZoomKeys(): void {
  useEffect(() => window.api.mighty.onZoomKey((key) => void applyZoomKey(key)), [])
}

function usePaneLevel(): number {
  return useSyncExternalStore(subscribe, () => paneLevel)
}

export function PaneZoom({ children }: { children: ReactNode }): JSX.Element {
  const level = usePaneLevel()
  return (
    <div
      data-pane-zoom
      className="h-full w-full"
      style={level === DEFAULT_LEVEL ? undefined : { zoom: 1.2 ** level }}
    >
      {children}
    </div>
  )
}

export function PaneZoomIndicator(): JSX.Element | null {
  const level = usePaneLevel()
  if (level === DEFAULT_LEVEL) return null
  const percent = zoomLevelToPercent(level)
  return (
    <Button
      variant="bare"
      onClick={() => setPaneLevel(DEFAULT_LEVEL)}
      title={`Chats at ${percent}% - click to reset to 100% (⌘0)`}
      className="flex items-center gap-1 text-xs font-bold uppercase tracking-wide text-on-surface bg-surface2 rounded-md px-1.5 py-1 hover:bg-surface3"
    >
      <Search size={12} />
      {percent}%
    </Button>
  )
}

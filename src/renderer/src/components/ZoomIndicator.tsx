import { useEffect, useState, type JSX } from 'react'
import { Search } from 'lucide-react'
import { zoomLevelToPercent } from '../../../shared/zoom'
import { CONFIG } from '../../../shared/config'
import { Button } from './Button'

/**
 * The window's zoom readout. Renders NOTHING at 100% — an always-on "100%" is
 * noise, and the whole point is to answer "why does this look wrong?" the moment
 * you're off the default. Click to snap back to 100%.
 *
 * Main owns the level (it clamps, persists, and broadcasts it), so this only
 * mirrors what it's told. Keyboard zoom is intercepted in mighty-window.ts —
 * ⌘+/⌘-/⌘0 never reach the renderer.
 */
export function ZoomIndicator(): JSX.Element | null {
  // Explicit <number>: CONFIG.MIGHTY is `as const`, so DEFAULT_LEVEL's type is the
  // literal 0 and inference would pin the state to it.
  const [level, setLevel] = useState<number>(CONFIG.MIGHTY.ZOOM.DEFAULT_LEVEL)

  useEffect(() => {
    void window.api.mighty.getZoomLevel().then(setLevel)
    return window.api.mighty.onZoomChanged(setLevel)
  }, [])

  const percent = zoomLevelToPercent(level)
  if (percent === zoomLevelToPercent(CONFIG.MIGHTY.ZOOM.DEFAULT_LEVEL)) return null

  return (
    <Button
      variant="bare"
      onClick={() => void window.api.mighty.setZoomLevel(CONFIG.MIGHTY.ZOOM.DEFAULT_LEVEL)}
      title={`Zoom ${percent}% - click to reset to 100% (⌘0)`}
      className="flex items-center gap-1 text-xs font-bold uppercase tracking-wide text-on-surface bg-surface2 rounded-md px-1.5 py-1 -mx-1.5 hover:bg-surface3"
    >
      <Search size={12} />
      {percent}%
    </Button>
  )
}

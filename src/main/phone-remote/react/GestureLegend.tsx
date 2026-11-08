import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { PINCH_ZOOM_ENABLED, SMART_ZOOM_ENABLED } from './pinch-zoom'
import { Button } from '@shared/ui/Button'

const GESTURES = [
  { name: '1 finger, drag', action: 'Move cursor' },
  { name: '1 finger, tap', action: 'Click' },
  { name: '1 finger, double-tap', action: 'Double-click' },
  { name: '1 finger, hold + drag', action: 'Click-and-drag' },
  { name: '2 fingers, drag', action: 'Scroll' },
  ...(PINCH_ZOOM_ENABLED ? [{ name: '2 fingers, pinch', action: 'Zoom in and out' }] : []),
  { name: '2 fingers, tap', action: 'Right-click' },
  ...(SMART_ZOOM_ENABLED ? [{ name: '2 fingers, double-tap', action: 'Zoom to fit' }] : []),
  { name: 'Line down the edge', action: 'Scroll bar' }
]

export interface GestureLegendProps {
  /** Whether a second screen is showing your Mac right now. The zoom track
   *  only exists while that is true, so listing it otherwise would name a
   *  control the reader cannot find anywhere on the deck. */
  glassesAttached?: boolean
}

// Reference list of every supported trackpad gesture -- collapsed by default
// since the trackpad's own hint text already covers the common ones; this is
// for when someone wants the full list without it always eating vertical
// space in the settings panel.
export default function GestureLegend({
  glassesAttached = false
}: GestureLegendProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const gestures = glassesAttached
    ? [
        ...GESTURES,
        { name: 'Thumb on the outer ring', action: 'Make the picture bigger' },
        { name: 'Swipe on your glasses', action: 'Move around your screen' },
        { name: 'Pinch on your glasses', action: 'Switch between moving and zooming' }
      ]
    : GESTURES

  return (
    <div className="gestureLegend">
      <Button
        variant="bare"
        type="button"
        className="gestureLegendToggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span>Gestures</span>
        <ChevronDown size={16} className={`gestureLegendChevron${open ? ' open' : ''}`} />
      </Button>
      {open && (
        <div className="gestureLegendBody">
          {gestures.map((g) => (
            <div className="gestureRow" key={g.name}>
              <span className="gestureName">{g.name}</span>
              <span className="gestureAction">{g.action}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

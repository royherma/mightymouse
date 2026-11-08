import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { CONFIG } from '@shared/config'
import type { PhoneRemoteMessage } from '@shared/phone-remote-protocol'

type Args = {
  send: (message: PhoneRemoteMessage) => void
  // True while this phone is attached to a remote picture (glasses//viewer).
  zoomTrackOn: boolean
  setRingZoomScaleValueRef: MutableRefObject<((scale: number) => void) | null>
}

/**
 * The ring-zoom track and the minimap, as driven by a phone that is CONTROLLING a
 * remote picture rather than showing one. Both values live here because this device
 * has no picture of its own to read them off.
 */
export function useViewerControls({ send, zoomTrackOn, setRingZoomScaleValueRef }: Args) {
  // The zoom the ring track has PUBLISHED to the viewer. Its own state rather
  // than mirrorZoom.scale: a controller driving glasses has no picture of its
  // own, so mirrorZoom stays at 1 here and reading it would peg the knob to the
  // bottom of the track no matter where the thumb left it.
  const [ringZoomScaleValue, setRingZoomScaleValue] = useState(
    CONFIG.PHONE_REMOTE.MIRROR_ZOOM_CURSORLESS_BASE
  )
  // Read by the attach effect below, which must not re-run on every knob move.
  const ringZoomScaleValueRef = useRef(ringZoomScaleValue)
  ringZoomScaleValueRef.current = ringZoomScaleValue
  // Lets the WS handler repaint the knob when the glasses report their own
  // zoom. Assigned during render rather than in an effect so a report arriving
  // on the very first frame is not dropped.
  setRingZoomScaleValueRef.current = setRingZoomScaleValue
  const onRingZoom = useCallback(
    (scale: number) => {
      setRingZoomScaleValue(scale)
      send({ type: 'mirrorViewerZoom', scale })
    },
    [send]
  )
  // On ATTACH the phone ASKS rather than asserting: pushing its own knob value
  // here reset glasses already sitting at 3x, since a fresh phone starts at the
  // base and the glasses hold the real value.
  useEffect(() => {
    if (!zoomTrackOn) {
      setRingZoomScaleValue(CONFIG.PHONE_REMOTE.MIRROR_ZOOM_CURSORLESS_BASE)
      return
    }
    send({ type: 'mirrorViewerZoomRequest' })
  }, [zoomTrackOn, send])

  // Where the minimap says the glasses are aimed, in normalized desktop space.
  // Its own state for the same reason ringZoomScaleValue is: this device has no
  // picture, so there is nothing local to read it off. Centre until a drag says
  // otherwise -- the glasses start parked on the cursor, but the phone is not
  // told where that is until the first cursorPos arrives.
  const [minimapCentre, setMinimapCentre] = useState({ x: 0.5, y: 0.5 })
  const minimapCentreRef = useRef(minimapCentre)
  minimapCentreRef.current = minimapCentre
  // Coalesces a drag's touchmove burst to one send per frame budget. The value
  // is a POSITION, not a delta, so dropping intermediate frames only ever costs
  // smoothness -- never accumulated error, which is why this can throttle at all.
  const minimapSentAtRef = useRef(0)
  const onMinimapPan = useCallback(
    (point: { x: number; y: number }) => {
      setMinimapCentre(point)
      const now = Date.now()
      if (now - minimapSentAtRef.current < CONFIG.PHONE_REMOTE.MIRROR_VIEWER_PAN_THROTTLE_MS) {
        return
      }
      minimapSentAtRef.current = now
      send({ type: 'mirrorViewerPan', x: point.x, y: point.y })
    },
    [send]
  )
  // Same contract as the zoom re-assert above: the phone owns this value, so on
  // attach it restates it rather than asking, and on detach it resets so a
  // stale box can't claim the next glasses are looking somewhere they aren't.
  useEffect(() => {
    if (!zoomTrackOn) {
      setMinimapCentre({ x: 0.5, y: 0.5 })
      return
    }
    send({ type: 'mirrorViewerPan', ...minimapCentreRef.current })
    // minimapCentre is deliberately not a dep -- same echo reasoning as the
    // zoom effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomTrackOn, send])

  return { ringZoomScaleValue, onRingZoom, minimapCentre, onMinimapPan }
}

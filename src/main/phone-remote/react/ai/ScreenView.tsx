import { useEffect, useRef, useState } from 'react'
import { Keyboard, Laptop, MessageSquare, MonitorX, Mouse, ZoomIn } from 'lucide-react'
import type { PhoneRemoteMessage } from '@shared/phone-remote-protocol'
import { hapticTick } from '../haptics'
import {
  PINCH_ZOOM_ENABLED,
  decideTwoFingerMode,
  touchSpread,
  zoomStepsFor,
  type TwoFingerMode
} from '../pinch-zoom'
import {
  DOUBLE_TAP_MAX_MS,
  DRAG_HOLD_MS,
  MOVE_THROTTLE_MS,
  TAP_MAX_MOVE_PX,
  TAP_MAX_MS
} from '../hooks/use-trackpad'
import { Button } from '@shared/ui/Button'

type ScreenMode = 'trackpad' | 'zoom'
const MODE_KEY = 'mm.ai.screenMode'
export const KEYS_KEY = 'mm.ai.screenKeys'

function readMode(): ScreenMode {
  try {
    return localStorage.getItem(MODE_KEY) === 'zoom' ? 'zoom' : 'trackpad'
  } catch {
    return 'trackpad'
  }
}

function readKeysShown(): boolean {
  try {
    return localStorage.getItem(KEYS_KEY) !== '0'
  } catch {
    return true
  }
}

export function TrackpadSurface({
  send,
  hint = 'Drag here to move the pointer'
}: {
  send: (msg: PhoneRemoteMessage) => void
  hint?: string
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const [dots, setDots] = useState<{ id: number; x: number; y: number }[]>([])

  useEffect(() => {
    const el = ref.current
    if (!el) return undefined
    let twoFingerMode: TwoFingerMode = 'undecided'
    let startSpread = 0
    let lastSpread = 0
    let pendingZoomPx = 0
    let lastX = 0
    let lastY = 0
    let startX = 0
    let startY = 0
    let startAt = 0
    let fingers = 0
    let moved = 0
    let dragging = false
    let pendingDx = 0
    let pendingDy = 0
    let lastSentAt = 0
    let holdTimer: number | null = null
    let tapTimer: number | null = null
    let lastTapAt = 0

    const center = (t: TouchList): { x: number; y: number } => {
      let x = 0
      let y = 0
      for (let i = 0; i < t.length; i++) {
        x += t[i].clientX
        y += t[i].clientY
      }
      return { x: x / t.length, y: y / t.length }
    }
    const spreadOf = (t: TouchList): number =>
      t.length >= 2 ? touchSpread(t[0].clientX, t[0].clientY, t[1].clientX, t[1].clientY) : 0
    const syncDots = (t: TouchList): void => {
      const rect = el.getBoundingClientRect()
      const next: { id: number; x: number; y: number }[] = []
      for (let i = 0; i < t.length; i++) {
        next.push({ id: t[i].identifier, x: t[i].clientX - rect.left, y: t[i].clientY - rect.top })
      }
      setDots(next)
    }
    const clearHold = (): void => {
      if (holdTimer !== null) window.clearTimeout(holdTimer)
      holdTimer = null
    }
    const flush = (): void => {
      if (pendingDx === 0 && pendingDy === 0) return
      const dx = pendingDx
      const dy = pendingDy
      pendingDx = 0
      pendingDy = 0
      lastSentAt = Date.now()
      if (fingers >= 2) send({ type: 'scroll', dx, dy })
      else send(dragging ? { type: 'dragMove', dx, dy } : { type: 'move', dx, dy })
    }

    const onStart = (e: TouchEvent): void => {
      e.preventDefault()
      syncDots(e.touches)
      const p = center(e.touches)
      lastX = p.x
      lastY = p.y
      if (e.touches.length === 1) {
        startX = p.x
        startY = p.y
        startAt = Date.now()
        moved = 0
        fingers = 1
        twoFingerMode = 'undecided'
        pendingZoomPx = 0
        clearHold()
        holdTimer = window.setTimeout(() => {
          holdTimer = null
          if (moved > TAP_MAX_MOVE_PX) return
          dragging = true
          hapticTick()
          send({ type: 'dragStart' })
        }, DRAG_HOLD_MS)
      } else {
        fingers = Math.max(fingers, e.touches.length)
        clearHold()
        startSpread = spreadOf(e.touches)
        lastSpread = startSpread
      }
    }
    const onMove = (e: TouchEvent): void => {
      e.preventDefault()
      const p = center(e.touches)
      const dx = p.x - lastX
      const dy = p.y - lastY
      lastX = p.x
      lastY = p.y
      syncDots(e.touches)
      moved = Math.max(moved, Math.hypot(p.x - startX, p.y - startY))
      if (moved > TAP_MAX_MOVE_PX) clearHold()
      if (PINCH_ZOOM_ENABLED && e.touches.length >= 2) {
        const spread = spreadOf(e.touches)
        if (startSpread === 0) {
          startSpread = spread
          lastSpread = spread
        }
        twoFingerMode = decideTwoFingerMode(twoFingerMode, spread - startSpread, moved, TAP_MAX_MOVE_PX)
        if (twoFingerMode === 'undecided') return
        if (twoFingerMode === 'zooming') {
          pendingZoomPx += spread - lastSpread
          lastSpread = spread
          const { steps, remainderPx } = zoomStepsFor(pendingZoomPx)
          pendingZoomPx = remainderPx
          if (steps !== 0) {
            hapticTick()
            send({ type: 'padZoom', steps })
          }
          return
        }
      }
      pendingDx += dx
      pendingDy += dy
      if (Date.now() - lastSentAt >= MOVE_THROTTLE_MS) flush()
    }
    const onEnd = (e: TouchEvent): void => {
      e.preventDefault()
      syncDots(e.touches)
      if (e.touches.length > 0) {
        const p = center(e.touches)
        lastX = p.x
        lastY = p.y
        return
      }
      clearHold()
      flush()
      const quick =
        Date.now() - startAt <= TAP_MAX_MS && moved <= TAP_MAX_MOVE_PX && twoFingerMode !== 'zooming'
      if (dragging) {
        dragging = false
        send({ type: 'dragEnd' })
      } else if (quick && fingers >= 2) {
        hapticTick()
        send({ type: 'twoFingerTap' })
      } else if (quick) {
        const now = Date.now()
        if (tapTimer !== null && now - lastTapAt <= DOUBLE_TAP_MAX_MS) {
          window.clearTimeout(tapTimer)
          tapTimer = null
          hapticTick()
          send({ type: 'doubleTap' })
        } else {
          lastTapAt = now
          tapTimer = window.setTimeout(() => {
            tapTimer = null
            hapticTick()
            send({ type: 'tap' })
          }, DOUBLE_TAP_MAX_MS)
        }
      }
      fingers = 0
      twoFingerMode = 'undecided'
      pendingZoomPx = 0
      startSpread = 0
    }

    el.addEventListener('touchstart', onStart, { passive: false })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd, { passive: false })
    el.addEventListener('touchcancel', onEnd, { passive: false })
    return () => {
      clearHold()
      if (tapTimer !== null) window.clearTimeout(tapTimer)
      if (dragging) send({ type: 'dragEnd' })
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onEnd)
    }
  }, [send])

  return (
    <div ref={ref} className="aiScreenPad" aria-label="Trackpad">
      <div className="aiScreenPadHint">{hint}</div>
      {dots.map((d, i) => (
        <div key={d.id} className={`touchDot active${i > 0 ? ' secondary' : ''}`} style={{ left: d.x, top: d.y }} />
      ))}
    </div>
  )
}

export function ScreenView(props: {
  pane?: React.ReactNode
  controls?: React.ReactNode
  macName: string | null
  send: (msg: PhoneRemoteMessage) => void
  onBack: () => void
  stop?: boolean
}): React.JSX.Element {
  const [mode, setMode] = useState<ScreenMode>(readMode)
  const [keysShown, setKeysShown] = useState(readKeysShown)
  const leaving = props.stop || !props.controls

  const toggleKeys = (): void => {
    hapticTick()
    setKeysShown((shown) => {
      try {
        localStorage.setItem(KEYS_KEY, shown ? '0' : '1')
      } catch {
        /* private mode */
      }
      return !shown
    })
  }

  const pick = (next: ScreenMode): void => {
    hapticTick()
    setMode(next)
    try {
      localStorage.setItem(MODE_KEY, next)
    } catch {
      /* private mode */
    }
  }

  return (
    <div className="aiScreen" data-mode={mode}>
      {props.pane ?? <div className="aiScreenWait">Connecting to your Mac…</div>}
      {mode === 'trackpad' && <TrackpadSurface send={props.send} />}
      <div className="aiScreenTop">
        <div className="aiScreenLeft">
          <Button
            variant="bare"
            type="button"
            className="aiScreenBack"
            aria-label={leaving ? 'Stop showing the Mac screen' : 'Back to chat'}
            onClick={props.onBack}
          >
            {leaving ? <MonitorX size={17} /> : <MessageSquare size={17} />}
            {leaving ? 'Stop viewing' : 'Chat'}
          </Button>
        </div>
        <div className="aiScreenRight">
          <div className="aiScreenModes" role="radiogroup" aria-label="How your finger works">
            <Button variant="bare" type="button" role="radio" aria-checked={mode === 'trackpad'} onClick={() => pick('trackpad')}>
              <Mouse size={15} />
              Click
            </Button>
            <Button variant="bare" type="button" role="radio" aria-checked={mode === 'zoom'} onClick={() => pick('zoom')}>
              <ZoomIn size={15} />
              Zoom
            </Button>
          </div>
          {mode === 'zoom' && <div className="aiScreenMac aiScreenHint">Pinch to zoom, drag to move around</div>}
          {props.macName && (
            <div className="aiScreenMac">
              <Laptop size={13} />
              {props.macName}
            </div>
          )}
        </div>
      </div>
      {props.controls && keysShown && (
        <div className="sessionScreenControlsFloat">{props.controls}</div>
      )}
      {props.controls && (
        <Button
          variant="bare"
          type="button"
          className="aiScreenKeys"
          aria-pressed={keysShown}
          onClick={toggleKeys}
        >
          <Keyboard size={18} />
          {keysShown ? 'Hide keys' : 'Show keys'}
        </Button>
      )}
    </div>
  )
}

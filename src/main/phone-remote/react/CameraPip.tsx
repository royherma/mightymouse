import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Circle,
  FlipHorizontal2,
  Glasses,
  RectangleHorizontal,
  RectangleVertical,
  Smartphone,
  X,
  type LucideIcon
} from 'lucide-react'
import { hapticTick } from './haptics'
import { nativeBridge, subscribeNativeIntent, type GlassesSource } from './native-bridge'
import { clampRect, useFloatingRect, viewportReady } from './hooks/use-floating-rect'
import { Button } from '@shared/ui/Button'

// Self-camera PiP for framing a reaction shot (recorded separately, e.g. a
// screen recording or a physical camera) -- purely local to the phone, never
// sent over the WS/WebRTC. See SettingsBody.tsx's "Camera" toggle for how
// this is opened; App.tsx mounts it once, as a sibling of Classic/Pro, so it
// floats above whichever layout is active.

const OPEN_PREF_KEY = 'mm-remote-camera-open'
const FACING_PREF_KEY = 'mm-remote-camera-facing'
const RECT_PREF_KEY = 'mm-remote-camera-rect'
const SHAPE_PREF_KEY = 'mm-remote-camera-shape'
const SOURCE_PREF_KEY = 'mm-remote-camera-source'

type FacingMode = 'user' | 'environment'

/** Frame shape -- the PiP is a framing aid for a reaction shot, so it has to be
 *  able to match the aspect of whatever you're actually recording. */
const CAMERA_SHAPE = {
  landscape: 'landscape',
  portrait: 'portrait',
  circle: 'circle'
} as const
type CameraShape = (typeof CAMERA_SHAPE)[keyof typeof CAMERA_SHAPE]

/** width / height per shape. Circle is 1:1 with a 50% border-radius. */
const SHAPE_ASPECT: Record<CameraShape, number> = {
  [CAMERA_SHAPE.landscape]: 4 / 3,
  [CAMERA_SHAPE.portrait]: 3 / 4,
  [CAMERA_SHAPE.circle]: 1
}

/** Phone first: it is what every user has, and the glasses are the opt-in. */
const SOURCE_OPTIONS: readonly { source: GlassesSource; label: string; Icon: LucideIcon }[] = [
  { source: 'phone', label: 'Phone camera', Icon: Smartphone },
  { source: 'glasses', label: 'Glasses camera', Icon: Glasses }
]

/** Display order in the picker popover, each with the icon that represents it. */
const SHAPE_OPTIONS: readonly { shape: CameraShape; label: string; Icon: LucideIcon }[] = [
  { shape: CAMERA_SHAPE.landscape, label: 'Landscape', Icon: RectangleHorizontal },
  { shape: CAMERA_SHAPE.portrait, label: 'Portrait', Icon: RectangleVertical },
  { shape: CAMERA_SHAPE.circle, label: 'Circle', Icon: Circle }
]

// Default: bottom-right corner, small enough to stay out of the touchpad's
// way but big enough to actually see your framing.
// 12s: a cold Bluetooth wake plus SDK handshake runs past 8s on a good day,
// so anything tighter reports a failure the glasses were about to recover from.
const GLASSES_FIRST_FRAME_TIMEOUT_MS = 12_000

const DEFAULT_W = 132
const MIN_W = 84
const MAX_W = 320

/** Bottom-right-ish corner: out of the touchpad's way, still big enough to
 *  frame yourself in. */
function placeDefault(w: number): { x: number; y: number } {
  return {
    x: Math.max(12, window.innerWidth - w - 16),
    y: Math.max(12, window.innerHeight * 0.14)
  }
}

function readBoolPref(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? fallback : raw === '1'
  } catch {
    return fallback
  }
}

function writeBoolPref(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? '1' : '0')
  } catch {
    // Private-mode storage failure -- in-memory value still applies this session.
  }
}

function readFacingPref(): FacingMode {
  try {
    return localStorage.getItem(FACING_PREF_KEY) === 'environment' ? 'environment' : 'user'
  } catch {
    return 'user'
  }
}

function writeFacingPref(value: FacingMode): void {
  try {
    localStorage.setItem(FACING_PREF_KEY, value)
  } catch {
    // Best-effort.
  }
}

function readSourcePref(): GlassesSource {
  try {
    return localStorage.getItem(SOURCE_PREF_KEY) === 'glasses' ? 'glasses' : 'phone'
  } catch {
    return 'phone'
  }
}

function writeSourcePref(value: GlassesSource): void {
  try {
    localStorage.setItem(SOURCE_PREF_KEY, value)
  } catch {
    // Best-effort.
  }
}

function isCameraShape(value: unknown): value is CameraShape {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SHAPE_ASPECT, value)
}

function readShapePref(): CameraShape {
  try {
    const raw = localStorage.getItem(SHAPE_PREF_KEY)
    return isCameraShape(raw) ? raw : CAMERA_SHAPE.landscape
  } catch {
    return CAMERA_SHAPE.landscape
  }
}

function writeShapePref(value: CameraShape): void {
  try {
    localStorage.setItem(SHAPE_PREF_KEY, value)
  } catch {
    // Best-effort.
  }
}

/** Flip takes a DOUBLE tap: a single tap on a draggable overlay is too easy to
 *  fire by accident, and flipping re-opens the camera (a visible stall). */
const DOUBLE_TAP_MAX_GAP_MS = 300

export default function CameraPip(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Admin-only, so a normal user never sees the Phone/Glasses picker at all. */
  showSourcePicker?: boolean
  log?: (message: string) => void
}): React.JSX.Element | null {
  const { open, onOpenChange, showSourcePicker = false, log } = props
  const logRef = useRef(log)
  logRef.current = log
  const [facing, setFacing] = useState<FacingMode>(readFacingPref)
  const [shape, setShape] = useState<CameraShape>(readShapePref)
  const [shapeMenuOpen, setShapeMenuOpen] = useState(false)
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [error, setError] = useState<string | null>(null)
  // A picker the user can't see must never select a source they can't leave.
  const [source, setSource] = useState<GlassesSource>(() =>
    showSourcePicker ? readSourcePref() : 'phone'
  )
  const [glassesFrame, setGlassesFrame] = useState<string | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const pipRef = useRef<HTMLDivElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  // A tap is only meaningful once a pair lands inside the window, so the count
  // lives here rather than in the shared layout hook.
  const lastTapAtRef = useRef(0)
  // `flip` is defined below (it closes over the camera state), so the tap
  // callback reaches it through a ref rather than reordering the file.
  const flipRef = useRef<() => void>(() => {})

  // Drag, pinch, clamp and persistence are the shared floating-overlay machine.
  // Only tap-to-flip and the shape picker are camera-specific, so only they
  // stay in this file.
  const { rect, setRect } = useFloatingRect(pipRef, {
    prefKey: RECT_PREF_KEY,
    aspect: SHAPE_ASPECT[shape],
    minW: MIN_W,
    maxW: MAX_W,
    defaultW: DEFAULT_W,
    place: placeDefault,
    enabled: open,
    isInteractive: (target) =>
      target instanceof Element && target.closest('button, .cameraPipShapeMenu') !== null,
    // A touch on the frame itself means the picker lost focus -- dismiss it
    // like any popover tapped away from.
    onDragStart: () => setShapeMenuOpen(false),
    onTap: () => {
      // Second tap inside the window flips; otherwise this becomes the first
      // tap of a possible pair. Reset after flipping so a third tap does not
      // immediately count as another double.
      const now = Date.now()
      if (now - lastTapAtRef.current <= DOUBLE_TAP_MAX_GAP_MS) {
        lastTapAtRef.current = 0
        flipRef.current()
      } else {
        lastTapAtRef.current = now
      }
    }
  })
  const rectRef = useRef(rect)
  rectRef.current = rect

  useEffect(() => {
    if (!open) return
    logRef.current?.(
      `[pip] mount vp=${window.innerWidth}x${window.innerHeight} rect=${Math.round(rectRef.current.x)},${Math.round(rectRef.current.y)},w${Math.round(rectRef.current.w)} saved=${localStorage.getItem(RECT_PREF_KEY) ?? 'none'} node=${pipRef.current ? 'yes' : 'NO'}`
    )
  }, [open])

  // A first render before the webview has a size computed rect against zero,
  // so re-place once real dimensions arrive.
  const placedRef = useRef(viewportReady())
  useEffect(() => {
    if (placedRef.current) return
    const place = (): void => {
      if (placedRef.current || !viewportReady()) return
      placedRef.current = true
      setRect({ w: DEFAULT_W, ...placeDefault(DEFAULT_W) })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [])

  const openCamera = useCallback((mode: FacingMode) => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setError(window.isSecureContext ? 'Camera not supported' : 'Needs a secure connection (https)')
      return
    }
    setError(null)
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: mode }, audio: false })
      .then((s) => {
        // A flip mid-open can resolve out of order -- only apply the stream
        // if this is still the facing mode that's actually wanted.
        if (facingRef.current !== mode) {
          s.getTracks().forEach((tr) => tr.stop())
          return
        }
        streamRef.current?.getTracks().forEach((tr) => tr.stop())
        streamRef.current = s
        setStream(s)
      })
      .catch(() => {
        setError('Camera access needed')
      })
  }, [])

  // Ref mirror so the async getUserMedia .then() above always checks the
  // CURRENT facing mode, not the one closed over at call time.
  const facingRef = useRef(facing)
  facingRef.current = facing

  // One source at a time: opening either path stops the other first, so the
  // phone camera is never left holding the LED on behind a glasses feed.
  const stopPhoneCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((tr) => tr.stop())
    streamRef.current = null
    setStream(null)
  }, [])

  useEffect(() => {
    if (!open) {
      stopPhoneCamera()
      nativeBridge.glassesCameraStop()
      setGlassesFrame(null)
      setShapeMenuOpen(false)
      return
    }
    if (source === 'glasses') {
      stopPhoneCamera()
      setError(null)
      setGlassesFrame(null)
      nativeBridge.glassesCameraStart()
    } else {
      nativeBridge.glassesCameraStop()
      setGlassesFrame(null)
      openCamera(facingRef.current)
    }
    return () => {
      stopPhoneCamera()
      nativeBridge.glassesCameraStop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, source])

  // The glasses report their own reasons; the page shows what was STATED and
  // never infers one from a frame that didn't arrive
  // (src/main/phone-remote/CLAUDE.md).
  useEffect(() => {
    if (!open || source !== 'glasses') return undefined
    logRef.current?.('[glasses] start requested, waiting for first frame')
    let frames = 0
    return subscribeNativeIntent((event) => {
      if (event.type === 'glassesFrame') {
        frames += 1
        if (frames === 1) logRef.current?.('[glasses] FIRST FRAME received')
        setError(null)
        setGlassesFrame(event.b64)
        return
      }
      logRef.current?.(`[glasses] event ${event.type} ${JSON.stringify(event)}`)
      if (event.type === 'glassesUnavailable') setError(event.message)
      if (event.type === 'glassesAvailability' && !event.available) setError(event.message)
    }, [])
  }, [open, source])

  // Glasses that never answer report nothing at all, so without this the PiP
  // sits on "Starting your glasses…" forever with no way back to the phone.
  useEffect(() => {
    if (!open || source !== 'glasses' || glassesFrame) return undefined
    const timer = setTimeout(() => {
      logRef.current?.('[glasses] no frame within timeout')
      setError('Your glasses did not answer. Check they are on and connected.')
    }, GLASSES_FIRST_FRAME_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [open, source, glassesFrame])

  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    v.srcObject = stream
    if (stream) v.play().catch(() => {})
  }, [stream])

  const flip = useCallback(() => {
    // The glasses have one camera, so there is nothing to flip to.
    if (sourceRef.current === 'glasses') return
    hapticTick()
    const next: FacingMode = facing === 'user' ? 'environment' : 'user'
    setFacing(next)
    writeFacingPref(next)
    openCamera(next)
  }, [facing, openCamera])
  flipRef.current = flip

  // Same ref-mirror reason as facingRef: the frame's native touch listeners
  // bind once per open and would otherwise flip against a stale source.
  const sourceRef = useRef(source)
  sourceRef.current = source

  const pickSource = useCallback((next: GlassesSource) => {
    hapticTick()
    setSource(next)
    writeSourcePref(next)
    setError(null)
  }, [])

  // Changing shape changes the height, so re-clamp against the NEW aspect --
  // a tall portrait frame at the bottom edge would otherwise hang off-screen.
  const pickShape = useCallback((next: CameraShape) => {
    hapticTick()
    setShape(next)
    writeShapePref(next)
    setRect((r) =>
      clampRect(r, {
        prefKey: RECT_PREF_KEY,
        aspect: SHAPE_ASPECT[next],
        minW: MIN_W,
        maxW: MAX_W,
        defaultW: DEFAULT_W,
        place: placeDefault
      })
    )
    setShapeMenuOpen(false)
  }, [])

  const toggleShapeMenu = useCallback(() => {
    hapticTick()
    setShapeMenuOpen((v) => !v)
  }, [])

  const close = useCallback(() => {
    hapticTick()
    onOpenChange(false)
  }, [onOpenChange])


  if (!open) return null

  // Off the native shell there is no DAT at all, so the picker would offer a
  // source that can never work.
  const sourcePickerVisible = showSourcePicker && nativeBridge.available
  const h = rect.w / SHAPE_ASPECT[shape]
  const ShapeIcon =
    shape === CAMERA_SHAPE.circle
      ? Circle
      : shape === CAMERA_SHAPE.portrait
        ? RectangleVertical
        : RectangleHorizontal

  return (
    <div
      ref={pipRef}
      className="cameraPip"
      data-shape={shape}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: h }}
    >
      {error ? (
        <div className="cameraPipError">{error}</div>
      ) : source === 'glasses' ? (
        // An <img> rather than a <video>: DAT hands back decoded frames, which
        // cross the bridge as base64 JPEG (ios/CLAUDE.md) with no container to
        // feed a MediaSource. Never mirrored -- this is the wearer's own POV.
        glassesFrame ? (
          <img className="cameraPipVideo" src={`data:image/jpeg;base64,${glassesFrame}`} alt="" />
        ) : (
          <div className="cameraPipError">Starting your glasses…</div>
        )
      ) : (
        <video
          ref={videoRef}
          className={`cameraPipVideo${facing === 'user' ? ' mirrored' : ''}`}
          playsInline
          muted
          autoPlay
        />
      )}
      <Button
        variant="bare"
        className="cameraPipClose"
        onTouchEnd={(e) => {
          e.preventDefault()
          close()
        }}
        onClick={close}
        aria-label="Close camera"
      >
        <X size={13} strokeWidth={2.5} />
      </Button>
      <Button
        variant="bare"
        className="cameraPipShape"
        data-active={shapeMenuOpen ? '' : undefined}
        onTouchEnd={(e) => {
          e.preventDefault()
          toggleShapeMenu()
        }}
        onClick={toggleShapeMenu}
        aria-label="Frame shape"
        aria-expanded={shapeMenuOpen}
      >
        <ShapeIcon size={13} strokeWidth={2.5} />
      </Button>
      {shapeMenuOpen ? (
        <div
          className="cameraPipShapeMenu"
          role="group"
          aria-label="Frame shape"
          onTouchStart={(e) => e.stopPropagation()}
        >
          {SHAPE_OPTIONS.map((opt) => (
            <Button
              variant="bare"
              key={opt.shape}
              className="cameraPipShapeOption"
              data-selected={opt.shape === shape ? '' : undefined}
              // touchend, not click: the frame's native listeners swallow the
              // 300ms-delayed synthetic click on iOS. onClick stays for a
              // desktop-browser tap (no touch events at all).
              onTouchEnd={(e) => {
                e.preventDefault()
                pickShape(opt.shape)
              }}
              onClick={() => pickShape(opt.shape)}
              aria-label={opt.label}
              aria-pressed={opt.shape === shape}
            >
              <opt.Icon size={15} strokeWidth={2.5} />
            </Button>
          ))}
        </div>
      ) : null}
      {sourcePickerVisible ? (
        <div
          className="cameraPipSource"
          role="group"
          aria-label="Camera source"
          onTouchStart={(e) => e.stopPropagation()}
        >
          {SOURCE_OPTIONS.map((opt) => (
            <Button
              variant="bare"
              key={opt.source}
              className="cameraPipSourceOption"
              data-selected={opt.source === source ? '' : undefined}
              // touchend, not click -- same reason as the shape options above.
              onTouchEnd={(e) => {
                e.preventDefault()
                pickSource(opt.source)
              }}
              onClick={() => pickSource(opt.source)}
              aria-label={opt.label}
              aria-pressed={opt.source === source}
            >
              <opt.Icon size={18} strokeWidth={2.5} />
            </Button>
          ))}
        </div>
      ) : null}
      {source === 'phone' ? (
        <div className="cameraPipHint" aria-hidden="true">
          <FlipHorizontal2 size={12} strokeWidth={2.5} />
        </div>
      ) : null}
    </div>
  )
}

export function getCameraOpenPref(): boolean {
  return readBoolPref(OPEN_PREF_KEY, false)
}

export function setCameraOpenPref(value: boolean): void {
  writeBoolPref(OPEN_PREF_KEY, value)
}

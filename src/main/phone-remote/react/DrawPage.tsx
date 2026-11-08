import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  Copy,
  Highlighter,
  ImageOff,
  Monitor,
  MousePointer2,
  Pause,
  PenLine,
  Play,
  Square,
  Trash2,
  Undo2,
  X,
  ExternalLink
} from 'lucide-react'
import { Button } from '@shared/ui/Button'
import {
  applyInkOp,
  drawInkScene,
  fitBox,
  inkRgba,
  INK_COLOR_LABEL,
  INK_COLORS,
  INK_POINTER_RGB,
  INK_SIZES,
  type InkColor,
  type InkOp,
  type InkScene,
  type InkSendTarget,
  type InkSurface,
  type InkTool
} from '@shared/ink'
import type { PhoneRemoteMessage } from '@shared/phone-remote-protocol'
import type { SocketBus } from './socket-bus'
import { hapticTick } from './haptics'
import './draw-page.css'

const PREFS_KEY = 'mm.draw.prefs'
const EXPORT_W = 2000
const EXPORT_JPEG_QUALITY = 0.9
const SEND_TIMEOUT_MS = 15_000
const TOAST_MS = 2600
const LIVE_GAP_MS = 300
const LIVE_RETRY_MS = 2000
const POINT_DECIMALS = 1e4
const SIZE_DOTS = [5, 8, 12, 17]
const SIZE_LABELS = ['Fine', 'Medium', 'Thick', 'Extra thick']

interface DrawPrefs {
  tool: InkTool
  color: InkColor
  size: number
  live: boolean
  surface: InkSurface
}

const DEFAULT_PREFS: DrawPrefs = {
  tool: 'pen',
  color: 'redRgb',
  size: INK_SIZES[1],
  live: true,
  surface: 'screen'
}

function readPrefs(): DrawPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<DrawPrefs>
    return {
      tool:
        raw.tool === 'pen' ||
        raw.tool === 'highlighter' ||
        (raw.tool === 'pointer' && raw.live !== false)
          ? raw.tool
          : DEFAULT_PREFS.tool,
      color: (INK_COLORS as readonly unknown[]).includes(raw.color)
        ? (raw.color as InkColor)
        : DEFAULT_PREFS.color,
      size: (INK_SIZES as readonly unknown[]).includes(raw.size)
        ? (raw.size as number)
        : DEFAULT_PREFS.size,
      live: typeof raw.live === 'boolean' ? raw.live : DEFAULT_PREFS.live,
      surface: raw.surface === 'blank' ? 'blank' : 'screen'
    }
  } catch {
    return DEFAULT_PREFS
  }
}

function writePrefs(prefs: DrawPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    /* private mode */
  }
}

interface Backdrop {
  loading: boolean
  image: string | null
  width: number
  height: number
}

type Toast = { text: string; ok: boolean }

function sizeCanvas(canvas: HTMLCanvasElement, width: number, height: number): void {
  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.round(width * dpr)
  canvas.height = Math.round(height * dpr)
}

const round = (n: number): number =>
  Math.round(Math.min(1, Math.max(0, n)) * POINT_DECIMALS) / POINT_DECIMALS

export default function DrawPage(props: {
  bus: SocketBus
  send: (msg: PhoneRemoteMessage) => void
  sendBinary: (data: ArrayBuffer) => boolean
  onClose: () => void
}): React.JSX.Element {
  const { bus, send, sendBinary, onClose } = props
  const [prefs, setPrefs] = useState<DrawPrefs>(readPrefs)
  const [backdrop, setBackdrop] = useState<Backdrop>({
    loading: true,
    image: null,
    width: 16,
    height: 10
  })
  const [strokeCount, setStrokeCount] = useState(0)
  const [sending, setSending] = useState<InkSendTarget | null>(null)
  const [toast, setToast] = useState<Toast | null>(null)
  const [styleOpen, setStyleOpen] = useState(false)
  const [paused, setPaused] = useState(false)
  const pausedRef = useRef(false)
  const liveTimerRef = useRef<number | null>(null)
  const [box, setBox] = useState<{ width: number; height: number } | null>(null)
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null)
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight })
  const [canvasEl, setCanvasEl] = useState<HTMLCanvasElement | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const sceneRef = useRef<InkScene>({ surface: prefs.surface, strokes: [] })
  const prefsRef = useRef(prefs)
  const pointerRef = useRef<{ x: number; y: number } | null>(null)
  const sendTimerRef = useRef<number | null>(null)
  const sendingRef = useRef<InkSendTarget | null>(null)

  const sendInk = useCallback((op: InkOp) => send({ type: 'ink', ink: op }), [send])
  const sendLive = useCallback(
    (op: InkOp) => {
      if (prefsRef.current.live) sendInk(op)
    },
    [sendInk]
  )

  const updatePrefs = (patch: Partial<DrawPrefs>): void => {
    hapticTick()
    setPrefs((p) => {
      const next = { ...p, ...patch }
      writePrefs(next)
      return next
    })
  }

  const showToast = useCallback((t: Toast) => {
    setToast(t)
    window.setTimeout(() => setToast((cur) => (cur === t ? null : cur)), TOAST_MS)
  }, [])

  const screenW = backdrop.width
  const screenH = backdrop.height

  const redraw = useCallback(() => {
    if (!canvasEl || !box) return
    const ctx = canvasEl.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    drawInkScene(ctx, { ...sceneRef.current, surface: 'screen' }, box.width, box.height)
    const p = pointerRef.current
    if (p) {
      ctx.fillStyle = `rgba(${INK_POINTER_RGB}, 0.9)`
      ctx.beginPath()
      ctx.arc(p.x * box.width, p.y * box.height, 7, 0, Math.PI * 2)
      ctx.fill()
    }
  }, [canvasEl, box])

  const requestSnapshot = useCallback(() => {
    setBackdrop((b) => ({ ...b, loading: true }))
    sendInk({ op: 'snapshot' })
  }, [sendInk])

  useEffect(() => {
    const scheduleLive = (ms: number): void => {
      if (liveTimerRef.current !== null) window.clearTimeout(liveTimerRef.current)
      liveTimerRef.current = window.setTimeout(() => {
        liveTimerRef.current = null
        if (pausedRef.current || prefsRef.current.surface !== 'screen' || document.hidden) return
        sendInk({ op: 'snapshot' })
      }, ms)
    }
    const offBackdrop = bus.subscribe('inkBackdrop', (e) => {
      setBackdrop((b) =>
        e.image || !b.image
          ? { loading: false, image: e.image, width: e.width, height: e.height }
          : { ...b, loading: false }
      )
      scheduleLive(e.image ? LIVE_GAP_MS : LIVE_RETRY_MS)
    })
    const onVisible = (): void => {
      if (!document.hidden) scheduleLive(0)
    }
    document.addEventListener('visibilitychange', onVisible)
    const offSent = bus.subscribe('inkSent', (e) => {
      if (sendTimerRef.current !== null) window.clearTimeout(sendTimerRef.current)
      sendTimerRef.current = null
      const target = sendingRef.current
      sendingRef.current = null
      setSending(null)
      if (e.ok) {
        showToast({
          ok: true,
          text:
            target === 'open'
              ? 'Opened on your Mac, and copied'
              : 'Copied. Paste it anywhere on your Mac'
        })
        sceneRef.current = { ...sceneRef.current, strokes: [] }
        setStrokeCount(0)
        sendLive({ op: 'clear' })
      } else {
        showToast({ ok: false, text: "Didn't reach your Mac. Try again." })
      }
    })
    sendInk({ op: 'snapshot' })
    return () => {
      offBackdrop()
      offSent()
      document.removeEventListener('visibilitychange', onVisible)
      if (liveTimerRef.current !== null) window.clearTimeout(liveTimerRef.current)
      sendInk({ op: 'close' })
      if (sendTimerRef.current !== null) window.clearTimeout(sendTimerRef.current)
    }
  }, [bus, sendInk, sendLive, showToast])

  useEffect(() => {
    sceneRef.current = { ...sceneRef.current, surface: prefs.surface }
    if (prefs.live) sendInk({ op: 'scene', scene: sceneRef.current })
    else sendInk({ op: 'close' })
  }, [prefs.live, prefs.surface, sendInk])

  useLayoutEffect(() => {
    prefsRef.current = prefs
  }, [prefs])

  useEffect(() => {
    pausedRef.current = paused
    if (!paused && prefs.surface === 'screen') sendInk({ op: 'snapshot' })
  }, [paused, prefs.surface, sendInk])

  useLayoutEffect(() => {
    if (!stageEl) return undefined
    const measure = (): void => {
      const r = stageEl.getBoundingClientRect()
      const fit = fitBox({ left: 0, top: 0, width: r.width, height: r.height }, screenW, screenH)
      setBox(fit ? { width: Math.floor(fit.width), height: Math.floor(fit.height) } : null)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(stageEl)
    return () => ro.disconnect()
  }, [stageEl, screenW, screenH])

  useLayoutEffect(() => {
    if (!canvasEl || !box) return
    sizeCanvas(canvasEl, box.width, box.height)
    redraw()
  }, [canvasEl, box, redraw])

  useEffect(() => redraw(), [strokeCount, redraw])

  useEffect(() => {
    const onResize = (): void =>
      setViewport({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    if (!canvasEl) return undefined
    let active: number | null = null
    let strokeId = ''
    let pending: number[] = []
    let raf = 0

    const flush = (): void => {
      raf = 0
      if (pending.length === 0) return
      const p = prefsRef.current
      if (p.tool === 'pointer') {
        sendInk({ op: 'pointer', nx: pending[pending.length - 2], ny: pending[pending.length - 1] })
      } else if (p.tool === 'pen' || p.tool === 'highlighter') {
        sendLive({
          op: 'points',
          id: strokeId,
          tool: p.tool,
          color: p.color,
          size: p.size,
          pts: pending
        })
      }
      pending = []
    }
    const toPoint = (e: PointerEvent): [number, number] => {
      const r = canvasEl.getBoundingClientRect()
      return [round((e.clientX - r.left) / r.width), round((e.clientY - r.top) / r.height)]
    }
    const add = (events: PointerEvent[]): void => {
      const p = prefsRef.current
      const pts: number[] = []
      for (const ev of events) pts.push(...toPoint(ev))
      if (p.tool === 'pointer') {
        pointerRef.current = { x: pts[pts.length - 2], y: pts[pts.length - 1] }
      } else {
        sceneRef.current = applyInkOp(sceneRef.current, {
          op: 'points',
          id: strokeId,
          tool: p.tool,
          color: p.color,
          size: p.size,
          pts
        })
      }
      pending.push(...pts)
      redraw()
      if (raf === 0) raf = requestAnimationFrame(flush)
    }
    const onDown = (e: PointerEvent): void => {
      if (active !== null) return
      e.preventDefault()
      active = e.pointerId
      canvasEl.setPointerCapture(e.pointerId)
      strokeId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
      add([e])
    }
    const onMove = (e: PointerEvent): void => {
      if (e.pointerId !== active) return
      e.preventDefault()
      const coalesced = e.getCoalescedEvents?.() ?? []
      add(coalesced.length > 0 ? coalesced : [e])
    }
    const onUp = (e: PointerEvent): void => {
      if (e.pointerId !== active) return
      active = null
      if (raf) cancelAnimationFrame(raf)
      flush()
      if (prefsRef.current.tool === 'pointer') {
        pointerRef.current = null
        sendInk({ op: 'pointerOff' })
        redraw()
      } else {
        setStrokeCount(sceneRef.current.strokes.length)
      }
    }
    canvasEl.addEventListener('pointerdown', onDown)
    canvasEl.addEventListener('pointermove', onMove)
    canvasEl.addEventListener('pointerup', onUp)
    canvasEl.addEventListener('pointercancel', onUp)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      canvasEl.removeEventListener('pointerdown', onDown)
      canvasEl.removeEventListener('pointermove', onMove)
      canvasEl.removeEventListener('pointerup', onUp)
      canvasEl.removeEventListener('pointercancel', onUp)
    }
  }, [canvasEl, redraw, sendInk, sendLive])

  const undo = (): void => {
    hapticTick()
    sceneRef.current = applyInkOp(sceneRef.current, { op: 'undo' })
    setStrokeCount(sceneRef.current.strokes.length)
    sendLive({ op: 'undo' })
    redraw()
  }

  const clear = (): void => {
    hapticTick()
    sceneRef.current = applyInkOp(sceneRef.current, { op: 'clear' })
    setStrokeCount(0)
    sendLive({ op: 'clear' })
    redraw()
  }

  const sendDrawing = async (target: InkSendTarget): Promise<void> => {
    if (sendingRef.current) return
    hapticTick()
    sendingRef.current = target
    setSending(target)
    const img = imgRef.current
    const fromShot = prefs.surface === 'screen' && img && img.complete && img.naturalWidth > 0
    const w = fromShot ? img.naturalWidth : EXPORT_W
    const h = Math.round((w * screenH) / screenW)
    const out = document.createElement('canvas')
    out.width = w
    out.height = h
    const ctx = out.getContext('2d')
    const blob = ctx
      ? await new Promise<Blob | null>((resolve) => {
          drawInkScene(
            ctx,
            fromShot ? sceneRef.current : { ...sceneRef.current, surface: 'blank' },
            w,
            h,
            fromShot ? img : null
          )
          out.toBlob(resolve, 'image/jpeg', EXPORT_JPEG_QUALITY)
        })
      : null
    const buf = blob ? await blob.arrayBuffer() : null
    if (!buf) {
      sendingRef.current = null
      setSending(null)
      showToast({ ok: false, text: "Couldn't make the picture. Try again." })
      return
    }
    send({
      type: 'imageMeta',
      mime: 'image/jpeg',
      byteLength: buf.byteLength,
      name: 'drawing.jpg',
      ink: target
    })
    if (!sendBinary(buf)) {
      sendingRef.current = null
      setSending(null)
      showToast({ ok: false, text: "Didn't reach your Mac. Try again." })
      return
    }
    sendTimerRef.current = window.setTimeout(() => {
      sendTimerRef.current = null
      sendingRef.current = null
      setSending(null)
      showToast({ ok: false, text: "Your Mac didn't answer. Try again." })
    }, SEND_TIMEOUT_MS)
  }

  const shot = backdrop.image
  const landscape = viewport.width > viewport.height
  const showShot = prefs.surface === 'screen'
  const empty = strokeCount === 0
  const strokeTool = prefs.tool !== 'pointer'
  const styleShown = landscape && styleOpen && strokeTool

  const closeBtn = (
    <Button
      variant="bare"
      type="button"
      className="drawRound"
      aria-label="Close drawing"
      onClick={onClose}
    >
      <X size={20} />
    </Button>
  )

  const surfaceSeg = (
    <div className="drawSeg drawSurface" role="radiogroup" aria-label="Draw on">
      <Button
        variant="bare"
        type="button"
        role="radio"
        aria-checked={prefs.surface === 'screen'}
        aria-label="Mac screen"
        onClick={() => updatePrefs({ surface: 'screen' })}
      >
        <Monitor size={15} />
        <span className="drawToolLabel">Mac screen</span>
      </Button>
      <Button
        variant="bare"
        type="button"
        role="radio"
        aria-checked={prefs.surface === 'blank'}
        aria-label="Blank page"
        onClick={() => updatePrefs({ surface: 'blank' })}
      >
        <Square size={15} />
        <span className="drawToolLabel">Blank page</span>
      </Button>
    </div>
  )

  const liveBtn = (
    <Button
      variant="bare"
      type="button"
      className="drawRound"
      aria-label={paused ? 'Make the Mac picture live again' : 'Pause the Mac picture'}
      disabled={!showShot}
      onClick={() => {
        hapticTick()
        setPaused((p) => !p)
      }}
    >
      {paused ? <Play size={18} /> : <Pause size={18} />}
    </Button>
  )

  const toolsSeg = (
    <div className="drawSeg drawTools" role="radiogroup" aria-label="Tool">
      <Button
        variant="bare"
        type="button"
        role="radio"
        aria-checked={prefs.tool === 'pen'}
        aria-label="Pen"
        onClick={() => updatePrefs({ tool: 'pen' })}
      >
        <PenLine size={16} />
        <span className="drawToolLabel">Pen</span>
      </Button>
      <Button
        variant="bare"
        type="button"
        role="radio"
        aria-checked={prefs.tool === 'highlighter'}
        aria-label="Marker"
        onClick={() => updatePrefs({ tool: 'highlighter' })}
      >
        <Highlighter size={16} />
        <span className="drawToolLabel">Marker</span>
      </Button>
      {prefs.live && (
        <Button
          variant="bare"
          type="button"
          role="radio"
          aria-checked={prefs.tool === 'pointer'}
          aria-label="Point"
          onClick={() => updatePrefs({ tool: 'pointer' })}
        >
          <MousePointer2 size={16} />
          <span className="drawToolLabel">Point</span>
        </Button>
      )}
    </div>
  )

  const undoBtn = (
    <Button
      variant="bare"
      type="button"
      className="drawRound light"
      aria-label="Undo"
      disabled={empty}
      onClick={undo}
    >
      <Undo2 size={18} />
    </Button>
  )

  const clearBtn = (
    <Button
      variant="bare"
      type="button"
      className="drawRound light"
      aria-label="Clear the drawing"
      disabled={empty}
      onClick={clear}
    >
      <Trash2 size={18} />
    </Button>
  )

  const colors = (
    <div className="drawColors" role="radiogroup" aria-label="Color">
      {INK_COLORS.map((c) => (
        <Button
          key={c}
          variant="bare"
          type="button"
          role="radio"
          aria-checked={prefs.color === c}
          aria-label={INK_COLOR_LABEL[c]}
          className="drawSwatch"
          style={{ '--swatch': inkRgba(c, 1) } as React.CSSProperties}
          onClick={() => {
            updatePrefs({ color: c })
            setStyleOpen(false)
          }}
        />
      ))}
    </div>
  )

  const sizes = (
    <div className="drawSizes" role="radiogroup" aria-label="Line size">
      {INK_SIZES.map((s, i) => (
        <Button
          key={s}
          variant="bare"
          type="button"
          role="radio"
          aria-checked={prefs.size === s}
          aria-label={SIZE_LABELS[i]}
          className="drawSize"
          onClick={() => {
            updatePrefs({ size: s })
            setStyleOpen(false)
          }}
        >
          <span
            style={{
              width: SIZE_DOTS[i],
              height: SIZE_DOTS[i],
              background: inkRgba(prefs.color, prefs.tool === 'highlighter' ? 0.5 : 1)
            }}
          />
        </Button>
      ))}
    </div>
  )

  const liveSwitch = (
    <Button
      variant="bare"
      type="button"
      role="switch"
      aria-checked={prefs.live}
      aria-label="Show on my Mac as I draw"
      className="drawLive"
      onClick={() =>
        updatePrefs(
          prefs.live && prefs.tool === 'pointer'
            ? { live: false, tool: 'pen' }
            : { live: !prefs.live }
        )
      }
    >
      <span className="drawLiveText">
        <span className="drawLiveTitle">
          {landscape ? 'Show on Mac' : 'Show on my Mac as I draw'}
        </span>
        {!landscape && (
          <span className="drawLiveSub">
            {prefs.live ? 'Your mouse stays where it is' : 'Only on this phone until you send it'}
          </span>
        )}
      </span>
      <span className="drawLiveTrack" aria-hidden />
    </Button>
  )

  const sendBtns = (
    <>
      <Button
        variant="bare"
        type="button"
        className="drawSendBtn drawCopy"
        aria-label="Copy to Mac"
        disabled={empty || sending !== null}
        onClick={() => void sendDrawing('copy')}
      >
        <Copy size={17} />
        {!landscape && (sending === 'copy' ? 'Sending…' : 'Copy to Mac')}
      </Button>
      <Button
        variant="bare"
        type="button"
        className="drawSendBtn primary"
        disabled={empty || sending !== null}
        onClick={() => void sendDrawing('open')}
      >
        <ExternalLink size={17} />
        {sending === 'open' ? 'Sending…' : 'Open on Mac'}
      </Button>
    </>
  )

  const stage = (
    <div className="drawStage" ref={setStageEl}>
      {box && (
        <div
          className={`drawSheet${showShot ? '' : ' blank'}`}
          style={{ width: box.width, height: box.height }}
        >
          {showShot && shot && (
            <img ref={imgRef} className="drawShot" src={shot} alt="" draggable={false} />
          )}
          {showShot && !shot && (
            <div className="drawShotState">
              {backdrop.loading ? (
                'Getting your Mac screen…'
              ) : (
                <>
                  <ImageOff size={20} />
                  <span>{"Couldn't get your Mac screen"}</span>
                  <Button
                    variant="bare"
                    type="button"
                    className="drawRetry"
                    onClick={requestSnapshot}
                  >
                    Try again
                  </Button>
                </>
              )}
            </div>
          )}
          {showShot && shot && (
            <div className={`drawLiveBadge${paused ? ' paused' : ''}`}>
              {paused ? 'Paused' : 'Live'}
            </div>
          )}
          <canvas
            ref={setCanvasEl}
            className="drawCanvas"
            style={{ width: box.width, height: box.height }}
          />
          {empty && strokeTool && <div className="drawHint">Draw with your finger</div>}
          {prefs.tool === 'pointer' && <div className="drawHint">Drag to point on your Mac</div>}
        </div>
      )}
      {toast && <div className={`drawToast${toast.ok ? '' : ' bad'}`}>{toast.text}</div>}
    </div>
  )

  if (landscape) {
    return (
      <div className="drawPage" role="dialog" aria-label="Draw" data-orient="landscape">
        <div className="drawTop">
          <div className="drawGroup">
            {closeBtn}
            {surfaceSeg}
            {liveBtn}
          </div>
          <div className="drawGroup">
            {toolsSeg}
            <div className="drawStyleWrap">
              <Button
                variant="bare"
                type="button"
                className="drawRound drawStyleBtn"
                aria-label="Color and line size"
                aria-expanded={styleShown}
                disabled={!strokeTool}
                onClick={() => {
                  hapticTick()
                  setStyleOpen((o) => !o)
                }}
              >
                <span
                  className="drawStyleDot"
                  style={{ '--swatch': inkRgba(prefs.color, 1) } as React.CSSProperties}
                />
              </Button>
              {styleShown && (
                <div className="drawStylePop">
                  {colors}
                  {sizes}
                </div>
              )}
            </div>
            {undoBtn}
            {clearBtn}
          </div>
          <div className="drawGroup">
            {liveSwitch}
            {sendBtns}
          </div>
        </div>
        {styleShown && <div className="drawScrim" onPointerDown={() => setStyleOpen(false)} />}
        {stage}
      </div>
    )
  }

  return (
    <div className="drawPage" role="dialog" aria-label="Draw" data-orient="portrait">
      <div className="drawMain">
        <div className="drawTop">
          {closeBtn}
          {surfaceSeg}
          {liveBtn}
        </div>
        {stage}
      </div>

      <div className="drawPanel">
        <div className="drawRow">
          {toolsSeg}
          {undoBtn}
          {clearBtn}
        </div>
        <div className={`drawRow drawStyle${strokeTool ? '' : ' off'}`} aria-hidden={!strokeTool}>
          {colors}
          {sizes}
        </div>
        {liveSwitch}
        <div className="drawRow drawSend">{sendBtns}</div>
      </div>
    </div>
  )
}

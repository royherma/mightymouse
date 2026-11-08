import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import {
  Circle,
  Eraser,
  Highlighter,
  MoveUpRight,
  PenLine,
  Redo2,
  Save,
  SendHorizontal,
  Square,
  Type,
  Undo2,
  X,
  type LucideIcon
} from 'lucide-react'
import { Button } from './Button'
import { sendToComposer } from '../hooks/useAttachments'
import './markup.css'

type Shape = 'box' | 'circle' | 'arrow'
type Ink = 'pen' | 'highlight' | 'text' | Shape
type Tool = Ink | 'eraser'
interface Pt {
  x: number
  y: number
}
interface Op {
  tool: Ink
  color: string
  pts: Pt[]
  text?: string
}
interface History {
  ops: Op[]
  past: Op[][]
  future: Op[][]
}

const COLORS = ['#FF3B30', '#FF9500', '#FFCC00', '#34C759', '#0A84FF', '#1C1C1E', '#FFFFFF']
const SHAPES: { id: Shape; icon: LucideIcon; label: string; key: string }[] = [
  { id: 'box', icon: Square, label: 'Box', key: 'r' },
  { id: 'circle', icon: Circle, label: 'Circle', key: 'o' },
  { id: 'arrow', icon: MoveUpRight, label: 'Arrow', key: 'a' }
]
const TOOLS: { id: Tool; icon: LucideIcon; label: string; key: string }[] = [
  { id: 'pen', icon: PenLine, label: 'Pen', key: 'p' },
  { id: 'highlight', icon: Highlighter, label: 'Highlighter', key: 'h' },
  { id: 'text', icon: Type, label: 'Text', key: 't' },
  ...SHAPES,
  { id: 'eraser', icon: Eraser, label: 'Eraser', key: 'e' }
]
const FLASH_MS = 2200

const isShape = (t: Tool): t is Shape => t === 'box' || t === 'circle' || t === 'arrow'
const inkWidth = (w: number, h: number): number => Math.max(2, Math.max(w, h) / 320)
const fontSize = (base: number): number => base * 8

function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = dx * dx + dy * dy
  const t = len ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

function outline(op: Op): Pt[] {
  const [a, b = a] = op.pts
  if (op.tool === 'box')
    return [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }, a]
  if (op.tool !== 'circle') return op.pts
  const cx = (a.x + b.x) / 2
  const cy = (a.y + b.y) / 2
  return Array.from({ length: 37 }, (_, i) => ({
    x: cx + (Math.abs(b.x - a.x) / 2) * Math.cos((i / 36) * Math.PI * 2),
    y: cy + (Math.abs(b.y - a.y) / 2) * Math.sin((i / 36) * Math.PI * 2)
  }))
}

function textBox(ctx: CanvasRenderingContext2D, op: Op, base: number): { w: number; h: number } {
  const size = fontSize(base)
  ctx.font = `600 ${size}px system-ui, -apple-system, sans-serif`
  const lines = (op.text ?? '').split('\n')
  return { w: Math.max(...lines.map((l) => ctx.measureText(l).width)), h: lines.length * size * 1.2 }
}

function hits(ctx: CanvasRenderingContext2D, op: Op, p: Pt, base: number): boolean {
  if (op.tool === 'text') {
    const [a] = op.pts
    const { w, h } = textBox(ctx, op, base)
    return p.x >= a.x - base && p.x <= a.x + w + base && p.y >= a.y - base && p.y <= a.y + h + base
  }
  const reach = base * (op.tool === 'highlight' ? 5 : 3)
  const pts = outline(op)
  if (pts.length === 1) return Math.hypot(p.x - pts[0].x, p.y - pts[0].y) <= reach
  return pts.some((a, i) => i > 0 && segDist(p, pts[i - 1], a) <= reach)
}

function drawOp(ctx: CanvasRenderingContext2D, op: Op, base: number): void {
  ctx.save()
  ctx.strokeStyle = op.color
  ctx.fillStyle = op.color
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.lineWidth = op.tool === 'highlight' ? base * 6 : base
  if (op.tool === 'highlight') ctx.globalAlpha = 0.38
  const [a, b = a] = op.pts
  if (op.tool === 'text') {
    const size = fontSize(base)
    textBox(ctx, op, base)
    ctx.textBaseline = 'top'
    ;(op.text ?? '').split('\n').forEach((line, i) => ctx.fillText(line, a.x, a.y + i * size * 1.2))
  } else if (op.tool === 'arrow') {
    const angle = Math.atan2(b.y - a.y, b.x - a.x)
    const head = Math.min(base * 6, Math.hypot(b.x - a.x, b.y - a.y) * 0.5)
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    for (const side of [-1, 1]) {
      ctx.moveTo(b.x, b.y)
      ctx.lineTo(b.x - head * Math.cos(angle + side * 0.5), b.y - head * Math.sin(angle + side * 0.5))
    }
    ctx.stroke()
  } else if (op.pts.length === 1) {
    ctx.beginPath()
    ctx.arc(a.x, a.y, ctx.lineWidth / 2, 0, Math.PI * 2)
    ctx.fill()
  } else {
    const pts = outline(op)
    ctx.beginPath()
    ctx.moveTo(pts[0].x, pts[0].y)
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2
      const my = (pts[i].y + pts[i + 1].y) / 2
      if (op.tool === 'pen' || op.tool === 'highlight') ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my)
      else ctx.lineTo(pts[i].x, pts[i].y)
    }
    const last = pts[pts.length - 1]
    ctx.lineTo(last.x, last.y)
    ctx.stroke()
  }
  ctx.restore()
}

export function MarkupEditor(props: {
  path: string
  onClose: () => void
  onSaved: (saved: string, sent: boolean) => void
}): ReactElement {
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const draftRef = useRef<Op | null>(null)
  const erasedRef = useRef(false)
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const [fit, setFit] = useState({ w: 0, h: 0 })
  const [tool, setTool] = useState<Tool>('pen')
  const [shape, setShape] = useState<Shape>('arrow')
  const [color, setColor] = useState(COLORS[0])
  const [menu, setMenu] = useState<'shape' | 'color' | null>(null)
  const [hist, setHist] = useState<History>({ ops: [], past: [], future: [] })
  const [typing, setTyping] = useState<{ at: Pt; text: string } | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const base = natural ? inkWidth(natural.w, natural.h) : 2
  const scale = natural && fit.w ? fit.w / natural.w : 1

  useLayoutEffect(() => {
    const stage = stageRef.current
    if (!stage || !natural) return
    const measure = (): void => {
      const s = Math.min(stage.clientWidth / natural.w, stage.clientHeight / natural.h, 1)
      setFit({ w: Math.round(natural.w * s), h: Math.round(natural.h * s) })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(stage)
    return () => ro.disconnect()
  }, [natural])

  const redraw = (): void => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0)
    for (const op of hist.ops) drawOp(ctx, op, base)
    if (draftRef.current) drawOp(ctx, draftRef.current, base)
  }
  useEffect(redraw)

  const change = (next: Op[]): void =>
    setHist((h) => ({ ops: next, past: [...h.past, h.ops], future: [] }))
  const undo = (): void =>
    setHist((h) => (h.past.length ? { ops: h.past[h.past.length - 1], past: h.past.slice(0, -1), future: [h.ops, ...h.future] } : h))
  const redo = (): void =>
    setHist((h) => (h.future.length ? { ops: h.future[0], past: [...h.past, h.ops], future: h.future.slice(1) } : h))

  const pick = (next: Tool): void => {
    setTool(next)
    if (isShape(next)) setShape(next)
    setMenu(null)
  }

  const commitText = (): void => {
    if (typing?.text.trim()) change([...hist.ops, { tool: 'text', color, pts: [typing.at], text: typing.text }])
    setTyping(null)
  }

  const pointAt = (e: React.PointerEvent): Pt => {
    const r = e.currentTarget.getBoundingClientRect()
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale }
  }

  const erase = (p: Pt): void => {
    const ctx = canvasRef.current?.getContext('2d')
    if (!ctx) return
    setHist((h) => {
      const kept = h.ops.filter((op) => !hits(ctx, op, p, base))
      if (kept.length === h.ops.length) return h
      if (erasedRef.current) return { ...h, ops: kept }
      erasedRef.current = true
      return { ops: kept, past: [...h.past, h.ops], future: [] }
    })
  }

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (e.button !== 0) return
    setMenu(null)
    const p = pointAt(e)
    if (tool === 'text') {
      if (typing) commitText()
      else setTyping({ at: p, text: '' })
      return
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    if (tool === 'eraser') {
      erasedRef.current = false
      erase(p)
      return
    }
    draftRef.current = { tool, color, pts: isShape(tool) ? [p, p] : [p] }
    redraw()
  }

  const onMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    const p = pointAt(e)
    if (tool === 'eraser') return erase(p)
    const draft = draftRef.current
    if (!draft) return
    if (isShape(draft.tool)) draft.pts[1] = p
    else draft.pts.push(p)
    redraw()
  }

  const onUp = (): void => {
    const draft = draftRef.current
    draftRef.current = null
    if (!draft) return
    const [a, b = a] = draft.pts
    if (isShape(draft.tool) && Math.hypot(b.x - a.x, b.y - a.y) < base * 2) return redraw()
    change([...hist.ops, draft])
  }

  const finish = async (send: boolean): Promise<void> => {
    const img = imgRef.current
    if (!img || !natural || busy) return
    setBusy(true)
    try {
      const out = document.createElement('canvas')
      out.width = natural.w
      out.height = natural.h
      const ctx = out.getContext('2d')
      if (!ctx) throw new Error('no canvas')
      ctx.drawImage(img, 0, 0)
      for (const op of hist.ops) drawOp(ctx, op, base)
      const saved = await window.api.markupSave(out.toDataURL('image/png'), props.path)
      const sent = send && sendToComposer(saved)
      if (send && !sent) {
        setStatus('Saved. Open a chat to send it.')
        setTimeout(() => props.onSaved(saved, false), FLASH_MS)
        return
      }
      props.onSaved(saved, sent)
    } catch {
      setStatus("Couldn't save it")
      setTimeout(() => setStatus(null), FLASH_MS)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (typing) return
      const key = e.key.toLowerCase()
      if (e.metaKey && key === 'z') e.shiftKey ? redo() : undo()
      else if (e.metaKey && key === 's') void finish(false)
      else if (e.key === 'Escape') menu ? setMenu(null) : hist.ops.length === 0 && props.onClose()
      else if (!e.metaKey && !e.ctrlKey && TOOLS.some((t) => t.key === key))
        pick(TOOLS.find((t) => t.key === key)!.id)
      else if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  const ShapeIcon = SHAPES.find((s) => s.id === shape)!.icon
  const toolButton = (t: (typeof TOOLS)[number]): ReactElement => (
    <Button
      key={t.id}
      variant="bare"
      className="markup-tool"
      data-on={tool === t.id ? '' : undefined}
      aria-label={t.label}
      title={`${t.label} (${t.key.toUpperCase()})`}
      onClick={() => pick(t.id)}
    >
      <t.icon size={16} strokeWidth={2.2} />
    </Button>
  )

  return (
    <div className="markup">
      <div className="markup-bar" role="toolbar" aria-label="Markup tools">
        {TOOLS.filter((t) => !isShape(t.id) && t.id !== 'eraser').map(toolButton)}
        <span className="markup-pop-anchor">
          <Button
            variant="bare"
            className="markup-tool"
            data-on={isShape(tool) ? '' : undefined}
            aria-label="Shapes"
            title="Shapes"
            onClick={() => {
              if (!isShape(tool)) pick(shape)
              setMenu((m) => (m === 'shape' ? null : 'shape'))
            }}
          >
            <ShapeIcon size={16} strokeWidth={2.2} />
          </Button>
          {menu === 'shape' && <div className="markup-pop">{SHAPES.map(toolButton)}</div>}
        </span>
        <span className="markup-pop-anchor">
          <Button
            variant="bare"
            className="markup-tool"
            aria-label="Color"
            title="Color"
            onClick={() => setMenu((m) => (m === 'color' ? null : 'color'))}
          >
            <span className="markup-swatch" style={{ background: color }} />
          </Button>
          {menu === 'color' && (
            <div className="markup-pop">
              {COLORS.map((c) => (
                <Button
                  key={c}
                  variant="bare"
                  className="markup-tool"
                  data-on={c === color ? '' : undefined}
                  aria-label={c}
                  onClick={() => {
                    setColor(c)
                    setMenu(null)
                    if (tool === 'eraser') setTool('pen')
                  }}
                >
                  <span className="markup-swatch" style={{ background: c }} />
                </Button>
              ))}
            </div>
          )}
        </span>
        {toolButton(TOOLS[TOOLS.length - 1])}
        <span className="markup-sep" />
        <Button variant="bare" className="markup-tool" aria-label="Undo" title="Undo (⌘Z)" disabled={!hist.past.length} onClick={undo}>
          <Undo2 size={16} strokeWidth={2.2} />
        </Button>
        <Button variant="bare" className="markup-tool" aria-label="Redo" title="Redo (⇧⌘Z)" disabled={!hist.future.length} onClick={redo}>
          <Redo2 size={16} strokeWidth={2.2} />
        </Button>
        <span className="markup-sep" />
        {status ? (
          <span className="markup-status">{status}</span>
        ) : (
          <>
            <Button variant="bare" className="markup-action" title="Save to Drawings (⌘S)" disabled={busy || !natural} onClick={() => void finish(false)}>
              <Save size={14} strokeWidth={2.2} />
              Save
            </Button>
            <Button variant="bare" className="markup-action" data-primary="" title="Save and add it to your message" disabled={busy || !natural} onClick={() => void finish(true)}>
              <SendHorizontal size={14} strokeWidth={2.2} />
              Send to chat
            </Button>
          </>
        )}
        <Button variant="bare" className="markup-tool" aria-label="Close markup" title="Close" onClick={props.onClose}>
          <X size={16} strokeWidth={2.2} />
        </Button>
      </div>
      <div ref={stageRef} className="markup-stage">
        <div className="markup-sheet" style={{ width: fit.w, height: fit.h }}>
          <img
            ref={imgRef}
            crossOrigin="anonymous"
            src={window.api.mediaUrl(props.path)}
            alt=""
            draggable={false}
            onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          />
          <canvas
            ref={canvasRef}
            width={Math.round(fit.w * (window.devicePixelRatio || 1))}
            height={Math.round(fit.h * (window.devicePixelRatio || 1))}
            data-tool={tool}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
          />
          {typing && (
            <textarea
              autoFocus
              className="markup-text"
              value={typing.text}
              placeholder="Type"
              rows={Math.max(1, typing.text.split('\n').length)}
              style={{
                left: typing.at.x * scale,
                top: typing.at.y * scale,
                color,
                fontSize: fontSize(base) * scale
              }}
              onChange={(e) => setTyping({ ...typing, text: e.target.value })}
              onBlur={commitText}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Escape') setTyping(null)
                else if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  commitText()
                }
              }}
            />
          )}
        </div>
      </div>
    </div>
  )
}

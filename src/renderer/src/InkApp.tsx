import { useEffect, useRef, type JSX } from 'react'
import {
  applyInkOp,
  drawInkScene,
  EMPTY_INK_SCENE,
  INK_POINTER_RGB,
  type InkScene
} from '../../shared/ink'

const POINTER_TRAIL_MS = 450
const POINTER_FADE_MS = 700
const POINTER_RADIUS = 9

interface TrailPoint {
  x: number
  y: number
  at: number
}

export default function InkApp(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return undefined
    let scene: InkScene = EMPTY_INK_SCENE
    let trail: TrailPoint[] = []
    let pointerOffAt: number | null = null
    let raf = 0

    const size = (): void => {
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.round(window.innerWidth * dpr)
      canvas.height = Math.round(window.innerHeight * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    const drawPointer = (now: number): boolean => {
      const fade = pointerOffAt === null ? 1 : 1 - (now - pointerOffAt) / POINTER_FADE_MS
      const head = trail[trail.length - 1]
      if (!head || fade <= 0) {
        trail = []
        return false
      }
      trail = trail.filter((p) => p === head || now - p.at < POINTER_TRAIL_MS)
      ctx.save()
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      for (let i = 1; i < trail.length; i++) {
        const age = Math.max(0, 1 - (now - trail[i].at) / POINTER_TRAIL_MS)
        ctx.strokeStyle = `rgba(${INK_POINTER_RGB}, ${0.55 * age * fade})`
        ctx.lineWidth = POINTER_RADIUS * 1.4 * age
        ctx.beginPath()
        ctx.moveTo(trail[i - 1].x, trail[i - 1].y)
        ctx.lineTo(trail[i].x, trail[i].y)
        ctx.stroke()
      }
      const glow = ctx.createRadialGradient(head.x, head.y, 0, head.x, head.y, POINTER_RADIUS * 3)
      glow.addColorStop(0, `rgba(${INK_POINTER_RGB}, ${0.45 * fade})`)
      glow.addColorStop(1, `rgba(${INK_POINTER_RGB}, 0)`)
      ctx.fillStyle = glow
      ctx.beginPath()
      ctx.arc(head.x, head.y, POINTER_RADIUS * 3, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = `rgba(${INK_POINTER_RGB}, ${fade})`
      ctx.beginPath()
      ctx.arc(head.x, head.y, POINTER_RADIUS, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
      return true
    }

    const frame = (): void => {
      raf = 0
      const w = window.innerWidth
      const h = window.innerHeight
      drawInkScene(ctx, scene, w, h)
      if (drawPointer(performance.now())) schedule()
    }
    const schedule = (): void => {
      if (raf === 0) raf = requestAnimationFrame(frame)
    }

    size()
    const onResize = (): void => {
      size()
      schedule()
    }
    window.addEventListener('resize', onResize)
    const off = window.api.onInkOp((op) => {
      if (op.op === 'pointer') {
        pointerOffAt = null
        trail.push({
          x: op.nx * window.innerWidth,
          y: op.ny * window.innerHeight,
          at: performance.now()
        })
      } else if (op.op === 'pointerOff') {
        pointerOffAt = performance.now()
      } else {
        scene = applyInkOp(scene, op)
      }
      schedule()
    })
    return () => {
      off()
      window.removeEventListener('resize', onResize)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'fixed',
        inset: 0,
        width: '100vw',
        height: '100vh',
        pointerEvents: 'none'
      }}
    />
  )
}

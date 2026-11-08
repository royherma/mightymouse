import { useEffect, useRef } from 'react'
import type { JSX } from 'react'
import { useMicLevel } from '../hooks/useMicLevel'

/**
 * Live audio waveform for the recording HUD. Taps the mic via getUserMedia +
 * a Web Audio AnalyserNode and draws three overlapping sine waves whose
 * amplitude tracks the real voice level (RMS of the time-domain buffer). The
 * layered phases drift across each other for a physical "alive" interference
 * look rather than a stiff bar EQ.
 *
 * No IPC / main-process work needed — the renderer already holds mic permission
 * (recording uses it). If the mic is denied or unavailable we degrade to a calm
 * synthetic idle ripple so the UI is never dead.
 *
 * Reads the brand accent from the injected --accent-rgb CSS var, so it stays in
 * sync with THEME_TOKENS instead of hardcoding orange. Pass `accentRgb` to
 * override it (e.g. the smart-dictation HUD uses a distinct blue/violet wave).
 */
export function WaveformViz({ accentRgb }: { accentRgb?: string } = {}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // One shared mic tap (useMicLevel). We read the live value off levelRef inside
  // the rAF draw loop — zero re-renders, same organic 0.18 smoothing as before.
  const { levelRef } = useMicLevel(true)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Accent: explicit prop wins (smart dictation), else the theme's --accent-rgb,
    // else the orange fallback. e.g. "255, 160, 80".
    const accent =
      accentRgb?.trim() ||
      getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim() ||
      '255, 160, 80'

    // Size the backing store to the device pixel ratio for crisp lines.
    const dpr = window.devicePixelRatio || 1
    const cssW = canvas.clientWidth || 120
    const cssH = canvas.clientHeight || 32
    canvas.width = cssW * dpr
    canvas.height = cssH * dpr
    ctx.scale(dpr, dpr)

    let raf = 0
    let phase = 0
    let disposed = false

    // Three layers: phase offset, spatial frequency, base opacity, line width.
    const layers = [
      { off: 0, freq: 1.6, alpha: 0.9, w: 2 },
      { off: 2.1, freq: 2.4, alpha: 0.55, w: 1.5 },
      { off: 4.3, freq: 1.0, alpha: 0.35, w: 1.5 }
    ]

    function draw(): void {
      if (disposed) return
      const level = levelRef.current
      phase += 0.05

      ctx!.clearRect(0, 0, cssW, cssH)
      const mid = cssH / 2
      // Idle floor keeps a gentle ripple alive during silence. A gentle curve
      // (level^0.7) lifts quiet speech without letting loud peaks spike — lively
      // but smooth.
      const shaped = Math.pow(level, 0.7)
      const amp = (0.12 + shaped * 3.0) * (cssH / 2)
      const clamped = Math.min(amp, cssH / 2 - 1)

      for (const L of layers) {
        ctx!.beginPath()
        for (let x = 0; x <= cssW; x += 2) {
          const t = x / cssW
          // Envelope tapers the ends so waves fade in/out at the edges.
          const env = Math.sin(Math.PI * t)
          const y =
            mid +
            Math.sin(t * Math.PI * 2 * L.freq + phase + L.off) * clamped * env
          if (x === 0) ctx!.moveTo(x, y)
          else ctx!.lineTo(x, y)
        }
        ctx!.strokeStyle = `rgba(${accent}, ${L.alpha})`
        ctx!.lineWidth = L.w
        ctx!.lineJoin = 'round'
        ctx!.stroke()
      }

      raf = requestAnimationFrame(draw)
    }

    raf = requestAnimationFrame(draw)

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
    }
  }, [levelRef, accentRgb])

  return <canvas ref={canvasRef} className="hud-waveform" />
}

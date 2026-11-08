import { useEffect, useRef, useState, type JSX } from 'react'
import { Pause, Play, Square, X } from 'lucide-react'
import { Button } from './components/Button'
import './agent-cursor.css'
import { CONFIG } from '../../shared/config'
import type { AgentCursorAction, AgentCursorTarget } from '../../shared/types'
import { entryPoint, glideMs, planPath, pointAt, type Point } from '../../shared/agent-cursor-motion'

// Click-through except the cursor itself, which opens Pause / Stop when the run can be controlled.

const LABEL_MAX = 40
const M = CONFIG.AGENT_CURSOR

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export default function AgentCursorApp(): JSX.Element {
  const [pos, setPos] = useState<Point | null>(null)
  const [tilt, setTilt] = useState(0)
  const [pressed, setPressed] = useState(false)
  const [target, setTarget] = useState<AgentCursorTarget | null>(null)
  const [visible, setVisible] = useState(false)
  const [arrived, setArrived] = useState(0)
  const [moving, setMoving] = useState(false)
  const [hover, setHover] = useState(false)
  const [menu, setMenu] = useState(false)

  const posRef = useRef<Point | null>(null)
  const rafId = useRef(0)
  const pressTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    const land = (p: AgentCursorTarget): void => {
      setMoving(false)
      setTilt(0)
      setArrived((n) => n + 1)
      if (p.kind !== 'click') return
      setPressed(true)
      clearTimeout(pressTimer.current)
      pressTimer.current = setTimeout(() => setPressed(false), M.PRESS_MS)
    }

    const offShow = window.api.onAgentCursorShow((p) => {
      setVisible(true)
      setTarget(p)
      setMoving(true)
      cancelAnimationFrame(rafId.current)
      const to = { x: p.x, y: p.y }

      if (prefersReducedMotion()) {
        posRef.current = to
        setPos(to)
        land(p)
        return
      }

      const from = posRef.current ?? entryPoint(to)
      const total = glideMs(posRef.current, to)
      if (total === 0) {
        land(p)
        return
      }
      const path = planPath(from, to, total)
      const start = performance.now()
      let prev = from
      let prevAt = start

      const tick = (now: number): void => {
        const { at, done } = pointAt(path, now - start)
        const dt = Math.max(1, now - prevAt)
        const lean = Math.max(-M.MAX_TILT_DEG, Math.min(M.MAX_TILT_DEG, ((at.x - prev.x) / dt) * 6))
        setTilt((t) => t + (lean - t) * 0.25)
        prev = at
        prevAt = now
        posRef.current = at
        setPos(at)
        if (done) land(p)
        else rafId.current = requestAnimationFrame(tick)
      }
      rafId.current = requestAnimationFrame(tick)
    })

    const offHide = window.api.onAgentCursorHide(() => {
      setVisible(false)
      setHover(false)
      setMenu(false)
    })

    return () => {
      offShow()
      offHide()
      cancelAnimationFrame(rafId.current)
      clearTimeout(pressTimer.current)
    }
  }, [])

  if (!pos) return <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none' }} />

  const T = CONFIG.THEME_TOKENS
  const label = target?.label ? target.label.slice(0, LABEL_MAX) : null
  const controllable = visible && !!target?.controls
  const paused = !!target?.paused
  const hoverTo = (on: boolean): void => {
    setHover(on)
    window.api.agentCursorHover(on)
  }
  const act = (action: AgentCursorAction): void => {
    window.api.agentCursorControl(action)
    if (action === 'stop') setMenu(false)
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        pointerEvents: 'none',
        opacity: visible ? 1 : 0,
        transition: `opacity ${CONFIG.AGENT_CURSOR.FADE_MS}ms ease-out`
      }}
    >
      <div
        onMouseEnter={() => controllable && hoverTo(true)}
        onMouseLeave={() => hover && hoverTo(false)}
        onClick={() => controllable && setMenu((m) => !m)}
        style={{
          position: 'absolute',
          left: pos.x,
          top: pos.y,
          pointerEvents: controllable ? 'auto' : 'none',
          cursor: controllable ? 'pointer' : undefined,
          transform: `translate(-4px, -2px) rotate(${tilt}deg) scale(${pressed ? 0.86 : hover ? 1.12 : 1})`,
          transformOrigin: '4px 2px',
          transition: `transform ${M.PRESS_MS}ms ease-out`
        }}
      >
        {!moving && (
          <div
            className="agent-cursor-pulse"
            data-paused={paused || undefined}
            style={{
              position: 'absolute',
              left: -8,
              top: -8,
              width: 24,
              height: 24,
              borderRadius: '50%',
              background: T.accent,
              animationDuration: `${M.PULSE_MS}ms`
            }}
          />
        )}

        <svg width="28" height="28" viewBox="0 0 28 28" style={{ filter: `drop-shadow(${T.shadowBubble})` }}>
          <path
            d="M4 2 L4 22 L10 17 L14 25 L18 23 L14 15 L21 15 Z"
            fill={T.accent}
            stroke={T.onAccent}
            strokeWidth={1.5}
            strokeLinejoin="round"
          />
        </svg>

        {!moving && target?.kind === 'click' && (
          <div
            key={`ripple-${arrived}`}
            className="agent-cursor-ripple"
            style={{
              position: 'absolute',
              left: 6,
              top: 6,
              width: 20,
              height: 20,
              borderRadius: '50%',
              border: `2px solid ${T.accent}`,
              animationDuration: `${CONFIG.AGENT_CURSOR.RIPPLE_MS}ms`
            }}
          />
        )}

        {!moving && target?.kind === 'type' && (
          <div
            key={`caret-${arrived}`}
            className="agent-cursor-caret"
            style={{
              position: 'absolute',
              left: 24,
              top: 2,
              width: 2,
              height: 16,
              background: T.accent,
              animationDuration: `${CONFIG.AGENT_CURSOR.CARET_BLINK_MS}ms`
            }}
          />
        )}

        <div
          style={{
            position: 'absolute',
            left: 20,
            top: 20,
            whiteSpace: 'nowrap',
            display: 'flex',
            flexDirection: 'column',
            gap: 2
          }}
        >
          <span
            style={{
              padding: '2px 6px',
              borderRadius: 6,
              background: T.accent,
              color: T.onAccent,
              fontSize: 11,
              fontWeight: 600,
              boxShadow: T.shadowBubble
            }}
          >
            MightyMouse
          </span>
          {label && (
            <span
              style={{
                padding: '2px 6px',
                borderRadius: 6,
                background: T.surfaceSolid,
                color: T.onSurface,
                fontSize: 11,
                boxShadow: T.shadowBubble,
                maxWidth: 200,
                overflow: 'hidden',
                textOverflow: 'ellipsis'
              }}
            >
              {label}
            </span>
          )}
          {hover && !menu && (
            <span className="agent-cursor-hint" style={{ background: T.surfaceSolid, color: T.muted }}>
              Click to pause or stop
            </span>
          )}
          {controllable && menu && (
            <div
              className="agent-cursor-menu"
              style={{ background: T.surfaceSolid, color: T.onSurface, boxShadow: T.shadowBubble }}
              onClick={(e) => e.stopPropagation()}
            >
              <Button variant="bare" onClick={() => act(paused ? 'resume' : 'pause')}>
                {paused ? <Play size={12} /> : <Pause size={12} />}
                {paused ? 'Resume' : 'Pause'}
              </Button>
              <Button variant="bare" onClick={() => act('stop')}>
                <Square size={11} />
                Stop
              </Button>
              <Button variant="bare" aria-label="Close" onClick={() => setMenu(false)}>
                <X size={12} />
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

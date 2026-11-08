import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { Mic, Video, Camera, Check, X } from 'lucide-react'
import type { ActivityPayload, ActivityState } from '../../shared/types'
import { CONFIG } from '../../shared/config'
import { IS_DEV } from '../../shared/env'
import { useMicLevel } from './hooks/useMicLevel'
import { useInterval } from './hooks/useInterval'
import { SnailTrail } from './components/SnailTrail'

// Dynamic Island renderer (?window=island). One slim black bar (the .band) hugging the
// camera notch: content sits in the gutters left + right of the camera, with the notch
// column transparent in the middle so the real camera shows through. The bar has rounded
// bottom corners (top stays square, tucked behind the notch). The glow-U + crawler mouse
// hang just BELOW the bar in transparent space — the window is taller than the bar but
// only the bar paints black. Hidden (collapsed to a thin sliver) when idle. Observational
// only — the window ignores mouse events.
//
// Geometry comes from the window query: notchW (camera width) + notchTop (px from the
// window top down to the notch's bottom edge).
//
// Self-contained <style> block (standalone overlay, not the shared CSS layer). Accents
// come from the injected theme vars — no raw hex for state colors.

const params = new URLSearchParams(window.location.search)
const NOTCH_W = Number(params.get('notchW')) || 185
const NOTCH_TOP = Number(params.get('notchTop')) || 38

// The U path the crawler mouse walks — DOWN the notch's left edge, ACROSS the
// bottom (following the rounded corners), UP the right edge. Coords are relative
// to the glow-U box (NOTCH_W × NOTCH_TOP), so they land exactly on that border.
// Sampled corners as short diagonal cuts (radius ~10) so the turn reads smooth
// instead of a hard 90°. y starts a few px down (mouse enters from under the mask).
const U_RADIUS = 10
const U_INSET = 1.5 // nudge inward so the sprite center sits ON the 3px border
const U_SPRITE = 34 // must match the SnailTrail size= below
// Top of the walk = how high the sprite CENTER climbs each side. The sprite extends
// U_SPRITE/2 ABOVE its center, so the center must stay at least that far below the
// notch's top edge (y=0) or the sprite's top half gets clipped behind the camera
// mask. We keep it a few px clear of that hard limit so it never kisses the notch.
const U_TOP = Math.round(U_SPRITE / 2 + 4)
const U_PATH = [
  { x: U_INSET, y: U_TOP }, // top-left, sprite fully below the mask
  { x: U_INSET, y: NOTCH_TOP - U_RADIUS }, // down left edge
  { x: U_INSET + U_RADIUS, y: NOTCH_TOP - U_INSET }, // round bottom-left corner
  { x: NOTCH_W - U_INSET - U_RADIUS, y: NOTCH_TOP - U_INSET }, // across bottom
  { x: NOTCH_W - U_INSET, y: NOTCH_TOP - U_RADIUS }, // round bottom-right corner
  { x: NOTCH_W - U_INSET, y: U_TOP } // up right edge to top-right
]

// Per-state accent driving the glow/glyph/label color on the black blob.
// THEME_TOKENS.accent is the brand orange. done=green /
// error=red because the color itself carries the meaning.
//
// We use the CONCRETE token VALUES here (not `var(--accent)`), because the accent is
// piped through a nested inline custom property (`--accent: <this>`, then read as
// `var(--accent)` in the <style> block). A nested `var(--accent)` inside that did NOT
// resolve in the island overlay and fell through to the `#fff` fallback — the glow
// rendered white. A literal rgba() resolves cleanly. (Burned us; keep it literal.)
const T = CONFIG.THEME_TOKENS
const ACCENT: Record<Exclude<ActivityState, 'idle'>, string> = {
  listening: T.accent,
  recording: T.red,
  screenshot: T.accent,
  thinking: T.accent,
  done: T.green,
  error: T.red
}

function Glyph({ state }: { state: ActivityState }): JSX.Element | null {
  const size = 15
  switch (state) {
    case 'listening':
      return <Mic size={size} />
    case 'recording':
      return <Video size={size} />
    case 'screenshot':
      return <Camera size={size} />
    case 'thinking':
      return <span className="island-spinner" />
    case 'done':
      return <Check size={size} />
    case 'error':
      return <X size={size} />
    default:
      return null
  }
}

function fmtElapsed(s: number): string {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

// Dev-only state override: open the island with `?demo=listening` (or any
// ActivityState) to FORCE that state without triggering a real session — lets you
// eyeball the glow + crawler mouse straight from the URL. Ignored in prod.
const DEMO_STATE = (IS_DEV && params.get('demo')) as ActivityState | '' | null

export default function IslandApp(): JSX.Element {
  const [payload, setPayload] = useState<ActivityPayload>(
    DEMO_STATE ? { state: DEMO_STATE } : { state: 'idle' }
  )
  const [elapsed, setElapsed] = useState(0)

  const recording = payload.state === 'recording'
  const listeningState = payload.state === 'listening'
  // Both timed states (listening + recording) run an elapsed clock — reset when
  // either one (re)starts so the right-side timer counts from 0 each session.
  const timed = recording || listeningState

  useEffect(() => {
    return window.api.onIslandActivity((p) => {
      setPayload(p)
      if (p.state === 'recording' || p.state === 'listening') setElapsed(0)
    })
  }, [])

  useInterval(() => setElapsed((e) => e + 1), timed ? 1000 : null)

  const { state, detail } = payload
  const visible = state !== 'idle'
  const listening = listeningState
  // Tap the mic only while listening. Drives the voice-reactive glow — no canvas,
  // no waveform; the cradling U around the camera IS the level meter now. Snappier
  // smoothing (0.32 vs the waveform's 0.18) so small voice changes register fast.
  // `normRef` is the auto-normalized 0..1 (rolling floor/ceiling AGC + idle
  // shimmer) — we write it straight to the DOM at 60fps below for a fluid glow,
  // bypassing React's 15fps state (which made the glow look static/steppy).
  const { normRef } = useMicLevel(listening, 0.32)
  const blobRef = useRef<HTMLDivElement>(null)

  // Push the live normalized level onto the blob's --glow var every frame while
  // listening. 60fps, no re-render — this is what makes it feel alive + reactive.
  useEffect(() => {
    if (!listening) {
      blobRef.current?.style.setProperty('--glow', '0')
      return
    }
    let raf = 0
    const pump = (): void => {
      blobRef.current?.style.setProperty('--glow', String(normRef.current))
      raf = requestAnimationFrame(pump)
    }
    raf = requestAnimationFrame(pump)
    return () => cancelAnimationFrame(raf)
  }, [listening, normRef])
  // Right gutter shows an elapsed timer. It ticks live during the timed states
  // (listening / recording), then FREEZES at the final value through the follow-on
  // states (thinking = transcribing, done) so you still see how long the clip was after
  // it stops. Reset back to 0 only on the next listening/recording start (above).
  // Hidden for screenshot / error / idle, which carry no duration.
  // Freeze-display only makes sense if a clip actually ran this cycle (elapsed > 0) —
  // a pure ask/act flow also passes through thinking/done with no recording, and we
  // don't want a phantom "0:00" there.
  const showTimer = timed || ((state === 'thinking' || state === 'done') && elapsed > 0)
  const timer = showTimer ? fmtElapsed(elapsed) : undefined
  // Left-of-mic label next to the glyph. "Listening" while listening; for other
  // non-timed states the short detail.
  const leftLabel = listening ? 'Listening' : recording ? undefined : detail
  const accent = visible ? ACCENT[state] : undefined

  // Drag the island out of the way mid-run. We send screen-space DELTAS, not points:
  // the window moves under the cursor as we drag, so each move changes what the next
  // event reports — absolute readings compound into runaway drift. A delta from the
  // previous event is stable regardless of where the window landed.
  const onDragStart = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    e.preventDefault()
    let lastX = e.screenX
    let lastY = e.screenY
    const onMove = (m: PointerEvent): void => {
      window.api.islandMove(m.screenX - lastX, m.screenY - lastY)
      lastX = m.screenX
      lastY = m.screenY
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // Double-click puts it back on the notch — the way out if it ends up somewhere bad.
  const onResetPosition = (): void => window.api.islandResetPosition()

  return (
    <>
      <style>{islandCss()}</style>
      <div
        ref={blobRef}
        className={`blob ${visible ? 'show' : ''}`}
        style={{ ['--accent' as string]: accent }}
      >
        {/* Top band: the two content wings with the camera gap between them. Also the
            drag surface while a run is showing — main flips setIgnoreMouseEvents off
            for exactly that window, so these handlers are inert when idle. */}
        <div className="band" onPointerDown={onDragStart} onDoubleClick={onResetPosition}>
          <div className="gutter gutter-left">
            <Glyph state={state} />
            {recording && <span className="rec-dot" />}
            {leftLabel && <span className="island-label">{leftLabel}</span>}
          </div>
          <div className="notch-edge" />
          <div className="gutter gutter-right">
            {/* Elapsed timer — mirrors the mic+label on the left. Monospaced
                figures so the digits don't jitter as the clock ticks. */}
            {timer && <span className="timer">{timer}</span>}
          </div>
        </div>

        {/* Glowing U cradling the camera: traces down the notch's left inner edge,
            across the bottom, up the right — tinted by --accent. While listening it
            reacts to the mic (--glow drives brightness); otherwise it breathes. */}
        {visible && <span className={`glow-u ${listening ? 'reactive' : ''}`} />}

        {/* Ambient "I'm working" crawler: a mouse walks the U around the camera
            notch — down the left edge, across the bottom, up the right — tracing the
            same path as the glow-U and leaving its trail filling the border behind
            it. The container is the EXACT glow-U box, so the U_PATH points (in that
            box's coords) sit right on the border. Decorative + pointer-events:none.
            Auto-loops while listening/recording. */}
        {(listening || recording) && (
          <div className="snail-trail-wrap">
            <SnailTrail
              path={U_PATH}
              size={U_SPRITE}
              speed={3}
              trailColor={`rgb(${CONFIG.THEME_TOKENS.whiteRgb})`}
              anchor="edge"
              anchorSide="outward"
              fill
              fillWidth={3}
            />
          </div>
        )}
      </div>
    </>
  )
}

// CSS is a function so it can interpolate the per-machine notch geometry (width +
// vertical offset) and the hug radius into fixed positions.
function islandCss(): string {
  const half = NOTCH_W / 2
  return `
  /* Standalone overlay — this <style> block is the island's whole CSS world, so it
     must set the brand font itself (it doesn't inherit the renderer's index.css).
     Without this the labels fall back to the browser default serif = off-brand. */
  html, body, #root {
    margin: 0; height: 100%; background: transparent; overflow: hidden;
    font-family: -apple-system, 'SF Pro Display', system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }

  /* The blob = the whole window, kept TRANSPARENT. Only the .band (top row) paints
     black now, so the island reads as ONE slim rounded bar — the area below the bar
     stays clear, letting the glow-U + crawler mouse hang past the bar's bottom edge
     with no black block behind them and no clipping. */
  .blob {
    position: relative; width: 100%; height: 100%; box-sizing: border-box;
    background: transparent;
    opacity: 0; transform: translateY(-6px);
    transition: opacity 180ms ease, transform 200ms cubic-bezier(0.4, 0, 0.2, 1);
  }
  .blob.show { opacity: 1; transform: translateY(0); }

  /* The black bar — the ONLY black surface. Sits in the notch row, split into two
     gutters with a transparent gap in the middle exactly the camera's width so the real
     notch shows through. Solid 100% opaque black, BOTTOM corners rounded; top corners
     stay square (they bleed off-screen behind the notch). The desktop never shows
     through the bar itself. */
  .band {
    position: relative;
    display: flex; align-items: center; height: calc(${NOTCH_TOP}px + 12px);
    padding: 0 4px; box-sizing: border-box;
    background: var(--curtain-black);
    border-bottom-left-radius: 22px; border-bottom-right-radius: 22px;
    /* Only ever grabbable while a run shows — main gates the whole window's
       mouse-catching, so this cursor can't appear when the island is idle. */
    cursor: grab;
  }
  .band:active { cursor: grabbing; }
  /* Extend the black SQUARELY upward past the window's top edge so the bar's top
     corners sit well off-screen — only the rounded BOTTOM of the bar is ever visible.
     Pure visual fill (no geometry change), so the glow-U + mouse positions are
     untouched. Sits behind the band content (z -1). */
  .band::before {
    content: ''; position: absolute; left: 0; right: 0; bottom: 100%; height: 40px;
    background: var(--curtain-black); z-index: -1;
  }
  /* Blob is solid black, so EVERYTHING inside it must be light. The glyph icons inherit
     currentColor — without this they'd render black-on-black and vanish. Tint the icon
     in the active accent color (reads well on black); fall back to white when idle. */
  .gutter { display: flex; align-items: center; justify-content: center; gap: 6px; min-width: 0; flex: 1; position: relative; color: var(--accent, #fff); }
  /* Center each gutter's content within its own half so the mic+label and the
     timer sit centered in the wings, not glued against the camera notch. */
  .gutter-left { justify-content: center; padding: 0 10px; }
  .gutter-right { justify-content: center; padding: 0 10px; }
  .notch-edge { width: ${NOTCH_W}px; flex: none; position: relative; }

  .rec-dot {
    width: 7px; height: 7px; border-radius: 50%; flex: none;
    background: var(--red); animation: pulse 1.1s ease-in-out infinite;
  }
  /* Scoped class name (NOT plain .label) — the renderer's global index.css has a
     .label rule with text-transform:uppercase that this overlay also loads, so a
     bare "label" got force-uppercased ("LISTENING"). island-label avoids the clash. */
  .island-label {
    font-size: var(--font-sm); font-weight: 600; color: rgba(255, 255, 255, 0.92);
    text-transform: none;
    letter-spacing: -0.01em;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  /* The left "Listening" label: clean sentence-case in the accent so it ties to the
     glyph + glow. No uppercase (reads shouty), modest weight + slight negative
     tracking = a calm status tag that matches the brand voice. */
  .gutter-left .island-label {
    color: var(--accent, #fff);
    font-size: var(--font-sm);
    font-weight: 500;
    letter-spacing: -0.01em;
    opacity: 0.92;
  }
  /* Right-gutter elapsed timer. Tabular figures keep the digits from jittering as
     the clock ticks; tinted in the accent to match the left label + glow. */
  .timer {
    font-size: var(--font-sm); font-weight: 600;
    color: var(--accent, #fff);
    font-variant-numeric: tabular-nums;
    font-feature-settings: 'tnum' 1;
    letter-spacing: 0.01em;
    opacity: 0.92;
  }

  .island-spinner {
    width: 13px; height: 13px; border-radius: 50%; flex: none;
    border: 2px solid rgba(255, 255, 255, 0.25); border-top-color: currentColor;
    animation: spin 0.7s linear infinite;
  }

  /* Glowing U cradling the camera. A box spanning the notch width + the two hug radii,
     sitting at the notch's bottom edge, with only its LEFT/BOTTOM/RIGHT borders drawn
     and the bottom corners rounded to follow the hugs — so it traces a U under the
     camera. Colored + lit by --accent (the active state's color), breathing via the
     box-shadow. Sits ABOVE the black blob so the glow reads against the notch. */
  .glow-u {
    position: absolute;
    /* Hug the EXACT camera-notch border: a box the size of the real notch
       (NOTCH_W wide × its full height), so the U traces down the camera's left
       edge, across its bottom, and up its right edge. Top runs up to ~y=0 (behind
       the mask); only L/B/R borders drawn, bottom corners rounded like the camera. */
    top: 0;
    left: calc(50% - ${half}px);
    width: ${NOTCH_W}px;
    height: ${NOTCH_TOP}px;
    box-sizing: border-box;
    /* Thicker so it reads clearly against the black blob (was 2px = too thin). */
    border: 3px solid var(--accent, #fff);
    border-top: none;
    border-bottom-left-radius: 10px;
    border-bottom-right-radius: 10px;
    pointer-events: none;
    animation: glow-breathe 1.6s ease-in-out infinite;
  }

  /* Listening: the U is the level meter. --glow (0..1, live mic loudness from
     useMicLevel) drives the halo size + opacity in real time, so the ring around
     the camera swells with your voice. No CSS animation here — JS owns the value,
     so it tracks speech instead of a fixed breathing loop. The transition smooths
     the 15fps React updates into a continuous glow. */
  .glow-u.reactive {
    animation: none;
    /* "A glowing BORDER with a blur" — not a wide soft bloom. The border itself is
       the glowing element: it thickens and brightens with --glow, wrapped in a TIGHT
       halo (small blur radii) that hugs the edge instead of bleeding across the whole
       island. Quiet = thin sharp ring; loud = fat bright ring with a snug glow.
       Halo radii are deliberately small (max ~14px, not 50px) so it stays crisp.
       JS owns --glow at 60fps; the short transition just smooths frame-to-frame. */
    opacity: 1;
    /* The glow grows in BOTH intensity AND distance with your voice — but the HUE
       never shifts. No filter:brightness/saturate (that washed orange → yellow).
       Intensity comes from the halo's own opacity (--accent-rgb at a glow-driven
       alpha), distance from its blur radius + spread. Quiet = faint tight ring;
       loud = same orange, brighter and reaching further. */
    border-width: calc(2px + var(--glow, 0) * 2px);
    box-shadow:
      /* crisp core ring — defines the edge, fully opaque accent */
      0 0 calc(2px + var(--glow, 0) * 5px) var(--accent, #fff),
      /* intensity layer: opacity ramps 0.3 → 1.0, radius swings hard */
      0 0 calc(4px + var(--glow, 0) * 26px) calc(var(--glow, 0) * 5px)
        rgba(var(--accent-rgb, 255, 160, 80), calc(0.3 + var(--glow, 0) * 0.7)),
      /* distance layer: BIG reach + spread on loud, dim so it reads as a halo */
      0 0 calc(6px + var(--glow, 0) * 60px) calc(var(--glow, 0) * 16px)
        rgba(var(--accent-rgb, 255, 160, 80), calc(0.12 + var(--glow, 0) * 0.5));
    transition: box-shadow 50ms linear, border-width 50ms linear;
  }

  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
  @keyframes glow-breathe {
    0%, 100% {
      box-shadow: 0 0 4px var(--accent, #fff), 0 2px 8px var(--accent, #fff);
      opacity: 0.85;
    }
    50% {
      box-shadow: 0 0 10px var(--accent, #fff), 0 3px 16px var(--accent, #fff);
      opacity: 1;
    }
  }

  /* SnailTrail box: overlays the EXACT glow-U box (same geometry as .glow-u) so the
     U_PATH points — given in this box's coords — land right on the notch border. The
     mouse walks down-left / across-bottom / up-right, tracing the U. overflow:visible
     so the sprite + its glow trail aren't clipped at the corners. Sits ABOVE the
     glow-U (z via DOM order) so the mouse rides on top of the lit border.
     pointer-events:none — the island is observational-only; double-fenced here. */
  .snail-trail-wrap {
    position: absolute;
    top: 0;
    left: calc(50% - ${half}px);
    width: ${NOTCH_W}px;
    height: ${NOTCH_TOP}px;
    overflow: visible;
    pointer-events: none;
  }
`
}

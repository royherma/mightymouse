import React, { useEffect, useRef, useState } from 'react'
import { Sparkles, Loader2, X } from 'lucide-react'
import { CONFIG } from '../../shared/config'
import { CursorStyleId, DEFAULT_CURSOR_STYLE, toCursorStyle } from '../../shared/cursor-styles'
import type { Suggestion, SuggestState } from '../../shared/types'
import { MouseGlyph } from './MouseGlyph'
import { SuggestionPreview } from './components/SuggestionPreview'
import { claimClickable, resetOverlayClaims } from './cursor-overlay-claims'
import { MODE_CHIP_STYLE } from './mode-colors'
import { useHoverIntent } from './hooks/useHoverIntent'

// Full-screen, click-through overlay that draws a companion following the OS
// cursor. The look is chosen by the user (Settings → Animated pointer style) and
// pushed live over CHANNELS.cursorStyle, so switching never restarts the window.
//
// All styles share one rAF loop. Per frame we ease a follower toward the cursor
// and derive velocity (speed + direction) from the frame-to-frame delta — that
// velocity drives the speed-reactive bits (comet stretch, mouse lean, particle
// spawn rate). Everything is GPU-friendly transforms/opacity on a transparent
// surface, so 60fps holds even with a short particle trail.

const BLUE = CONFIG.THEME_TOKENS.accent
const CYAN = CONFIG.THEME_TOKENS.cyan
const SURFACE = CONFIG.THEME_TOKENS.surface1
const SURFACE_STRONG = CONFIG.THEME_TOKENS.surface2
const TEXT = CONFIG.THEME_TOKENS.onSurface
const MUTED = CONFIG.THEME_TOKENS.muted
const BORDER = CONFIG.THEME_TOKENS.accentBorderSubtle

// Where the companion sits relative to the real cursor tip.
const OFFSET_X = 24
const OFFSET_Y = 28
const BUBBLE_OFFSET_X = 28
const BUBBLE_OFFSET_Y = 18
const BUBBLE_W = 260
const BUBBLE_RADIUS = 8
const BUBBLE_PAD = 10
const BUBBLE_GAP = 8
const MODE_CHIP_W = 54
// Wide enough for the full ⌘⌥⇧1 accept chord (matches the app's one hotkey set).
const HINT_W = 50
const LABEL_MAX_W = 116
// macOS modifier glyphs for the accept-chord hint. Same combo as every shortcut.
const CHORD_MODS = '⌘⌥⇧'

// Follow easing (0..1 per frame): lower = laggier, more "trailing" feel.
const FOLLOW = 0.2

// Shared pulse (breathing) for idle styles.
const REST_SPEED = 0.05
const REST_FRAME_MS = 66
const PULSE_SPEED = 0.0022 // ~one breath / 2.8s

// ── "Point at" glide ────────────────────────────────────────────────────────
// How long the glyph holds on the target (pulsing) before releasing back to
// following the real cursor. Long enough to read "it's pointing HERE", short
// enough not to feel stuck.
const GLIDE_HOLD_MS = 2200
// Snappier easing than FOLLOW so the glyph arrives at the target promptly
// instead of lazily trailing to it.
const GLIDE_FOLLOW = 0.28
// Pixel proximity at which we consider the glyph "arrived" and start the hold.
const GLIDE_ARRIVE_PX = 6
// Expanding pulse ring: how big it grows and how fast it repeats while pointing.
const RING_MAX_PX = 64
const RING_PERIOD_MS = 900
// Arrival bounce: the instant the glyph lands it hops up and settles, so the
// landing reads as a deliberate "go HERE!" jump instead of a smooth slide-in.
// A damped sine over BOUNCE_MS: starts at full height, overshoots once, decays.
const BOUNCE_HEIGHT_PX = 18 // peak hop height (drawn upward = negative y)
const BOUNCE_MS = 520 // total settle time
const BOUNCE_BOUNCES = 2.2 // sine half-cycles within the window (≈ two hops)

// Max trail particles kept alive at once. Raised for a denser, more visible wake;
// still bounded so the transparent overlay stays flicker-free on most Macs.
const MAX_PARTICLES = 18

// ── Heat trail ──────────────────────────────────────────────────────────────
// Modelled on the phone-remote touchpad trail (phone-remote/react/CursorTrail.tsx),
// which reads as one continuous STROKE rather than a scatter of dots. Four things
// make that work, and all four are load-bearing here too:
//
//   1. Points are sampled by DISTANCE, not on a timer — evenly spaced along the
//      path, so the stroke doesn't clump when slow or gap when fast.
//   2. Size tapers big-head → small-tail, so the stroke has direction.
//   3. Opacity falls off SQUARED — a linear ramp ends the tail in a visible stub
//      instead of dissolving.
//   4. A slight blur + screen blend melts overlapping dots into one stroke.
//
// What's ours: the colour axis is AGE along the stroke, walked as a classic
// thermal ramp — white-hot at the cursor, cooling back through yellow/orange/red
// to a deep violet tail. v2 mapped colour to birth SPEED instead, which meant two
// neighbouring points could be cyan and red; the stroke read as scattered beads
// rather than one cooling wake. Position-mapped heat is coherent by construction:
// neighbours are always adjacent on the ramp.
const HEAT_RAMP = [
  [255, 255, 238], // white-hot core, at the cursor
  [255, 214, 92], // yellow
  [255, 138, 32], // orange
  [232, 58, 46], // red
  [124, 32, 110] // violet embers, at the tail
] as const

// Below this (px/frame) the pointer counts as parked and lays nothing — without
// the floor a resting cursor burns a permanent dot into the overlay.
const HEAT_MOVING_PX = 0.35
// Min px between sampled points. The distance gate that makes the stroke even.
const HEAT_MIN_DIST_PX = 6
// Points alive at once, and how long each lives. Both are deliberately short: the
// trail must feel welded to the cursor, and a long TTL is what made v2 drag a
// visible comet behind the pointer seconds after it stopped.
const HEAT_MAX_POINTS = 14
const HEAT_POINT_TTL_MS = 380
// Head/tail size. Newest point is MAX, oldest MIN — direction comes from taper.
const HEAT_DOT_MAX_PX = 17
const HEAT_DOT_MIN_PX = 3

interface Particle {
  x: number
  y: number
  born: number
  life: number // ms
  size: number
  el: HTMLDivElement
}

export default function CursorApp(): React.ReactElement {
  const [style, setStyle] = useState<CursorStyleId>(DEFAULT_CURSOR_STYLE)
  const [visible, setVisible] = useState(false)
  const [suggest, setSuggest] = useState<SuggestState>({ phase: 'hidden' })
  // Once the user drags the bubble it pins to this window-local point and stops
  // following the cursor. null = still anchored next to the cursor.
  const [dropPos, setDropPos] = useState<{ x: number; y: number } | null>(null)
  // Live cursor position the bubble trails WHILE LOADING (so the "thinking" bubble
  // hovers along with the mouse). Frozen the instant the chips arrive so the user
  // can aim at them; null until the first position lands.
  const [followPos, setFollowPos] = useState<{ x: number; y: number } | null>(null)
  // HUD-style two-step cancel: bare Esc (from main) arms this + reveals the
  // "⏎ to cancel" hint; Enter then confirms (main dismisses the bubble).
  const [cancelArmed, setCancelArmed] = useState(false)
  // Pointer art draws only when the companion pref is on. The overlay can be up
  // purely for the suggestion bubble (insights on, companion off) — then this
  // stays false and no uninvited animated pointer is shown.
  const [pointerEnabled, setPointerEnabled] = useState(false)
  // rAF reads the live value via a ref (avoids re-subscribing the loop on toggle).
  const pointerEnabledRef = useRef(false)

  // Refs: target = latest cursor (window-local), pos = eased follower.
  const target = useRef({ x: -100, y: -100 })
  const pos = useRef({ x: -100, y: -100 })
  const vel = useRef({ x: 0, y: 0, speed: 0, angle: 0 })
  const rafId = useRef<number>(0)
  const startTs = useRef<number | null>(null)
  // Active "point at" glide: destination (window-local) + when the glyph arrived
  // (null until it reaches the target, then starts the hold clock). null glide =
  // not pointing, normal cursor-follow. The expanding ring is drawn at `glideRingRef`.
  const glide = useRef<{ x: number; y: number; arrivedTs: number | null } | null>(null)
  const glideRingRef = useRef<HTMLDivElement>(null)

  // Style-specific element refs.
  const cometRef = useRef<HTMLDivElement>(null)
  const cometTailRef = useRef<HTMLDivElement>(null)
  const mouseRef = useRef<HTMLDivElement>(null)
  const mouseEyesRef = useRef<SVGGElement>(null)
  const mouseLaserRef = useRef<SVGGElement>(null)
  const laserBeams = useRef<Array<SVGRectElement | null>>([])
  const particleLayer = useRef<HTMLDivElement>(null)
  // Last sampled heat-trail point — the distance gate measures against this, so
  // it must be cleared alongside the point pool or a style switch draws one long
  // dash from wherever the pointer was last time.
  const lastHeatPoint = useRef<{ x: number; y: number } | null>(null)
  const particles = useRef<Particle[]>([])
  const particleSeq = useRef(0)
  const lastSpawn = useRef(0)

  // Live style switch from Settings.
  useEffect(() => {
    const off = window.api.onCursorStyle((s) => setStyle(toCursorStyle(s)))
    return off
  }, [])

  // "Point at" — main tells the glyph to glide to an absolute (window-local)
  // point and pulse. We arm a glide; the rAF loop drives the glyph there, holds,
  // then releases back to following the real cursor.
  useEffect(() => {
    const off = window.api.onCursorFlyTo((p) => {
      glide.current = { x: p.x, y: p.y, arrivedTs: null }
      if (!visible) setVisible(true)
    })
    return off
  }, [visible])

  useEffect(() => {
    const off = window.api.onCursorSuggest((next) => {
      // Seed the follow anchor to the cursor's spot the instant a bubble opens, so
      // the loading bubble appears AT the mouse even before any movement frame.
      setSuggest((prev) => {
        if (prev.phase === 'hidden' && next.phase !== 'hidden') {
          setFollowPos({ ...target.current })
        }
        return next
      })
    })
    return off
  }, [])

  // While LOADING, the bubble trails the cursor live (re-render on each position).
  // Other phases freeze followPos so 'ready' chips stay put to be aimed at/dragged.
  // Esc (cancelArmed) also freezes it mid-load: the bubble parks where it is so the
  // user can aim at it / hit Enter / click ✕ without it chasing the cursor away.
  useEffect(() => {
    if (suggest.phase !== 'loading' || cancelArmed) return
    const off = window.api.onCursorPos((p) => setFollowPos({ x: p.x, y: p.y }))
    return off
  }, [suggest.phase, cancelArmed])

  // Esc (from main) arms the cancel hint; reset whenever the bubble changes phase
  // or goes away so a stale arm can't linger into the next bubble.
  useEffect(() => {
    const off = window.api.onCursorCancelArm(() => setCancelArmed(true))
    return off
  }, [])
  useEffect(() => {
    setCancelArmed(false)
  }, [suggest.phase])

  // Auto-fade the transient empty/error notes after a beat (manual trigger only —
  // the manager only ever sends those phases on the ⌘⌥⇧S path). 'loading'/'ready'
  // persist until the next state arrives; 'hidden' is already gone.
  useEffect(() => {
    if (suggest.phase !== 'empty' && suggest.phase !== 'error') return
    const t = setTimeout(() => setSuggest({ phase: 'hidden' }), CONFIG.SUGGESTIONS.FEEDBACK.AUTO_FADE_MS)
    return () => clearTimeout(t)
  }, [suggest.phase])

  // The overlay window stays click-through (and never steals focus/clicks from
  // the app underneath). It becomes interactive ONLY while the pointer is
  // physically over the bubble — the bubble's onMouseEnter/Leave flip it, so the
  // ✕ + drag work without the fullscreen window ever blocking typing or clicks
  // elsewhere. `forward:true` keeps move events flowing so enter/leave still fire
  // while click-through. Always release on hide so a stale hover can't stick.
  useEffect(() => {
    // Zero the claim refcounts on hide (not a bare setClickable(false)): a hover/
    // preview claim that never released can't leave the NEXT bubble's overlay stuck
    // click-through. See resetOverlayClaims. (Proactive arm-on-show lives in a second
    // effect below, after acquireHover is defined.)
    if (suggest.phase === 'hidden') resetOverlayClaims()
  }, [suggest.phase])

  // Reset the dropped position whenever the bubble goes away, so the next bubble
  // starts fresh next to the cursor instead of where the last one was dropped.
  useEffect(() => {
    if (suggest.phase === 'hidden') {
      setDropPos(null)
      setFollowPos(null)
    }
  }, [suggest.phase])

  useEffect(() => {
    const off = window.api.onCursorPointerEnabled((on) => {
      pointerEnabledRef.current = on
      setPointerEnabled(on)
    })
    // Pull the real state now that the listener above is attached. Main can't
    // safely push it at window-open — ready-to-show races this effect and a push
    // with no listener yet is dropped silently, which is what left the pointer
    // invisible until a restart. Subscribe first, then ask: no ordering to lose.
    void window.api.cursorGetState().then((s) => {
      pointerEnabledRef.current = s.pointerEnabled
      setPointerEnabled(s.pointerEnabled)
      setStyle(toCursorStyle(s.style))
    })
    return off
  }, [])

  useEffect(() => {
    const off = window.api.onCursorPos((p) => {
      target.current = { x: p.x, y: p.y }
      if (!visible) setVisible(true)
    })

    let lastRestDraw = 0
    const tick = (ts: number): void => {
      if (startTs.current === null) {
        startTs.current = ts
        pos.current = { ...target.current }
      }

      // While pointing, the glyph eases toward the GLIDE destination (snappier
      // than normal follow) instead of the cursor; the ring pulses at the target.
      // Once it arrives we hold for GLIDE_HOLD_MS, then release back to the cursor.
      // The art is drawn at pos + OFFSET, so aim `pos` at (target - OFFSET) to land
      // the glyph ON the point rather than offset from it.
      const g = glide.current
      const follow = g ? GLIDE_FOLLOW : FOLLOW
      const aim = g ? { x: g.x - OFFSET_X, y: g.y - OFFSET_Y } : target.current

      // Ease follower toward the aim point; derive velocity from the step we took.
      const dx = (aim.x - pos.current.x) * follow
      const dy = (aim.y - pos.current.y) * follow
      pos.current.x += dx
      pos.current.y += dy
      const speed = Math.hypot(dx, dy)
      // Smooth the speed a touch so stretch/glow don't jitter.
      vel.current.speed = vel.current.speed * 0.7 + speed * 0.3
      if (speed > 0.4) vel.current.angle = Math.atan2(dy, dx)

      // Glide bookkeeping: mark arrival, draw the ring, release after the hold.
      // `bounceY` is the upward hop applied to the drawn glyph (not the ring, which
      // stays pinned to the true target so it marks the exact spot through the hop).
      let bounceY = 0
      if (g) {
        renderGlideRing(g.x, g.y, ts, g.arrivedTs)
        // Glyph is drawn at pos + OFFSET; arrival = that drawn point near target.
        const glyphX = pos.current.x + OFFSET_X
        const glyphY = pos.current.y + OFFSET_Y
        const near = Math.hypot(g.x - glyphX, g.y - glyphY) < GLIDE_ARRIVE_PX
        if (near && g.arrivedTs === null) g.arrivedTs = ts
        if (g.arrivedTs !== null) {
          // Damped sine: |sin| gives clean hops; the linear decay envelope settles
          // it to rest by BOUNCE_MS so the glyph ends exactly on the target.
          const t = ts - g.arrivedTs
          if (t < BOUNCE_MS) {
            const decay = 1 - t / BOUNCE_MS
            bounceY = Math.abs(Math.sin((t / BOUNCE_MS) * Math.PI * BOUNCE_BOUNCES)) * BOUNCE_HEIGHT_PX * decay
          }
        }
        if (g.arrivedTs !== null && ts - g.arrivedTs > GLIDE_HOLD_MS) {
          glide.current = null
          if (glideRingRef.current) glideRingRef.current.style.opacity = '0'
        }
      } else if (glideRingRef.current && glideRingRef.current.style.opacity !== '0') {
        glideRingRef.current.style.opacity = '0'
      }

      const phase = (ts - startTs.current) * PULSE_SPEED
      const wave = (Math.sin(phase) + 1) / 2 // 0..1
      const x = pos.current.x + OFFSET_X
      // Subtract the arrival hop so the glyph springs UP off the target and settles.
      const y = pos.current.y + OFFSET_Y - bounceY
      const sp = vel.current.speed
      const angleDeg = (vel.current.angle * 180) / Math.PI

      // Pointer art is gated on the companion pref. When off, skip all drawing
      // (the bubble is separate React state and renders regardless).
      if (!pointerEnabledRef.current) {
        rafId.current = requestAnimationFrame(tick)
        return
      }

      const resting = !g && sp < REST_SPEED && particles.current.length === 0
      if (resting && ts - lastRestDraw < REST_FRAME_MS) {
        rafId.current = requestAnimationFrame(tick)
        return
      }
      lastRestDraw = ts

      if (style === 'comet') {
        renderComet(x, y, sp, wave, angleDeg)
      } else if (style === 'mouseHead') {
        // Vector from the glyph (drawn at x,y) to the REAL pointer (target).
        // When still it's ~ -OFFSET; when moving the eased lag makes it swing +
        // lengthen, so the lasers aim at the pointer and intensify with motion.
        const toPointerX = target.current.x - x
        const toPointerY = target.current.y - y
        renderMouse(x, y, sp, wave, angleDeg, toPointerX, toPointerY)
      } else if (style === 'particles') {
        renderParticles(x, y, sp, wave, ts)
      } else if (style === 'heatTrail') {
        renderHeatTrail(x, y, sp, wave, ts)
      }

      rafId.current = requestAnimationFrame(tick)
    }

    rafId.current = requestAnimationFrame(tick)
    return () => {
      off()
      cancelAnimationFrame(rafId.current)
      // Drop any lingering particle nodes when the style changes / unmounts.
      for (const p of particles.current) p.el.remove()
      particles.current = []
      lastHeatPoint.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [style])

  // ── "Point at" ring: an accent ring that expands+fades at the target, marking
  // exactly where the glyph is pointing. Repeats while the glide holds. Drawn at
  // the absolute target (rx,ry), independent of the glyph's eased position.
  function renderGlideRing(rx: number, ry: number, ts: number, arrivedTs: number | null): void {
    const ring = glideRingRef.current
    if (!ring) return
    // Don't pulse until the glyph has basically arrived — while it's still flying
    // in, hold a steady faint ring at the destination as a "heading here" marker.
    const t = arrivedTs === null ? 0 : ((ts - arrivedTs) % RING_PERIOD_MS) / RING_PERIOD_MS
    const size = arrivedTs === null ? 18 : 18 + t * (RING_MAX_PX - 18)
    const opacity = arrivedTs === null ? 0.5 : 0.85 * (1 - t)
    ring.style.opacity = String(opacity)
    ring.style.width = `${size}px`
    ring.style.height = `${size}px`
    // translate(-50%,-50%) keeps the ring centered on (rx,ry) as its size grows.
    ring.style.transform = `translate3d(${rx}px, ${ry}px, 0) translate(-50%, -50%)`
  }

  // ── Comet: glowing orb + exaggerated gradient tail, blue→cyan with speed ────
  function renderComet(x: number, y: number, sp: number, wave: number, angleDeg: number): void {
    const head = cometRef.current
    const tail = cometTailRef.current
    if (!head) return
    const speedN = Math.min(sp / 22, 1) // normalize 0..1 (saturates a bit sooner)
    const glow = 12 + wave * 8 + speedN * 22
    const headScale = 1 + wave * 0.16 + speedN * 0.35
    const tint = mix(BLUE, CYAN, speedN)
    head.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${headScale})`
    head.style.background = tint
    head.style.filter = `drop-shadow(0 0 ${glow}px ${tint}) drop-shadow(0 0 ${glow * 0.5}px ${tint})`
    if (tail) {
      // Exaggerated gradient tail: long base length so it always reads, growing
      // hard with speed. Base bar is 40px wide; scaleX stretches it well past that.
      const len = 28 + speedN * 120
      tail.style.opacity = String(0.45 + speedN * 0.5)
      tail.style.transform = `translate3d(${x}px, ${y}px, 0) rotate(${angleDeg + 180}deg) scaleX(${len / 40})`
      tail.style.background = `linear-gradient(90deg, ${tint} 0%, ${mix(tint, BLUE, 0.5)} 40%, transparent 100%)`
    }
  }

  // ── Mouse head: logo that leans toward travel; eyes shoot lasers that always
  //    aim at the REAL pointer and intensify as it pulls away (= faster motion) ─
  function renderMouse(
    x: number,
    y: number,
    sp: number,
    wave: number,
    angleDeg: number,
    toPointerX: number,
    toPointerY: number
  ): void {
    const el = mouseRef.current
    if (!el) return
    const speedN = Math.min(sp / 26, 1)
    // Lean: tilt up to ~14° toward the movement direction (damped at low speed).
    const lean = Math.max(-14, Math.min(14, (angleDeg > 90 || angleDeg < -90 ? -1 : 1) * speedN * 14))
    const scale = 1 + wave * 0.06 + speedN * 0.12
    el.style.transform = `translate3d(${x}px, ${y}px, 0) rotate(${lean}deg) scale(${scale})`

    const eyes = mouseEyesRef.current
    if (eyes) {
      const glow = 4 + wave * 4 + speedN * 12
      eyes.style.filter = `drop-shadow(0 0 ${glow}px ${CYAN}) drop-shadow(0 0 ${glow * 0.5}px ${CYAN})`
      eyes.style.opacity = String(0.85 + speedN * 0.15)
    }

    // Lasers: ONLY while moving. Each beam emits from its OWN eye and aims at the
    // real pointer (vector from glyph→pointer). `fire` is gated on actual motion,
    // so the beams vanish the moment the cursor settles. The head <div> is rotated
    // by `lean`, so subtract it to keep the beams aimed in world space.
    const laser = mouseLaserRef.current
    if (laser) {
      const fire = Math.min(Math.max((speedN - 0.04) / 0.5, 0), 1) // 0 at rest
      const worldAngle = (Math.atan2(toPointerY, toPointerX) * 180) / Math.PI
      const localAngle = worldAngle - lean
      const dist = Math.hypot(toPointerX, toPointerY)
      const beamLen = Math.min(36 + dist * 2.2, 220)
      laser.style.opacity = String(fire) // hidden entirely when still
      laser.style.filter = `drop-shadow(0 0 ${2 + fire * 9}px ${CYAN})`
      // Eye anchor points in viewBox units (must match the rect x and the eye art).
      const EYES = [
        { x: 36, y: 54 },
        { x: 64, y: 54 }
      ]
      laserBeams.current.forEach((b, i) => {
        if (!b) return
        const e = EYES[i]
        b.setAttribute('width', String(beamLen))
        // Rotate THIS beam about ITS OWN eye so it shoots from the eye point.
        b.setAttribute('transform', `rotate(${localAngle} ${e.x} ${e.y})`)
      })
    }
  }

  // ── Particles: spawn a fading dot behind the cursor as it moves ─────────────
  function renderParticles(x: number, y: number, sp: number, wave: number, ts: number): void {
    const layer = particleLayer.current
    if (!layer) return
    const speedN = Math.min(sp / 26, 1)

    // Spawn rate scales with speed; spawns even at gentle movement so the wake
    // is always visible. Faster cadence + bigger/brighter dots than before.
    const interval = sp > 0.5 ? 38 - speedN * 24 : 1e9
    if (ts - lastSpawn.current >= interval && particles.current.length < MAX_PARTICLES) {
      lastSpawn.current = ts
      const id = particleSeq.current++
      const size = 7 + speedN * 7
      const tint = mix(BLUE, CYAN, speedN * 0.6)
      const dot = document.createElement('div')
      dot.style.cssText = `position:absolute;top:0;left:0;border-radius:50%;will-change:transform,opacity;background:${tint};box-shadow:0 0 12px ${tint}, 0 0 20px ${tint};`
      dot.style.width = `${size}px`
      dot.style.height = `${size}px`
      dot.style.marginLeft = `${-size / 2}px`
      dot.style.marginTop = `${-size / 2}px`
      layer.appendChild(dot)
      particles.current.push({
        x: x + Math.sin(id) * 5, // tiny scatter, deterministic (no Math.random)
        y: y + Math.cos(id) * 5,
        born: ts,
        life: 720,
        size,
        el: dot
      })
    }

    // Advance live particles; remove + drop retired ones. Each particle owns its
    // DOM node, so reconciliation is just a filter — no index/Map juggling.
    particles.current = particles.current.filter((p) => {
      const t = (ts - p.born) / p.life
      if (t >= 1) {
        p.el.remove()
        return false
      }
      p.el.style.opacity = String(1 - t)
      p.el.style.transform = `translate3d(${p.x}px, ${p.y}px, 0) scale(${1 + t * 0.6})`
      return true
    })

    // A subtle leading orb so there's always something at the cursor.
    const head = cometRef.current
    if (head) {
      head.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${1 + wave * 0.12})`
      head.style.background = BLUE
      head.style.filter = `drop-shadow(0 0 ${6 + wave * 5}px ${BLUE})`
    }
  }

  // ── Heat trail: the wake IS the heatmap ─────────────────────────────────────
  // Distance-sampled stroke (see the constants block above for why). Colour comes
  // from AGE, so the stroke is always a clean white-hot → violet cooling ramp
  // trailing the cursor, whatever the pointer did on the way there.
  function renderHeatTrail(x: number, y: number, sp: number, wave: number, ts: number): void {
    const layer = particleLayer.current
    if (!layer) return

    // Sample by DISTANCE from the last point, not on a timer. A resting pointer
    // never clears the gate, so it lays nothing and can't burn in a dot.
    const last = lastHeatPoint.current
    const far = !last || Math.hypot(x - last.x, y - last.y) >= HEAT_MIN_DIST_PX
    if (sp > HEAT_MOVING_PX && far) {
      lastHeatPoint.current = { x, y }
      const dot = document.createElement('div')
      // Blur + screen blend is what melts overlapping dots into ONE stroke
      // instead of a row of circles; without it the taper reads as beads.
      dot.style.cssText = `position:absolute;top:0;left:0;border-radius:50%;will-change:transform,opacity;filter:blur(0.6px);mix-blend-mode:screen;`
      layer.appendChild(dot)
      particles.current.push({
        x,
        y,
        born: ts,
        life: HEAT_POINT_TTL_MS,
        size: 0, // set per-frame from age; the field is unused for this style
        el: dot
      })
      // Oldest-first eviction keeps the stroke a fixed length behind the cursor.
      while (particles.current.length > HEAT_MAX_POINTS) {
        particles.current.shift()?.el.remove()
      }
    }

    // Age-driven, NOT index-driven. Index shading looks the same while moving,
    // but the moment old points retire every survivor's index shifts and the
    // whole stroke jumps brighter. Age only ever decreases, per point.
    particles.current = particles.current.filter((p) => {
      const age = Math.min(1, Math.max(0, (ts - p.born) / p.life))
      if (age >= 1) {
        p.el.remove()
        return false
      }
      const t = 1 - age
      const size = HEAT_DOT_MIN_PX + (HEAT_DOT_MAX_PX - HEAT_DOT_MIN_PX) * t
      // Age IS the ramp position, so the tint has to be reassigned every frame as
      // the point cools — freezing it at birth is what made v2 look scattered.
      const tint = heatColor(age)
      // Squared falloff: linear leaves the tail's oldest dots too solid, so the
      // stroke ends in a stub instead of dissolving.
      p.el.style.opacity = String(0.9 * t * t)
      p.el.style.background = tint
      // Glow shrinks as the point cools; a constant bloom smears the violet tail
      // back into a haze and kills the taper.
      p.el.style.boxShadow = `0 0 ${4 + t * 12}px ${tint}`
      p.el.style.width = `${size}px`
      p.el.style.height = `${size}px`
      p.el.style.transform = `translate3d(${p.x - size / 2}px, ${p.y - size / 2}px, 0)`
      return true
    })

    // The orb is the white-hot end of the same ramp, so the cursor reads as the
    // source the stroke is cooling away from rather than a separate dot.
    const head = cometRef.current
    if (head) {
      const core = heatColor(0)
      head.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${1 + wave * 0.12})`
      head.style.background = core
      head.style.filter = `drop-shadow(0 0 8px ${core}) drop-shadow(0 0 16px ${heatColor(0.3)})`
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        margin: 0,
        background: 'transparent',
        overflow: 'hidden',
        pointerEvents: 'none',
        // `visible` gates only the animated POINTER art (it waits for the first
        // cursor position). The suggestion bubble must show the instant a state
        // arrives — even if the cursor hasn't moved yet — so keep the overlay
        // shown whenever a bubble is up regardless of `visible`.
        opacity: visible || suggest.phase !== 'hidden' ? 1 : 0
      }}
    >
      {/* Spinner keyframe for the loading note. Scoped here (not index.css, which
          other windows share) so this overlay is self-contained. */}
      <style>
        {
          '@keyframes mm-spin { to { transform: rotate(360deg) } }' +
            '@keyframes mm-float { 0%,100% { transform: translate3d(0,0,0) } 50% { transform: translate3d(0,-5px,0) } }' +
            '@keyframes mm-ring-shimmer { 0%,100% { opacity: 0.45 } 50% { opacity: 0.95 } }'
        }
      </style>
      {/* "Point at" ring — marks the target the glyph is pointing to. Renders
          regardless of pointer-art pref / style; driven directly by glideRingRef. */}
      <div
        ref={glideRingRef}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: 18,
          height: 18,
          borderRadius: '50%',
          border: `2px solid ${BLUE}`,
          boxShadow: `0 0 12px ${BLUE}`,
          opacity: 0,
          willChange: 'transform, width, height, opacity',
          pointerEvents: 'none'
        }}
      />
      {/* Animated pointer art — only when the companion pref is on. The bubble
          below renders regardless, so insights works with the pointer off. */}
      {pointerEnabled && (
        <>
      {/* Particle layer (used by 'particles' + 'heatTrail', harmless otherwise) */}
      <div ref={particleLayer} style={{ position: 'absolute', inset: 0 }} />

      {/* Comet/particle/heat head orb */}
      {(style === 'comet' || style === 'particles' || style === 'heatTrail') && (
        <>
          {style === 'comet' && (
            <div
              ref={cometTailRef}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: 40,
                height: 11,
                marginTop: -5.5,
                borderRadius: 6,
                transformOrigin: 'left center',
                willChange: 'transform, opacity'
              }}
            />
          )}
          <div
            ref={cometRef}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: 20,
              height: 20,
              marginLeft: -10,
              marginTop: -10,
              borderRadius: '50%',
              transformOrigin: 'center center',
              willChange: 'transform, filter'
            }}
          />
        </>
      )}

      {/* Mouse-head glyph: matches the app icon, eyes glow via mouseEyesRef */}
      {style === 'mouseHead' && (
        <div
          ref={mouseRef}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: 40,
            height: 40,
            marginLeft: -20,
            marginTop: -20,
            transformOrigin: 'center center',
            willChange: 'transform'
          }}
        >
          <MouseGlyph
            size={40}
            eyesRef={mouseEyesRef}
            laserRef={mouseLaserRef}
            beam0Ref={(el) => {
              laserBeams.current[0] = el
            }}
            beam1Ref={(el) => {
              laserBeams.current[1] = el
            }}
          />
        </div>
      )}
        </>
      )}

      <SuggestionBubble
        cursor={target.current}
        state={suggest}
        dropPos={dropPos}
        followPos={followPos}
        cancelArmed={cancelArmed}
        onDrop={setDropPos}
      />
    </div>
  )
}

// Below this many pixels of pointer travel a mousedown→mouseup counts as a click
// (chip pick / ✕), not a drag — so tapping a suggestion still works.
const DRAG_THRESHOLD_PX = 5

function SuggestionBubble({
  cursor,
  state,
  dropPos,
  followPos,
  cancelArmed,
  onDrop
}: {
  cursor: { x: number; y: number }
  state: SuggestState
  dropPos: { x: number; y: number } | null
  followPos: { x: number; y: number } | null
  cancelArmed: boolean
  onDrop: (pos: { x: number; y: number }) => void
}): React.ReactElement | null {
  // Drag bookkeeping: where in the bubble we grabbed, and whether the pointer has
  // moved past the click threshold yet (so a tap still picks a chip).
  const grab = useRef<{ dx: number; dy: number; moved: boolean } | null>(null)

  // The bubble's hover claim on the overlay's clickable state (refcounted — see
  // claimClickable). Held while hovered/dragging, released on leave; a preview's
  // own claim keeps the overlay live even after the bubble releases, so the
  // Confirm button stays clickable when the pointer moves onto the panel.
  const hoverClaim = useRef<(() => void) | null>(null)
  const acquireHover = (): void => {
    if (!hoverClaim.current) hoverClaim.current = claimClickable()
  }
  const releaseHover = (): void => {
    hoverClaim.current?.()
    hoverClaim.current = null
  }
  useEffect(() => releaseHover, []) // drop the claim if the bubble unmounts mid-hover

  // NOTE: a proactive arm-on-'ready' (claimClickable the moment chips show) was tried
  // to fix the stationary-cursor dead-hover — it STOLE FOCUS / yanked the cursor off
  // the compose field on the real overlay (clickable-only is NOT focus-safe there,
  // contrary to the focusable:false theory). Reverted. Overlay hover-delivery must be
  // solved WITHOUT making the whole overlay clickable on show. See the PRD.

  // ── ETA ring ────────────────────────────────────────────────────────────────
  // The loading bubble traces a thin accent sweep around its border as a "this is
  // how far along the gen is" cue. etaMs comes from estimateSuggestionDuration
  // (past gen times); 0 = no history → no ring, just the spinner. We tick elapsed
  // locally (the bubble has no other clock) and translate it to a sweep fraction,
  // capping at BAR_CAP_PCT so an over-long gen holds near-full with a shimmer
  // instead of falsely completing the circle.
  const ringEta = state.phase === 'loading' ? (state.etaMs ?? 0) : 0
  const [ringPct, setRingPct] = useState(0)
  const ringStart = useRef(0)
  useEffect(() => {
    if (ringEta <= 0) {
      setRingPct(0)
      return
    }
    ringStart.current = Date.now()
    setRingPct(0)
    const id = setInterval(() => {
      const elapsed = Date.now() - ringStart.current
      setRingPct(Math.min(CONFIG.ESTIMATOR.BAR_CAP_PCT, (elapsed / ringEta) * 100))
    }, 80)
    return () => clearInterval(id)
  }, [ringEta])
  const showRing = state.phase === 'loading' && ringEta > 0
  const ringOvertime = showRing && ringPct >= CONFIG.ESTIMATOR.BAR_CAP_PCT

  // Position priority: dragged-and-dropped wins; else the live follow anchor
  // (trails the cursor while loading, frozen on ready); else the raw cursor ref.
  const anchor = dropPos ?? followPos ?? cursor
  const left = dropPos ? anchor.x : anchor.x + BUBBLE_OFFSET_X
  const top = dropPos ? anchor.y : anchor.y + BUBBLE_OFFSET_Y

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>): void {
    // Don't hijack a click on the ✕ or a suggestion chip — those handle their own.
    if ((e.target as HTMLElement).closest('[data-no-drag]')) return
    const rect = e.currentTarget.getBoundingClientRect()
    grab.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top, moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>): void {
    const g = grab.current
    if (!g) return
    if (!g.moved && Math.hypot(e.clientX - (left + g.dx), e.clientY - (top + g.dy)) < DRAG_THRESHOLD_PX) {
      return // still within the click slop — not a drag yet
    }
    g.moved = true
    onDrop({ x: e.clientX - g.dx, y: e.clientY - g.dy })
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>): void {
    if (grab.current) e.currentTarget.releasePointerCapture(e.pointerId)
    grab.current = null
    // A drag can end with the pointer off the bubble (no mouseleave fired during
    // capture) — release click-through unless we're still hovering the bubble.
    const r = e.currentTarget.getBoundingClientRect()
    const over = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom
    if (!over) releaseHover()
  }

  // 'hidden' = no bubble at all. Every other phase shows the shell: 'loading' is
  // the preliminary spinner that morphs into 'ready' chips; 'empty'/'error' are
  // short notes that auto-fade (timer lives in the parent).
  if (state.phase === 'hidden') return null

  const FADE = CONFIG.SUGGESTIONS.FEEDBACK
  // 'ready' shows the chip list; every transient phase is a single status line.
  // Built outside the JSX so the union narrows cleanly per branch.
  let body: React.ReactElement | null
  if (state.phase === 'ready') {
    // Key by the suggestion set so a NEW bubble fully remounts the list — its
    // openPreviewIndex resets to null. Without a key React reuses the instance and
    // a stale "preview open" index from the previous bubble survives, which left the
    // next bubble's preview stuck/blank (the index pointed at a chip that no longer
    // matched). Remount = clean slate every trigger.
    const bubbleKey = state.suggestions.map((s) => s.instruction).join('|')
    body = <SuggestionList key={bubbleKey} suggestions={state.suggestions} />
  } else if (state.phase === 'loading') {
    body = <BubbleNote phase="loading" text={FADE.LOADING_TEXT} />
  } else if (state.phase === 'empty') {
    body = <BubbleNote phase="empty" text={FADE.EMPTY_TEXT} />
  } else {
    body = <BubbleNote phase="error" text={FADE.ERROR_TEXT} />
  }

  // Floaty bob while loading so it reads as alive/working — but only when it
  // hasn't been dragged (a CSS transform would fight the dropped position).
  const floating = state.phase === 'loading' && !dropPos

  return (
    <div
      // Make the overlay catch clicks ONLY while the pointer is over the bubble,
      // then release on leave — so the fullscreen window never blocks clicks or
      // typing elsewhere. Move events keep flowing (forward:true) so these fire
      // even while the window is click-through.
      onMouseEnter={acquireHover}
      onMouseLeave={() => {
        if (!grab.current) releaseHover() // keep capturing mid-drag
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={{
        position: 'absolute',
        left,
        top,
        width: BUBBLE_W,
        padding: BUBBLE_PAD,
        borderRadius: BUBBLE_RADIUS,
        border: `1px solid ${BORDER}`,
        background: SURFACE,
        boxShadow: `0 12px 34px rgba(${CONFIG.THEME_TOKENS.accentRgb}, 0.18), 0 4px 16px rgba(0, 0, 0, 0.14)`,
        color: TEXT,
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif',
        fontSize: 12,
        lineHeight: 1.25,
        backdropFilter: 'blur(16px)',
        opacity: 1,
        animation: floating ? 'mm-float 2.4s ease-in-out infinite' : undefined,
        transition: 'opacity 140ms ease',
        // Always interactive now: the ✕ is clickable AND the whole bubble (any
        // phase, incl. loading) can be grabbed and dragged.
        pointerEvents: 'auto',
        cursor: grab.current?.moved ? 'grabbing' : 'grab',
        userSelect: 'none',
        touchAction: 'none'
      }}
    >
      {showRing && <LoadingRing pct={ringPct} overtime={ringOvertime} />}
      <CloseButton onClose={() => window.api.cursorDismiss()} />
      {body}
      {cancelArmed && <CancelHint />}
    </div>
  )
}

// A thin accent ring that sweeps clockwise around the loading bubble's border,
// from the top, filling toward the predicted gen time. Drawn as a conic-gradient
// disc masked down to a 2px ring (border-box minus an inset padding-box), so it
// hugs the rounded corners. `overtime` swaps in a slow shimmer once the sweep
// caps — the gen ran long, so we breathe at near-full instead of claiming done.
const RING_W = 2 // ring thickness (px)
function LoadingRing({ pct, overtime }: { pct: number; overtime: boolean }): React.ReactElement {
  // pct → sweep angle. The conic fill is the accent up to `deg`, transparent after.
  const deg = Math.round((pct / 100) * 360)
  return (
    <div
      aria-hidden
      style={{
        position: 'absolute',
        inset: 0,
        borderRadius: BUBBLE_RADIUS,
        padding: RING_W,
        // Sweep clockwise from 12 o'clock. A small soft tail (4°) on the leading
        // edge so the head reads as motion, not a hard wedge.
        background: `conic-gradient(from 0deg, ${BLUE} ${deg}deg, transparent ${deg + 4}deg 360deg)`,
        // Mask the interior away → only the `padding` band (the ring) shows.
        WebkitMask: 'linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0)',
        mask: 'linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0)',
        opacity: overtime ? undefined : 0.9,
        animation: overtime ? 'mm-ring-shimmer 1.4s ease-in-out infinite' : undefined,
        pointerEvents: 'none'
      }}
    />
  )
}

// HUD-style cancel affordance: appears after the first Esc, tells the user to
// press Enter to confirm. Mirrors the HUD's "⏎ to cancel" pattern.
function CancelHint(): React.ReactElement {
  return (
    <div
      style={{
        marginTop: BUBBLE_GAP,
        paddingTop: BUBBLE_GAP,
        borderTop: `1px solid ${BORDER}`,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        color: MUTED,
        fontSize: 11,
        fontWeight: 600
      }}
    >
      <span
        style={{
          padding: '1px 5px',
          borderRadius: 4,
          background: SURFACE_STRONG,
          fontWeight: 800
        }}
      >
        ⏎
      </span>
      <span>{CONFIG.SUGGESTIONS.FEEDBACK.CANCEL_HINT_TEXT}</span>
    </div>
  )
}

// Gray ✕ in the top-right corner. Esc also dismisses, but the button gives an
// obvious affordance. Hover lifts it from muted to full text color.
function CloseButton({ onClose }: { onClose: () => void }): React.ReactElement {
  const [hover, setHover] = useState(false)
  return (
    <button
      type="button"
      data-no-drag
      onClick={onClose}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-label="Dismiss suggestions"
      style={{
        position: 'absolute',
        top: 6,
        right: 6,
        width: 20,
        height: 20,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 0,
        border: 'none',
        borderRadius: 5,
        background: hover ? SURFACE_STRONG : 'transparent',
        color: hover ? TEXT : MUTED,
        cursor: 'pointer',
        transition: 'background 120ms ease, color 120ms ease'
      }}
    >
      <X size={13} strokeWidth={2.4} />
    </button>
  )
}

// Single-line transient status: a spinner while loading, a soft dot for empty,
// a warm-toned dot for error. The spin animation is injected once below.
function BubbleNote({
  phase,
  text
}: {
  phase: 'loading' | 'empty' | 'error'
  text: string
}): React.ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: BUBBLE_GAP,
        color: phase === 'loading' ? TEXT : MUTED,
        fontSize: 12,
        fontWeight: 600
      }}
    >
      {phase === 'loading' ? (
        <Loader2
          size={14}
          color={BLUE}
          strokeWidth={2.4}
          style={{ animation: 'mm-spin 0.9s linear infinite', flexShrink: 0 }}
        />
      ) : (
        <Sparkles
          size={13}
          color={phase === 'error' ? CONFIG.THEME_TOKENS.amber : MUTED}
          strokeWidth={2.3}
          style={{ flexShrink: 0 }}
        />
      )}
      <span>{text}</span>
    </div>
  )
}

function SuggestionList({
  suggestions
}: {
  suggestions: Suggestion[]
}): React.ReactElement | null {
  const shown = suggestions.slice(0, CONFIG.SUGGESTIONS.MAX)
  // Which chip's write-preview is currently open (null = none). Lifted here so
  // opening one chip's preview closes every other — at most one panel on screen.
  const [openPreviewIndex, setOpenPreviewIndex] = useState<number | null>(null)
  console.log(
    `[cursor] SuggestionList render: count=${shown.length} openPreviewIndex=${openPreviewIndex} kinds=[${shown.map((s) => s.kind).join(',')}]`
  )
  if (shown.length === 0) return null
  // The first suggestion may carry an advice headline (manual ⌘⌥⇧S trigger). When
  // present, it's the "best next move" line shown above the action chips.
  const advice = shown.find((s) => s.advice)?.advice
  return (
    <>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: BUBBLE_GAP,
          marginBottom: BUBBLE_GAP,
          color: MUTED,
          fontSize: 11,
          fontWeight: 600
        }}
      >
        <Sparkles size={13} color={BLUE} strokeWidth={2.3} />
        <span>Suggestions</span>
      </div>
      {advice && (
        <div
          style={{
            marginBottom: BUBBLE_GAP,
            paddingBottom: BUBBLE_GAP,
            borderBottom: `1px solid ${BORDER}`,
            color: TEXT,
            fontSize: 12,
            fontWeight: 600,
            lineHeight: 1.3
          }}
        >
          {advice}
        </div>
      )}
      <div style={{ display: 'grid', gap: 6 }}>
        {shown.map((s, i) => (
          <SuggestionChip
            key={`${s.mode}:${s.instruction}:${i}`}
            suggestion={s}
            index={i}
            // Single-preview invariant: the list owns which chip's preview is open.
            // Hovering a chip claims the slot, which closes any other panel — only
            // one SuggestionPreview can ever render (was: each chip had its own
            // previewOpen, so hover 1→2→3 left all three panels stacked).
            previewOpen={openPreviewIndex === i}
            onOpenPreview={() => setOpenPreviewIndex(i)}
            onClosePreview={() => setOpenPreviewIndex((cur) => (cur === i ? null : cur))}
          />
        ))}
      </div>
    </>
  )
}

// One clickable suggestion row. Clicking runs it (same path as the ⌘⌥⇧1/2/3 keys)
// via the cursorAccept IPC; hover lifts the background so it's obviously live.
// `data-no-drag` keeps a click from being swallowed by the bubble's drag handler.
//
// A 'write' chip carries a pre-drafted body (`s.text`). Hovering it opens a preview
// panel to the right where the user edits + confirms; the edited text is what gets
// pasted AND logged beside the draft (the training signal). A 'run' chip has no
// draft — clicking it re-runs the LLM as before.
function SuggestionChip({
  suggestion: s,
  index: i,
  previewOpen,
  onOpenPreview,
  onClosePreview
}: {
  suggestion: Suggestion
  index: number
  /** Whether THIS chip's preview is the one currently open (owned by the list). */
  previewOpen: boolean
  /** Claim the single preview slot for this chip (closes any other). */
  onOpenPreview: () => void
  /** Release the slot if this chip held it. */
  onClosePreview: () => void
}): React.ReactElement {
  const [hover, setHover] = useState(false)
  const isWrite = s.kind === 'write'
  const hasDraft = isWrite && (s.text || '').length > 0
  // Tint the mode chip by its mode so ask / rewrite / act / write each read as a
  // distinct color at a glance (was: one color for all run modes, cyan for write).
  // Same palette as the Analytics charts — one home in ./mode-colors.
  const chip = MODE_CHIP_STYLE[s.mode]

  // Clicking ANY chip accepts it directly — a write chip pastes its pre-drafted body
  // (no LLM round-trip), a run chip re-runs. Hovering a write chip with a draft ALSO
  // opens SuggestionPreview to the right so the user can READ the full draft (and
  // optionally Edit it). The preview's read-only stage claims NO keyboard focus, so
  // it can't blur the target compose field — that focus theft was the old flaky-paste
  // bug, now fixed in SuggestionPreview (focus is claimed only when the user clicks
  // Edit). The chip's own onClick still pastes the draft as-is — the reliable default.
  // While editing, the user is typing in the panel — a stray mouse-leave must NOT
  // yank it shut. Track it so the group's onMouseLeave only auto-closes the read
  // stage (the hover-to-read affordance), never an active edit.
  const [previewEditing, setPreviewEditing] = useState(false)
  // Grace-timer close: bridges the chip↔panel seam so reaching for the panel doesn't
  // snap it shut. scheduleClose on leave, cancelClose on any re-enter within the group.
  const { cancelClose, scheduleClose } = useHoverIntent(onClosePreview)

  const openPreview = (): void => {
    // [cursor]-tagged so main forwards it to ~/MightyMouse/cursor-renderer.log.
    // Pin down WHY a hover does/doesn't open the panel: is it a write? has a draft?
    console.log(
      `[cursor] hover chip i=${i} kind=${s.kind} hasDraft=${hasDraft} draftLen=${(s.text || '').length} previewOpen=${previewOpen}`
    )
    if (hasDraft) onOpenPreview()
  }
  return (
    <div
      style={{ position: 'relative' }}
      // Auto-dismiss on hover-off (it's a read affordance, not a pinned panel), but
      // through a grace timer: the panel is an absolutely-positioned child across a
      // gap, and crossing that seam fires a synthetic leave a frame before the panel's
      // enter. A bare close-on-leave snapped the panel shut mid-reach; scheduleClose +
      // cancelClose-on-reenter bridges the seam. Editing is exempt — see previewEditing.
      onMouseEnter={cancelClose}
      // Any pointer movement anywhere inside the chip+panel group cancels a pending
      // close. On the click-through overlay, flipping setIgnoreMouseEvents triggers a
      // macOS re-hit-test that fires a synthetic mouseleave on the wrapper WITHOUT a
      // reliable matching mouseenter — so onMouseEnter alone can't always cancel the
      // close. mousemove fires continuously while the pointer is over the group, so it
      // re-cancels through the storm. This is the overlay-specific belt to the seam
      // suspenders. (A truly still pointer over the group emits no mousemove, but it
      // also emits no spurious leave, so there's nothing to cancel — safe.)
      onMouseMove={cancelClose}
      onMouseLeave={() => {
        if (previewOpen && !previewEditing) scheduleClose()
      }}
    >
      <div
        data-no-drag
        role="button"
        onMouseEnter={() => {
          cancelClose()
          setHover(true)
          openPreview()
        }}
        onMouseLeave={() => setHover(false)}
        onClick={() => window.api.cursorAccept(i)}
        style={{
          display: 'grid',
          gridTemplateColumns: `${HINT_W}px minmax(0, 1fr) ${MODE_CHIP_W}px`,
          alignItems: 'center',
          gap: BUBBLE_GAP,
          minHeight: 30,
          padding: '6px 7px',
          borderRadius: 6,
          cursor: 'pointer',
          background: hover ? CONFIG.THEME_TOKENS.accentBgSubtle : SURFACE_STRONG,
          boxShadow: hover ? `inset 0 0 0 1px ${BORDER}` : 'none',
          transition: 'background 120ms ease, box-shadow 120ms ease'
        }}
      >
      <span style={{ width: HINT_W, color: hover ? BLUE : MUTED, fontWeight: 700, fontSize: 11 }}>
        {CHORD_MODS}
        {i + 1}
      </span>
      <span
        style={{
          color: TEXT,
          fontWeight: 650,
          // A run chip's label is clamped to one ellipsized line (maxWidth) so the
          // bubble stays tidy. On hover, run chips (no draft) drop the clamp so the
          // full suggestion wraps to the column's full width and reads in place. Write
          // chips keep the clamp — their full draft pastes on click, so there's no need
          // to expand the label in the bubble.
          ...(hover && !hasDraft
            ? { whiteSpace: 'normal', wordBreak: 'break-word' }
            : {
                maxWidth: LABEL_MAX_W,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              })
        }}
      >
        {s.label}
      </span>
      <span
        style={{
          width: MODE_CHIP_W,
          textAlign: 'center',
          borderRadius: 6,
          padding: '3px 0',
          // One color per mode (rewrite=orange, ask=cyan, act=violet, write=amber).
          // 'write' chips (mode === 'write') land on amber, which also reads as the
          // "instant paste, no rerun" tier — its own hue, distinct from the others.
          color: chip.fg,
          background: chip.bg,
          border: `1px solid ${chip.border}`,
          fontSize: 10,
          fontWeight: 800,
          textTransform: 'uppercase'
        }}
      >
        {isWrite ? 'write' : s.mode}
      </span>
      </div>
      {(() => {
        console.log(
          `[cursor] render chip i=${i} previewOpen=${previewOpen} hasDraft=${hasDraft} -> panel=${previewOpen && hasDraft}`
        )
        return null
      })()}
      {previewOpen && hasDraft && (
        <div
          data-no-drag
          // Anchored to the right edge of the chip. The breathing-room gap is
          // paddingLeft (not margin) so the hit area is CONTINUOUS from chip to
          // panel — a margin gap would be click-through dead space that drops the
          // hover mid-move. The panel holds its own clickable claim for its whole
          // life (see SuggestionPreview), so the overlay stays live even after the
          // bubble's hover claim releases. Auto-close happens on the GROUP wrapper's
          // onMouseLeave (above) — moving off the chip+panel dismisses the read stage;
          // editing is exempt. Explicit close (✕, Esc, Paste, Confirm) still works.
          style={{
            position: 'absolute',
            left: '100%',
            top: 0,
            paddingLeft: BUBBLE_GAP,
            zIndex: 10
          }}
        >
          <SuggestionPreview
            draft={s.text || ''}
            onEditingChange={setPreviewEditing}
            onConfirm={(finalText) => {
              onClosePreview()
              window.api.cursorAccept(i, finalText)
            }}
            onClose={onClosePreview}
          />
        </div>
      )}
    </div>
  )
}

// Linear blend of two rgba()/hex color strings by t (0..1). Parses the brand
// tokens (which are rgba(...) strings) and falls back to `a` if parsing fails.
/**
 * Classic thermal ramp, indexed by how far a point has cooled: 0 = white-hot at
 * the cursor → 1 = violet embers at the tail. Interpolating between adjacent
 * HEAT_RAMP stops (rather than across the whole range) is what keeps the middle
 * reading as orange instead of the muddy grey a direct white→violet blend gives.
 */
function heatColor(age: number): string {
  const a = Math.min(Math.max(age, 0), 1)
  const span = HEAT_RAMP.length - 1
  const i = Math.min(Math.floor(a * span), span - 1)
  const t = a * span - i
  const from = HEAT_RAMP[i]
  const to = HEAT_RAMP[i + 1]
  const r = Math.round(from[0] + (to[0] - from[0]) * t)
  const g = Math.round(from[1] + (to[1] - from[1]) * t)
  const b = Math.round(from[2] + (to[2] - from[2]) * t)
  return `rgb(${r}, ${g}, ${b})`
}

function mix(a: string, b: string, t: number): string {
  const pa = parseColor(a)
  const pb = parseColor(b)
  if (!pa || !pb) return a
  const r = Math.round(pa[0] + (pb[0] - pa[0]) * t)
  const g = Math.round(pa[1] + (pb[1] - pa[1]) * t)
  const bl = Math.round(pa[2] + (pb[2] - pa[2]) * t)
  return `rgb(${r}, ${g}, ${bl})`
}

function parseColor(c: string): [number, number, number] | null {
  const m = c.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])]
  const h = c.match(/^#([0-9a-f]{6})$/i)
  if (h) {
    const n = parseInt(h[1], 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  return null
}

import { JSX, useEffect, useState } from 'react'
import { CONFIG } from '../../shared/config'
import type { PermissionKey } from '../../shared/types'
import appIcon from './assets/app-icon.png'

// The drag-to-add coach panel (?window=drag-coach).
//
// macOS has no prompt for Screen Recording, and Accessibility's is a dead end
// once TCC is stale: both panes are `+` allow-LISTS, so if the app never
// registered, the user is left staring at a list of OTHER apps with no reason to
// press the plus. Two external testers stalled exactly there. Words don't fix
// it, because the fix is a GESTURE — so this panel IS the gesture: the icon
// below is a real draggable .app bundle, and the panel sits directly under the
// System Settings window so the drag runs a short path up into the list.
//
// EVERY style choice here is deliberately NOT MightyMouse. This panel appears
// attached to System Settings while the user is inside a system pane, so it has
// to read as part of that pane, not as our app leaning over their shoulder. No
// brand tokens, no --accent, no rounded brand buttons, no 🐭. Instead:
//   - -apple-system / system-ui, the exact stack System Settings itself uses
//   - the system blue (#007AFF light / #0A84FF dark), not our accent
//   - `light-dark()` throughout so it follows the OS appearance, not our theme
//   - vibrancy behind it (set on the BrowserWindow) like a real system sheet
// The one exception is the app icon, which MUST be ours: recognising the thing
// they have to drag is the entire point.

// Native macOS system colors, as light/dark pairs. Hardcoded rather than pulled
// from theme.ts on purpose — theme.ts is MightyMouse's palette, and this window
// must track macOS, which the app's own light/dark setting does not.
const SYSTEM_BLUE = 'light-dark(#007AFF, #0A84FF)'
const LABEL = 'light-dark(#000000, #FFFFFF)'
const SECONDARY_LABEL = 'light-dark(rgba(0,0,0,0.55), rgba(255,255,255,0.55))'
const CLOSE_BG = 'light-dark(rgba(0,0,0,0.08), rgba(255,255,255,0.13))'

/** Which permission we're coaching — set by main via the ?perm= query param. */
function permFromQuery(): PermissionKey {
  const raw = new URLSearchParams(window.location.search).get('perm')
  const known = CONFIG.ONBOARDING_DRAG_COACH.panesWithList
  return known.includes(raw as PermissionKey) ? (raw as PermissionKey) : 'accessibility'
}

// Pane names exactly as macOS labels them in System Settings, so the panel's
// subtitle matches the window it's attached to. A generic "this permission"
// would make the user check which pane they're in.
const PANE_LABEL: Partial<Record<PermissionKey, string>> = {
  accessibility: 'Accessibility',
  screen: 'Screen Recording'
}

export default function DragCoachApp(): JSX.Element {
  const copy = CONFIG.ONBOARDING_DRAG_COACH
  const [perm] = useState(permFromQuery)
  const [dragging, setDragging] = useState(false)

  // Esc closes, matching every macOS sheet. The panel is focusable:false, so
  // this only fires when the user has clicked into it — which is exactly when
  // they'd expect Esc to work.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') void window.api.dragCoach.close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div
      style={{
        // colorScheme enables light-dark() and makes the OS pick the matching
        // scrollbar/form rendering — without it every light-dark() resolves light.
        colorScheme: 'light dark',
        fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
        color: LABEL,
        // No background: the window's `vibrancy: 'under-window'` shows through,
        // which is what gives it a real system-sheet material.
        background: 'transparent',
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        padding: '12px 18px 16px',
        boxSizing: 'border-box',
        WebkitUserSelect: 'none',
        // The whole panel is a drag handle — it's frameless, and a system sheet
        // the user can't move out of their own way would be worse than none.
        // The icon and the close button opt back out with 'no-drag'.
        WebkitAppRegion: 'drag'
      } as React.CSSProperties}
    >
      <CloseButton />

      {/* Left-padded past the close button so the title never collides with it. */}
      <div style={{ paddingLeft: 26 }}>
        <h1 style={{ fontSize: 13, fontWeight: 600, margin: 0, letterSpacing: '-0.01em' }}>
          {copy.title}
        </h1>
        <p style={{ fontSize: 11, lineHeight: 1.35, color: SECONDARY_LABEL, margin: '3px 0 0' }}>
          {PANE_LABEL[perm] ?? ''} · {copy.blurb}
        </p>
      </div>

      {/* The squiggle and the icon share one stacking context: the curve starts
          just above the icon and arcs up-and-right toward the pane's `+`, which
          sits above this panel. flex:1 lets the curve claim the height the
          taller panel added. */}
      <div style={{ position: 'relative', flex: 1, marginTop: 6 }}>
        <Squiggle />
        <div
          style={{
            position: 'absolute',
            left: 0,
            bottom: 0,
            display: 'flex',
            alignItems: 'flex-end',
            gap: 14
          }}
        >
          <DraggableIcon dragging={dragging} setDragging={setDragging} />
          <p
            style={{
              fontSize: 11,
              lineHeight: 1.45,
              margin: '0 0 6px',
              color: SECONDARY_LABEL,
              maxWidth: 240
            }}
          >
            {copy.steps}
          </p>
        </div>
      </div>
    </div>
  )
}

/**
 * The hand-drawn curve arcing up out of the icon toward the pane's `+`.
 *
 * One gentle bend, not a loop and not a ruler-straight arrow. A crisp arrow
 * reads as chrome the OS drew and gets scanned past; anything more elaborate
 * makes the eye follow the shape instead of the direction, which is the
 * opposite of what a pointer is for. The bend is just enough to read as drawn
 * by hand.
 *
 * preserveAspectRatio is NOT 'none' here — stretching the viewBox to the
 * panel's aspect would shear the curve and skew the arrowhead off its tangent.
 * 'xMinYMax meet' keeps the geometry true and pins the drawing to the
 * bottom-left, where the icon is.
 */
function Squiggle(): JSX.Element {
  return (
    <svg
      aria-hidden
      viewBox="0 0 160 150"
      preserveAspectRatio="xMinYMax meet"
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        overflow: 'visible',
        pointerEvents: 'none',
        color: SYSTEM_BLUE
      }}
    >
      {/* One cubic, up out of the TOP of the icon: starts at (25, 96) — the
          icon's top-centre, measured in a harness at the real 460x300 panel
          size, not derived. Leans right off the start, then straightens and
          finishes up-and-right under the pane's `+`. The old start (50, 144)
          sat past the icon container's bottom-RIGHT corner, so the curve
          appeared to grow out of the box's edge rather than the icon. */}
      <path
        className="squiggle-path"
        d="M 25 96 C 30 66, 48 36, 69 7"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray="7 6"
      />
      {/* Arrowhead sitting on the curve's final tangent (~36° off vertical,
          measured from the rendered path — the start move changed it from 29°).
          Wings mirrored about that angle — squaring them to the viewBox instead
          leaves the head visibly snapped on, which is what the first pass did. */}
      <path
        d="M 56 12.3 L 69 7 L 68 21"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <style>{`
        @keyframes squiggle-march {
          to { stroke-dashoffset: -26; }
        }
        .squiggle-path { animation: squiggle-march 1.1s linear infinite; }
        @media (prefers-reduced-motion: reduce) {
          .squiggle-path { animation: none; }
        }
      `}</style>
    </svg>
  )
}

/**
 * The lone close control, top-left.
 *
 * Replaces the old Done / Show in Finder pair: two buttons implied a decision
 * the user doesn't have to make here — the panel's whole job is one drag, and
 * anything else competing for the eye is noise. Top-left because that's where
 * macOS puts close, and because the drag itself starts bottom-left.
 */
function CloseButton(): JSX.Element {
  return (
    <button
      onClick={() => void window.api.dragCoach.close()}
      title={CONFIG.ONBOARDING_DRAG_COACH.closeLabel}
      aria-label={CONFIG.ONBOARDING_DRAG_COACH.closeLabel}
      style={
        {
          position: 'absolute',
          top: 10,
          left: 10,
          width: 18,
          height: 18,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 0,
          borderRadius: '50%',
          border: 'none',
          background: CLOSE_BG,
          color: LABEL,
          cursor: 'default',
          WebkitAppRegion: 'no-drag'
        } as React.CSSProperties
      }
    >
      <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
        <path d="M1.5 1.5 L8.5 8.5 M8.5 1.5 L1.5 8.5" />
      </svg>
    </button>
  )
}

/**
 * The app icon as a REAL draggable file.
 *
 * The first version of this panel rendered a static <img> that animated toward
 * a dashed `+` box — a picture of a drag that could not itself be dragged. A
 * user who tries the gesture it depicts gets nothing, which is worse than no
 * instruction at all.
 *
 * onDragStart calls into main, which hands the actual .app bundle to the system
 * drag pasteboard via webContents.startDrag. From that point macOS owns the
 * drag: dropping it on the pane's list adds the app for real, exactly as
 * dragging it out of Finder would.
 *
 * preventDefault() on the HTML5 drag is required — we do NOT want the browser's
 * own image drag (which would drop a PNG, not the bundle) racing the native one.
 */
function DraggableIcon({
  dragging,
  setDragging
}: {
  dragging: boolean
  setDragging: (v: boolean) => void
}): JSX.Element {
  return (
    <span
      onDragStart={(e) => {
        e.preventDefault()
        setDragging(true)
        window.api.dragCoach.startDrag()
      }}
      onDragEnd={() => setDragging(false)}
      // The drag ends outside our window, so onDragEnd can be missed entirely;
      // a mouseleave reset stops the icon from being stuck dimmed forever.
      onMouseLeave={() => setDragging(false)}
      draggable
      title={CONFIG.ONBOARDING_DRAG_COACH.dragHint}
      style={
        {
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 5,
          padding: '8px 12px',
          borderRadius: 10,
          border: `1.5px dashed ${SYSTEM_BLUE}`,
          background: 'light-dark(rgba(0,122,255,0.07), rgba(10,132,255,0.14))',
          cursor: 'grab',
          opacity: dragging ? 0.4 : 1,
          transition: 'opacity 0.12s',
          // Must opt out of the window-drag region, or the whole panel moves
          // instead of the file being dragged.
          WebkitAppRegion: 'no-drag'
        } as React.CSSProperties
      }
    >
      <img
        src={appIcon}
        alt=""
        width={52}
        height={52}
        draggable={false}
        style={{
          display: 'block',
          filter: 'drop-shadow(0 3px 6px rgb(0 0 0 / 0.30))',
          // The bob is a hint that this thing MOVES — the one affordance a
          // static icon can't convey. It stops while actually dragging.
          animation: dragging ? 'none' : 'coach-bob 2.4s ease-in-out infinite'
        }}
      />
      <span style={{ fontSize: 10, fontWeight: 500, color: SYSTEM_BLUE, whiteSpace: 'nowrap' }}>
        {CONFIG.ONBOARDING_DRAG_COACH.dragHint}
      </span>

      {/* Scoped rather than index.css: this animation exists for exactly one
          window and dies with it. prefers-reduced-motion kills it — a
          permanently-moving element on a screen the user is stuck on is
          precisely the case that guideline was written for. */}
      <style>{`
        @keyframes coach-bob {
          0%, 100% { transform: translateY(0); }
          50%      { transform: translateY(-5px); }
        }
        @media (prefers-reduced-motion: reduce) {
          img { animation: none !important; }
        }
      `}</style>
    </span>
  )
}

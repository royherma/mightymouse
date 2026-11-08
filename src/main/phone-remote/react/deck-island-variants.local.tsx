/**
 * Dev-only: mock the floating control island on the swipe deck so its SHAPE
 * gets picked from pixels rather than from a description.
 *
 * Nothing here ships. It portals the REAL `BottomIconRow` + `KeyPillGrid` on
 * top of the REAL `SwipeDeckSheet`, so the shipped deck stays byte-identical
 * while the four layouts are judged. Whichever wins gets built properly after
 *
 * Real components on purpose, not a sketch: they carry the `data-img` hooks
 * every skin paints against, so what you see here is what a skinned island
 * actually looks like. Handlers are inert -- this judges layout, not wiring.
 *
 * Drag and pinch are re-implemented here in ~40 lines against mouse+touch.
 * The shipped version lifts CameraPip's state machine into a shared hook
 * instead; duplicating it in a throwaway harness is cheaper than extracting a
 * hook for a layout that might not survive the review.
 */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { LayoutGrid } from 'lucide-react'
import { KeyPillGrid, BottomIconRow } from './TouchpadControls'
import DeckControlIsland from './DeckControlIsland'
import type { KeyPillId, IconBtnId } from './TouchpadControls'

/** The four shapes the user chose between, plus `real`: the SHIPPED component, so
 *  what the harness shows is the code that runs on the phone rather than a
 *  mock that has drifted from it. */
export type IslandVariant = 'off' | 'real' | 'stacked' | 'iconsOnly' | 'wide' | 'corner'

export const ISLAND_VARIANTS: { id: IslandVariant; label: string; note: string }[] = [
  { id: 'off', label: 'Off (today)', note: 'The deck exactly as it ships. Every control is behind the opaque deck plate.' },
  {
    id: 'real',
    label: 'SHIPPED',
    note: 'The real DeckControlIsland component, not a mock. This is what runs on the phone.'
  },
  {
    id: 'stacked',
    label: 'A · Stacked',
    note: 'The shipped deck cluster, shrunk: keys above icons. Most familiar, tallest footprint.'
  },
  {
    id: 'iconsOnly',
    label: 'B · Icons only',
    note: 'Mic, switcher, previous app, settings. Smallest thing that still lets you talk, so it covers the least card.'
  },
  {
    id: 'wide',
    label: 'C · Wide',
    note: 'One row, all eight controls. Shortest, but spans the card - fights the swipe more than it looks like it should.'
  },
  {
    id: 'corner',
    label: 'D · Corner dock',
    note: 'Stacked, but snapped to the nearest corner on release instead of floating free. No stray placement, less control.'
  }
]

/** Which controls each variant carries. `undefined` means all of them - the
 *  same contract `only` already has on both row components. */
const VARIANT_KEYS: Record<Exclude<IslandVariant, 'off' | 'real'>, KeyPillId[] | undefined> = {
  stacked: undefined,
  iconsOnly: [],
  wide: ['tab', 'return'],
  corner: undefined
}
const VARIANT_ICONS: Record<Exclude<IslandVariant, 'off' | 'real'>, IconBtnId[] | undefined> = {
  stacked: undefined,
  iconsOnly: undefined,
  wide: undefined,
  corner: undefined
}

type Rect = { x: number; y: number }

// Over the card, not off its left edge: the phone column is 393px wide and the
// island is ~240px, so 16px put a third of it outside the deck.
const DEFAULT_RECT: Rect = { x: 76, y: 150 }

/** Injected rather than written into theme.css: this is a mock, and a real
 *  stylesheet edit would have to be unpicked once a variant wins. */
const CSS = `
.divIsland {
  position: absolute;
  z-index: 40;
  touch-action: none;
  /* The container never takes a touch -- only the controls inside it do.
     Same rule QuickSwitchOverlay follows, and the reason a card swipe that
     starts under the island still swipes the card. */
  pointer-events: none;
  transform-origin: top left;
}
.divIslandInner {
  pointer-events: auto;
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  /* Hugs the controls instead of framing them: the plate was reading as a
     panel laid over the card rather than the buttons themselves floating.
     Sides get the least, since that is where it ate the most card. */
  padding: 2px 4px 4px;
  border-radius: 16px;
  /* See-through on purpose -- you are meant to keep reading the card
     underneath while the controls sit on top of it. */
  background: transparent;
}
/* The paint layer. Carries the clip so the blur is cut with the shape --
   on .divIslandInner itself the backdrop-filter composites before the
   clip and leaves a full-box haze above the narrow top row. */
.divIslandInner::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: -1;
  /* No backdrop-filter: a blur layer always composites over its full border
     box and ignores clip-path, which is what left a haze block above the
     narrow top row. A translucent fill respects the clip. */
  background: rgba(255,255,255,0.72);
  clip-path: var(--island-clip, none);
}
/* Wide is one ROW of everything. The direction has to be set on
   .proControlsCell, not on .divIslandInner: the key grid and the icon row are
   both children of the cell, so flipping the wrapper only moved the grab bar. */
.divIsland[data-variant='wide'] .divIslandInner {
  flex-direction: row;
  align-items: center;
}
.divIsland[data-variant='wide'] .proControlsCell {
  flex-direction: row;
  align-items: center;
}
.divIsland[data-variant='wide'] .proKeyGrid {
  flex-direction: row;
}
/* The grab bar is the ONLY drag surface. Dragging from the body would mean a
   mispress on the mic moves the island instead of recording. */
.divGrab {
  pointer-events: auto;
  width: 28px;
  height: 4px;
  border-radius: 2px;
  background: rgba(0,0,0,0.16);
  cursor: grab;
  flex: 0 0 auto;
  margin: 2px 0 0;
}
.divIsland[data-dragging] .divGrab { cursor: grabbing; background: rgba(0,0,0,0.32); }
.divIsland[data-variant='wide'] .divGrab { width: 5px; height: 34px; }
/* The cluster is position:absolute in theme.css:6961 -- it is built to pin
   itself to the DECK's bottom edge. Left as-is inside the island it leaves the
   flow entirely and the island collapses to 56px wide around nothing. Put it
   back in flow and let it size to its own contents; everything else about it
   (gaps, hit-test opt-outs, skin hooks) stays exactly as it ships.

   Scale is applied on the OUTER node as one transform, so every skin's art
   scales with the buttons rather than being re-derived per button. */
.divIsland .proControlsCell {
  position: static;
  width: auto;
  height: auto;
  padding: 0;
  gap: 4px;
}
.divIsland .proIconRow, .divIsland .proKeyGrid { position: static; }
/* The key grid stretches to the deck width on the real cluster, which inside
   the island shows up as empty gutter either side of Esc/Tab. */
.divIsland .proKeyGrid { width: auto; align-self: stretch; justify-content: center; gap: 4px; }
.divIsland .proKeyGrid > * { flex: 1 1 auto; min-width: 0; }
`

/**
 * The island itself, portalled into the live `.swipeDeck` node.
 *
 * Portalled rather than rendered as a sibling because `.swipeDeck` is
 * `position: fixed; inset: 0` and OPAQUE -- an island mounted outside it is
 * painted over and invisible. That is the whole reason this feature exists.
 */
export function IslandVariantOverlay({
  variant,
  host,
  scale
}: {
  variant: IslandVariant
  host: HTMLElement | null
  /** Driven by the harness slider rather than a pinch: size is the thing being
   *  judged, and a trackpad cannot pinch a portalled div. The shipped island
   *  gets the real two-finger gesture from CameraPip's state machine. */
  scale: number
}): React.JSX.Element | null {
  const [mount, setMount] = useState<HTMLElement | null>(null)
  const [headSlot, setHeadSlot] = useState<HTMLElement | null>(null)
  const [on, setOn] = useState(true)
  const [clip, setClip] = useState<{ d: string; w: number; h: number } | null>(null)
  const [innerEl, setInnerEl] = useState<HTMLDivElement | null>(null)
  const [rect, setRect] = useState<Rect>(DEFAULT_RECT)
  const [dragging, setDragging] = useState(false)
  const rectRef = useRef(rect)
  rectRef.current = rect
  const micRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!host || variant === 'off') {
      setMount(null)
      return
    }
    const deck = host.querySelector<HTMLElement>('.swipeDeck')
    if (!deck) return
    const el = document.createElement('div')
    deck.appendChild(el)
    setMount(el)
    return () => {
      el.remove()
      setMount(null)
    }
  }, [host, variant])

  // The toggle mounts into the deck's REAL header group, so it inherits
  // .chatHeaderBtn and sits with the screen/zoom icons instead of near them.
  useEffect(() => {
    if (!host) return
    const btns = host.querySelector<HTMLElement>('.chatHeaderBtns')
    if (!btns) return
    const el = document.createElement('span')
    el.style.display = 'contents'
    btns.insertBefore(el, btns.firstChild)
    setHeadSlot(el)
    return () => {
      el.remove()
      setHeadSlot(null)
    }
  }, [host])

  useEffect(() => {
    const style = document.createElement('style')
    style.textContent = CSS
    document.head.appendChild(style)
    return () => style.remove()
  }, [])

  // The plate traces the buttons instead of boxing them, using the pad's own
  // path builder: the cluster is a 3-row staircase (two key rows + the icon
  // row), each a different width, so a rectangle leaves dead corners. Same
  // measure-every-row approach as useNotchPath, fed the island's rows.
  useEffect(() => {
    const el = innerEl
    if (!el || !on || variant === 'off') return
    let raf = 0
    const measure = (): void => {
      const box = el.getBoundingClientRect()
      const rows = [
        ...Array.from(el.querySelectorAll<HTMLElement>('.proKeyRow')),
        el.querySelector<HTMLElement>('.proIconRow')
      ].filter((r): r is HTMLElement => r !== null)
      if (rows.length === 0 || box.width === 0) return
      const PAD = 10
      // "Outline the buttons" literally: each row is a rounded band grown PAD
      // around its own buttons, and the bands are unioned. Rows cascade wider
      // toward the bottom (2 keys, 2 keys, 4 icons), so the silhouette is a
      // staircase -- the same shape the trackpad notch traces, built here from
      // the button boxes because the row containers are all one width.
      const bands = rows
        .map((r) => {
          const kids = Array.from(r.children) as HTMLElement[]
          if (kids.length === 0) return null
          const ls = kids.map((k) => k.getBoundingClientRect())
          const rr = r.getBoundingClientRect()
          return {
            x0: Math.min(...ls.map((b) => b.left)) - box.left - PAD,
            x1: Math.max(...ls.map((b) => b.right)) - box.left + PAD,
            y0: rr.top - box.top - PAD,
            y1: rr.bottom - box.top + PAD
          }
        })
        .filter((b): b is { x0: number; x1: number; y0: number; y1: number } => b !== null)
      if (bands.length === 0) return
      const w = box.width
      const h = box.height
      // Bands overlap vertically once grown, so a plain union of rounded rects
      // reads as one continuous plate with no seams between the rows.
      const R = 22
      const d = bands
        .map((b) => {
          const x0 = Math.max(0, b.x0)
          const x1 = Math.min(w, b.x1)
          const y0 = Math.max(0, b.y0)
          const y1 = Math.min(h, b.y1)
          const r = Math.min(R, (x1 - x0) / 2, (y1 - y0) / 2)
          return (
            `M${x0 + r},${y0} L${x1 - r},${y0} Q${x1},${y0} ${x1},${y0 + r} ` +
            `L${x1},${y1 - r} Q${x1},${y1} ${x1 - r},${y1} ` +
            `L${x0 + r},${y1} Q${x0},${y1} ${x0},${y1 - r} ` +
            `L${x0},${y0 + r} Q${x0},${y0} ${x0 + r},${y0} Z`
          )
        })
        .join(' ')
      setClip({ d, w, h })
    }
    raf = requestAnimationFrame(measure)
    const ro = new ResizeObserver(() => measure())
    ro.observe(el)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [innerEl, on, variant, scale])

  // Reset placement when the shape changes: a rect that fit the wide row can
  // leave the tall stacked one hanging off the bottom of the deck.
  useEffect(() => setRect(DEFAULT_RECT), [variant])

  const headBtn =
    headSlot &&
    createPortal(
      <button
        className="chatHeaderBtn"
        aria-label={on ? 'Hide the controls' : 'Show the controls'}
        aria-pressed={on}
        onClick={() => setOn((v) => !v)}
        type="button"
      >
        <LayoutGrid size={18} />
      </button>,
      headSlot
    )

  if (!mount || variant === 'off' || !on) return headBtn

  // The shipped component, mounted in the same portal so the harness measures
  // the real thing. Handlers are inert here -- this judges geometry, and the
  // live wiring is TouchpadLayout's job.
  if (variant === 'real') {
    return (
      <>
        {headBtn}
        {createPortal(
          <DeckControlIsland
            open
            pressKey={() => {}}
            openKeyboard={() => {}}
            recording={false}
        micLatched={false}
        micSidePress={() => {}}
        micStreamRef={{ current: null }}
        chatOpen={false}
            handsFree="off"
            handsFreeSpeaking={false}
            micRef={micRef}
            toggleAppSwitcher={() => {}}
            appSwitchOpen={false}
            quickSwitchTap={() => {}}
            quickSteps={0}
            settingsOpen={false}
            setSettingsOpen={() => {}}
            openWindowLayouts={() => {}}
          />,
          mount
        )}
      </>
    )
  }

  /** Drag from the grab bar only, mouse or touch. The harness runs on a
   *  trackpad, so mouse has to work; the device is touch. */
  const startDrag = (clientX: number, clientY: number): void => {
    const originX = rectRef.current.x
    const originY = rectRef.current.y
    setDragging(true)
    const move = (cx: number, cy: number): void => {
      setRect((r) => ({ ...r, x: originX + (cx - clientX), y: originY + (cy - clientY) }))
    }
    const onMouseMove = (e: MouseEvent): void => move(e.clientX, e.clientY)
    const onTouchMove = (e: TouchEvent): void => {
      if (e.touches.length === 1) move(e.touches[0].clientX, e.touches[0].clientY)
    }
    const end = (): void => {
      setDragging(false)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', end)
      window.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('touchend', end)
      // The corner variant's whole difference: it snaps on release.
      if (variant === 'corner' && mount) {
        const box = mount.parentElement?.getBoundingClientRect()
        if (box) {
          setRect((r) => ({
            ...r,
            x: r.x + 120 > box.width / 2 ? box.width - 150 : 16,
            y: r.y + 90 > box.height / 2 ? box.height - 190 : 80
          }))
        }
      }
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', end)
    window.addEventListener('touchmove', onTouchMove, { passive: true })
    window.addEventListener('touchend', end)
  }

  const keys = VARIANT_KEYS[variant]
  const icons = VARIANT_ICONS[variant]

  return (
    <>
      {headBtn}
      {createPortal(
    <div
      className="divIsland"
      data-variant={variant}
      data-dragging={dragging || undefined}
      style={{
        left: rect.x,
        top: rect.y,
        transform: `scale(${scale})`
      }}
    >
      {clip && (
        <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden>
          <defs>
            <clipPath id="divIslandClip" clipPathUnits="objectBoundingBox">
              <path
                d={clip.d}
                transform={`scale(${1 / clip.w} ${1 / clip.h})`}
              />
            </clipPath>
          </defs>
        </svg>
      )}
      <div
        ref={setInnerEl}
        className="divIslandInner"
        style={clip ? ({ '--island-clip': 'url(#divIslandClip)' } as React.CSSProperties) : undefined}
        onMouseDown={(e) => {
          // Anywhere on the plate that is not a control drags it. A 4px grab
          // bar is a miss on glass; the buttons still swallow their own press.
          if ((e.target as HTMLElement).closest('button')) return
          e.preventDefault()
          startDrag(e.clientX, e.clientY)
        }}
        onTouchStart={(e) => {
          if ((e.target as HTMLElement).closest('button')) return
          if (e.touches.length === 1) startDrag(e.touches[0].clientX, e.touches[0].clientY)
        }}
      >
        <div className="divGrab" />
        <div className="proControlsCell">
          {/* Inert handlers. This judges layout; the real island forwards the
              live ones down from TouchpadLayout. */}
          {keys?.length !== 0 && (
            <KeyPillGrid pressKey={() => {}} openKeyboard={() => {}} only={keys} />
          )}
          <BottomIconRow
            recording={false}
            handsFree="off"
            handsFreeSpeaking={false}
            micRef={micRef}
            toggleAppSwitcher={() => {}}
            appSwitchOpen={false}
            quickSwitchTap={() => {}}
            quickSteps={0}
            settingsOpen={false}
            setSettingsOpen={() => {}}
            openWindowLayouts={() => {}}
            only={icons}
          />
        </div>
      </div>
    </div>,
        mount
      )}
    </>
  )
}

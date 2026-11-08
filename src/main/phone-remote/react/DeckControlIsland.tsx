/**
 * The deck's control cluster, floating over the cards.
 *
 * `.swipeDeck` is an opaque `inset: 0` plate, so every control is on the other
 * side of it and triaging a card means closing the deck to press anything.
 * This mounts INSIDE the deck with the live handlers forwarded down from
 * `TouchpadLayout`, so the mic, app switcher, previous app, settings and the
 * four keys all work exactly as they do on the trackpad.
 *
 * The plate traces the buttons rather than boxing them: the three rows cascade
 * wider toward the bottom (2 keys, 2 keys, 4 icons), so a rectangle would eat
 * card either side of the narrow top. See `measureOutline` below.
 */

import { useEffect, useRef, useState, type RefObject } from 'react'
import { BottomIconRow, KeyPillGrid } from './TouchpadControls'
import type { HandsFreeDisplay } from './hands-free-rules'
import { useFloatingRect } from './hooks/use-floating-rect'
import { MicWaveform } from './MicWaveform'
import { Button } from '@shared/ui/Button'

const RECT_PREF_KEY = 'mm-remote-island-rect'
const OPEN_PREF_KEY = 'mm-remote-island-open'

/** Open/closed survives a reload, because an installed PWA reconnecting into a
 *  running session is the common case here, not a fresh start. */
export function readIslandOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_PREF_KEY) === '1'
  } catch {
    return false
  }
}

export function writeIslandOpen(open: boolean): void {
  try {
    localStorage.setItem(OPEN_PREF_KEY, open ? '1' : '0')
  } catch {
    // Private-mode storage failure -- the session value still applies.
  }
}

/** Width bounds for the pinch. The island is a control surface, so the floor
 *  is "every button still takes a thumb" rather than "still legible". */
const DEFAULT_W = 226
/** Only used before the plate has been measured once, on the very first
 *  paint. Every frame after that the real box supplies the ratio. */
const DEFAULT_ASPECT = 226 / 200
const MIN_W = 150
const MAX_W = 330

/** Grown around each row's own buttons before the bands are unioned. */
const OUTLINE_PAD = 14
/** Corner radius of a band. Larger than the pad, so the staircase reads as one
 *  rounded plate rather than three stacked pills. */
const OUTLINE_R = 22

type Band = { x0: number; x1: number; y0: number; y1: number }

/**
 * "Outline the buttons" literally: each row becomes a rounded band grown
 * around its own buttons, and the bands are unioned into one path.
 *
 * Measured from the BUTTON boxes, not the row containers -- all three
 * containers are the same width, so a staircase built from them is a
 * rectangle. Bands overlap vertically once grown, so the union reads as one
 * continuous plate with no seams between rows.
 */
function measureOutline(el: HTMLElement): { d: string; w: number; h: number } | null {
  const box = el.getBoundingClientRect()
  const rows = [
    ...Array.from(el.querySelectorAll<HTMLElement>('.proKeyRow')),
    el.querySelector<HTMLElement>('.proIconRow')
  ].filter((r): r is HTMLElement => r !== null)
  if (rows.length === 0 || box.width === 0) return null

  const bands = rows
    .map((row): Band | null => {
      const kids = Array.from(row.children) as HTMLElement[]
      if (kids.length === 0) return null
      const boxes = kids.map((k) => k.getBoundingClientRect())
      const rowBox = row.getBoundingClientRect()
      return {
        x0: Math.min(...boxes.map((b) => b.left)) - box.left - OUTLINE_PAD,
        x1: Math.max(...boxes.map((b) => b.right)) - box.left + OUTLINE_PAD,
        y0: rowBox.top - box.top - OUTLINE_PAD,
        y1: rowBox.bottom - box.top + OUTLINE_PAD
      }
    })
    .filter((b): b is Band => b !== null)
  if (bands.length === 0) return null

  const w = box.width
  const h = box.height
  const d = bands
    .map((b) => {
      const x0 = Math.max(0, b.x0)
      const x1 = Math.min(w, b.x1)
      const y0 = Math.max(0, b.y0)
      const y1 = Math.min(h, b.y1)
      const r = Math.min(OUTLINE_R, (x1 - x0) / 2, (y1 - y0) / 2)
      return (
        `M${x0 + r},${y0} L${x1 - r},${y0} Q${x1},${y0} ${x1},${y0 + r} ` +
        `L${x1},${y1 - r} Q${x1},${y1} ${x1 - r},${y1} ` +
        `L${x0 + r},${y1} Q${x0},${y1} ${x0},${y1 - r} ` +
        `L${x0},${y0 + r} Q${x0},${y0} ${x0 + r},${y0} Z`
      )
    })
    .join(' ')
  return { d, w, h }
}

export default function DeckControlIsland(props: {
  open: boolean
  pressKey: (key: 'tab' | 'return' | 'escape') => void
  openKeyboard: () => void
  recording: boolean
  /** The finger is OFF the mic. Cancel/Stop mount on this, not `recording` --
   *  `recording` flips mid-tap, so the pointerup's synthesized click used to
   *  land on Cancel and discard the clip. Same rule the fixed row follows. */
  micLatched: boolean
  micSidePress: (kind: 'cancel' | 'stop') => void
  micStreamRef: RefObject<MediaStream | null>
  chatOpen: boolean
  handsFree: HandsFreeDisplay
  handsFreeSpeaking: boolean
  micRef: RefObject<HTMLButtonElement | null>
  toggleAppSwitcher: () => void
  appSwitchOpen: boolean
  quickSwitchTap: () => void
  quickSteps: number
  settingsOpen: boolean
  setSettingsOpen: (fn: (v: boolean) => boolean) => void
  openWindowLayouts: () => void
}): React.JSX.Element | null {
  const { open } = props
  const islandRef = useRef<HTMLDivElement | null>(null)
  // The NODE, not a ref read during an effect that runs before the plate
  // mounts -- this directory's trackpad and mic each shipped dead listeners
  // from an effect keyed on something that merely described when a node should
  // exist. See phone-remote/CLAUDE.md.
  const [innerEl, setInnerEl] = useState<HTMLDivElement | null>(null)
  const [clip, setClip] = useState<{ d: string; w: number; h: number } | null>(null)

  const { rect, moving } = useFloatingRect(islandRef, {
    prefKey: RECT_PREF_KEY,
    // Bounds the drag only -- the plate's real height comes from its contents.
    // Measured rather than a literal, so a padding change cannot silently
    // desync the clamp from the box it is clamping.
    aspect: clip ? clip.w / clip.h : DEFAULT_ASPECT,
    minW: MIN_W,
    maxW: MAX_W,
    defaultW: DEFAULT_W,
    // Left edge, mid-height: clear of the header buttons at the top and the
    // swipe actions at the bottom, both of which are tap targets.
    place: () => ({ x: 12, y: Math.max(12, window.innerHeight * 0.3) }),
    enabled: open,
    // A press on a control must never drag the island. Everything else on the
    // plate does drag it -- a slim grab bar is a miss target on glass.
    isInteractive: (target) =>
      target instanceof Element && target.closest('button, [role="button"]') !== null
  })

  useEffect(() => {
    if (!innerEl || !open) return undefined
    const remeasure = (): void => setClip(measureOutline(innerEl))
    const raf = requestAnimationFrame(remeasure)
    // The rows resize with the skin, the pinch and any font change, and the
    // clip is only correct for the geometry it was measured against.
    const ro = new ResizeObserver(remeasure)
    ro.observe(innerEl)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [innerEl, open])

  if (!open) return null

  return (
    <div
      ref={islandRef}
      className="deckIsland"
      data-moving={moving ? '1' : undefined}
      /* Position rides the transform, not left/top: those trigger layout on
         every drag frame, which is what made the plate stutter under a finger.
         translate before scale, so the offset stays in screen pixels. */
      style={{
        left: 0,
        top: 0,
        transform: `translate3d(${rect.x}px, ${rect.y}px, 0) scale(${rect.w / DEFAULT_W})`
      }}
    >
      {clip && (
        <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden>
          <defs>
            <clipPath id="deckIslandClip" clipPathUnits="objectBoundingBox">
              <path d={clip.d} transform={`scale(${1 / clip.w} ${1 / clip.h})`} />
            </clipPath>
          </defs>
        </svg>
      )}
      <div
        ref={setInnerEl}
        className="deckIslandInner"
        style={clip ? ({ '--island-clip': 'url(#deckIslandClip)' } as React.CSSProperties) : undefined}
      >
        <div className="proControlsCell">
          <KeyPillGrid pressKey={props.pressKey} openKeyboard={props.openKeyboard} />
          <BottomIconRow
            recording={props.recording}
            handsFree={props.handsFree}
            handsFreeSpeaking={props.handsFreeSpeaking}
            micRef={props.micRef}
            toggleAppSwitcher={props.toggleAppSwitcher}
            appSwitchOpen={props.appSwitchOpen}
            quickSwitchTap={props.quickSwitchTap}
            quickSteps={props.quickSteps}
            settingsOpen={props.settingsOpen}
            setSettingsOpen={props.setSettingsOpen}
            openWindowLayouts={props.openWindowLayouts}
          />
        </div>
        {/* The recording controls, DOCKED to the plate instead of the screen
            bottom where the trackpad's copy lives. The island can be parked
            anywhere, so a fixed row leaves Cancel a full screen away from the
            finger that just pressed the mic. Same three components as the
            fixed row and the same `micLatched` gate -- only the anchor moves,
            via `.deckIslandRec` unsetting their `position: fixed`. */}
        {props.recording && !props.chatOpen && (
          <div className="deckIslandRec">
            {props.micLatched && (
              <Button
                variant="bare"
                className="micSideBtn micCancel proMicSideBtn"
                onPointerDown={(e) => {
                  e.preventDefault()
                  props.micSidePress('cancel')
                }}
                aria-label="Cancel recording"
              >
                Cancel
              </Button>
            )}
            <MicWaveform streamRef={props.micStreamRef} />
            {props.micLatched && (
              <Button
                variant="bare"
                className="micSideBtn micStop proMicSideBtn"
                onPointerDown={(e) => {
                  e.preventDefault()
                  props.micSidePress('stop')
                }}
                aria-label="Stop and send recording"
              >
                Stop
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

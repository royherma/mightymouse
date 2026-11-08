import { CONFIG } from '@shared/config'

// A macOS-style pointer drawn under the finger on the phone's touchpad
// (Settings > "Show cursor"). Deliberately LOCAL feedback: it marks where
// you're touching on THIS screen, it is not the Mac cursor's position
// translated onto the pad.
//
// Hand-rolled inline SVG on purpose: this is a faithful reproduction of the
// macOS arrow, not a UI icon, so it sits in the same category as the codebase's
// other brand/logo marks rather than the lucide-react icon rule (CLAUDE.md's
// "one icon family" carve-out for logos and glyphs).
//
// Fill and outline come from the user's own macOS pointer settings where they
// set them (see macos/cursor-appearance.ts) -- so a user who made their pointer
// green with a white outline sees that here too, not a generic black arrow.

const BASE_WIDTH = 14
const BASE_HEIGHT = 22

export default function MacCursor(props: {
  /** Position within the touchpad, in pad-local px (same space as the touch
   *  dot) -- the finger's own spot on this phone. */
  x: number
  y: number
  visible: boolean
  style: { size: number; fill: string; outline: string }
}): React.JSX.Element {
  const { x, y, visible, style } = props
  const w = BASE_WIDTH * style.size
  const h = BASE_HEIGHT * style.size

  return (
    <div
      className={`macCursor${visible ? ' visible' : ''}`}
      style={{
        left: x,
        top: y,
        width: w,
        height: h,
        transitionDuration: `${CONFIG.PHONE_REMOTE.SHOW_CURSOR_FADE_MS}ms`
      }}
      aria-hidden="true"
    >
      {/* The macOS arrow: a vertical left edge, a diagonal right edge, and the
          notched tail. viewBox is in BASE units so `size` scales it purely
          through the wrapper's width/height -- no path math per size. */}
      <svg width={w} height={h} viewBox={`0 0 ${BASE_WIDTH} ${BASE_HEIGHT}`} fill="none">
        <path
          d="M1 1 L1 16.5 L4.7 13.2 L7.1 19.4 L9.9 18.3 L7.5 12.3 L12.4 12.1 Z"
          fill={style.fill}
          stroke={style.outline}
          strokeWidth={1.2}
          strokeLinejoin="round"
        />
      </svg>
    </div>
  )
}

import { type RefObject } from 'react'
import { ClipboardPaste } from 'lucide-react'
import type { PhoneRemoteKeysPosition } from '@shared/types'
import { useClusterTop } from './useClusterTop'
import { hapticTick } from './haptics'
import { Button } from '@shared/ui/Button'

/** Breathing room kept between the button and the far screen edge. */
const GUTTER = 10

/** Cushion between this row and whatever it is stacked on top of. */
const STACK_GAP = 6

/**
 * Paste, floating on the deck with no keyboard up.
 *
 * Paste shipped as a keyboard-strip control in both keyboard hosts, on the
 * reasoning written up in FloatingContextBar: paste answers "put the Mac's
 * clipboard into what I am typing", and the deck has nothing to type into. That
 * holds for typing and misses what the button is actually used for -- moving a
 * link or a snippet from the Mac into whatever is frontmost. Reaching it meant
 * raising a keyboard purely to press one button and dismiss it again.
 *
 * TOPMOST OF THE FLOATING STACK, by request. It parks above the cluster like
 * FloatingContextBar, and above THAT bar when it is up (`floorTop`) -- so the
 * order from the bottom is cluster, context bar, paste. With neither the ring
 * nor the context bar painted, the same math leaves it sitting alone just off
 * the cluster's top edge, which is the whole point: it is the one control here
 * that does not depend on anything else being on screen.
 *
 * POSITIONED OFF THE CLUSTER'S MEASURED RECT for the reason useClusterTop
 * documents at length -- five separate rules move that cluster, so a calc()
 * could only ever be right in one of them. Ring clearance rides the same hook,
 * so this button clears the arc without knowing the arc exists.
 */
export default function FloatingPasteButton(props: {
  /** The .proControlsCell this parks against -- the PRIMARY cell in split mode,
   *  same one FloatingContextBar takes, so the two stack on one side. */
  clusterRef: RefObject<HTMLDivElement | null>
  keysPosition: PhoneRemoteKeysPosition
  isLandscape: boolean
  /** Card-local y of the app ring's outer edge, or null when no ring is up.
   *  Forwarded to useClusterTop untouched. */
  ringClearanceTop: number | null
  /** Viewport y of the context bar's top, when that bar is mounted. This button
   *  is pushed above it so the two never share a band. Null means the bar is
   *  absent and the cluster's own edge wins -- which is also the no-ring,
   *  no-bar case where this is the only thing floating. */
  floorTop: number | null
  onPaste: () => void
  /** Fade out of the way while the app ring is being scrubbed, same as the
   *  context bar: the arc paints inside the card at z-index 2 and this is fixed
   *  at the chrome tier, so it covers the icons the thumb is choosing between. */
  dimmed?: boolean
}): React.JSX.Element | null {
  const {
    clusterRef,
    keysPosition,
    isLandscape,
    ringClearanceTop,
    floorTop,
    onPaste,
    dimmed = false
  } = props

  const edge = useClusterTop(clusterRef, keysPosition, ringClearanceTop, isLandscape)

  // No measurement means no place to draw -- a button defaulting to y=0 would
  // park under the status bar rather than reveal the missing rect.
  if (edge === null) return null

  // Which gutter the cluster is against, measured rather than read off
  // `data-hand`: landscape has its own handedness rules and split mode moves
  // the primary cell again, so the rect is the only answer true in every mode.
  const onRight = edge.viewportWidth - edge.right < edge.left
  const outerInset = onRight ? edge.viewportWidth - edge.right : edge.left

  // Keys at the TOP means the stack hangs DOWNWARD, so the context bar's top is
  // not a ceiling to clear -- it is behind us in the other direction, and the
  // bar's own bottom edge is what we would need. Only the bottom case stacks.
  const stacked = keysPosition === 'bottom' && floorTop !== null
  const top = stacked ? Math.min(edge.top, floorTop - STACK_GAP) : edge.top

  return (
    <div
      className={`floatingPasteBar${dimmed ? ' dimmed' : ''}`}
      data-vpos={keysPosition}
      data-side={onRight ? 'right' : 'left'}
      style={{
        top: `${top}px`,
        ...(onRight
          ? { right: `${Math.max(0, outerInset)}px` }
          : { left: `${Math.max(0, outerInset)}px` }),
        maxWidth: `${Math.max(0, edge.viewportWidth - outerInset - GUTTER)}px`
      }}
    >
      <Button
        variant="bare"
        className="kbAccessoryBtn"
        // pointerdown, not click: click lands ~300ms after the touch ends, and
        // every control on this deck that can race a keyboard or a gesture
        // fires on the down edge. See this directory's CLAUDE.md.
        onPointerDown={(e) => {
          e.preventDefault()
          hapticTick()
          onPaste()
        }}
        aria-label="Paste what is on the Mac's clipboard"
      >
        <ClipboardPaste size={15} strokeWidth={2.25} />
        <span>Paste</span>
      </Button>
    </div>
  )
}

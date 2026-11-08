import { useCallback, useEffect, useState, type RefObject } from 'react'
import type { AppContext } from '@shared/app-context'
import type { PhoneRemoteKeysPosition } from '@shared/types'
import type { TmuxAction } from '@shared/phone-remote-keys'
import AppContextBar from './AppContextBar'
import { useClusterTop, type ClusterEdge } from './useClusterTop'
import { useCursorless } from './cursorless-host'

/** Breathing room kept between the bar and the far screen edge. */
const GUTTER = 10

/** Hard ceiling on the bar's width, as a share of the viewport. */
const MAX_SHARE = 0.6

/**
 * AppContextBar's THIRD host: floating on the deck, no keyboard involved.
 *
 * The bar's two keyboard hosts only ever appear with a keyboard up, which is
 * backwards for what it does. Jumping to another Chrome tab or cmux terminal is
 * navigation, not typing -- so the switcher was reachable only in the one state
 * where a keyboard covered the trackpad the user was about to reach for. This
 * host draws the same component on the deck itself, parked just off the button
 * cluster's leading edge.
 *
 * SAME COMPONENT, NOT A COPY. The reason is written up in this directory's
 * CLAUDE.md: the bar shipped with two hosts wired differently and a fix landed
 * on one keyboard while silently missing the other, twice. A third host is a
 * third chance at that, so everything host-specific here is confined to the
 * container's POSITION and the mount rule (`floatingBarVisible`) -- the bar's
 * own props are passed through untouched.
 *
 * WHAT IT DELIBERATELY DOES NOT DRAW, so this host is ONLY the context switcher:
 *
 *   The Paste key and the keyboard-swap button -- both keyboard-strip controls.
 *   Paste answers "put the Mac's clipboard into what I am typing", and there is
 *   nothing to type into here. The deck has its own Esc/Tab/Enter/keyboard pills
 *   a few px below.
 *
 *   NOT tmux zoom, which this host DOES draw (when cmux is frontmost). It reads
 *   as typing because it rides the `ctrl+b` prefix, but what it does is toggle
 *   which pane fills the window -- a change to what you are looking at, which is
 *   this host's whole job. It sits beside the two dropdowns for that reason.
 *
 *   The app chip (`hideAppChip`) -- a duplicate here, not a keyboard control. It
 *   opens the app switcher, and the deck's icon row already carries a button for
 *   exactly that, one row down. On the keyboard hosts the chip earns its place by
 *   naming what you are typing into; on the deck nothing is being typed into and
 *   the switcher is already reachable, so it is two entry points to one surface.
 *
 * What remains is the pair the deck genuinely cannot reach any other way: which
 * group, and which item.
 *
 * POSITIONED OFF THE CLUSTER'S MEASURED RECT, not a CSS calc -- see
 * useClusterTop for the five separate rules that move that cluster, and why a
 * calc() could only ever be right in one of them.
 */
export default function FloatingContextBar(props: {
  context: AppContext | null
  /** The .proControlsCell whose leading edge the bar parks against. In split
   *  mode this is the PRIMARY cell -- the dominant thumb's cluster, the one that
   *  holds the keyboard pill, so the bar stays on the side the hand is already
   *  on. */
  clusterRef: RefObject<HTMLDivElement | null>
  keysPosition: PhoneRemoteKeysPosition
  isLandscape: boolean
  /** Card-local y of the app ring's outer edge, or null when no ring is up. The
   *  bar parks above it -- see useClusterTop for why the arc cannot instead grow
   *  to enclose the bar. */
  ringClearanceTop: number | null
  onActivateItem: (itemId: string) => void
  onActivatePane: (paneId: string) => void
  onActivateGroup: (groupId: string) => void
  /** Forwarded to AppContextBar; see its prop doc. Required on every host --
   *  the compiler catching an omission here is why it is not optional. */
  onSheetOpenChange: (open: boolean) => void
  /** Forwarded to AppContextBar; see its prop doc. Reachable here only through
   *  the zoom button, which renders only while cmux is frontmost. */
  onTmuxAction: (action: TmuxAction) => void
  /** Forwarded to AppContextBar; see its prop doc. */
  onBarTap: () => void
  /** Fade out of the way while the app ring is being scrubbed. The bar is fixed
   *  at z-index 45 and the arc paints inside the card at 2, so it covers exactly
   *  the icons and label the thumb is choosing between. */
  dimmed?: boolean
  /** Viewport y of the bar's own TOP, reported so a surface above it can clear
   *  it. Measured off the rendered node rather than recomputed from `edge.top`
   *  minus a height: the height is the chip token plus padding plus whatever a
   *  host restyles, and a second derivation of this line is what put the glass
   *  zoom bar straight through it. Null while unmounted. */
  onTopChange?: (top: number | null) => void
}): React.JSX.Element | null {
  const {
    context,
    clusterRef,
    keysPosition,
    isLandscape,
    ringClearanceTop,
    onActivateItem,
    onActivatePane,
    onActivateGroup,
    onSheetOpenChange,
    onTmuxAction,
    onBarTap,
    dimmed = false,
    onTopChange
  } = props

  // Freeze the measured edge while a dropdown is up, for the same reason the
  // accessory strip freezes its own `top`: the sheet is a CHILD of the bar, so
  // anything that can move or unmount the bar mid-tap takes the open sheet with
  // it. Rotating with a sheet open is the one way this host can get a new
  // measurement mid-tap.
  const [frozenEdge, setFrozenEdge] = useState<ClusterEdge | null>(null)
  const liveEdge = useClusterTop(clusterRef, keysPosition, ringClearanceTop, isLandscape)
  const edge = frozenEdge ?? liveEdge

  // The rendered row, held in state rather than a ref so the effect below keys
  // on the NODE. Keyed on `edge` instead, the bar's first mount would measure
  // nothing: `edge === null` returns before this row exists.
  const [barNode, setBarNode] = useState<HTMLDivElement | null>(null)
  const cursorless = useCursorless()

  useEffect(() => {
    if (!barNode || !onTopChange) return
    const measure = (): void => onTopChange(barNode.getBoundingClientRect().top)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(barNode)
    const vv = window.visualViewport
    vv?.addEventListener('resize', measure)
    vv?.addEventListener('scroll', measure)
    window.addEventListener('resize', measure)
    window.addEventListener('orientationchange', measure)
    return () => {
      ro.disconnect()
      vv?.removeEventListener('resize', measure)
      vv?.removeEventListener('scroll', measure)
      window.removeEventListener('resize', measure)
      window.removeEventListener('orientationchange', measure)
      onTopChange(null)
    }
  }, [barNode, onTopChange, edge])

  const handleSheetOpenChange = useCallback(
    (open: boolean) => {
      setFrozenEdge(open ? (prev) => prev ?? liveEdge : null)
      onSheetOpenChange(open)
    },
    [liveEdge, onSheetOpenChange]
  )

  // No measurement means no place to draw -- and a bar defaulting to y=0 would
  // park itself under the status bar rather than reveal the missing rect.
  if (edge === null) return null
  // Off entirely on a cursorless host. It is a floating overlay parked on top of
  // the deck, and its tab picker is a dropdown -- on a 600x600 screen driven by
  // four arrows that is a second surface to swipe through before reaching any
  // control that does something. The app switcher grid covers the same job.
  if (cursorless) return null

  // Which gutter the cluster is against, measured rather than read off
  // `data-hand`: landscape has its own handedness rules and split mode moves the
  // primary cell again, so the rect is the only answer true in every mode. The
  // bar anchors to the cluster's OUTER edge and grows inward across open deck --
  // anchored the other way, a long tab title would run off screen.
  const onRight = edge.viewportWidth - edge.right < edge.left
  const outerInset = onRight ? edge.viewportWidth - edge.right : edge.left
  // TWO ceilings, and the tighter one wins.
  //
  // Room to the far gutter keeps the bar on screen; on its own it is nearly the
  // whole width (~380 of 393pt with the cluster against a gutter), so it bounds
  // nothing a real title would hit. A Chrome tab title is an unbounded string
  // and simply ran the bar across the entire deck.
  //
  // MAX_SHARE is the one that actually bites: past ~60% of the screen the bar
  // stops reading as a control parked over the trackpad and starts reading as a
  // second deck. `.bbTabTitle` is already `min-width: 0` + `text-overflow: ellipsis`, so
  // a real constraint is all it needs -- it truncates rather than pushing the
  // chevron and the count off the end.
  const room = Math.min(
    Math.max(0, edge.viewportWidth - outerInset - GUTTER),
    edge.viewportWidth * MAX_SHARE
  )

  return (
    <div
      ref={setBarNode}
      className={`floatingContextBar${dimmed ? ' dimmed' : ''}`}
      data-vpos={keysPosition}
      data-side={onRight ? 'right' : 'left'}
      style={{
        top: `${edge.top}px`,
        ...(onRight
          ? { right: `${Math.max(0, outerInset)}px` }
          : { left: `${Math.max(0, outerInset)}px` }),
        maxWidth: `${room}px`
      }}
      role="toolbar"
      aria-label="App and tab switcher"
    >
      <AppContextBar
        context={context}
        onBarTap={onBarTap}
        onTmuxAction={onTmuxAction}
        hideAppChip
        // Same story as onTmuxAction: hideAppChip drops the only control that
        // reaches it, and the deck's own icon-row button owns this action here.
        onOpenAppSwitcher={() => {}}
        onActivateItem={onActivateItem}
        onActivatePane={onActivatePane}
        onActivateGroup={onActivateGroup}
        onSheetOpenChange={handleSheetOpenChange}
      />
    </div>
  )
}

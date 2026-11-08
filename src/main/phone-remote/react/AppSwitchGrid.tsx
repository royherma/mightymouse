import { useCallback, useState } from 'react'
import { Button } from '@shared/ui/Button'

/**
 * The app-switcher's tile grid.
 *
 * ONE component, for the reason this directory's CLAUDE.md gives about
 * AppContextBar: two layouts once held byte-identical copies of this markup,
 * and a fix applied to one silently missed the other.
 *
 * WHY IT HAS ITS OWN STATE: a tap used to switch the Mac with no acknowledgement
 * on the phone at all -- `:active` is the only feedback a plain <div> gets, and
 * it is gone the instant the finger lifts, which is also the instant the overlay
 * starts closing. So the tile you picked and the tile you missed looked exactly
 * the same on the way out. `picked` survives the finger lifting and holds a
 * highlight through the close, which is the confirmation. Same call
 * QuickSwitchOverlay already makes with its ring: move the highlight FIRST, act
 * second, so the pick is visibly acknowledged before the Mac steals the screen.
 *
 * BOTH states are a HIGHLIGHT, never a badge. A check mark shipped here as the
 * pick receipt and read as a selection checkbox instead of "this is the tile
 * your finger is on" -- what is actually wanted is seeing where you press.
 * `pressed` tints under the finger, `picked` deepens that same tint and holds
 * it; nothing is added to the tile that wasn't already there.
 *
 * Fires on POINTERUP, not pointerdown: the grid scrolls, and acting on down
 * means a scroll flick launches whatever tile the finger started on. The slop
 * check is the same shape as AppContextBar's rowTap, for the same reason.
 */

/** How far a finger may travel on a tile and still count as a tap, not a scroll. */
const TILE_TAP_SLOP_PX = 10

export interface AppSwitchGridItem {
  bundleId: string
  name: string
  iconPngBase64?: string | null
}

export default function AppSwitchGrid(props: {
  apps: AppSwitchGridItem[] | null
  /** Bundle id of the app that is frontmost RIGHT NOW (`appContext.bundleId`),
   *  or null while unknown. Deliberately NOT derived from `apps` -- see the
   *  `currentBundleId` comment below. */
  frontBundleId: string | null
  /** Bundle ids to mark as chosen INSTEAD of the frontmost app. Set by callers
   *  that select rather than switch (the window-layout slots): there the
   *  highlight answers "which apps are in the layout", and marking whatever
   *  happens to be in front would name an app the user never picked. */
  selectedBundleIds?: string[]
  onPick: (bundleId: string) => void
  onRetry?: () => void
}): React.JSX.Element {
  const { apps, frontBundleId, selectedBundleIds, onPick, onRetry } = props
  const [picked, setPicked] = useState<string | null>(null)
  const [pressed, setPressed] = useState<string | null>(null)

  // `picked` has to be RELEASED, because this grid never unmounts -- both hosts
  // toggle it with an `.open` class, so component state outlives the overlay.
  // Left alone, a pick made now still owns the highlight on an open five
  // minutes later, and if you switched apps on the Mac in between it points at
  // the wrong app while the real frontmost sits unmarked. Releasing it whenever
  // the frontmost app changes hands the highlight back to the live front app --
  // so a confirmed pick keeps its highlight across the close, and a switch made
  // anywhere else corrects it.
  const [frontSeen, setFrontSeen] = useState<string | null>(frontBundleId)
  if (frontBundleId !== frontSeen) {
    setFrontSeen(frontBundleId)
    if (picked !== null) setPicked(null)
  }

  const pick = useCallback(
    (bundleId: string) => {
      // Highlight lands in the frame BEFORE the switch is sent -- see the
      // header. The haptic is the caller's: activateApp already ticks, and a
      // second one here would double-buzz a single tap.
      setPicked(bundleId)
      onPick(bundleId)
    },
    [onPick]
  )

  if (apps === null) return <div className="appRowEmpty">Loading…</div>
  if (apps.length === 0) {
    return (
      <div className="appRowEmpty">
        Couldn't load your apps
        {onRetry && (
          <Button variant="bare" type="button" className="appRowRetry" onClick={onRetry}>
            Try again
          </Button>
        )}
      </div>
    )
  }

  // The app already in front, highlighted before you touch anything: the grid
  // used to open with nothing marked, so it read as if the Mac didn't know
  // which app you were in.
  //
  // This must come from `appContext.bundleId` (pushed live by the NSWorkspace
  // frontmost watcher), NOT from `apps[0]`. `appList` is served
  // stale-while-revalidate -- openAppSwitcher paints the PREVIOUS open's list
  // instantly and refreshes in the background -- which is right for the app
  // SET but wrong for ordering, the one thing that changes on every switch. So
  // opening the switcher in Chrome briefly highlighted whatever was frontmost
  // last time, and because `picked` was released on `apps[0]` changing, a stale
  // head also kept a minutes-old pick lit. The live front app has neither
  // problem and is authoritative the moment the overlay opens.
  //
  // Only a fallback for `picked`, never an override: once you tap, YOUR choice
  // owns the highlight until the Mac confirms the switch landed.
  // A selecting caller states its own truth; only a switching one falls back to
  // the live front app.
  const highlighted = picked ?? frontBundleId
  const isHighlighted = (bundleId: string): boolean =>
    selectedBundleIds ? selectedBundleIds.includes(bundleId) : highlighted === bundleId

  return (
    <>
      {apps.map((item) => (
        <AppSwitchTile
          key={item.bundleId}
          item={item}
          picked={isHighlighted(item.bundleId)}
          pressed={pressed === item.bundleId}
          setPressed={setPressed}
          onPick={pick}
        />
      ))}
    </>
  )
}

function AppSwitchTile(props: {
  item: AppSwitchGridItem
  picked: boolean
  pressed: boolean
  setPressed: (id: string | null) => void
  onPick: (bundleId: string) => void
}): React.JSX.Element {
  const { item, picked, pressed, setPressed, onPick } = props
  // Where the finger landed, so pointerup can tell a tap from a scroll flick.
  const [start, setStart] = useState<{ x: number; y: number } | null>(null)

  return (
    <Button
      variant="bare"
      type="button"
      className={`appRow${pressed ? ' pressed' : ''}${picked ? ' picked' : ''}`}
      aria-label={item.name}
      onPointerDown={(e) => {
        setStart({ x: e.clientX, y: e.clientY })
        setPressed(item.bundleId)
      }}
      onPointerUp={(e) => {
        if (!start) {
          setPressed(null)
          return
        }
        setStart(null)
        if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > TILE_TAP_SLOP_PX) {
          setPressed(null)
          return
        }
        // Deliberately NOT clearing `pressed` on a real tap: the press tint is
        // the brighter of the two, and dropping it on lift makes the tile dim
        // at the exact moment the choice is confirmed. `picked` takes over on
        // the same frame and the grid unmounts moments later anyway.
        onPick(item.bundleId)
      }}
      // A finger that leaves the tile, or a scroll that steals the gesture,
      // must clear the press tint -- otherwise it sticks lit until the next tap.
      onPointerCancel={() => {
        setPressed(null)
        setStart(null)
      }}
      onPointerLeave={() => setPressed(null)}
    >
      {item.iconPngBase64 ? (
        <img src={`data:image/png;base64,${item.iconPngBase64}`} alt="" />
      ) : (
        <div className="appRowIconPlaceholder" />
      )}
      <span>{item.name}</span>
    </Button>
  )
}

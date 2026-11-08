import { ArrowLeftRight, Keyboard, LayoutGrid, Mic, Settings } from 'lucide-react'
import type { RefObject } from 'react'
import { useCursorless } from './cursorless-host'
import { handsFreeMicClass, type HandsFreeDisplay } from './hands-free-rules'
import { useLongPress } from './useLongPress'
import { Button } from '@shared/ui/Button'

/** One row of the MRU app list, mirrored from the server's SwitchableApp. */
export type QuickSwitchTarget = { name: string; bundleId: string; iconPngBase64: string }

/**
 * Which entry a burst of `steps` taps lands on: find where we are, step
 * forward, wrap.
 *
 * THE ONE place this is computed. Both the preview overlay and the send path
 * call it, so the tile the user sees lit and the app the Mac is asked to
 * activate are guaranteed to be the same app. Two separate derivations of
 * "which app is next" is the bug this feature keeps regressing into -- see
 *
 * `anchor` is the bundle id the Mac's last switch landed on. Null (first tap
 * of a session) or not found (that app quit) both start from index 0.
 */
export function quickSwitchTargetIndex(
  apps: QuickSwitchTarget[],
  anchor: string | null,
  steps: number
): number {
  const anchorIndex = anchor ? apps.findIndex((a) => a.bundleId === anchor) : -1
  const from = anchorIndex === -1 ? 0 : anchorIndex
  return (from + steps) % apps.length
}

/**
 * The floating chip shown while a quick-switch burst is accumulating: which app
 * the current tap count lands on. Shared by both layouts.
 *
 * Falls back to a neutral "Back N" label when the MRU list can't name the
 * destination (not fetched yet, too short, or stale). Showing the WRONG app
 * name is worse than showing none -- the user acts on this preview.
 */
/**
 * The macOS Cmd+Tab switcher, mirrored on the phone: a centered horizontal row
 * of app icons with the destination highlighted, shown while a burst builds.
 *
 * Deliberately the same shape as the real thing rather than a "you're going to
 * X" label -- the row is what makes the count legible. Seeing three icons with
 * the third lit answers "how far back am I?" at a glance, which a single name
 * never can, and it matches the muscle memory of holding Cmd on the Mac.
 *
 * The highlight is resolved with the SAME arithmetic quick-switch.ts uses --
 * `(indexOf(anchor) + steps) % apps.length` -- because anything else drifts off
 * the app that actually gets activated. In particular this must NOT assume
 * apps[0] is the current app: listSwitchableApps() orders by CGWindowList
 * z-order, which does not reliably reorder after an activate, so apps[0] stays
 * pinned across taps. That assumption is what froze the highlight on one tile
 * while the Mac correctly walked forward.
 *
 * `anchor` is the bundle id the Mac's last switch landed on, or null before the
 * first tap of a session -- in which case index 0 is the right place to start,
 * matching the Mac's own `currentIndex === -1` fallback.
 *
 * The row is capped and windowed (see MAX_VISIBLE) so a machine with 15 apps
 * open doesn't overflow a phone screen.
 *
 * Tiles are also directly tappable (`onPick`): the tap count walks to an app,
 * but once the row is up, pointing at the icon you want is the shorter path and
 * the one a finger reaches for. The panel itself stays `pointer-events: none`
 * so it never swallows a trackpad drag -- only the tiles take touches.
 */
export function QuickSwitchOverlay(props: {
  steps: number
  apps: QuickSwitchTarget[] | null
  anchor?: string | null
  pinned?: string | null
  onPick?: (bundleId: string) => void
}): React.JSX.Element | null {
  const { steps, apps, anchor, pinned, onPick } = props
  const cursorless = useCursorless()
  if (steps < 1) return null
  // A cursorless host cannot use this. The row is a TAP-COUNT affordance -- it
  // exists to show where repeated taps have walked to, and it dismisses itself
  // on a timer. With four arrows and a pinch there is nothing to count and no
  // way to reach a tile before it vanishes, so it is pure obstruction over the
  // deck. The app switcher grid is the equivalent that does work there.
  if (cursorless) return null

  // No list yet (first tap before the MRU round-trip landed, or Accessibility
  // denied): fall back to a bare count rather than an empty row. Never claim an
  // app name we don't have -- the user acts on this.
  if (!apps || apps.length < 2) {
    return (
      <div className="quickSwitchOverlay" role="status" aria-live="polite">
        <div className="quickSwitchRow">
          <div className="quickSwitchTile selected">
            <div className="quickSwitchTileIcon quickSwitchTileFallback">
              <ArrowLeftRight size={26} strokeWidth={2.25} />
            </div>
          </div>
        </div>
        <div className="quickSwitchLabel">Back {steps}</div>
      </div>
    )
  }

  // Window the list around the selection so the target is always on screen.
  const MAX_VISIBLE = 5
  // Once a burst has fired, hold the highlight on the app we actually asked
  // for while the overlay lingers -- the anchor moved to that app on send, so
  // recomputing would slide the highlight one further as the user watches.
  // Live burst (nothing sent yet): the SAME call the send path makes, so the
  // tile we light up and the app we ask for can never be two different apps.
  const pinnedIndex = pinned ? apps.findIndex((a) => a.bundleId === pinned) : -1
  const selected =
    pinnedIndex !== -1 ? pinnedIndex : quickSwitchTargetIndex(apps, anchor ?? null, steps)
  let start = 0
  if (apps.length > MAX_VISIBLE) {
    // Center the selection, then clamp so we never scroll past either end.
    start = Math.min(
      Math.max(0, selected - Math.floor(MAX_VISIBLE / 2)),
      apps.length - MAX_VISIBLE
    )
  }
  const visible = apps.slice(start, start + MAX_VISIBLE)

  return (
    <div className="quickSwitchOverlay" role="status" aria-live="polite">
      <div className="quickSwitchRow">
        {visible.map((app, i) => {
          const isSelected = start + i === selected
          return (
            <Button
              variant="bare"
              key={app.bundleId}
              type="button"
              className={`quickSwitchTile${isSelected ? ' selected' : ''}`}
              aria-label={`Switch to ${app.name}`}
              // Pointer-down, not click: the switcher is a transient overlay on
              // a timer, and waiting for the full tap cycle risks the row
              // closing out from under the finger mid-gesture.
              onPointerDown={(e) => {
                e.stopPropagation()
                onPick?.(app.bundleId)
              }}
            >
              {app.iconPngBase64 ? (
                <img
                  className="quickSwitchTileIcon"
                  src={`data:image/png;base64,${app.iconPngBase64}`}
                  alt={app.name}
                />
              ) : (
                <div className="quickSwitchTileIcon quickSwitchTileFallback">
                  {app.name.slice(0, 1)}
                </div>
              )}
            </Button>
          )
        })}
      </div>
      {/* Only the selected app is named -- the real switcher does the same, and
          labelling every tile would wrap and jitter as the selection moves. */}
      <div className="quickSwitchLabel">{apps[selected].name}</div>
    </div>
  )
}

// The Pro layout's secondary control cluster: the 2x2 key pill grid (top)
// and the bottom icon row (mic + download/grid/settings). Split out of
// TouchpadLayout.tsx per the design's "subcomponents, not one monolithic file"
// ask -- this is the one piece with enough repeated button markup to be
// worth its own file.

/** Which key pills this instance renders. Absent = all four (the shipped
 *  stacked deck). Split mode passes half to each thumb's cluster.
 *
 *  A filter rather than two hand-written cluster components on purpose: the
 *  pills carry skin tokens and `data-img` hooks that every skin styles, so a
 *  parallel markup tree would need every skin updated to match and would drift
 *  the first time one side gained a control. */
export type KeyPillId = 'escape' | 'keyboard' | 'tab' | 'return'

export function KeyPillGrid(props: {
  pressKey: (key: 'tab' | 'return' | 'escape') => void
  openKeyboard: () => void
  gridRef?: RefObject<HTMLDivElement | null>
  only?: KeyPillId[]
}): React.JSX.Element {
  const { pressKey, openKeyboard, gridRef, only } = props
  // useNotchPath measures the grid's CHILD ROWS, so an emptied row must not
  // render at all -- a zero-width row still has a rect, and the notch would
  // carve a level for a row with nothing in it.
  const has = (id: KeyPillId): boolean => !only || only.includes(id)
  const row1 = has('escape') || has('keyboard')
  const row2 = has('tab') || has('return')
  // The GRID is measured too, not just its rows -- an empty grid is the same
  // phantom-level bug one level up. Reachable via the mirror concept, which
  // gives one cluster all four icons and no pills at all.
  if (!row1 && !row2) return <></>
  return (
    // Tier 3: reachable, but last. These are keystroke helpers -- a swipe
    // should pass the mic and the app controls before it lands on a key.
    // Each pill also declares data-nav-order, because the grid is a 2x2 block
    // whose reading order (Esc, Kbd, Tab, Enter) is not the order anyone wants
    // to swipe it in -- Tab and Enter are the two that get used.
    <div className="proKeyGrid" data-nav-group="keys" ref={gridRef}>
      {row1 && (
      <div className="proKeyRow">
        {/* role+tabIndex, not <button>: these are <div>s because the skin CSS
            styles them as plates and a <button>'s UA appearance fights it. But
            a bare <div onClick> is invisible to keyboard focus, so on a
            cursorless host the whole key grid was unreachable -- focus stopped
            after the top row, which is the only row of real <button>s. */}
        {has('escape') && (
          <div
            className="proKeyPill"
            data-img="esc"
            data-nav-order="3"
            role="button"
            tabIndex={0}
            onClick={() => pressKey('escape')}
          >
            Esc
          </div>
        )}
        {/* pointerdown, NOT click -- this is the main way the native keyboard
            gets raised, and openKeyboard ends in a focus() call. iOS honours a
            programmatic focus only inside the user-gesture window, and `click`
            fires ~300ms after the touch ends (after the scroll/zoom wait), so
            it is routinely outside it and the focus silently no-ops. Same
            defect VirtualKeyboard's swap button was fixed for; this pill was
            the last entry point still on click. */}
        {has('keyboard') && (
        <div
          className="proKeyPill proKeyPillIcon"
          data-img="keyboard"
          data-nav-order="4"
          role="button"
          tabIndex={0}
          onPointerDown={(e) => {
            e.preventDefault()
            openKeyboard()
          }}
          // A cursorless select arrives as a synthesized click with no pointer
          // event before it, so the pointerdown path above never runs and the
          // pill was dead to a pinch. Guarded on the event having no pointer
          // behind it -- a real tap fires BOTH, and opening the keyboard twice
          // re-runs the focus() this pill exists to get right.
          onClick={(e) => {
            if (e.detail === 0) openKeyboard()
          }}
          aria-label="Keyboard"
        >
          <Keyboard size={18} strokeWidth={2} />
          <span className="proBtnLabel">Keys</span>
        </div>
        )}
      </div>
      )}
      {row2 && (
      <div className="proKeyRow">
        {has('tab') && (
          <div
            className="proKeyPill"
            data-img="tab"
            data-nav-order="1"
            role="button"
            tabIndex={0}
            onClick={() => pressKey('tab')}
          >
            Tab
          </div>
        )}
        {has('return') && (
          <div
            className="proKeyPill"
            data-img="enter"
            data-nav-order="2"
            role="button"
            tabIndex={0}
            onClick={() => pressKey('return')}
          >
            Enter
          </div>
        )}
      </div>
      )}
    </div>
  )
}

/** Which icon buttons this instance renders. Same filter contract as
 *  KeyPillId -- absent means all four. */
export type IconBtnId = 'mic' | 'switcher' | 'prev' | 'settings'


export function BottomIconRow(props: {
  recording: boolean
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
  rowRef?: RefObject<HTMLDivElement | null>
  only?: IconBtnId[]
}): React.JSX.Element {
  const {
    recording,
    handsFree,
    handsFreeSpeaking,
    micRef,
    toggleAppSwitcher,
    appSwitchOpen,
    quickSwitchTap,
    quickSteps,
    settingsOpen,
    setSettingsOpen,
    openWindowLayouts,
    rowRef,
    only
  } = props
  const settingsPress = useLongPress(
    () => setSettingsOpen((v) => !v),
    openWindowLayouts
  )
  const has = (id: IconBtnId): boolean => !only || only.includes(id)
  // Same invariant the key rows hold: a row with nothing in it must not render
  // at all. useNotchPath measures this container's rect, and an empty one still
  // has a rect -- the notch would carve a level for a row holding no controls.
  // Reachable via the split concepts that put all icons on one side.
  if (only && only.length === 0) return <></>
  return (
    // Tier 2 for the row; the mic overrides itself to tier 1 below.
    <div className="proIconRow" data-nav-group="main" ref={rowRef}>
      {has('mic') && (
      <Button
        variant="bare"
        className={`proMicBtn${recording ? ' recording' : ''}${handsFreeMicClass(handsFree, handsFreeSpeaking)}`}
        data-img="mic"
        // Tier 1, alone: with nothing focused the ring starts here, because
        // talking is what someone reaches for the remote to do.
        data-nav-group="primary"
        ref={micRef}
        aria-label={handsFree === 'listening' ? 'Listening, tap to stop' : 'Hold or tap to talk'}
      >
        <Mic size={26} strokeWidth={2} />
      </Button>
      )}
      {has('switcher') && (
      <Button
        variant="bare"
        className={`proIconBtn${appSwitchOpen ? ' active' : ''}`}
        data-img="switcher"
        onClick={toggleAppSwitcher}
        aria-label="App switcher"
      >
        <LayoutGrid size={20} strokeWidth={2.25} />
        <span className="proBtnLabel">Apps</span>
      </Button>
      )}
      {has('prev') && (
      <Button
        variant="bare"
        className={`proIconBtn${quickSteps > 0 ? ' active' : ''}`}
        data-img="prev"
        onClick={quickSwitchTap}
        aria-label="Switch to previous app"
      >
        <ArrowLeftRight size={20} strokeWidth={2.25} />
        <span className="proBtnLabel">Last app</span>
        {quickSteps > 1 && <span className="quickSwitchBadge">{quickSteps}</span>}
      </Button>
      )}
      {has('settings') && (
      <Button
        variant="bare"
        className={`proIconBtn${settingsOpen ? ' active' : ''}`}
        data-img="settings"
        // Tap opens Settings, a 1s hold opens the window-layout sheet.
        {...settingsPress}
        aria-label="Settings, or hold to arrange windows"
      >
        <Settings size={20} strokeWidth={2.25} />
        <span className="proBtnLabel">Settings</span>
      </Button>
      )}
    </div>
  )
}

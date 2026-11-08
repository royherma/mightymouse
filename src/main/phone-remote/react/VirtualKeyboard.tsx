import { useState } from 'react'
import {
  Keyboard,
  X,
  ArrowLeftToLine,
  ArrowRightToLine,
  StretchHorizontal,
  Smartphone,
  ClipboardPaste
} from 'lucide-react'
import { hapticTick } from './haptics'
import type { PhoneRemoteKeyName, PhoneRemoteModifier, TmuxAction } from '@shared/phone-remote-keys'
import type { AppContext } from '@shared/app-context'
import AppContextBar from './AppContextBar'
import KeyGrid from './KeyGrid'
import { KEYBOARD_LAYOUTS, type KeyboardLayoutId } from './keyboard-layouts'
import { getKeyboardDock, setKeyboardDock, type KeyboardDock } from './keyboard-dock-pref'
import { Button } from '@shared/ui/Button'

/**
 * The on-screen virtual keyboard: a drawn keyboard the phone renders and taps
 * drive, distinct from the "openKeyboard" trick (App.tsx) that pops iOS's own
 * native keyboard via a hidden focused <input>. That path stays the default --
 * it's free autocorrect and emoji -- this is the opt-in alternative
 * (virtual-keyboard-pref.ts) that MIRRORS THE HOST'S KEYBOARD: the Mac reports
 * hostKeyboard in layoutPrefs, App.tsx resolves it through
 * KEYBOARD_LAYOUT_FOR_HOST, and this component draws whatever layout it's
 * handed (full MacBook layout against a Mac -- Roy: "exact same keyboard.
 * It's very critical").
 *
 * Rendered at App level, sibling to ReferralSheet/HistorySheet -- but unlike
 * them, deliberately WITHOUT a scrim: the touchpad stays live while the
 * keyboard is up (scroll, move, click between keystrokes -- Roy: "I imagine
 * I'd want to do both"). Dismissal is explicit instead: the header ✕ or the
 * Keyboard pill again (App.tsx toggles). NOT nested inside .settingsPanel's
 * transformed box (see SettingsBody.tsx's skin-store comment for why: a
 * transformed ancestor becomes the containing block for every position:fixed
 * descendant).
 */

export default function VirtualKeyboard(props: {
  open: boolean
  layoutId: KeyboardLayoutId
  onClose: () => void
  onChar: (text: string) => void
  onBackspace: () => void
  onSpecialKey: (key: PhoneRemoteKeyName) => void
  onCombo: (modifiers: PhoneRemoteModifier[], key: PhoneRemoteKeyName) => void
  onSwitchToNative: () => void
  appContext: AppContext | null
  /** Whether the Mac clipboard holds anything pasteable -- gates the paste key. */
  clipboardHasContent: boolean
  onPasteClipboard: () => void
  onActivateItem: (itemId: string) => void
  onActivatePane: (paneId: string) => void
  onActivateGroup: (groupId: string) => void
  onOpenAppSwitcher: () => void
  /** Same contract as KeyboardAccessoryBar's: raised while an AppContextBar
   *  sheet is open. Both hosts MUST forward it -- see the note on the render. */
  onSheetOpenChange: (open: boolean) => void
  /** Forwarded to AppContextBar; see its prop doc. */
  onBarTap: () => void
  /** Forwarded to AppContextBar; see its prop doc. */
  onTmuxAction: (action: TmuxAction) => void
}): React.JSX.Element {
  const {
    open,
    layoutId,
    onClose,
    onChar,
    onBackspace,
    onSpecialKey,
    onCombo,
    onSwitchToNative,
    appContext,
    clipboardHasContent,
    onPasteClipboard,
    onActivateItem,
    onActivatePane,
    onActivateGroup,
    onOpenAppSwitcher,
    onSheetOpenChange,
    onBarTap,
    onTmuxAction
  } = props
  // iOS-one-handed-style dock: full-width by default, squashable toward
  // either edge so the board stops covering the whole touchpad (the
  // uncovered side stays live -- no scrim, see the render comment below).
  const [dock, setDock] = useState<KeyboardDock>(() => getKeyboardDock())

  const layout = KEYBOARD_LAYOUTS[layoutId]

  function pickDock(next: KeyboardDock): void {
    hapticTick()
    // Tapping the already-active edge is an undo back to full-width, so each
    // edge button is its own toggle -- no separate "exit" control needed.
    const resolved = dock === next ? 'full' : next
    setDock(resolved)
    setKeyboardDock(resolved)
  }

  return (
    <>
      {/* NO scrim, unlike the sibling sheets: the whole point of typing from
          the phone is doing it WHILE driving the touchpad (scroll, move, click
          between keystrokes). A scrim would either dismiss the keyboard on the
          first touchpad touch or swallow it -- so the touchpad stays live and
          dismissal is explicit: the ✕ below, or the same Keyboard pill that
          opened it (a toggle -- one entry point, both directions). */}
      <div
        className={`virtualKeyboard${open ? ' open' : ''}${layout.dense ? ' vkDense' : ''}${
          dock === 'left' ? ' vkDockLeft' : dock === 'right' ? ' vkDockRight' : ''
        }`}
        role="dialog"
        aria-label="Virtual keyboard"
      >
        <div className="historyHeader">
          {/* Both the icon and the title go on the SAME condition the bar renders
              on: they only ever said "this is the keyboard", which the keys below
              already say. Once there is an app to name, that slot is worth more
              to the app chip -- and hiding the pair outright beats shrinking the
              row around them, since it puts the chip at the left edge where the
              eye already goes. Nothing is lost: the ✕ and the Keyboard pill both
              still dismiss. */}
          {!appContext?.appName && (
            <>
              <Keyboard size={17} strokeWidth={2.25} />
              <span className="historyTitle vkHeaderTitle">Keyboard</span>
            </>
          )}
          {/* Between the title and the dock trio: the trio + ✕ already own the
              right edge (margin-left:auto), so the browser bar takes the middle
              and both keep their positions.

              `hasContext` drives the title's exit from JS, using the SAME
              condition AppContextBar renders on. It was a CSS
              `:has(.vkBrowserBar:not(:empty))` chain -- a proxy for that
              condition, and one that disagreed with it on cmux: the title
              stayed and ate 48px the tab title needed, measured at a 13px
              stub against Chrome's 66px in the same row. Why `:empty`
              evaluated the way it did was never pinned down; expressing the
              one condition once removes the question. */}
          <div className={`vkBrowserBar${appContext?.appName ? ' hasContext' : ''}`}>
            {/* onSheetOpenChange is NOT optional in practice: without it the
                hidden input's blur reads a sheet tap as "the user dismissed the
                keyboard" and tears the bar down mid-tap. It shipped missing on
                exactly this instance while the accessory strip had it, so the
                bug only appeared on the virtual keyboard. */}
            <AppContextBar
              onBarTap={onBarTap}
              context={appContext}
              onTmuxAction={onTmuxAction}
              onActivateItem={onActivateItem}
              onActivatePane={onActivatePane}
              onActivateGroup={onActivateGroup}
              onOpenAppSwitcher={onOpenAppSwitcher}
              onSheetOpenChange={onSheetOpenChange}
            />
          </div>
          {/* iOS-style one-handed dock: squash the board to an edge so the
              touchpad beside it stays visible AND live. Each edge button
              toggles -- tap it again (or tap Full) to go back to full width. */}
          <div className="vkHeaderBtns">
            {/* Paste what the Mac already has on its clipboard. Hidden when
                that clipboard is empty rather than disabled: a dead control on
                an already-crowded row reads as broken. */}
            {clipboardHasContent && (
              <Button
                variant="bare"
                className="vkHeaderBtn"
                onClick={onPasteClipboard}
                aria-label="Paste what is on the Mac's clipboard"
              >
                <ClipboardPaste size={15} strokeWidth={2.25} />
              </Button>
            )}
            {/* The mirror of KeyboardAccessoryBar's button: each board carries
                one control pointing at the other, so switching never costs a
                trip to Settings. Separated from the dock trio -- it leaves
                this keyboard entirely, they only reshape it. */}
            {/* pointerdown, NOT click. This one calls focus() on the hidden
                input, and iOS only honours a programmatic focus inside the
                user-gesture window -- which `click` (fired ~300ms after the
                touch ends, after a scroll/zoom wait) is routinely outside. The
                focus then silently no-ops: the virtual board is already gone,
                the native one never arrives, and the app sits with NO keyboard
                and a half-applied switch. The next tap anywhere then resolved
                the pending state and read as "tapping anything switches
                keyboards" (Roy, on-device). Every other control that moves
                keyboard focus in this codebase already fires on pointerdown;
                this button was the one that did not. */}
            <Button
              variant="bare"
              className="vkHeaderBtn vkSwitchBtn"
              onPointerDown={(e) => {
                e.preventDefault()
                onSwitchToNative()
              }}
              aria-label="Switch to the phone keyboard"
            >
              <Smartphone size={15} strokeWidth={2.25} />
            </Button>
            <Button
              variant="bare"
              className={`vkHeaderBtn vkDockBtn${dock === 'left' ? ' active' : ''}`}
              onClick={() => pickDock('left')}
              aria-label="Dock keyboard left"
            >
              <ArrowLeftToLine size={15} strokeWidth={2.25} />
            </Button>
            <Button
              variant="bare"
              className={`vkHeaderBtn vkDockBtn${dock === 'full' ? ' active' : ''}`}
              onClick={() => pickDock('full')}
              aria-label="Full-width keyboard"
            >
              <StretchHorizontal size={15} strokeWidth={2.25} />
            </Button>
            <Button
              variant="bare"
              className={`vkHeaderBtn vkDockBtn${dock === 'right' ? ' active' : ''}`}
              onClick={() => pickDock('right')}
              aria-label="Dock keyboard right"
            >
              <ArrowRightToLine size={15} strokeWidth={2.25} />
            </Button>
            <Button variant="icon" className="vkClose" onClick={onClose} aria-label="Close keyboard">
              <X size={16} strokeWidth={2.5} />
            </Button>
          </div>
        </div>
        <KeyGrid
          open={open}
          layoutId={layoutId}
          onChar={onChar}
          onBackspace={onBackspace}
          onSpecialKey={onSpecialKey}
          onCombo={onCombo}
        />
      </div>
    </>
  )
}

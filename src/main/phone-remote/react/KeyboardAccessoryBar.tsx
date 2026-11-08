import { useCallback, useEffect, useRef, useState } from 'react'
import { ClipboardPaste, Command } from 'lucide-react'
import type { AppContext } from '@shared/app-context'
import { hapticTick } from './haptics'
import AppContextBar from './AppContextBar'
import type { TmuxAction } from '@shared/phone-remote-keys'
import { kbTrace } from './keyboard-trace'
import { Button } from '@shared/ui/Button'

/**
 * Occluded height below which we call it "no keyboard".
 *
 * Not zero: iOS leaves a few px of rounding between the two viewports, and
 * Safari's own toolbars occlude far less than any keyboard (the shortest,
 * a collapsed emoji board, still clears 200px).
 */
export const KEYBOARD_MIN_OCCLUSION_PX = 120

/**
 * Whether the strip stays on screen. Extracted because getting it wrong is
 * invisible in a screenshot and reads as a dead tap: this returned false the
 * instant a dropdown blurred the hidden input, unmounting the strip -- and the
 * open sheet inside it -- before the tap resolved.
 *
 * `keyboardFocused` is now `keyboardMode === 'native'` (barHostVisible in
 * keyboard-state.ts), the SAME rule VirtualKeyboard's header answers to, rather
 * than this component's own reading of the hidden input's focus. That divergence
 * is why a bar fix could land on one keyboard and silently miss the other.
 *
 * What stays local is the `top` term, because it is a POSITIONING requirement
 * unique to this host: the strip is `position: fixed` at the keyboard's top
 * edge and there is nowhere to draw it without a measurement. `sheetOpen`
 * outranks the mode (a dropdown tap blurs the input mid-tap) and nothing
 * outranks a missing measurement.
 */
export function accessoryBarVisible(state: {
  keyboardFocused: boolean
  sheetOpen: boolean
  top: number | null
}): boolean {
  if (state.top === null) return false
  return state.keyboardFocused || state.sheetOpen
}

/**
 * Our own accessory strip, drawn directly above iOS Safari's `< > Done` bar
 * while the native keyboard is up.
 *
 * WHY THIS EXISTS AT ALL: that `< > Done` bar is Safari's FORM ACCESSORY BAR,
 * rendered by the OS outside the page. No web API can add a button to it --
 * `inputAccessoryView` is native WKWebView only, and phone remote is Safari.
 * So the only way to put a control next to the native keyboard is to draw one
 * ourselves and pin it to the top of the keyboard's occupied area.
 *
 * POSITIONED FROM visualViewport, NOT innerHeight. When iOS raises the
 * keyboard the layout viewport (`innerHeight`) does not change -- only the
 * VISUAL viewport shrinks. `vv.height + vv.offsetTop` is the y of the
 * keyboard's top edge (accessory bar included, since that bar is part of the
 * occluded region), measured from the layout viewport's top -- exactly what a
 * `position: fixed; top:` wants. Hand-deriving this from innerHeight and a
 * guessed keyboard height is the same trap `.proRoot` documents in this
 * directory's CLAUDE.md: measure, never assume.
 *
 * FIRES ON pointerdown WITH preventDefault, like VirtualKeyboard's keys. A
 * `click` needs the touch to end, and the touch ending on a non-input element
 * blurs the hidden <input>, which collapses the keyboard AND this strip out
 * from under the finger before the handler ever runs. preventDefault on
 * pointerdown keeps focus in the input so the tap resolves against a strip
 * that is still on screen.
 *
 * Built as a ROW holding one button. The swap is the first occupant; the
 * quick keys this strip exists to make cheap (Cmd-C/Cmd-V, Esc, Tab, arrows)
 * drop in beside it without touching the geometry.
 */
export default function KeyboardAccessoryBar(props: {
  open: boolean
  onSwitchToVirtual: () => void
  appContext: AppContext | null
  clipboardHasContent: boolean
  onPasteClipboard: () => void
  onActivateItem: (itemId: string) => void
  onActivatePane: (paneId: string) => void
  onActivateGroup: (groupId: string) => void
  onOpenAppSwitcher: () => void
  onSheetOpenChange: (open: boolean) => void
  /** Forwarded to AppContextBar; see its prop doc. */
  onBarTap: () => void
  /** Forwarded to AppContextBar; see its prop doc. */
  onTmuxAction: (action: TmuxAction) => void
}): React.JSX.Element | null {
  const {
    open,
    onSwitchToVirtual,
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
  // y of the keyboard's top edge, or null while we have no measurement AND
  // whenever nothing is occluding the viewport -- see OCCLUSION below.
  const [top, setTop] = useState<number | null>(null)

  // A sheet opened from this strip pins it in place: tapping a dropdown blurs
  // the hidden input, so `open` goes false and iOS starts collapsing the
  // keyboard -- both of which unmount this strip, and the sheet lives inside
  // it. browserSheetOpenRef keeps the KEYBOARD alive but says nothing about
  // this component's mount, which is why the bug survived on the native board
  // while the virtual one (no such gate) was fine. Freeze rather than hide: the
  // last measured top is where the user is looking.
  const [sheetOpen, setSheetOpen] = useState(false)
  // The SAME flag as a ref, because `measure` below has to read it from inside
  // a visualViewport listener. State is committed on React's schedule; a resize
  // fired between the tap and that commit still ran the old closure, wrote
  // `top = null`, and unmounted the strip -- `top === null` outranks `sheetOpen`
  // in accessoryBarVisible, so the freeze never got a chance to apply. The ref
  // is set synchronously in the same handler that opens the sheet.
  const sheetOpenRef = useRef(false)
  const handleSheetOpenChange = useCallback(
    (next: boolean): void => {
      sheetOpenRef.current = next
      setSheetOpen(next)
      onSheetOpenChange(next)
    },
    [onSheetOpenChange]
  )

  useEffect(() => {
    // Hold the last measurement while a sheet is up -- re-measuring against a
    // collapsing keyboard would walk the strip down the screen mid-tap.
    if (sheetOpen) return
    if (!open) {
      // Unmounts the strip WITHOUT measuring anything -- `top === null` outranks
      // every other term in accessoryBarVisible. Traced because on screen this
      // is indistinguishable from the keyboard genuinely closing.
      kbTrace('strip:unfocus', { verdict: 'top=null (no measure)' })
      setTop(null)
      return
    }
    const vv = window.visualViewport
    if (!vv) return
    const measure = (): void => {
      // A sheet is up: whatever this resize says, it is not a dismissal. Read
      // the REF, not the state above -- this listener can fire before React has
      // committed the tap that opened the sheet, and that one stale frame was
      // enough to null `top` and take the strip down mid-tap.
      if (sheetOpenRef.current) {
        kbTrace('strip:measure', { verdict: 'frozen(sheet)' })
        return
      }
      // OCCLUSION IS THE REAL SIGNAL, not focus. `open` tracks the hidden
      // input's focus, and iOS can take its keyboard away WITHOUT blurring it
      // (swipe-to-dismiss, app backgrounded and resumed). The stale `open`
      // then parked this strip at the bottom of a full-height viewport, on
      // screen with no keyboard under it. If nothing is occluded there is no
      // keyboard, whatever focus claims.
      const occluded = window.innerHeight - (vv.height + vv.offsetTop)
      const next = occluded > KEYBOARD_MIN_OCCLUSION_PX ? vv.height + vv.offsetTop : null
      // `top -> null` is the single edge that unmounts this strip, and it is
      // invisible on screen (the strip is simply gone). Logging the occlusion
      // that caused it is what separates "the keyboard really closed" from
      // "iOS reported a transient mid-animation height".
      kbTrace('strip:measure', { occluded: Math.round(occluded), top: next ?? 'null' })
      setTop(next)
    }
    measure()
    // `resize` catches the keyboard opening/closing and any autocorrect-bar
    // height change; `scroll` catches iOS panning the visual viewport, which
    // moves offsetTop without a resize.
    vv.addEventListener('resize', measure)
    vv.addEventListener('scroll', measure)
    return () => {
      vv.removeEventListener('resize', measure)
      vv.removeEventListener('scroll', measure)
    }
  }, [open, sheetOpen])

  if (!accessoryBarVisible({ keyboardFocused: open, sheetOpen, top })) return null

  // The only crowded case: AppContextBar shows its dropdowns (only for an app
  // an adapter can read -- on any other app it is just the app chip) AND Paste
  // is present. That is four controls on a ~390px row, so the swap button sheds
  // its label.
  const compact = appContext?.adapterId != null && clipboardHasContent

  return (
    <div className="kbAccessory" style={{ top: `${top}px` }} role="toolbar" aria-label="Keyboard tools">
      <AppContextBar
        onBarTap={onBarTap}
        context={appContext}
        onTmuxAction={onTmuxAction}
        onActivateItem={onActivateItem}
        onActivatePane={onActivatePane}
        onActivateGroup={onActivateGroup}
        onOpenAppSwitcher={onOpenAppSwitcher}
        onSheetOpenChange={handleSheetOpenChange}
      />
      {clipboardHasContent && (
        <Button
          variant="bare"
          className="kbAccessoryBtn"
          onPointerDown={(e) => {
            e.preventDefault()
            // Records the tap so a blur arriving right after it reads as
            // "the bar stole focus", not "the user dismissed the keyboard".
            // preventDefault alone does not hold focus here: iOS still blurs
            // the hidden input, and submitKeyboardText only refocuses when
            // focusWasStolenByBar() says a bar tap explains the blur. Without
            // this, Paste collapsed the native keyboard -- and only that one,
            // since the virtual board never gates on the input's focus.
            onBarTap()
            hapticTick()
            onPasteClipboard()
          }}
          aria-label="Paste what is on the Mac's clipboard"
        >
          <ClipboardPaste size={15} strokeWidth={2.25} />
          <span>Paste</span>
        </Button>
      )}
      <Button
        variant="bare"
        className="kbAccessoryBtn"
        onPointerDown={(e) => {
          e.preventDefault()
          hapticTick()
          onSwitchToVirtual()
        }}
        aria-label="Switch to the Mac keyboard"
      >
        <Command size={15} strokeWidth={2.25} />
        {/* Label drops once the browser dropdowns claim the row: four labelled
            controls do not fit an iPhone's width, and the glyph alone still
            reads as "Mac keys" beside a labelled Paste. */}
        {!compact && <span>Mac keys</span>}
      </Button>
    </div>
  )
}

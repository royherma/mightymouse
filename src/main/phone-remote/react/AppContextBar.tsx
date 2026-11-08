import { Fragment, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Globe, Maximize2, Minimize2 } from 'lucide-react'
import { kbTrace } from './keyboard-trace'
import type { AppContext, AppContextGroup, AppContextItem } from '@shared/app-context'
import { APP_ADAPTER } from '@shared/app-context'
import type { TmuxAction } from '@shared/phone-remote-keys'
import { hapticTick } from './haptics'
import { monoHues } from './mono-hue'
import { Button } from '@shared/ui/Button'

/**
 * The app-aware cluster: which group, and which item, as two dropdowns.
 *
 * ONE component rendered by BOTH keyboard bars (the floating accessory strip
 * over the native keyboard, and the virtual keyboard's own header row). They
 * are two separate surfaces with two separate geometries, and the pairing bug
 * this directory's CLAUDE.md documents came from exactly that shape — two
 * implementations of one control drifting apart. The bars own their layout;
 * this file owns the control.
 *
 * Leads with a chip naming the frontmost app WHATEVER it is, so the bar always
 * answers "what am I typing into?"; the two dropdowns appear on top of that
 * when the app is one an adapter can read (Chrome profiles + tabs, cmux tabs +
 * terminals). Both levels are OPTIONAL: Safari reports zero groups and its left
 * dropdown simply does not render. Renders nothing only when no frontmost
 * app can be read at all.
 *
 * EVERY control preventDefaults on pointerdown, matching KeyboardAccessoryBar's
 * button: on the accessory strip a `click` would blur the hidden <input>, which
 * collapses the keyboard and the strip out from under the finger before the
 * handler runs. Bar buttons ACT on that same pointerdown; list rows do not (see
 * rowTap) because they sit on something scrollable.
 *
 * The dropdowns are PORTALLED to document.body — both hosts are transformed,
 * and a transformed ancestor captures `position: fixed`, so an in-place sheet
 * could not escape its host's box.
 */

/** Breathing room kept between a sheet and the screen edges. */
const SHEET_EDGE_GUTTER = 8
/** Gap between a sheet's bottom and the button that opened it. */
export const SHEET_ANCHOR_GAP = 6
/** Widest a sheet gets before its rows start ellipsising instead. */
const SHEET_MAX_WIDTH = 340
/** Share of the viewport a sheet may cover vertically. */
const SHEET_MAX_HEIGHT_RATIO = 0.42
/** How far a finger may travel on a row and still count as a tap, not a scroll. */
const ROW_TAP_SLOP_PX = 10

/** Narrowest a sheet may be squeezed before it stops narrowing and slides instead. */
const SHEET_MIN_WIDTH = 190

/** Scroll offset past which the top-of-list fade turns on. Not zero: iOS reports
 *  sub-pixel scrollTop at rest, which would flicker the mask against a real top. */
const SHEET_FADE_AT_PX = 2

/** Viewport-space geometry for a portalled sheet. */
interface SheetBox {
  left: number
  bottom: number
  maxWidth: number
  maxHeight: number
}

/**
 * Place a sheet above its anchor, clamped so BOTH edges stay on screen.
 *
 * Anchored by its LEFT edge, not its right. Right-aligning to a chip that sits
 * near the left of the row (the profile avatar is the second control in) left
 * only ~140px between the chip and the left gutter, and the sheet does not
 * narrow below `SHEET_MIN_WIDTH` -- so it overflowed by the difference and its
 * rows were sliced off mid-word. Aligning left instead means the free space is
 * measured toward the RIGHT of the anchor, where the whole rest of the row is.
 *
 * The final clamp is what actually guarantees it: once a width is chosen, left
 * is pulled back so `left + width` still clears the right gutter. A sheet wider
 * than the viewport pins to the left gutter and ellipsises, which is the one
 * case where clipping is the correct answer.
 *
 * Measured against visualViewport when available -- with a keyboard up, that is
 * the only box that describes what is actually visible.
 */
export function sheetBoxIn(
  anchor: DOMRect,
  view: { vw: number; layoutH: number; visualH: number }
): SheetBox {
  const { vw, layoutH, visualH } = view

  const widest = Math.max(0, vw - SHEET_EDGE_GUTTER * 2)
  // Never below the min-width the CSS enforces anyway: promising a 140px cap the
  // element ignores is what produced the off-screen edge.
  const maxWidth = Math.max(Math.min(SHEET_MIN_WIDTH, widest), Math.min(SHEET_MAX_WIDTH, widest))
  const left = Math.min(
    Math.max(SHEET_EDGE_GUTTER, anchor.left),
    Math.max(SHEET_EDGE_GUTTER, vw - SHEET_EDGE_GUTTER - maxWidth)
  )
  return {
    left,
    // `bottom` is resolved by the browser against the LAYOUT viewport, because
    // the sheet is portalled to document.body and `position: fixed` there is
    // laid out in layout-viewport space -- NOT the visual one. `anchor.top` is
    // already in that space (getBoundingClientRect), so both terms have to be.
    //
    // Measuring this against visualViewport.height put the sheet exactly one
    // keyboard-height too low (~335px on an iPhone), i.e. behind the keyboard:
    // the two viewports differ by precisely the occluded region while a
    // keyboard is up, which is the only time this surface is ever open.
    bottom: Math.max(SHEET_EDGE_GUTTER, layoutH - anchor.top + SHEET_ANCHOR_GAP),
    maxWidth,
    // The HEIGHT cap is the opposite: it asks "how much room is actually
    // visible above the anchor?", and the space above the anchor is bounded by
    // the anchor itself, not by either viewport's height. Capping against the
    // VISUAL height keeps a long list from growing up under the notch.
    maxHeight: Math.min(
      visualH * SHEET_MAX_HEIGHT_RATIO,
      anchor.top - SHEET_ANCHOR_GAP - SHEET_EDGE_GUTTER
    )
  }
}

function sheetBoxFor(anchor: DOMRect): SheetBox {
  const vv = window.visualViewport
  return sheetBoxIn(anchor, {
    vw: vv?.width ?? window.innerWidth,
    layoutH: window.innerHeight,
    visualH: vv?.height ?? window.innerHeight
  })
}

/**
 * Which context the bar draws: the live one, else the last one it could draw.
 *
 * A null `appName` has exactly ONE meaning here -- "the Mac could not read the
 * frontmost app this poll" -- never "there is no frontmost app". The adapter
 * answers null whenever an Apple-events read times out, and `App.tsx` refetches
 * the context every time a keyboard opens, so a null routinely lands in the
 * middle of the tap that opens a dropdown.
 *
 * That matters because the bar returns null on `!context?.appName`, and both
 * sheets are its CHILDREN: one unreadable poll unmounts the dropdown the tap
 * was opening, and the tap closes the keyboard instead. On-device the two are
 * indistinguishable -- which is how this shipped three wrong fixes.
 *
 * The freeze is deliberately NOT scoped to "a sheet is open". The trace shows
 * the null arriving BETWEEN the tap and the sheet opening, while `open` is
 * still null, so an open-scoped guard falls through to the live value and
 * unmounts the bar in the one instant it has to survive. Scoping it to "have we
 * ever drawn?" covers that window; a stale chip for one poll beats a bar that
 * vanishes under the finger, and the next readable answer replaces it.
 */
export function barContext(
  live: AppContext | null,
  lastGood: AppContext | null
): AppContext | null {
  return live?.appName ? live : lastGood
}

export default function AppContextBar(props: {
  context: AppContext | null
  onActivateItem: (itemId: string) => void
  onActivateGroup: (groupId: string) => void
  onActivatePane: (paneId: string) => void
  onOpenAppSwitcher: () => void
  /**
   * Told whenever a sheet opens or closes, so the host can stop treating the
   * hidden input's blur as "the user dismissed the keyboard".
   *
   * REQUIRED, not optional. Tapping a dropdown blurs the hidden input, and
   * without this the blur handler tears the keyboard -- and this bar, mid-tap --
   * down. It was optional once and VirtualKeyboard silently omitted it, so the
   * bug appeared on the virtual keyboard only while the accessory strip was
   * fine. A host with genuinely nothing to do still passes `() => {}`.
   */
  onSheetOpenChange: (open: boolean) => void
  /** Marks "a bar control was tapped" SYNCHRONOUSLY, before any blur lands.
   *  Required on both hosts: the blur beats React's commit, so this is the only
   *  thing that can tell the blur handler the keyboard is not being dismissed. */
  onBarTap: () => void
  /** Fires a tmux prefix sequence (ctrl+b, then a key) as one message. Only
   *  reachable while cmux is frontmost — see the tmux cluster below. */
  onTmuxAction: (action: TmuxAction) => void
  /**
   * Drop the leading app chip, leaving the two dropdowns alone.
   *
   * For the deck's floating host, where the chip is a DUPLICATE: the deck's own
   * icon row already carries an app-switcher button a few px below, and the chip
   * does nothing else — tapping it opens that same switcher. On the keyboard
   * hosts it stays, because there it is not a switcher entry point but the answer
   * to "what am I typing into?", and no other control on a keyboard says.
   *
   * Leaves the floating host as purely the CONTEXT switcher: which group, which
   * item. Defaults off so the keyboard hosts keep the chip without opting in.
   */
  hideAppChip?: boolean
}): React.JSX.Element | null {
  const {
    context: liveContext,
    onActivateItem,
    onActivateGroup,
    onActivatePane,
    onOpenAppSwitcher,
    onSheetOpenChange,
    onBarTap,
    onTmuxAction,
    hideAppChip = false
  } = props
  const [open, setOpen] = useState<'items' | 'groups' | 'panes' | null>(null)
  // The last context we could actually draw. A sheet is a child of this bar, so
  // `!context?.appName` below unmounts the open dropdown with it -- and the Mac
  // answers `appContext` with a null context often enough (frontmost app
  // momentarily unreadable while its adapter polls Apple events) that the
  // refetch fired by a keyboard opening can land mid-tap. Freezing the last
  // good context WHILE A SHEET IS OPEN is scoped exactly like the strip's frozen
  // `top`: it cannot strand a stale bar, because closing the sheet returns the
  // bar to the live value on the next render.
  const lastGoodRef = useRef<AppContext | null>(null)
  if (liveContext?.appName) lastGoodRef.current = liveContext
  const context = barContext(liveContext, lastGoodRef.current)
  const itemAnchorRef = useRef<HTMLDivElement>(null)
  const paneAnchorRef = useRef<HTMLDivElement>(null)
  const groupAnchorRef = useRef<HTMLDivElement>(null)
  const [sheetBox, setSheetBox] = useState<SheetBox | null>(null)
  const rowStartRef = useRef<{ x: number; y: number } | null>(null)
  // Which row the finger is on, and which one was last committed. See rowTap.
  const [pressedRow, setPressedRow] = useState<string | null>(null)
  const [pickedRow, setPickedRow] = useState<string | null>(null)

  // Both sheets render in a PORTAL on document.body, so they need explicit
  // viewport coordinates -- measured from whichever anchor is open, on open.
  // Re-measured against `context` too: the anchor's x moves when the tab title
  // changes length or the app chip's name appears/disappears.
  useLayoutEffect(() => {
    if (!open) return setSheetBox(null)
    const anchor = (
      open === 'items' ? itemAnchorRef : open === 'panes' ? paneAnchorRef : groupAnchorRef
    ).current
    if (!anchor) return
    const rect = anchor.getBoundingClientRect()
    const box = sheetBoxFor(rect)
    const vv = window.visualViewport
    // Every input to the placement, from the device. Three fixes in a row were
    // reasoned from which viewport iOS "should" report; this prints what it
    // actually did, so the next one is measured.
    kbTrace('sheet:box', {
      anchorTop: Math.round(rect.top),
      innerH: window.innerHeight,
      vvH: Math.round(vv?.height ?? -1),
      vvTop: Math.round(vv?.offsetTop ?? -1),
      bottom: Math.round(box.bottom),
      maxH: Math.round(box.maxHeight)
    })
    setSheetBox(box)
  }, [open, context])

  // Cleared on unmount too: the bar disappears with the keyboard, and a flag
  // left set would suppress the next real dismissal.
  useLayoutEffect(() => {
    onSheetOpenChange?.(open !== null)
    return () => onSheetOpenChange?.(false)
  }, [open, onSheetOpenChange])

  // The bar going away is the event that made this bug unreadable: its cleanup
  // above emits the SAME `sheet open=false` as a user closing the sheet, so an
  // unmount mid-tap and a normal dismissal were indistinguishable in the trace.
  // Name it explicitly.
  useLayoutEffect(() => () => kbTrace('bar:unmount'), [])

  // No frontmost app at all (nothing readable) is the only nothing-to-say case.
  if (!context?.appName) return null
  const { items, groups, activeGroupId, panes } = context

  const activeItem = items.find((i) => i.active) ?? items[0]
  // The third level exists per TERMINAL, not per adapter: only a terminal running
  // tmux has panes, and half of a live cmux window's panels are plain shells. So
  // the chip keys on the data being there, never on `adapterId` -- the gate the
  // zoom button uses, which is the wrong granularity one level down.
  const paneList = panes ?? []
  const activePane = paneList.find((p) => p.active)
  const group = groups.find((g) => g.id === activeGroupId)
  // Assigned across the WHOLE list, not per row, so the collapsed chip and the
  // row for the same group always agree on a color.
  const hues = monoHues(groups)

  // preventDefault keeps focus in the hidden input; see the header.
  //
  // TRACED because this is the one link never measured: every fix so far
  // assumed the tap reaches here and preventDefault holds focus. If the trace
  // shows `input:blur` with NO `bar:tap` before it, the tap never landed on
  // this element at all (something is over it) -- a completely different bug
  // from preventDefault failing to hold focus, and the two were indistinguish-
  // able on screen.
  const tap = (fn: () => void) => (e: React.PointerEvent) => {
    // FIRST, before anything can yield: the blur this tap causes is delivered
    // ~1ms later and must find the flag already set.
    onBarTap()
    kbTrace('bar:tap', {
      target: (e.target as HTMLElement)?.className || '?',
      cancelable: e.cancelable
    })
    e.preventDefault()
    hapticTick()
    fn()
  }

  /**
   * Open (or close) a sheet, dropping any previous pick highlight.
   *
   * The reset lives HERE, in the event, and must never move back into a
   * `useLayoutEffect` keyed on `open`. Setting state from a layout effect
   * forces a second render pass in the same commit, which re-runs the
   * onSheetOpenChange effect below -- and ITS cleanup fires
   * `onSheetOpenChange(false)`, clearing the host's browserSheetOpenRef at the
   * exact moment the sheet is opening. The hidden input's blur then reads as
   * "the user dismissed the keyboard" and tears the whole bar down, so the tap
   * closed the keyboard instead of opening the dropdown.
   */
  const openSheet = (next: 'items' | 'groups' | 'panes' | null): void => {
    // Pairs with the `sheet open=` line the effect emits. `openSheet items`
    // with no `sheet open=true` after it means React never committed the state
    // -- i.e. the component was unmounting as the tap resolved.
    kbTrace('openSheet', { next: next ?? 'null' })
    setPickedRow(null)
    setOpen(next)
  }

  // Rows need the OPPOSITE of `tap`: they sit on a scrollable list, and firing
  // on pointerdown means a scroll flick activates whatever row the finger
  // started on. So commit on pointerup, and only if the finger stayed put.
  // preventDefault still has to happen on DOWN (that is the event that would
  // blur the hidden input and collapse the keyboard), just without acting.
  //
  // `pressedRow`/`pickedRow` exist because `:active` is not enough feedback on
  // a touch list. It paints unreliably under a finger, and it vanishes the
  // instant the finger lifts -- which is the same instant the sheet closes, so
  // the row you chose and the row you missed looked identical on the way out.
  // The press tint tracks the finger; the pick highlight outlives it and is the
  // receipt for the choice. Same call AppSwitchGrid makes for its tiles.
  const rowTap = (id: string, fn: () => void): React.DOMAttributes<HTMLButtonElement> => ({
    onPointerDown: (e) => {
      e.preventDefault()
      rowStartRef.current = { x: e.clientX, y: e.clientY }
      setPressedRow(id)
    },
    onPointerUp: (e) => {
      const start = rowStartRef.current
      rowStartRef.current = null
      setPressedRow(null)
      if (!start) return
      const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y)
      if (moved > ROW_TAP_SLOP_PX) return
      hapticTick()
      // Highlight first, act second: `fn` closes the sheet, and setting this
      // after would land on an unmounted row.
      setPickedRow(id)
      fn()
    },
    // A scroll stealing the gesture, or a finger sliding off, must clear the
    // tint -- otherwise the row stays lit with nothing selected.
    onPointerCancel: () => {
      rowStartRef.current = null
      setPressedRow(null)
    },
    onPointerLeave: () => setPressedRow(null)
  })

  /** The class pair every row in both sheets carries. */
  const rowClass = (id: string): string =>
    `bbRow${pressedRow === id ? ' pressed' : ''}${pickedRow === id ? ' picked' : ''}`

  // Scrim + sheet both live on document.body, NOT in the bar. Both hosts
  // transform themselves (.virtualKeyboard slides in, .kbAccessory shifts up),
  // and a transformed ancestor makes even `position: fixed` resolve against IT
  // rather than the viewport -- which is why the old in-place sheet could not be
  // positioned, scrolled, or reliably tapped near a screen edge. On the body it
  // has real viewport coordinates and nothing clips it.
  const sheet = (rows: React.ReactNode, label: string): React.JSX.Element =>
    createPortal(
      <>
        <div className="bbScrim" onPointerDown={tap(() => openSheet(null))} />
        <div
          className="bbSheet"
          ref={(el) => {
            // Where it LANDED, not where we asked. A correct `bottom` still
            // paints low if a transformed ancestor captured the fixed element
            // or the anchor was measured mid keyboard animation.
            if (!el || !sheetBox) return
            const r = el.getBoundingClientRect()
            kbTrace('sheet:painted', {
              top: Math.round(r.top),
              bottom: Math.round(r.bottom),
              h: Math.round(r.height),
              askedBottom: Math.round(sheetBox.bottom)
            })
          }}
          style={
            sheetBox
              ? {
                  left: `${sheetBox.left}px`,
                  bottom: `${sheetBox.bottom}px`,
                  maxWidth: `${sheetBox.maxWidth}px`,
                  maxHeight: `${sheetBox.maxHeight}px`
                }
              : // Hidden until measured: a sheet painted at a guessed position
                // flashes in the wrong place for a frame.
                { visibility: 'hidden' }
          }
        >
          {/* The scrolling layer, separate from the plate above so the top fade
              can never touch the plate's background or border. */}
          <div
            className="bbSheetScroll"
            role="listbox"
            aria-label={label}
            // Toggled on the node, not through state: this fires on every scroll
            // frame of a touch drag, and a re-render per frame would fight the
            // momentum scrolling the list depends on.
            onScroll={(e) => {
              const el = e.currentTarget
              el.classList.toggle('moreAbove', el.scrollTop > SHEET_FADE_AT_PX)
            }}
            ref={(el) => {
              if (!el) return
              // Opens on the SELECTED row, centred -- on a list too long for the
              // sheet, the tab you are in is the one row that must not be the
              // hidden one. Found by aria-selected rather than an id passed in,
              // so both sheets get it from the attribute they already set.
              // Falls back to the END: with rows in the adapter's top-to-bottom
              // order the list overflows off its TOP, so the bottom is the edge
              // nearest the button that opened it.
              // Jumped, not scrolled: this runs on the frame the sheet appears,
              // so there is no motion to animate away from.
              const picked = el.querySelector<HTMLElement>('[aria-selected="true"]')
              if (picked) {
                // Measured rect-to-rect, NOT offsetTop: .bbSheetScroll is not a
                // positioned element, so offsetTop would resolve against some
                // ancestor further up and centre the wrong row.
                const top = picked.getBoundingClientRect().top - el.getBoundingClientRect().top
                el.scrollTop += top - (el.clientHeight - picked.offsetHeight) / 2
              } else {
                el.scrollTop = el.scrollHeight
              }
              // Seeded here because onScroll does NOT fire for the lines above --
              // the fade would be off on open, the one moment this list is most
              // likely to have content hidden above it.
              el.classList.toggle('moreAbove', el.scrollTop > SHEET_FADE_AT_PX)
            }}
          >
            {rows}
          </div>
        </div>
      </>,
      document.body
    )

  return (
    <>
      {/* The frontmost app, always -- it answers "what am I typing into?", the
          question the bar could not answer at all when the app had no
          adapter. Tapping it opens the app switcher: showing the current app
          and choosing the next one are the same thought, and the switcher
          already exists, so this is a second entry point to it rather than a
          new surface. Its name hides once an item title competes for the row. */}
      {!hideAppChip && (
        <Button
          variant="bare"
          className="bbApp"
          aria-haspopup="dialog"
          aria-label={`${context.appName} - switch app`}
          onPointerDown={tap(onOpenAppSwitcher)}
        >
          <AppIcon context={context} />
          <span className="bbAppName">{context.appName}</span>
        </Button>
      )}

      {/* The two dropdowns are ONE segmented control, not two floating pills:
          "which group" and "which item" are a single thought, and rendering
          them as separate plates left them reading as unrelated islands beside
          each other. The plate, border and shadow live on this group; each half
          is transparent and carries only a hairline divider between them. The
          app chip and the keyboard-swap button stay outside it -- they are
          different actions, not another segment. */}
      <div className="bbGroup">
        {groups.length > 0 && (
          <div className="bbWrap" ref={groupAnchorRef}>
            {open === 'groups' &&
              sheet(
                // Drawn bottom-up, unlike the items half beside it: these are
                // an ordered first..last run, and the FIRST one belongs at the
                // bottom, nearest the button that opened the sheet.
                [...groups].reverse().map((g, i, drawn) => (
                  <Fragment key={g.id}>
                    {/* The open/idle boundary — one bucket draws no heading. Read
                        off the DRAWN neighbour: bottom-up puts "Not open" first,
                        so source order would label the wrong block. */}
                    {(i === 0 || drawn[i - 1].active !== g.active) &&
                      groups.some((o) => o.active !== g.active) && (
                        <div className="bbGroupHead" role="presentation">
                          {g.active ? 'Open' : 'Not open'}
                        </div>
                      )}
                    <Button
                      variant="bare"
                      className={rowClass(g.id)}
                      role="option"
                      aria-selected={g.id === activeGroupId}
                      {...rowTap(g.id, () => {
                        setOpen(null)
                        onActivateGroup(g.id)
                      })}
                    >
                      <GroupIcon group={g} hue={hues.get(g.id)} />
                      {/* Name and subtitle stack: four Chrome profiles here share
                          the display name "studio.example" and two cmux tabs can
                          be two checkouts of one repo, so the second line is the
                          only thing that tells them apart. */}
                      <span className="bbRowStack">
                        <span className="bbRowLabel">{g.name}</span>
                        {g.subtitle && <span className="bbRowSub">{g.subtitle}</span>}
                      </span>
                      {g.itemCount > 0 && <span className="bbCount">{g.itemCount}</span>}
                      {g.id === activeGroupId && <Check size={13} strokeWidth={2.5} />}
                    </Button>
                  </Fragment>
                )),
                `${context.appName} groups`
              )}
            <Button
              variant="bare"
              className={`bbBtn bbProfile${activeItem ? '' : ' bbProfileSolo'}`}
              aria-haspopup="listbox"
              aria-expanded={open === 'groups'}
              aria-label={`${context.appName}: ${group?.name ?? 'unknown'}`}
              onPointerDown={tap(() => openSheet(open === 'groups' ? null : 'groups'))}
            >
              {group ? (
                <GroupIcon group={group} hue={hues.get(group.id)} />
              ) : (
                <Globe size={14} strokeWidth={2.25} />
              )}
              {/* Alone on the plate (an adapter with no items, e.g. Cursor) an
                  avatar and a caret name nothing, so it borrows the tab half's
                  title. Beside a titled tab half the icon alone is enough. */}
              {!activeItem && group && <span className="bbTabTitle">{group.name}</span>}
              <ChevronDown size={12} strokeWidth={2.5} />
            </Button>
          </div>
        )}

        {activeItem && (
          <div className="bbWrap bbWrapTab" ref={itemAnchorRef}>
            {open === 'items' &&
              sheet(
                items.map((it) => (
                  <Button
                    variant="bare"
                    key={it.id}
                    className={rowClass(it.id)}
                    role="option"
                    aria-selected={it.active}
                    {...rowTap(it.id, () => {
                      setOpen(null)
                      // The adapter's own id, echoed back untouched -- never our
                      // render position, which can be a frame stale.
                      onActivateItem(it.id)
                    })}
                  >
                    <ItemIcon item={it} />
                    <span className="bbRowLabel">{it.title || it.subtitle}</span>
                    {it.active && <Check size={13} strokeWidth={2.5} />}
                  </Button>
                )),
                `Open in ${context.appName}`
              )}
            <Button
              variant="bare"
              className="bbBtn bbTab"
              aria-haspopup="listbox"
              aria-expanded={open === 'items'}
              aria-label={`Current: ${activeItem.title || activeItem.subtitle}`}
              onPointerDown={tap(() => openSheet(open === 'items' ? null : 'items'))}
            >
              <ItemIcon item={activeItem} />
              <span className="bbTabTitle">{activeItem.title || activeItem.subtitle}</span>
              {items.length > 1 && <span className="bbCount">{items.length}</span>}
              <ChevronDown size={12} strokeWidth={2.5} />
            </Button>
          </div>
        )}
      </div>

      {/* The panes inside the focused terminal -- the level the user actually
          navigates, since he runs six agents as panes in ONE terminal. Without
          it the bar drilled to `Terminal 3` while the screen showed six named
          agents, and picking one from the phone was impossible.

          FLOATS ABOVE the row rather than sitting in it as a third segment.
          Three unbounded strings on one plate (profile, tab, pane) left every
          one of them ellipsised to a few characters on a phone -- `imag...` for
          a pane named after the agent running in it. Stacked, the pane gets a
          full row of its own and the two below keep the width they had before
          the level existed. Absolutely positioned off the BAR -- not off the
          group plate, whose right edge stops short of the tmux zoom button
          beside it -- so the two rows share one outer edge and the level costs
          the row below ZERO horizontal space. */}
      {activePane && (
        <div className="bbPaneFloat" ref={paneAnchorRef}>
          {open === 'panes' &&
            sheet(
              paneList.map((p) => (
                <Button
                  variant="bare"
                  key={p.id}
                  className={rowClass(p.id)}
                  role="option"
                  aria-selected={p.active}
                  {...rowTap(p.id, () => {
                    setOpen(null)
                    // tmux's own id, echoed back untouched. Never the render
                    // position: killing a sibling shifts a pane's index while
                    // its id holds.
                    onActivatePane(p.id)
                  })}
                >
                  <span className="bbRowLabel">{p.title}</span>
                  {/* Which agent is FULLSCREENED, not just which is focused --
                        two different questions once six panes share a window. */}
                  {p.zoomed && <Maximize2 size={12} strokeWidth={2.5} />}
                  {p.active && <Check size={13} strokeWidth={2.5} />}
                </Button>
              )),
              'Panes in this terminal'
            )}
          <Button
            variant="bare"
            className="bbBtn bbPane"
            aria-haspopup="listbox"
            aria-expanded={open === 'panes'}
            aria-label={`Pane: ${activePane.title}`}
            onPointerDown={tap(() => openSheet(open === 'panes' ? null : 'panes'))}
          >
            <span className="bbTabTitle">{activePane.title}</span>
            {paneList.length > 1 && <span className="bbCount">{paneList.length}</span>}
            <ChevronDown size={12} strokeWidth={2.5} />
          </Button>
        </div>
      )}

      {/* tmux controls, cmux only.

          Gated on the ADAPTER, and now LIT by the real thing: cmux's session
          file records the tmux session a panel attached to, so the Mac reads
          `window_zoomed_flag` and sends the answer down. `null` is a third
          state, not a falsy second one -- a plain shell has no zoom to be in,
          and a button claiming "not zoomed" about it would be lying.

          Zoom only. The pane-move d-pad was built and pulled before it shipped:
          four 26px targets beside two dropdowns crowded a row a keyboard is
          already competing for. The actions still exist in TMUX_ACTION and the
          handler still fires them, so restoring the pad is a UI change alone.

          NOT gated on hideTmux, unlike the pane moves that flag was written for.
          Zoom is the one tmux action that is not typing: it toggles which pane
          fills the window, so its whole point is to change what you are LOOKING
          at -- the same job as the two dropdowns beside it, and useful from the
          deck with no keyboard up.
          The adapter gate is what keeps it off Chrome and
          Cursor; a non-cmux app never renders it on any host. */}
      {context.adapterId === APP_ADAPTER.cmux && (
        <Button
          variant="bare"
          className={`bbBtn bbTmuxZoom${context.tmuxZoomed ? ' isOn' : ''}`}
          aria-label={context.tmuxZoomed ? 'tmux: unzoom pane' : 'tmux: zoom pane'}
          // Only claimed when we actually read the flag; an unknowable pane gets
          // no pressed state rather than a confident "false".
          aria-pressed={context.tmuxZoomed ?? undefined}
          onPointerDown={tap(() => onTmuxAction('zoom'))}
        >
          {context.tmuxZoomed ? (
            <Minimize2 size={14} strokeWidth={2.25} />
          ) : (
            <Maximize2 size={14} strokeWidth={2.25} />
          )}
        </Button>
      )}
    </>
  )
}

/** An app with no rendered icon (the native binary failed, or it is not in the
 *  switcher list) still gets a chip — the name is the useful half. */
function AppIcon(props: { context: AppContext }): React.JSX.Element {
  const { appIconPngBase64 } = props.context
  if (!appIconPngBase64) return <Globe size={14} strokeWidth={2.25} className="bbFallback" />
  return <img className="bbIcon" src={`data:image/png;base64,${appIconPngBase64}`} alt="" />
}

/** A missing item icon is NORMAL, not a failure: Chrome caches only favicons it
 *  has actually fetched, and cmux ships no per-terminal icon at all. */
function ItemIcon(props: { item: AppContextItem }): React.JSX.Element {
  const { iconPngBase64 } = props.item
  if (!iconPngBase64) return <Globe size={14} strokeWidth={2.25} className="bbFallback" />
  return <img className="bbIcon" src={`data:image/png;base64,${iconPngBase64}`} alt="" />
}

/** Groups without a picture (a Chrome profile with no Google account stores its
 *  avatar as a `chrome://theme/` resource; a cmux tab has none) get a monogram. */
function GroupIcon(props: { group: AppContextGroup; hue?: number }): React.JSX.Element {
  const { iconPngBase64, name } = props.group
  if (!iconPngBase64)
    return (
      <span className="bbMono" style={{ '--bb-mono-h': props.hue } as React.CSSProperties}>
        {(name[0] ?? '?').toUpperCase()}
      </span>
    )
  return <img className="bbAvatar" src={`data:image/png;base64,${iconPngBase64}`} alt="" />
}

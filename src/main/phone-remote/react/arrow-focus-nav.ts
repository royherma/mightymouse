/**
 * Moves focus with the arrow keys, for hosts where focus IS the cursor.
 *
 * The browser does NOT do this -- Chrome moves focus on Tab; arrows scroll, or
 * move within one radio group. Every Neural Band swipe arrives as an arrow, so
 * with nothing listening the ring never moved at all.
 *
 * FLAT, not spatial, and not DOM order. Spatial scoring leaves two of the four
 * arrows dead over a 2D deck and has no predictable answer for "up" from a
 * corner; DOM order is a paint-order accident a skin can reshuffle. So the deck
 * is ONE ring: group first (GROUP_ORDER), then reading order within a group,
 * wrapping at both ends -- every control reachable by swiping one direction.
 *
 * Deliberately NOT Meta's sample, which wants a `.focusable` class plus a
 * registry: that is a second source of truth over the same nodes, so a control
 * missing the class silently vanishes from the remote. Here the DOM is the
 * registry.
 */

import { isCursorless } from './cursorless-host'
import { noteKeySeen } from './last-key-seen'
import { describeNode, noteNav } from './nav-trace'

/** `a[href]`, NOT bare `[href]` -- an SVG <image href="data:…"> matches the
 *  loose form and every app icon became a focus stop. Otherwise deliberately
 *  the same set `useSheetFocus` lands on. */
const FOCUSABLE =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export type Direction = 'up' | 'down' | 'left' | 'right'

/** Input types whose own arrow/Enter handling must win over ours. A refuse-list,
 *  not an allow-list, so a new type defaults to drivable -- declining the whole
 *  INPUT tag is what left the Settings toggle with no gesture at all. */
const TEXT_ENTRY_TYPES = new Set([
  'text',
  'email',
  'password',
  'search',
  'tel',
  'url',
  'number',
  'date',
  'datetime-local',
  'month',
  'time',
  'week'
])

/** True when the caret owns this element's keys. A bare `<input>` is `text`,
 *  hence `?? 'text'` -- a falsy check would make it drivable and eat a
 *  half-typed pairing code. */
export function isTextEntry(el: { tagName: string; type?: string | null }): boolean {
  const tag = el.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag !== 'INPUT') return false
  return TEXT_ENTRY_TYPES.has((el.type ?? 'text').toLowerCase())
}

/** Which band of the deck a control belongs to, best first. Declared via
 *  `data-nav-group` and outranks geometry -- pure distance put the first swipe
 *  on the Share watermark. */
const GROUP_ORDER = ['primary', 'main', 'keys', 'chrome'] as const
export type NavGroup = (typeof GROUP_ORDER)[number]

const DEFAULT_GROUP: NavGroup = 'main'

/** Never focusable: arrows cannot operate the app ring (a continuous drag
 *  angle) or the skin corners (invisible pointerdown targets).
 *
 *  `.keyboardInput` is the third: it is visually hidden but keeps real layout
 *  (the only way iOS Safari will raise its keyboard for it), so it passes the
 *  isVisible test and sat in the ring as an INVISIBLE stop -- focus really was
 *  on it, with nothing on screen to show for it. On the glasses that reads as
 *  the highlight vanishing on the swipe after the mic. Worse than cosmetic:
 *  focusing it IS summoning the native keyboard, so a swipe past the mic would
 *  raise the board. Trace `proMicBtn -> input.keyboardInput`, 2026-08-10. */
const NAV_EXCLUDED = '[data-nav-skip], .proAppRing, .skinCorner, .keyboardInput'

/** Headers that expand a body INLINE, the only kind Left/Right may drive --
 *  see the ariaExpanded note in installArrowFocusNav. */
const DISCLOSURE = '.settingsSectionToggle, .gestureLegendToggle'

export function groupRank(group: string | null | undefined): number {
  const i = GROUP_ORDER.indexOf((group ?? DEFAULT_GROUP) as NavGroup)
  return i === -1 ? GROUP_ORDER.indexOf(DEFAULT_GROUP) : i
}

/** Arrows may only claim what the pinch CANNOT drive -- a control holding a
 *  value -- because the HUD legend is a contract we don't own: arrows Navigate,
 *  return Selects. 'step' is the default, so no swipe is ever dead. */
export type ArrowAction = 'step' | 'expand' | 'collapse'

/** The focused control reduced to what the choice needs -- DOM-free, because
 *  this repo's vitest has no DOM. Matches `FocusedTarget`'s shape next door. */
export interface AdjustTarget {
  tagName: string
  type?: string | null
  disabled?: boolean
  /** The `aria-expanded` attribute verbatim, or null when absent. A disclosure
   *  header is the one control where stepping past it and opening it are
   *  different intents, so Left/Right drive it -- the user's call from the band. */
  ariaExpanded?: string | null
}

export function resolveArrowAction(el: AdjustTarget, dir: Direction): ArrowAction {
  if (dir === 'up' || dir === 'down') return 'step'
  if (el.disabled) return 'step'
  if (el.ariaExpanded === 'true') return dir === 'right' ? 'step' : 'collapse'
  if (el.ariaExpanded === 'false') return dir === 'right' ? 'expand' : 'step'
  // A switch is Select's alone. Arrows once drove these (Right = on, Left =
  // off) and that can lock you out: Left on Screen sharing kills the mirror you
  // are navigating BY, and the swipe that undoes it needs the screen that just
  // went dark. A section header is safe to drive because collapsing one hides
  // nothing you need to get back -- a toggle isn't. The user on the band, 2026-08-10.
  return 'step'
}

const DIRECTIONS: Record<string, Direction> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right'
}

/** A candidate reduced to what the choice needs, so the rule below is testable
 *  without a DOM -- this repo's vitest has none. Coordinates are viewport px,
 *  i.e. getBoundingClientRect(). */
export interface NavRect {
  x: number
  y: number
  width: number
  height: number
}

export interface Candidate<T> {
  rect: NavRect
  node: T
  /** Omitted means 'main' -- see GROUP_ORDER. */
  group?: string
  /** From `data-nav-order`; overrides geometry, lower first. Anything without
   *  one sorts after everything that has one. */
  order?: number
}

function center(r: NavRect): { cx: number; cy: number } {
  return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 }
}

/** 28px: the deck mixes a 56px mic disc with 120px key plates, so one visual
 *  row has centres several px apart -- tighter splits the row and the ring
 *  zigzags. Still far below the ~60px gap between real rows. */
const ROW_TOLERANCE_PX = 28

/** Every control on screen, in the ONE order a swipe walks them: group, then
 *  declared order, then geometry. Exported for the tests and the debug readout. */
export function navOrder<T>(candidates: Candidate<T>[]): Candidate<T>[] {
  return [...candidates].sort((a, b) => {
    const rank = groupRank(a.group) - groupRank(b.group)
    if (rank !== 0) return rank
    if (a.order !== undefined || b.order !== undefined) {
      if (a.order === undefined) return 1
      if (b.order === undefined) return -1
      if (a.order !== b.order) return a.order - b.order
    }
    const ca = center(a.rect)
    const cb = center(b.rect)
    if (Math.abs(ca.cy - cb.cy) > ROW_TOLERANCE_PX) return ca.cy - cb.cy
    return ca.cx - cb.cx
  })
}

/** The next node in the ring, or null if there is nothing to move to. Wraps at
 *  both ends, so every control is reachable by swiping one direction -- the only
 *  recovery a band with no back button has. `from` null starts at the head. */
export function pickNextFocus<T>(
  from: NavRect | null,
  candidates: Candidate<T>[],
  dir: Direction,
  fromGroup?: string,
  fromOrder?: number,
  inSheet = false
): T | null {
  if (candidates.length === 0) return null
  if (!from) return navOrder(candidates)[0].node

  // SORTED IN rather than located by coordinate: group outranks position, so a
  // control physically below the key grid still sits before it. Comparing
  // centres directly missed that and wrapped Settings straight past the grid.
  const SELF = Symbol('from')
  const ring = navOrder([
    ...candidates,
    { rect: from, node: SELF as unknown as T, group: fromGroup, order: fromOrder }
  ])
  const index = ring.findIndex((c) => (c.node as unknown) === SELF)

  // Up and Right go FORWARD, Left and Down back -- from driving it on the band,
  // not reading order. An earlier version paired Down with Right and it fought
  // the hand.
  //
  // EXCEPT inside a sheet, where Up/Down invert to WYSIWYG: the deck is a
  // spatial ring of buttons around a trackpad, but a sheet is a vertical list,
  // and on a list "up" has to mean up the screen. The user on the band, both times.
  // Left/Right are unaffected -- they carry no spatial meaning either way.
  const vertical = dir === 'up' || dir === 'down'
  const forward = vertical && inSheet ? dir === 'down' : dir === 'up' || dir === 'right'
  const step = forward ? 1 : -1
  const raw = index + step

  // A sheet does NOT wrap backwards off the head -- it exits. Wrapping is the
  // deck's no-dead-ends rule, and it's wrong here: a modal has a way out, so
  // swiping BACK past the first control should leave rather than teleport you
  // to the last one. Returning null means "no move"; the handler closes.
  // Forward still wraps, so a lap round the list is unbroken.
  if (inSheet && raw < 0) return null

  const next = ((raw % ring.length) + ring.length) % ring.length
  return ring[next].node
}

/** On screen and hit-testable -- an element can be `display:none`, zero-sized or
 *  scrolled out and still match the selector, and focusing one parks the ring
 *  somewhere invisible. */
function isVisible(el: HTMLElement, r: DOMRect): boolean {
  if (r.width <= 0 || r.height <= 0) return false
  if (r.bottom < 0 || r.right < 0) return false
  if (r.top > window.innerHeight || r.left > window.innerWidth) return false
  // NOT `opacityProperty: true`. Every switch in Settings is an `opacity: 0`
  // input stretched over a sibling that paints it (.mirrorToggle input), so
  // that check called each one hidden and Down walked straight from one section
  // header to the next, skipping the rows -- on device, "the toggles don't
  // exist". The input IS the control; something visible is drawn at its rect.
  return el.checkVisibility ? el.checkVisibility({ visibilityProperty: true }) : true
}

/** Scope traversal to the topmost open sheet -- without this a swipe inside
 *  Settings walks out onto the deck behind it, which is the bug useSheetFocus
 *  fixes, reintroduced from the other end. */
function scopeRoot(active: Element | null): ParentNode {
  const sheet = active?.closest('[data-sheet], dialog[open]')
  return sheet ?? document
}

function collect(root: ParentNode): Candidate<HTMLElement>[] {
  const out: Candidate<HTMLElement>[] = []
  for (const el of root.querySelectorAll<HTMLElement>(FOCUSABLE)) {
    if (el.closest(NAV_EXCLUDED)) continue
    const r = el.getBoundingClientRect()
    if (!isVisible(el, r)) continue
    const order = el.dataset.navOrder
    out.push({
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      node: el,
      // Group inherits (stamped once on the row that owns it); order does NOT,
      // or every button in a row would share one rank.
      group: el.closest<HTMLElement>('[data-nav-group]')?.dataset.navGroup,
      order: order === undefined ? undefined : Number(order)
    })
  }
  return out
}

/** Installs arrow traversal. Returns a disposer. UNGATED on purpose -- gating on
 *  the import-time `isPointerlessHost` const latched false in Meta's simulator
 *  and killed arrows on the one host they exist for. */
export function installArrowFocusNav(target: Document = document): () => void {
  function onKeyDown(e: KeyboardEvent): void {
    const dir = DIRECTIONS[e.key]
    // The fullscreen mirror owns all four arrows -- they drive the picture
    // there (fullscreen-mirror.ts). Declared and greppable rather than a
    // capture-phase interception from the other file, for the same reason
    // NAV_EXCLUDED is: a handler standing down should say so where you'd look.
    //
    // Without this the arrows still act: the deck is hidden, so `collect()`
    // returns an empty roster and the !activeIsInRing branch grabs the first
    // focusable node it can find behind the picture -- focus lands somewhere
    // invisible and the swipe reads as the picture freezing.
    if (dir && target.querySelector('[data-mirror-full="on"]')) {
      return noteKeySeen(e.key, 'mirror-full')
    }
    // Recorded, not silently dropped: on a band the only way to tell "the host
    // consumed that gesture" from "it reached us and we ignored it" is whether
    // the key shows up here at all.
    if (!dir) return noteKeySeen(e.key, 'unrouted')
    // The guard is for a REAL keyboard, where Cmd-Left is "go back" and stealing
    // it would be wrong. A cursorless host has no such keyboard -- the glasses'
    // touchpad (and the band, same arrow vocabulary) is the only input -- and it
    // sets modifier flags on its swipes, so here the guard rejects every gesture
    // the ring exists to handle. Observed on the glasses' touchpad as
    // `key:ArrowLeft/modifier` with zero [nav] lines: the key arrives, and
    // traversal never runs.
    //
    // Which flag is named, not just that one was set: "the band sets alt" and
    // "a stray Ctrl is latched from a paired keyboard" want opposite fixes.
    if (e.altKey || e.ctrlKey || e.metaKey) {
      const mods = [e.altKey && 'alt', e.ctrlKey && 'ctrl', e.metaKey && 'meta']
        .filter(Boolean)
        .join('+')
      if (document.documentElement.dataset.cursorless !== 'on') {
        return noteKeySeen(e.key, `modifier:${mods}`)
      }
      noteKeySeen(e.key, `modifier-ignored:${mods}`)
    }

    const active = target.activeElement as HTMLElement | null
    // A text field owns its arrows -- stepping out of a half-typed message is
    // worse than no traversal at all.
    if (active && isTextEntry(active as HTMLInputElement)) {
      return noteKeySeen(e.key, `declined:${active.tagName.toLowerCase()}`)
    }

    // A range moves its own thumb and commits on keyup; ours is only to stop
    // stepping focus off it mid-adjust. A hand-rolled increment would re-read
    // min/max/step and drift from what the input actually does.
    if (active?.tagName === 'INPUT' && (active as HTMLInputElement).type === 'range') {
      return noteKeySeen(e.key, 'native:range')
    }

    // Left/Right may act on the focused control, but ONLY when it holds a value
    // the pinch cannot reach. Gated on the live cursorless check because a
    // finger user never generates arrows, so on a phone this must stay inert.
    if (active && isCursorless()) {
      const action = resolveArrowAction(
        {
          tagName: active.tagName,
          type: (active as HTMLInputElement).type,
          disabled: active.hasAttribute('disabled'),
          // Only a header whose body renders INLINE beneath it. The bar's app
          // dropdowns and the camera shape menu also carry aria-expanded, but
          // they open a floating menu -- Left there would close it instead of
          // stepping back, which is not what Left means anywhere else.
          ariaExpanded: active.matches(DISCLOSURE)
            ? active.getAttribute('aria-expanded')
            : null
        },
        dir
      )
      // Click, not a state write: the header's open/closed set lives in
      // SettingsBody, so onClick is the only way in. Focus survives it -- the
      // node stays mounted, only its body appears -- so the next swipe walks
      // into the section it just opened.
      if (action === 'expand' || action === 'collapse') {
        e.preventDefault()
        active.click()
        return noteKeySeen(e.key, `${action}:section`)
      }
    }

    const root = scopeRoot(active)
    const all = collect(root)
    const candidates = all.filter((c) => c.node !== active)
    const roster = (): string[] => navOrder(all).map((c) => describeNode(c.node))
    // Membership is tested against the UNFILTERED collection -- `candidates`
    // excludes the focused node by construction, so asking it whether `active`
    // belongs to the ring always answers no.
    const activeIsInRing = !!active && all.some((c) => c.node === active)

    // Focus is not on anything the ring owns: claim its START rather than
    // stepping from wherever the browser happened to park. Gating this on
    // `=== body` alone was the bug -- a wrapper <div> can hold focus (a
    // scroll container, or any node the browser falls back to), and such a
    // div is not IN `candidates`, so the step path measured geometry from a
    // node the ring does not contain and landed on whatever sat beside it.
    // On the glasses that read as "it starts on the app switcher, not the
    // mic": trace `div -> button.proIconBtn[App switcher]`, 2026-08-10.
    if (!activeIsInRing) {
      const first = navOrder(candidates)[0]
      if (!first) {
        noteNav(e.key, describeNode(active), 'NOTHING FOUND', candidates.length, roster())
        return noteKeySeen(e.key, `empty:${dir}`)
      }
      e.preventDefault()
      first.node.focus()
      noteNav(e.key, describeNode(active), describeNode(first.node), candidates.length, roster())
      return noteKeySeen(e.key, `entered:${first.node.tagName.toLowerCase()}`)
    }

    const fromRect = active.getBoundingClientRect()
    const activeOrder = active?.dataset.navOrder
    const next = pickNextFocus(
      fromRect,
      candidates,
      dir,
      active?.closest<HTMLElement>('[data-nav-group]')?.dataset.navGroup,
      activeOrder === undefined ? undefined : Number(activeOrder),
      root instanceof Element
    )
    if (!next) {
      // Swiping BACK off the head of a sheet leaves it. Synthesized as Escape
      // rather than closing anything directly: the sheets already listen for it
      // (SettingsBody collapses its sections first, then closes), so re-deriving
      // "what does exiting mean here" would be a second, drifting answer.
      if (root instanceof Element) {
        e.preventDefault()
        noteNav(e.key, describeNode(active), 'EXIT SHEET', candidates.length, roster())
        target.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
        )
        return noteKeySeen(e.key, `exit:${dir}`)
      }
      // Only reachable with nothing focusable on screen at all.
      noteNav(e.key, describeNode(active), 'NOTHING FOUND', candidates.length, roster())
      return noteKeySeen(e.key, `empty:${dir}`)
    }

    e.preventDefault()
    next.focus()
    noteNav(e.key, describeNode(active), describeNode(next), candidates.length, roster())
    noteKeySeen(e.key, `moved:${next.tagName.toLowerCase()}`)
  }

  target.addEventListener('keydown', onKeyDown)
  return () => target.removeEventListener('keydown', onKeyDown)
}

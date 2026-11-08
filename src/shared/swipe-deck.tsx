/**
 * The swipe deck: one live agent per card, decided with a gesture.
 *
 * Render-only by construction -- every card, action and outcome comes in as a
 * prop and every decision leaves as one `onAffirm`. That is what lets the Mac
 * window mount the same deck against IPC instead of a socket, and what lets the
 * static harness drive it from fixtures with no server at all.
 *
 * The swipe IS the confirm: there is no send button, so a card cannot be
 * answered by a stray tap on a chip. Picking an action arms the card; the right
 * swipe fires it. Left swipe sends the card to the back and sends NOTHING.
 *
 * Two platform bits arrive as props rather than imports -- haptics (iOS only)
 * and the arming store (localStorage on the phone, a renderer store on the Mac).
 * Both have safe defaults, so the harness mounts this with neither. Hosts pass
 * their own class names, following `relay-interview-nav.tsx`: the phone is
 * camelCase and the Mac is hyphenated, so any single convention would be wrong
 * for one of them.
 *
 * NEVER import a stylesheet here -- the phone bundle is deliberately
 * Tailwind-free and the renderer is not (see phone-remote/CLAUDE.md).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Clock,
  ExternalLink,
  Maximize2,
  Minimize2,
  MonitorSmartphone,
  Palette,
  SendHorizontal
} from 'lucide-react'
import { CONFIG } from './config'
import { AgentFace } from './agent-face-view'
import { sessionFaceId } from './agent-face'
import { actionsFor, affirmFor, skip, jumpTo, pendingOptions } from './swipe-triage'
import type { SwipeAction, SwipeAffirm, SwipeCard } from './swipe-triage'
import { armingKey, armedAction, rememberedValue } from './swipe-arming'
import { cardSuggestKey, suggestContext, worthSuggesting } from './swipe-suggest'
import type { Suggestion } from './swipe-suggest'
import type { RelayStatusLine } from './relay-status'
import { Button } from './ui/Button'

/** How far a card must travel before the release counts as a decision rather
 *  than a stray drag. A fraction of the card, not a pixel count: the same
 *  gesture has to mean the same thing on a mini and a Pro Max. */
const COMMIT_FRACTION = 0.28

/** Cap on how far the card follows the thumb. Past this the drag is already a
 *  decision and more travel only lets it leave the screen mid-gesture. */
const MAX_DRAG_PX = 160

/** Vertical cap. Tighter than the horizontal one because nothing commits on this
 *  axis -- it is give, not travel toward a decision, and a card that can be
 *  hauled half a screen up reads as a drawer that should stay where you drop it. */
const MAX_DRAG_Y_PX = 72

/** Rotation at full commit distance. Small on purpose -- the tilt is a hint
 *  that the card is leaving, not a card game. */
const MAX_TILT_DEG = 7

/** How far a thumb may slide and still count as a tap rather than a small
 *  swipe. A finger on glass never lands perfectly still. */
const TAP_SLOP_PX = 8

/** Travel at which the drag is committed enough to a DIRECTION to name it, which
 *  is what reveals that side's stamp. Just past the tap slop: the moment the
 *  gesture stops being a possible tap it has a side, so the word arrives while
 *  there is still room to change your mind rather than as a result announcement. */
const INTENT_PX = 10

/** Cards the stack draws: the live one plus two behind it. Prefetch reads this
 *  too -- they were separate numbers, and the deepest card spent its whole life
 *  rendered but never asked for, so it could never show a loading skeleton. */
const CARDS_SHOWN = 3

type Direction = 'skip' | 'affirm'

/** Every class the deck paints, supplied by the host. */
export interface SwipeDeckClasses {
  scrim: string
  root: string
  rootOpen: string
  header: string
  title: string
  headerBtn: string
  /** Right-edge group holding the header's icon buttons. */
  headerBtns: string
  /** The back caret, left of the title. */
  headerBack: string
  count: string
  /** Zero-height flow slot the open jump list positions against. */
  jumpAnchor: string
  jump: string
  jumpRow: string
  jumpWho: string
  jumpName: string
  jumpWhat: string
  jumpDot: string
  empty: string
  emptyTitle: string
  emptyBody: string
  passed: string
  again: string
  stage: string
  stamp: string
  card: string
  cardBehind: string
  cardRising: string
  cardLeaving: string
  head: string
  who: string
  name: string
  place: string
  age: string
  goTo: string
  subject: string
  subjectMuted: string
  subjectTag: string
  facts: string
  last: string
  ask: string
  askLabel: string
  askText: string
  failed: string
  more: string
  note: string
  actions: string
  actionsNudge: string
  chip: string
  chipEmoji: string
  chipSkeleton: string
  composer: string
  input: string
  rail: string
  railBtn: string
  /** The "who can reach you" strip under the header. */
  status: string
  statusDot: string
  statusText: string
}

/** The vibration motor. Absent on the Mac, where every call is a no-op. */
export interface DeckHaptics {
  tick(): void
  dragEngage(): void
  dragRelease(): void
  keyPress(): void
}

/** Which action this person armed last time, per card shape. Absent in the
 *  harness, where an in-memory map is exactly the wanted behavior. */
export interface DeckArming {
  recall(key: string | undefined): string | undefined
  remember(key: string | undefined, value: string | undefined): void
}

const NO_HAPTICS: DeckHaptics = {
  tick: () => {},
  dragEngage: () => {},
  dragRelease: () => {},
  keyPress: () => {}
}

/** Module-level so it survives a remount -- an arming store that forgot on every
 *  render would re-arm the first action mid-triage. */
const memoryArming = new Map<string, string>()
const MEMORY_ARMING: DeckArming = {
  recall: (key) => (key ? memoryArming.get(key) : undefined),
  remember: (key, value) => {
    if (key && value) memoryArming.set(key, value)
  }
}

export default function SwipeDeck(props: {
  open: boolean
  deck: SwipeCard[]
  classes: SwipeDeckClasses
  onClose: () => void
  /** The back caret. Absent on a surface with nowhere to go back to, which is
   *  why the caret renders only when this is supplied. */
  onBack?: () => void
  /** The screen button, top right: shows the Mac and toggles what a one-finger
   *  drag on it does. Absent on a surface with no mirror (the Mac's own deck). */
  /** Phone only -- the Mac window has the control cluster on screen already,
   *  so it passes nothing and the button does not render. */
  island?: {
    on: boolean
    onToggle: () => void
    /** Rendered inside the deck, over the cards -- the host builds it, because
     *  every control it holds is a host local. */
    node?: React.ReactNode
  }
  screen?: {
    on: boolean
    onToggle: () => void
    /** Rendered under the header when the mirror is up. */
    pane?: React.ReactNode
    /** Fill the Mac's window with the TOP card's agent. Keyed by label, so a
     *  swipe to the next card reads that agent's state, not the last one's. */
    zoomed?: Readonly<Record<string, boolean>>
    onZoom?: (label: string, on: boolean) => void
  }
  /** Who can reach you, in the same sentence the Mac panel and the phone's Code
   *  tab show -- the deck REPLACES the whole screen on both surfaces, so without
   *  it the one line saying whether anything is connected is the one thing you
   *  lose by opening it. Formatted by the host (`relayStatusLine`), never here. */
  statusLine?: RelayStatusLine
  archiveSessions?: boolean
  onAffirm: (affirm: SwipeAffirm, card: SwipeCard) => void
  /** Opens the full sheet on this session -- the tap-through a multi-question
   *  ask gets instead of options it cannot finish here. */
  onOpenSession?: (label: string, card: SwipeCard) => void
  /** Puts the agent's own window on the Mac's screen -- the session sheet's
   *  "Open on Mac", on the card, so it costs no tap-through. */
  onGoTo?: (label: string, card: SwipeCard) => void
  /** Labels whose last `onGoTo` came back with nothing to open. */
  goToFailed?: ReadonlySet<string>
  /** Labels whose last affirm failed to land. The card comes BACK on a failure
   *  rather than staying gone: a silently dropped answer is worse than a
   *  re-swipe. */
  failed?: ReadonlySet<string>
  /** Model-written chips for an idle card, keyed by `cardSuggestKey`. Absent or
   *  empty is the normal case, not a failure: the card shows the canned three. */
  suggestions?: Record<string, Suggestion[]>
  /** Asks the host for chips for one card. Optional: the static harness mounts
   *  this deck with no server behind it. */
  onRequestSuggestions?: (label: string, context: string) => void
  haptics?: DeckHaptics
  arming?: DeckArming
}): React.JSX.Element {
  const { open, deck, classes, onClose, onBack, onAffirm, onOpenSession, onGoTo } = props
  const statusLine = props.statusLine
  const screen = props.screen
  const island = props.island
  const haptics = props.haptics ?? NO_HAPTICS
  const arming = props.arming ?? MEMORY_ARMING

  // Order lives here, not in the parent: a skip is a local rearrangement and
  // pushing it up would re-render every card on every swipe.
  const [order, setOrder] = useState<SwipeCard[]>(deck)
  const [chosen, setChosen] = useState<string | null>(null)
  const [typing, setTyping] = useState(false)
  const [draft, setDraft] = useState('')
  const [dragX, setDragX] = useState(0)
  // Vertical travel is FEEL ONLY -- the card follows the thumb in both axes so a
  // diagonal drag doesn't slide along an invisible rail, but only `dragX` ever
  // decides anything. A committed Y would need a third stamp and a third rule.
  const [dragY, setDragY] = useState(0)
  // Measured once per gesture at pointerdown, so the render path never touches
  // layout. 320 is a floor, not a guess -- it only ever applies before the first
  // touch, when nothing is being dragged and the value is unused.
  const [leaving, setLeaving] = useState<Direction | null>(null)
  // WHICH card is mid-rise, cleared on `animationend`. The rise used to be
  // applied on `!dragging && !leaving` -- which is the RESTING condition, so the
  // class never came off and `overflow: hidden` stayed on the card forever,
  // clipping any content taller than the height it was promoted at. Tracked by
  // label so the flag belongs to one card and cannot outlive it.
  const [rising, setRising] = useState<string | null>(() => deck[0]?.label ?? null)
  const [nudge, setNudge] = useState(false)
  const [jumpOpen, setJumpOpen] = useState(false)
  // Passed-over labels, in the order they were passed. Held here rather than at
  // the back of `order` so the run actually ENDS: the deck drains, and these are
  // what the end screen offers to go back through.
  const [skipped, setSkipped] = useState<string[]>([])

  const cardRef = useRef<HTMLDivElement | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const railRef = useRef<HTMLDivElement | null>(null)
  const widthRef = useRef(320)
  const intentRef = useRef<Direction | null>(null)
  const dragLive = useRef({ x: 0, y: 0, tilt: 0, commit: 0 })
  // The top card's height, republished to the stage so the cards BEHIND can be
  // pinned to it. Cards size to their own content, so a behind card with more to
  // say stood taller than the card covering it and its rows painted outside the
  // plate on both edges -- a ragged stack rather than a deck. Pinned here and
  // released on promotion, so the size change becomes the rise animation instead
  // of a pop.
  const [cardH, setCardH] = useState<number | null>(null)
  const cardObserver = useRef<ResizeObserver | null>(null)
  // The height the OUTGOING card was pinned at, held across the swap. The
  // observer below republishes `--deck-card-h` the instant the new top card
  // mounts, so a keyframe reading that var would start from the new height and
  // grow by nothing. The rise reads this frozen value instead.
  const risenFrom = useRef<number | null>(null)
  const measureCard = useCallback((node: HTMLDivElement | null) => {
    cardRef.current = node
    if (!node) return
    // Captured BEFORE the new measurement lands: this is the height the card
    // being promoted was standing at one frame ago, which is where its rise has
    // to start from.
    setCardH((prev) => {
      risenFrom.current = prev
      return node.offsetHeight
    })
    // Observed, not measured once: the top card grows when its suggestions land
    // and when a composer opens, and a stale pin would leave the stack ragged
    // again the moment either happened.
    const ro = new ResizeObserver(() => setCardH(node.offsetHeight))
    ro.observe(node)
    cardObserver.current?.disconnect()
    cardObserver.current = ro
  }, [])
  useEffect(() => () => cardObserver.current?.disconnect(), [])
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const startX = useRef(0)
  const startY = useRef(0)
  const dragging = useRef(false)
  const onControl = useRef(false)
  const captured = useRef(false)
  // Whether the live drag is already past the commit distance, so the tick
  // fires on the CROSSING and not on every move past it.
  const pastThreshold = useRef(false)
  // Last chip tapped, for the double-tap send.
  const lastTap = useRef<{ id: string; at: number } | null>(null)

  // The parent owns membership (a session ended, a card resolved elsewhere);
  // this owns position. Merging is the parent's job so the two cannot disagree.
  // Skipped labels are subtracted here too: the parent still holds them, and
  // without this every merge would deal a passed card straight back to the top.
  useEffect(() => {
    setOrder(skipped.length === 0 ? deck : deck.filter((c) => !skipped.includes(c.label)))
  }, [deck, skipped])

  // A pass is only pending while its session still is -- one answered on the Mac
  // must not sit on the end screen offering a card that no longer exists.
  const skippedCards = skipped
    .map((label) => deck.find((c) => c.label === label))
    .filter((c): c is SwipeCard => Boolean(c))

  const top: SwipeCard | undefined = order[0]
  // Every card in the stack resolves its chips the SAME way. A behind card built
  // from `actionsFor(card)` with no suggestions showed the canned chips, so it
  // stood at the wrong HEIGHT and then swapped its whole chip row the instant it
  // was promoted -- the pop.
  const actionsForCard = useCallback(
    (card: SwipeCard): SwipeAction[] => {
      const key = cardSuggestKey(card)
      return actionsFor(card, (key ? props.suggestions?.[key] : undefined) ?? [], props.archiveSessions)
    },
    [props.suggestions, props.archiveSessions]
  )
  const actions = top ? actionsForCard(top) : []
  const armingKeyForTop = top ? armingKey(top, actions) : undefined

  // Asked from HERE, not the parent: a skip reorders `order` alone, so a parent
  // keyed on its own `deck[0]` kept suggesting for a card already swiped past.
  // One card at a time -- the whole deck would spawn a CLI per session on open.
  const onRequestSuggestions = props.onRequestSuggestions
  // One ask per key: the effect re-runs on every deck render while the reply is
  // in flight, and without this each render re-sent the same request (24 in one
  // wait, measured). Entries age out at the server's own timeout so a lost
  // reply (disconnect mid-flight) can be re-asked, not stuck forever.
  const suggestAskedAt = useRef<Map<string, number>>(new Map())
  const [, suggestTick] = useState(0)
  useEffect(() => {
    if (!open || !onRequestSuggestions) return
    // Every card the stack DRAWS, not just the top two: asking for two while
    // rendering three left the deepest card permanently unable to show a
    // skeleton, because nothing ever asked on its behalf. Still not the whole
    // deck -- that would spawn a CLI per session on open.
    let sent = false
    for (const card of order.slice(0, CARDS_SHOWN)) {
      if (!worthSuggesting(card.session, Boolean(card.pending), card.subject)) continue
      const context = suggestContext(card.session, card.subject)
      const key = cardSuggestKey(card) ?? ''
      if (!context || props.suggestions?.[key]) continue
      const asked = suggestAskedAt.current.get(key)
      if (asked !== undefined && Date.now() - asked < CONFIG.SUGGESTIONS.PREDICT_TIMEOUT_MS)
        continue
      suggestAskedAt.current.set(key, Date.now())
      onRequestSuggestions(card.label, context)
      sent = true
    }
    // The ask lives in a ref, so it paints nothing on its own. Without this the
    // skeleton it turns on waited for some unrelated re-render -- which the top
    // card always got and a behind card did not, so behind cards showed no
    // skeleton at all until the user touched something.
    if (sent) suggestTick((n) => n + 1)
  }, [open, order, onRequestSuggestions, props.suggestions])

  // Loading = asked, no answer yet, server still within its own timeout. The
  // timer below re-renders once at the deadline so a never-answered ask falls
  // back to the canned chips instead of a skeleton that shimmers forever.
  //
  // Asked PER CARD, not just for the top one: the effect above prefetches the
  // card behind as well, so its chips really are in flight and its skeletons are
  // honest. Showing them only on top meant a promoted card grew a skeleton row
  // it did not have a frame earlier -- the height jumped exactly as it became
  // the thing you were looking at.
  const isLoadingFor = useCallback(
    (card: SwipeCard): boolean => {
      const key = cardSuggestKey(card)
      if (!key) return false
      const asked = suggestAskedAt.current.get(key)
      return (
        asked !== undefined &&
        props.suggestions?.[key] === undefined &&
        Date.now() - asked < CONFIG.SUGGESTIONS.PREDICT_TIMEOUT_MS
      )
    },
    [props.suggestions]
  )
  const suggestionsLoading = top ? isLoadingFor(top) : false
  // The EARLIEST outstanding ask across every drawn card, so one timer expires
  // the whole stack's skeletons. Keyed on the top card alone it left a behind
  // card shimmering past the server's own deadline, until an unrelated render
  // happened to recompute it.
  const nextDeadline = order
    .slice(0, CARDS_SHOWN)
    .filter((card) => isLoadingFor(card))
    .reduce<number | undefined>((soonest, card) => {
      const asked = suggestAskedAt.current.get(cardSuggestKey(card) ?? '')
      if (asked === undefined) return soonest
      return soonest === undefined || asked < soonest ? asked : soonest
    }, undefined)
  useEffect(() => {
    if (nextDeadline === undefined) return
    const remain = CONFIG.SUGGESTIONS.PREDICT_TIMEOUT_MS - (Date.now() - nextDeadline) + 50
    const t = window.setTimeout(() => suggestTick((n) => n + 1), Math.max(0, remain))
    return () => window.clearTimeout(t)
  }, [nextDeadline])

  // The card opens ARMED: a right swipe always has something to send, so a card
  // you agree with costs one gesture instead of tap-then-swipe. `chosen` is the
  // override, not the answer -- null means "whatever this card leads with".
  const preselected = armedAction(actions, arming.recall(armingKeyForTop))
  const chosenAction: SwipeAction | undefined =
    actions.find((a) => a.id === chosen) ?? (chosen === null ? preselected : undefined)

  // A card change drops the override: carrying "postgres" onto the next agent's
  // question is how the wrong thing gets sent to the wrong session. The NEXT
  // card then arms its own first action, which is the point.
  const topLabel = top?.label
  useEffect(() => {
    setChosen(null)
    setTyping(false)
    setDraft('')
    setDragX(0)
    setDragY(0)
    // A tap left on the old card must not pair with the first tap on the new
    // one and send it -- ids repeat across cards ('wrap' is on every card).
    lastTap.current = null
    // The jump list names the cards BEHIND the top one, so a new top makes it
    // stale the instant it changes -- including the jump that opened it.
    setJumpOpen(false)
  }, [topLabel])

  const advance = useCallback(() => {
    if (!topLabel) return
    setSkipped((s) => (s.includes(topLabel) ? s : [...s, topLabel]))
    setOrder((prev) => skip(prev))
  }, [topLabel])

  const commit = useCallback(
    // `override` exists for the double-tap: the second tap sends the chip it
    // landed on, and `chosenAction` still holds the pre-tap value on that tick.
    (direction: Direction, override?: SwipeAction) => {
      if (!top) return
      if (direction === 'skip') {
        haptics.dragRelease()
        setLeaving('skip')
        return
      }

      const action = override ?? chosenAction
      const affirm = action ? affirmFor(top, action, draft) : null
      if (!action || !affirm) {
        // Nothing armed, or the armed action went stale: snap back and pulse
        // the row rather than sending a guess. Reachable even with preselection
        // -- "Type your own" with an empty draft lands here.
        setDragX(0)
        setDragY(0)
        setNudge(true)
        window.setTimeout(() => setNudge(false), 400)
        return
      }
      // Remembered on the affirm, never on the tap: what someone SENT is the
      // preference, and an armed action they swiped away from is the opposite
      // of one.
      arming.remember(armingKeyForTop, rememberedValue(action))
      haptics.dragRelease()
      setLeaving('affirm')
      onAffirm(affirm, top)
    },
    [top, chosenAction, draft, onAffirm, armingKeyForTop, haptics, arming]
  )

  // The card leaves under its own animation, then the deck moves. Doing both on
  // the same tick makes the next card appear already mid-flight.
  useEffect(() => {
    if (!leaving) return
    const timer = window.setTimeout(() => {
      setLeaving(null)
      setDragX(0)
      setDragY(0)
      // Armed for the card about to be promoted; `onAnimationEnd` disarms it.
      setRising(deck[1]?.label ?? null)
      advance()
      // 200ms, matching `.swipeDeckCardLeaving`'s transition exactly. At 180 the
      // deck swapped while the outgoing card was still 20ms from landing.
    }, 200)
    return () => window.clearTimeout(timer)
    // `deck` is read to name the card being promoted, so it belongs here: a
    // stale closure would arm the label of a card that is no longer next.
  }, [leaving, advance, deck])

  const paintDrag = (x: number, y: number): void => {
    const width = widthRef.current
    const commit = Math.min(1, Math.abs(x) / (width * COMMIT_FRACTION))
    const tilt = (x / MAX_DRAG_PX) * MAX_TILT_DEG
    dragLive.current = { x, y, tilt, commit }
    const card = cardRef.current
    if (card) card.style.transform = `translate(${x}px, ${y}px) rotate(${tilt}deg)`
    const root = rootRef.current
    if (root) {
      root.style.setProperty('--deck-commit', String(commit))
      // The blur radius gets a QUANTISED copy of the same drag. A changing
      // radius cannot be GPU-composited, so at pointer rate it repaints both
      // behind cards ~60 times a drag and the swipe visibly lags on a phone. In
      // 5 steps the card still sharpens as it is uncovered, at a twelfth of the
      // repaints. Scale and opacity keep the unrounded value.
      root.style.setProperty('--deck-commit-stepped', String(Math.round(commit * 5) / 5))
      // The behind cards' blur follows the thumb, so it must not be animating
      // while the thumb moves. They cannot carry the top card's inline
      // `transition: none`, so the flag rides the root instead. Keyed off the
      // live drag, because `paintDrag(0, 0)` also runs on release to snap back
      // -- and re-arming it there would freeze the blur mid-ease.
      if (dragging.current) root.setAttribute('data-dragging', '')
      else root.removeAttribute('data-dragging')
    }
    const next: Direction | null = x > INTENT_PX ? 'affirm' : x < -INTENT_PX ? 'skip' : null
    if (next === intentRef.current) return
    intentRef.current = next
    for (const node of [stageRef.current, card, railRef.current]) {
      if (!node) continue
      if (next) node.setAttribute('data-intent', next)
      else node.removeAttribute('data-intent')
    }
  }

  const onPointerDown = (e: React.PointerEvent): void => {
    // The composer owns its own drags; a swipe that starts on the text field is
    // someone placing a caret.
    if ((e.target as HTMLElement).closest(`.${classes.composer}`)) return
    dragging.current = true
    captured.current = false
    pastThreshold.current = false
    widthRef.current = cardRef.current?.offsetWidth ?? 320
    const card = cardRef.current
    if (card) card.style.transition = 'none'
    const root = rootRef.current
    if (root) root.style.transition = 'none'
    // A press that lands on a control is that control's -- it may still DRAG
    // the card (the chips cover most of it), but releasing without travel must
    // pick the chip, not open the detail behind it.
    onControl.current = Boolean((e.target as HTMLElement).closest('button'))
    startX.current = e.clientX
    startY.current = e.clientY
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    if (!dragging.current) return
    const dx = e.clientX - startX.current
    const dy = e.clientY - startY.current
    // Chromium fires click at the capture target, so capturing on a chip press
    // steals the pick. Wait until this is a drag -- in EITHER axis, or a straight
    // vertical pull stays uncaptured and releases as a tap that opens the card.
    if (!captured.current && Math.hypot(dx, dy) >= TAP_SLOP_PX) {
      captured.current = true
      cardRef.current?.setPointerCapture(e.pointerId)
    }

    // One tick the moment the drag crosses into "releasing now would send it",
    // and one more if it comes back out -- the threshold is invisible, so
    // without this the only way to learn where it is, is to guess and watch.
    // Native-bridge only by construction (`dragEngage` no-ops on plain Safari,
    // where a touchmove has no user-activation window to fire in).
    const width = widthRef.current
    const past = Math.abs(dx) >= width * COMMIT_FRACTION
    if (past !== pastThreshold.current) {
      pastThreshold.current = past
      haptics.dragEngage()
    }

    paintDrag(
      Math.max(-MAX_DRAG_PX, Math.min(MAX_DRAG_PX, dx)),
      Math.max(-MAX_DRAG_Y_PX, Math.min(MAX_DRAG_Y_PX, dy))
    )
  }

  const onPointerUp = (e: React.PointerEvent): void => {
    if (!dragging.current) return
    dragging.current = false
    if (cardRef.current) cardRef.current.style.transition = ''
    if (rootRef.current) {
      rootRef.current.style.transition = ''
      rootRef.current.removeAttribute('data-dragging')
    }
    if (captured.current) {
      cardRef.current?.releasePointerCapture(e.pointerId)
      captured.current = false
    }
    const width = widthRef.current
    const dx = e.clientX - startX.current
    const dy = e.clientY - startY.current
    if (Math.abs(dx) < width * COMMIT_FRACTION) {
      paintDrag(0, 0)
      setDragX(0)
      setDragY(0)
      // A press that never travelled is a tap, not an abandoned swipe: it opens
      // the session's own detail. The threshold is TAP_SLOP, not the commit
      // distance -- a 40px drag that snapped back was still a drag, and opening
      // a sheet under a thumb that was clearly swiping is worse than doing
      // nothing.
      if (top && !onControl.current && Math.hypot(dx, dy) < TAP_SLOP_PX) {
        haptics.tick()
        swallowNextClick()
        onOpenSession?.(top.label, top)
      }
      return
    }
    commit(dx > 0 ? 'affirm' : 'skip')
  }

  const pickAction = (action: SwipeAction): void => {
    // Second tap on the SAME chip inside the window sends it -- the shortcut for
    // a card you already agree with, without reaching for the swipe. Compared by
    // id, so a fast tap across two chips only ever re-arms.
    const now = Date.now()
    const isSecondTap =
      lastTap.current?.id === action.id &&
      now - lastTap.current.at < CONFIG.PHONE_REMOTE.DECK_CHIP_DOUBLE_TAP_MS
    lastTap.current = { id: action.id, at: now }
    if (isSecondTap && action.kind !== 'typed') {
      lastTap.current = null
      setChosen(action.id)
      commit('affirm', action)
      return
    }

    haptics.tick()
    if (action.kind === 'typed') {
      setChosen(action.id)
      setTyping(true)
      // iOS raises its keyboard only from a focus inside the tap's activation
      // window, so this cannot wait for a state flush.
      inputRef.current?.focus()
      return
    }
    setTyping(false)
    // No toggle-off: with a card always armed, disarming by re-tap leaves one
    // that LOOKS ready and silently is not. Tapping moves the arming; it never
    // removes it.
    setChosen(action.id)
  }

  const armed = Boolean(chosenAction && (chosenAction.kind !== 'typed' || draft.trim()))
  const travel =
    leaving === 'skip' ? -MAX_DRAG_PX * 2.5 : leaving === 'affirm' ? MAX_DRAG_PX * 2.5 : dragX
  // A card on its way out flies flat: keeping the thumb's last Y would send it
  // off at whatever angle the release happened to end on.
  const travelY = leaving ? 0 : dragY
  const tilt = (travel / MAX_DRAG_PX) * MAX_TILT_DEG
  const intent: Direction | null =
    travel > INTENT_PX ? 'affirm' : travel < -INTENT_PX ? 'skip' : null

  const commitProgress = Math.min(1, Math.abs(travel) / (widthRef.current * COMMIT_FRACTION))
  const commitNow = dragging.current ? dragLive.current.commit : commitProgress
  const liveX = dragging.current ? dragLive.current.x : travel
  const liveY = dragging.current ? dragLive.current.y : travelY
  const liveTilt = dragging.current ? dragLive.current.tilt : tilt
  const liveIntent = dragging.current ? intentRef.current : intent

  return (
    <>
      {open && <div className={classes.scrim} onClick={onClose} />}
      <div
        ref={rootRef}
        className={`${classes.root}${open ? ` ${classes.rootOpen}` : ''}`}
        role="dialog"
        aria-label={CONFIG.UI_LABELS.SWIPE_DECK_TITLE}
        style={{
          ['--deck-commit' as string]: commitNow,
          // Set alongside the raw value on every render, so a re-render mid-drag
          // cannot drop back to the fallback and snap the blur to full.
          ['--deck-commit-stepped' as string]: Math.round(commitNow * 5) / 5
        }}
      >
        <div className={classes.header}>
          {onBack && (
            <Button variant="bare"
              className={classes.headerBack}
              aria-label="Back"
              onClick={() => {
                haptics.tick()
                onBack()
              }}
              type="button"
            >
              <ChevronLeft size={18} />
              {CONFIG.UI_LABELS.SWIPE_DECK_CLOSE}
            </Button>
          )}
          <span className={classes.title}>{CONFIG.UI_LABELS.SWIPE_DECK_TITLE}</span>
          {/* The stack depth, not a progress fraction: cards can arrive while
              the deck is open, so a "3 of 7" would count up past its own total.
              A skip rotates rather than removes, so this deliberately does NOT
              move on one -- the card went to the back and is still yours. */}
          {order.length > 0 && (
            <Button variant="bare"
              className={classes.count}
              type="button"
              aria-expanded={jumpOpen}
              aria-label={`${order.length} in the stack`}
              onClick={() => {
                haptics.tick()
                setJumpOpen((v) => !v)
              }}
            >
              {order.length}
            </Button>
          )}
          {/* One group, so the header's `margin-left: auto` lands ONCE and both
              icons sit together at the right edge -- applied per button it
              pushed the first icon into the middle of the bar. */}
          <div className={classes.headerBtns}>
          {island && (
            <Button variant="bare"
              className={classes.headerBtn}
              aria-label={island.on ? 'Hide the controls' : 'Show the controls'}
              aria-pressed={island.on}
              onClick={() => {
                haptics.tick()
                island.onToggle()
              }}
              type="button"
            >
              <Palette size={18} />
            </Button>
          )}
          {/* Only while the screen is up, and only for the card on top: this
              zooms one agent's pane, and off-screen there is nothing to aim at. */}
          {screen?.on && screen.onZoom && top && (
            <Button variant="bare"
              className={classes.headerBtn}
              aria-label={
                screen.zoomed?.[top.label]
                  ? 'Show the other agents'
                  : 'Fill the screen with this agent'
              }
              aria-pressed={screen.zoomed?.[top.label] === true}
              onClick={() => {
                haptics.tick()
                screen.onZoom?.(top.label, !screen.zoomed?.[top.label])
              }}
              type="button"
            >
              {screen.zoomed?.[top.label] ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
            </Button>
          )}
          {screen && (
            <Button variant="bare"
              className={classes.headerBtn}
              aria-label={screen.on ? 'Stop touching the screen' : 'Touch the screen'}
              aria-pressed={screen.on}
              onClick={() => {
                haptics.tick()
                screen.onToggle()
              }}
              type="button"
            >
              <MonitorSmartphone size={18} />
            </Button>
          )}
          </div>
        </div>
        {/* Plain text, not a control: on both surfaces the deck IS the
            full-screen mode, so there is no list behind it to tap through to. */}
        {statusLine && (
          <div className={classes.status} data-health={statusLine.health}>
            <span className={classes.statusDot} aria-hidden="true" />
            {/* polite, not assertive: an agent opening mid-swipe is worth
                announcing, never worth interrupting the card you are answering. */}
            <span className={classes.statusText} aria-live="polite">
              {statusLine.text}
            </span>
          </div>
        )}
        {/* Jump straight to an agent instead of swiping down to it. Lists the
            whole stack, top card included and marked, because "which one am I
            on" is half of what the list is being opened to answer. */}
        <div className={classes.jumpAnchor}>
          {jumpOpen && order.length > 0 && (
            <div className={classes.jump}>
              {order.map((card, i) => (
                <Button variant="bare"
                  key={card.label}
                  type="button"
                  className={classes.jumpRow}
                  data-current={i === 0 ? '' : undefined}
                  onClick={() => {
                    haptics.tick()
                    setJumpOpen(false)
                    // Already on it: closing the list IS the whole action, and
                    // rotating a deck onto its own top card would still reset
                    // the arming the card is holding.
                    if (i > 0) setOrder((prev) => jumpTo(prev, card.label))
                  }}
                >
                  <AgentFace id={sessionFaceId(card.session)} size={20} />
                  <span className={classes.jumpWho}>
                    <span className={classes.jumpName}>{card.row.name ?? card.row.repo}</span>
                    <span className={classes.jumpWhat}>{card.subject || activityLine(card)}</span>
                  </span>
                  {card.pending && <span className={classes.jumpDot} aria-label="waiting on you" />}
                </Button>
              ))}
            </div>
          )}
        </div>

        {screen?.pane}

        {!top ? (
          <div className={classes.empty}>
            <p className={classes.emptyTitle}>
              {skippedCards.length > 0
                ? CONFIG.UI_LABELS.SWIPE_DECK_END
                : CONFIG.UI_LABELS.SWIPE_DECK_EMPTY}
            </p>
            <p className={classes.emptyBody}>
              {skippedCards.length > 0
                ? `You passed on ${skippedCards.length}.`
                : CONFIG.UI_LABELS.SWIPE_DECK_EMPTY_DETAIL}
            </p>
            {skippedCards.length > 0 && (
              <>
                {/* Named, not just counted: tapping one starts the next run on
                    THAT agent, so a specific "I'll come back to the migration
                    one" costs a tap instead of another pass through the stack. */}
                <div className={classes.passed}>
                  {skippedCards.map((card) => (
                    <Button variant="bare"
                      key={card.label}
                      className={classes.jumpRow}
                      type="button"
                      onClick={() => {
                        haptics.tick()
                        setSkipped([])
                        setOrder(jumpTo(skippedCards, card.label))
                      }}
                    >
                      <AgentFace id={sessionFaceId(card.session)} size={26} />
                      <span className={classes.jumpWho}>
                        <span className={classes.jumpName}>{card.row.name ?? card.row.repo}</span>
                        <span className={classes.jumpWhat}>
                          {card.subject ?? activityLine(card)}
                        </span>
                      </span>
                      {card.pending && (
                        <span className={classes.jumpDot} aria-label="waiting on you" />
                      )}
                    </Button>
                  ))}
                </div>
                <Button variant="bare"
                  className={classes.again}
                  type="button"
                  onClick={() => {
                    haptics.tick()
                    setSkipped([])
                    setOrder(skippedCards)
                  }}
                >
                  {CONFIG.UI_LABELS.SWIPE_DECK_END_AGAIN}
                </Button>
              </>
            )}
          </div>
        ) : (
          <div
            ref={stageRef}
            className={classes.stage}
            data-intent={liveIntent ?? undefined}
            style={{
              ...(cardH ? { ['--deck-card-h' as string]: `${cardH}px` } : {}),
              // Where the rise STARTS. Falls back to the live pin on the very
              // first card, which has nothing to have risen from.
              ...(risenFrom.current || cardH
                ? { ['--deck-rise-from-h' as string]: `${risenFrom.current ?? cardH}px` }
                : {})
            }}
          >
            {/* Which way this release goes, painted on the STAGE over the card's
                shoulder. Behind the stack it stayed hidden by the opaque card
                until the swipe was already decided, which is too late to be the
                thing that tells you what releasing does. Both mounted always and
                revealed by intent: fading one in from a fresh mount lands a frame
                late on a gesture already moving. `aria-hidden` because the rail
                buttons carry the same two words to a screen reader. */}
            <span className={classes.stamp} data-side="affirm" aria-hidden="true">
              {CONFIG.UI_LABELS.SWIPE_DECK_AFFIRM}
            </span>
            <span className={classes.stamp} data-side="skip" aria-hidden="true">
              {CONFIG.UI_LABELS.SWIPE_DECK_SKIP}
            </span>

            {/* The cards behind the top one -- the REAL next cards, same
                component, pushed back by CSS. Never interactive: they are what
                you decide next, not more things to answer now. Deepest first so
                DOM order matches paint order without any z-index. */}
            {Array.from({ length: CARDS_SHOWN - 1 }, (_, i) => CARDS_SHOWN - 1 - i).map((depth) => {
              const behind = order[depth]
              if (!behind) return null
              return (
                <div
                  key={behind.label}
                  className={`${classes.card} ${classes.cardBehind}`}
                  data-depth={depth}
                  aria-hidden="true"
                >
                  <DeckCard
                    card={behind}
                    depth={depth}
                    classes={classes}
                    actions={actionsForCard(behind)}
                    suggestionsLoading={isLoadingFor(behind)}
                  />
                </div>
              )
            })}

            <div
              // Keyed on the label so a promoted card MOUNTS rather than
              // re-renders -- that mount is what plays the rise, and without it
              // React would reuse the node and the new card would just pop.
              key={top.label}
              ref={measureCard}
              // The rise animation ends the moment a drag starts: a running
              // keyframe wins over an inline transform, so a thumb that lands
              // inside those 200ms would move nothing. A live drag is the ONLY
              // thing that suppresses it -- an `allowRise` ref used to latch off
              // on the first swipe and never back on, so every promotion after
              // it snapped straight to its own geometry instead of rising.
              className={`${classes.card}${
                rising === top.label && !dragging.current && !leaving
                  ? ` ${classes.cardRising}`
                  : ''
              }${leaving ? ` ${classes.cardLeaving}` : ''}`}
              // The rise is TRANSIENT: without this the class stayed applied at
              // rest and its `overflow: hidden` clipped the card permanently.
              onAnimationEnd={() => setRising((r) => (r === top.label ? null : r))}
              data-intent={liveIntent ?? undefined}
              style={{
                transform: `translate(${liveX}px, ${liveY}px) rotate(${liveTilt}deg)`,
                transition: dragging.current ? 'none' : undefined
              }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            >
              <DeckCard
                card={top}
                depth={0}
                classes={classes}
                actions={actions}
                suggestionsLoading={suggestionsLoading}
                chosenAction={chosenAction}
                failed={props.failed}
                goToFailed={props.goToFailed}
                onGoTo={onGoTo}
                onOpenSession={onOpenSession}
                onPickAction={pickAction}
                nudge={nudge}
                haptics={haptics}
              >
                {typing && (
                  <div className={classes.composer}>
                    <textarea
                      ref={inputRef}
                      className={classes.input}
                      rows={1}
                      value={draft}
                      maxLength={CONFIG.PHONE_REMOTE.CHAT_MESSAGE_MAX_CHARS}
                      placeholder={CONFIG.UI_LABELS.SWIPE_DECK_TYPE_PLACEHOLDER}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault()
                          haptics.keyPress()
                          commit('affirm')
                        }
                      }}
                    />
                  </div>
                )}

                {nudge && <p className={classes.note}>{CONFIG.UI_LABELS.SWIPE_DECK_PICK_FIRST}</p>}
              </DeckCard>
            </div>
          </div>
        )}

        {top && (
          <div
            ref={railRef}
            className={classes.rail}
            // The rail answers the drag: the side you are heading toward grows
            // and lights, the other recedes. Same `--deck-commit` the stamps
            // read, so the two can never disagree about how far along you are.
            data-intent={liveIntent ?? undefined}
          >
            <Button variant="bare"
              className={classes.railBtn}
              type="button"
              data-side="skip"
              onClick={() => commit('skip')}
            >
              {/* The icon says WHAT the button does; the arrow it replaces only
                  said which way to swipe, which the rail's own position already
                  shows. `aria-hidden` -- the label beside it is the name. */}
              <Clock size={15} strokeWidth={2.5} aria-hidden="true" />
              {CONFIG.UI_LABELS.SWIPE_DECK_SKIP}
            </Button>
            <Button variant="bare"
              className={classes.railBtn}
              type="button"
              data-side="affirm"
              data-armed={armed ? '' : undefined}
              onClick={() => commit('affirm')}
            >
              {CONFIG.UI_LABELS.SWIPE_DECK_AFFIRM}
              <SendHorizontal size={15} strokeWidth={2.5} aria-hidden="true" />
            </Button>
          </div>
        )}
        {/* Last child of the deck, so it paints over the cards and the rail
            without either needing a z-index of its own. */}
        {island?.on && island.node}
      </div>
    </>
  )
}

/**
 * Eat the ONE click a tap-through leaves behind.
 *
 * Opening the session unmounts the deck and its scrim on the pointerup tick, so
 * the trailing click for that same finger hit-tests to whatever is underneath --
 * CodeSheet's own scrim, whose onClick closes the whole sheet. The session
 * detail rendered, then vanished a frame later, which reads as broken routing
 * and is not.
 *
 * Capture phase so it lands before the scrim's own handler, and self-removing on
 * a timer as well as on the click: a tap that somehow produces no click must not
 * leave a listener armed for the next one.
 */
function swallowNextClick(): void {
  const eat = (e: MouseEvent): void => {
    e.stopPropagation()
    e.preventDefault()
    done()
  }
  const done = (): void => {
    window.removeEventListener('click', eat, true)
    window.clearTimeout(timer)
  }
  const timer = window.setTimeout(done, 400)
  window.addEventListener('click', eat, true)
}

/**
 * ONE card, rendered at every depth in the stack.
 *
 * There is no such thing as a placeholder here: the cards behind the top one are
 * the real next cards, drawn by this same component and pushed back by CSS. They
 * used to be empty plates, so a swipe uncovered a blank rectangle and the card
 * you were about to decide on only appeared after the release, as a pop.
 *
 * `depth` changes exactly one thing: whether the card can be TOUCHED. Depth 0
 * drags and its chips are buttons; deeper cards are inert -- no handlers, no
 * keys, `aria-hidden`, and chips render as `<span>`s, since a disabled `<button>`
 * paints greyed on iOS and this has to look like the card it actually is.
 *
 * It changes nothing about SHAPE, and that is deliberate. A card behind shows the
 * same rows at the same heights it will have when promoted, skeletons included --
 * the deck already prefetches suggestions one card ahead, so a loading row there
 * is honest. Suppressing it meant a promoted card grew a skeleton row it did not
 * have a frame earlier, and the height jumped exactly as it became the card you
 * were looking at.
 */
function DeckCard({
  card,
  depth,
  classes,
  actions,
  suggestionsLoading,
  chosenAction,
  failed,
  goToFailed,
  onGoTo,
  onOpenSession,
  onPickAction,
  nudge,
  haptics,
  children
}: {
  card: SwipeCard
  depth: number
  classes: SwipeDeckClasses
  actions: SwipeAction[]
  suggestionsLoading?: boolean
  chosenAction?: SwipeAction | null
  failed?: ReadonlySet<string>
  goToFailed?: ReadonlySet<string>
  onGoTo?: (label: string, card: SwipeCard) => void
  onOpenSession?: (label: string, card: SwipeCard) => void
  onPickAction?: (action: SwipeAction) => void
  /** Flashes the chip row when a swipe lands with nothing picked. Live-only:
   *  nothing can be armed on a card that cannot be touched. */
  nudge?: boolean
  haptics?: DeckHaptics
  /** The composer and the nudge -- live-only, so the caller passes them rather
   *  than this component learning about drafts it can never own. */
  children?: React.ReactNode
}): React.JSX.Element {
  const live = depth === 0
  return (
    <>
      <div className={classes.head}>
        <AgentFace id={sessionFaceId(card.session)} size={26} />
        <div className={classes.who}>
          <span className={classes.name}>{card.row.name ?? card.row.repo}</span>
          <span className={classes.place}>
            {[card.row.place ?? card.row.repo, card.row.branch].filter((part) => part && part !== card.row.name).join(' · ')}
          </span>
        </div>
        {card.row.waitAge && <span className={classes.age}>{card.row.waitAge}</span>}
        {live && onGoTo && (
          <Button variant="bare"
            className={classes.goTo}
            type="button"
            aria-label="Open on Mac"
            disabled={goToFailed?.has(card.label)}
            onClick={(e) => {
              e.stopPropagation()
              haptics?.tick()
              onGoTo(card.label, card)
            }}
          >
            <ExternalLink size={15} strokeWidth={2.5} />
          </Button>
        )}
      </div>

      {card.subject && !(card.pending && card.subject === questionText(card)) ? (
        <p className={classes.subject}>
          {/* The tag rides the DECLARED subject only -- `subjectFor` falls back
              to text derived from cards, and labelling that "TLDR" would name it
              something it isn't. */}
          {card.session.tldr?.trim() === card.subject && (
            <span className={classes.subjectTag}>RECAP</span>
          )}
          {card.subject}
        </p>
      ) : (
        /* Never a blank gap: a card with nothing to say says how much it has
           done, which is still something to decide on. */
        <p className={`${classes.subject} ${classes.subjectMuted}`}>{activityLine(card)}</p>
      )}

      {/* Absent fields render nothing -- a strip of "unknown" costs more than the
          shorter strip it replaces. */}
      {factsLine(card) && <p className={classes.facts}>{factsLine(card)}</p>}

      {card.activity.lastSummary && card.activity.lastSummary !== card.subject && (
        <p className={classes.last}>{card.activity.lastSummary}</p>
      )}

      {card.pending && (
        <div className={classes.ask}>
          <span className={classes.askLabel}>
            {card.row.label ?? CONFIG.UI_LABELS.CODE_SESSION_WRAP_BUSY}
          </span>
          <p className={classes.askText}>
            {questionText(card) || CONFIG.UI_LABELS.CODE_SESSION_LAST_EMPTY}
          </p>
        </div>
      )}

      {live && failed?.has(card.label) && (
        <p className={classes.failed} role="alert">
          {CONFIG.UI_LABELS.SWIPE_DECK_SEND_FAILED}
        </p>
      )}

      {card.moreQuestions ? (
        live ? (
          <Button variant="bare"
            className={classes.more}
            type="button"
            onClick={(e) => {
              // Same tap-through trap as the card body: this click is already in
              // flight, so it only has to be stopped from reaching the scrim the
              // deck is about to stop covering.
              e.stopPropagation()
              haptics?.tick()
              onOpenSession?.(card.label, card)
            }}
          >
            {CONFIG.UI_LABELS.SWIPE_DECK_MORE_QUESTIONS}
            <ChevronRight size={15} />
          </Button>
        ) : (
          <span className={classes.more}>
            {CONFIG.UI_LABELS.SWIPE_DECK_MORE_QUESTIONS}
            <ChevronRight size={15} />
          </span>
        )
      ) : actions.length === 0 && !suggestionsLoading ? (
        <p className={classes.note}>{CONFIG.UI_LABELS.SWIPE_DECK_NOTHING_TO_DO}</p>
      ) : (
        <div className={`${classes.actions}${live && nudge ? ` ${classes.actionsNudge}` : ''}`}>
          {/* Skeletons stand in for the SUGGESTION slot only -- "Type your own"
              and "Wrap up" don't depend on the model, so they stay live while it
              thinks. */}
          {suggestionsLoading &&
            [0, 1].map((i) => (
              <span key={`sk-${i}`} className={classes.chipSkeleton} aria-hidden="true" />
            ))}
          {(suggestionsLoading ? actions.filter((a) => a.kind !== 'chip') : actions).map(
            (action) =>
              live ? (
                <Button variant="bare"
                  key={action.id}
                  type="button"
                  className={classes.chip}
                  // Reads the RESOLVED action, not raw `chosen` -- which is null
                  // on a preselected card, and would leave the row a swipe will
                  // send looking like nothing is armed.
                  data-chosen={chosenAction?.id === action.id ? '' : undefined}
                  aria-pressed={chosenAction?.id === action.id}
                  onClick={() => onPickAction?.(action)}
                >
                  {/* Its own element, never prepended to the label: the label is
                      what gets typed into the agent, and a glyph glued to it
                      would ride along into the terminal. `aria-hidden` because
                      the label already says it. */}
                  {action.emoji && (
                    <span className={classes.chipEmoji} aria-hidden="true">
                      {action.emoji}
                    </span>
                  )}
                  <span>{action.label}</span>
                </Button>
              ) : (
                <span key={action.id} className={classes.chip}>
                  {action.emoji && (
                    <span className={classes.chipEmoji} aria-hidden="true">
                      {action.emoji}
                    </span>
                  )}
                  <span>{action.label}</span>
                </span>
              )
          )}
        </div>
      )}

      {children}
    </>
  )
}

/** Model · harness · effort, from what the row already carries. Joined here
 *  rather than in `swipe-triage` because it is a rendering choice, not a
 *  meaning: the two shells want the same facts in a different shape. */
function factsLine(card: SwipeCard): string {
  return [card.row.model, card.row.agent, card.row.effort].filter(Boolean).join(' · ')
}

/** The fallback subject: what this session has DONE, when it has never said
 *  what it is doing. */
function activityLine(card: SwipeCard): string {
  const { total, waiting } = card.activity
  if (waiting > 0) return `${waiting} waiting on you`
  if (total === 1) return '1 card so far'
  return `${total} cards so far`
}

/** The question actually on screen -- the interview's current one when there is
 *  an array, the flat field otherwise. Same precedence `pendingOptions` uses,
 *  so the words and the buttons can never come from different questions. */
function questionText(card: SwipeCard): string {
  const params = card.pending?.params
  if (!params) return ''
  if (params.questions && card.questionIndex >= 0) {
    return params.questions[card.questionIndex]?.question ?? ''
  }
  return params.question ?? params.action ?? params.title ?? ''
}

/** Re-exported so the harness can render an armed card without importing the
 *  shared module separately. */
export { pendingOptions }

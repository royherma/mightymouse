/**
 * The Agents tab: one row per open `npx mightymouse-code`.
 *
 * Every string comes from `sessionRow` in `@shared/relay-status`, the same
 * function the Mac panel calls, so the two can never disagree about what a
 * session is called. This file owns only the touch markup -- a name or an age
 * that looks wrong is a bug in the shared formatter, not here.
 */

import { useEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Filter, Search, Terminal, X } from 'lucide-react'
import SessionDetail, { ProjectMark } from './SessionDetail'
import SessionFullScreen from './SessionFullScreen'
import { useFloatingRect } from './hooks/use-floating-rect'

/** The Mac's verdict on the last manual refresh, stamped so a repeat tap with
 *  an identical verdict still re-shows the caption. */
export type SessionPeekOutcome = {
  label: string
  outcome: 'changed' | 'unchanged' | 'unavailable'
  at: number
}
import {
  sessionRow,
  isGeneratedTag,
  sessionMatchesFrom,
  isOriginResolvable,
  withSeenIdle,
  sessionHaystack,
  matchesSession
} from '@shared/relay-status'
import { sessionActivity, senderMatchKey } from '@shared/relay-cards'
import { probeWidthChain, chainHasOverflow } from './width-probe'
import {
  sessionEntry,
  sortEntries,
  passesFilters,
  groupKeyFor,
  sessionSpoke,
  SESSION_FILTER_LABELS
} from '@shared/relay-sessions'
import { CONFIG } from '@shared/config'
import { ProgressMeter, PHONE_METER_CLASSES } from '@shared/progress-ring'
import type { AgentRelaySessionInfo } from '@shared/types'
import type { Suggestion } from '@shared/swipe-suggest'
import type { RelayRequestWire, RelayResponseWire } from '@shared/phone-remote-protocol'
import { Button } from '@shared/ui/Button'

/** 10s, the coarsest tick the FASTEST caption can take: the wait age counts in
 *  seconds under a minute, so a minute tick would freeze it at whatever it read
 *  when the list mounted. The session age above it is still minute-granular and
 *  simply re-renders to the same string. Held once here rather than per row, so
 *  ten sessions share one timer. */
function useAgeTick(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 10_000)
    return () => clearInterval(tick)
  }, [])
  return now
}

/** One agent. Every row opens its own sheet -- it used to be tappable only with
 *  a card waiting, which made a healthy agent read as a dead row rather than a
 *  row with no news. */
function SessionCard({
  session,
  waiting,
  lastSummary,
  derivedSubject,
  progress,
  now,
  onOpen
}: {
  session: AgentRelaySessionInfo
  waiting: number
  lastSummary?: string
  derivedSubject?: string
  progress?: number
  now: number
  onOpen: () => void
}): React.JSX.Element {
  const row = sessionRow(session, now)

  // Both come from `sessionRow` now -- the Mac reads the same two values, so
  // neither surface can word or colour a state differently from the other.
  const state = row.state_text
  const health = row.health

  // A card always states a title. `sessionRow` leaves `name` unset for an
  // unnamed pane and puts the checkout on line 1 instead, which is exactly the
  // fallback wanted here.
  const title = row.name ?? row.repo ?? CONFIG.UI_LABELS.CODE_SESSION_UNNAMED

  return (
    <Button
      variant="bare"
      className="codeSession"
      role="listitem"
      type="button"
      onClick={onOpen}
      data-clickable=""
      data-health={health}
      data-waiting={waiting > 0 ? '' : undefined}
    >
      <div className="codeSessionTop">
        <span className="codeSessionFace" aria-hidden="true">
          <ProjectMark project={session.project} />
        </span>
        {/* Name and age share a bounded row of their own: the face is fixed, so
            without this wrapper the name measured against the whole card and an
            unbreakable agent name ran past its border instead of ellipsizing. */}
        <span className="codeSessionHeading">
          <span className="codeSessionName">{title}</span>
        </span>
        {/* State and its clock are one fact, so they are one object: split across
            opposite corners (state bottom-left, age top-right) the age read as
            unrelated to the state it was measuring. */}
        <span className="codeSessionStateChip">
          <span className="codeSessionStateDot" aria-hidden="true" />
          {state}
          {row.waitAge && <span className="codeSessionStateAge">{row.waitAge}</span>}
        </span>
        {/* Beside the state, not over the avatar: an agent face is not always a
            circle, so a ring drawn around one reads as a mistake rather than a
            measurement. Here it also gets to carry its number. */}
        {progress !== undefined && <ProgressMeter value={progress} classes={PHONE_METER_CLASSES} />}
      </div>

      {(row.name || row.branch || row.started) && (
        <div className="codeSessionPlace">
          {row.name && row.repo && <b className="codeSessionRepo">{row.repo}</b>}
          {row.branch && <span className="codeSessionBranch">{row.branch}</span>}
          {row.started && <span className="codeSessionStarted">{row.started}</span>}
        </div>
      )}

      {/* The small print, only where it says something: which agent is running,
          a handle that tells two unnamed panes apart, and a folder that is not
          simply the repo. Absent rather than empty when the shim did not report
          it -- an older shim reads as a plain card, never one with holes. */}
      {(row.agent || row.model || row.effort || row.detail || row.where) && (
        <div className="codeSessionMeta">
          {row.agent && (
            <span className="codeSessionChip" data-agent="">
              {row.agent}
            </span>
          )}
          {row.model && <span className="codeSessionChip">{row.model}</span>}
          {row.effort && <span className="codeSessionChip">{row.effort}</span>}
          {row.detail && (
            <span
              className="codeSessionChip"
              data-generated={isGeneratedTag(row.detail) ? '' : undefined}
            >
              {row.detail}
            </span>
          )}
          {row.where && <span className="codeSessionChip">{row.where}</span>}
        </div>
      )}

      {(row.tldr || derivedSubject || lastSummary) && (
        <div className="codeSessionLast">{row.tldr ?? derivedSubject ?? lastSummary}</div>
      )}
    </Button>
  )
}

/** The chat composer's dictation pipeline, reused verbatim for session replies:
 *  the transcript lands in `draftPatch` instead of being sent. */
export interface SessionMicProps {
  onMicDown: () => void
  onMicUp: () => void
  dictating: boolean
  recording: boolean
  micStreamRef: RefObject<MediaStream | null>
  draftPatch: string | null
  onDraftConsumed: () => void
}

export default function SessionList(props: {
  sessions: AgentRelaySessionInfo[]
  footer?: React.ReactNode
  /** Outstanding cards, for the per-session `waiting` count and the jump. */
  pending: RelayRequestWire[]
  /** Already-answered cards, so a session's sheet can show its whole story and
   *  not just what is still open. */
  previous?: RelayRequestWire[]
  /** Settled cards BEFORE `previousList` drops notify. The full-screen reading
   *  asks a different question than the Previous tab does: there, a notify buries
   *  the handful of cards that were actually a question; here, the notifications
   *  ARE the conversation, and filtering them left an agent that only ever
   *  notified showing an empty screen in both modes. */
  settled?: RelayRequestWire[]
  /** A resolved card tapped on Previous: its row washes once on arrival. */
  flashRequestId?: string | null
  onFlashConsumed?: () => void
  /** The strip's one thing to do about a relay that is off or has nobody to
   *  push to. Rendered under the empty state, where it is the only content. */
  hint?: string
  /** Open this sender's waiting card. Called with the STATED name, the same
   *  join the Mac counts `waiting` by. */
  onReveal: (from: string) => void
  /** Answer a card from inside the session sheet. Absent on hosts with no
   *  socket to answer on, which is what makes the cards render read-only. */
  onRespond?: (requestId: string, response: RelayResponseWire) => void
  imageSrc?: (requestId: string) => string
  onPickPhoto?: (requestId: string, file: File) => Promise<boolean>
  /** Pane tails keyed by session label, filled after `onPeek`. */
  previews?: Record<string, string>
  /** When each pane tail last CHANGED, keyed the same. Drives the age caption. */
  previewAges?: Record<string, number>
  peekOutcome?: SessionPeekOutcome | null
  /** Notification tap: open this agent's sheet (`from` is stated name or label). */
  focusedFrom?: string | null
  onFocusedFromConsumed?: () => void
  onPeek?: (label: string) => void
  onReply?: (label: string, text: string) => void
  onStop?: (label: string) => void
  /** What you have already said to each agent, by label, as the Mac holds it. */
  sent?: Record<string, { text: string; at: number }[]>
  onSentGet?: (label: string) => void
  /** Send a photo with the reply being typed, by label. */
  onAttach?: (label: string, file: File) => Promise<boolean>
  /** Raise this agent's window on the Mac, by label. */
  onGoTo?: (label: string) => void
  /** Labels whose last `onGoTo` came back with nothing to open. */
  goToFailed?: ReadonlySet<string>
  /** Put the Mac's screen on this phone. Carries no label -- there is one
   *  screen, and it is the one the agent is running on. */
  onOpenScreen?: () => void
  mirrorOn?: boolean
  /** The live Mac pane + toggle for the open sheet. Threaded from the one place
   *  the single `useMirror` lives -- see SessionDetail's `screen`. */
  screen?: {
    on: boolean
    onToggle: () => void
    pane?: React.ReactNode
    controls?: React.ReactNode
    aspect?: number
  }
  /** Fill the Mac's window with the open agent's own pane. Label-keyed because
   *  the sheet pages between agents while a zoom is still in flight. */
  onZoom?: (label: string, on: boolean) => void
  zoomed?: Readonly<Record<string, boolean>>
  onArchive?: (session: AgentRelaySessionInfo) => boolean
  archived?: boolean
  /** Dictation for the reply box, forwarded to the open session's composer. */
  mic?: SessionMicProps
  /** Model-written chips, keyed by `cardSuggestKey`. The same map the deck
   *  reads -- both surfaces ask for one session's suggestions the one way. */
  suggestions?: Record<string, Suggestion[]>
  onRequestSuggestions?: (label: string, context: string, refresh?: boolean) => void
  /** Which agent sheet to open on mount, from the caller's saved place. Read
   *  once -- after that this component owns which sheet is open, and `onOpenChange`
   *  is how the caller hears about it. */
  initialOpenLabel?: string | null
  onOpenChange?: (label: string | null) => void
  /** Render the open session as a full-screen layer instead of in place. Set
   *  while the swipe deck is up, which is full-screen itself. */
  overlay?: boolean
}): React.JSX.Element {
  const now = useAgeTick()
  const { focusedFrom, onFocusedFromConsumed, onPeek, onReply, previews, previewAges } = props
  const { peekOutcome } = props
  const [query, setQuery] = useState('')
  const [pulled, setPulled] = useState(false)
  // Starts on the handed-back view: that is what you open the list to see.
  // With nothing handed back the chips hide and the list falls back to all.
  const [handedBackOnly, setHandedBackOnly] = useState(true)
  // Which checkout the list is pinned to, '' for every one. Held as the folder
  // NAME rather than an index: sessions come and go under the list, so a number
  // would silently repoint at a different folder as agents open and close.
  const [folder, setFolder] = useState('')
  // State, not a ref: the effect below must re-run when the list MOUNTS, and a
  // ref's assignment fires no render. Same reason the mic button holds a node in
  // state -- see this directory's CLAUDE.md.
  const [listEl, setListEl] = useState<HTMLDivElement | null>(null)

  // Pull-to-reveal, the same gesture as pull-to-refresh: only from the top of
  // the list, only downward, and only past a real drag. Read off touch deltas
  // rather than a negative scrollTop, because iOS rubber-banding does not
  // report overscroll on an inner scroller -- scrollTop just floors at 0.
  useEffect(() => {
    const el = listEl
    if (!el) return
    let startY: number | null = null

    const onStart = (e: TouchEvent): void => {
      // Only from the top, and never mid-pinch: anywhere else this is a scroll,
      // and the box must not appear under a thumb that is flicking the list.
      startY = e.touches.length === 1 && el.scrollTop <= 0 ? e.touches[0].clientY : null
    }
    const onMove = (e: TouchEvent): void => {
      if (startY === null) return
      const t = e.touches[0]
      if (t === undefined) return
      if (t.clientY - startY > CONFIG.PHONE_REMOTE.SESSION_SEARCH_PULL_PX) {
        setPulled(true)
        startY = null
      }
    }
    const onEnd = (): void => {
      startY = null
    }

    // Passive: nothing here calls preventDefault, and a non-passive listener on
    // a scroller costs scroll responsiveness for no gain.
    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: true })
    el.addEventListener('touchend', onEnd)
    el.addEventListener('touchcancel', onEnd)
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onEnd)
    }
  }, [listEl])

  // Width probe for the card-title clipping bug: measures the real box chain on
  // device (desktop harnesses demonstrably cannot reproduce it) and paints the
  // numbers on-glass only while overflow actually exists, so a screenshot both
  // verifies the fix and names the guilty box. Logs to the Mac either way.
  const [, setProbeReport] = useState<string | null>(null)
  useEffect(() => {
    if (!listEl) return
    // rAF: measure the laid-out frame, not the mid-commit one.
    const raf = requestAnimationFrame(() => {
      let widest: Element | null = null
      for (const el of listEl.querySelectorAll('.codeSessionName')) {
        if (!widest || el.scrollWidth > widest.scrollWidth) widest = el
      }
      if (!widest) return
      const report = probeWidthChain(widest)
      setProbeReport(chainHasOverflow(report) ? report : null)
    })
    return () => cancelAnimationFrame(raf)
  }, [listEl, props.sessions])

  // The open sheet, held by LABEL rather than index: sessions come and go under
  // the list, and one that drops off resolves to null here and falls back to
  // the list on its own rather than showing another agent's facts.
  const [openLabel, setOpenLabelState] = useState<string | null>(props.initialOpenLabel ?? null)
  const onOpenChange = props.onOpenChange
  // Reading one agent full screen. Cleared on every session change below: left
  // set, switching agents would land you full screen on the new one's history
  // without ever having asked for it.
  const [fullOpen, setFullOpen] = useState(false)
  const setOpenLabel = (label: string | null): void => {
    setOpenLabelState(label)
    setFullOpen(false)
    onOpenChange?.(label)
  }
  const screenAspect =
    props.screen?.aspect && props.screen.aspect > 0 ? props.screen.aspect : 16 / 9
  const rootData = document.querySelector<HTMLElement>('.proRoot')?.dataset
  const themeData = rootData
    ? Object.fromEntries(
        Object.entries(rootData).map(([key, value]) => [
          `data-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
          value
        ])
      )
    : {}
  const proRoot = document.querySelector('.proRoot')
  const safeBottomValue = proRoot
    ? Number.parseFloat(getComputedStyle(proRoot).getPropertyValue('--pro-safe-bottom'))
    : 0
  const safeBottom = Number.isFinite(safeBottomValue) ? safeBottomValue : 0
  const usableHeight = Math.max(0, window.innerHeight - safeBottom)
  const open = openLabel ? (props.sessions.find((s) => s.label === openLabel) ?? null) : null
  const screenRef = useRef<HTMLDivElement | null>(null)
  const screenFloat = useFloatingRect(screenRef, {
    prefKey: 'mm-remote-session-screen-rect',
    aspect: screenAspect,
    minW: 168,
    maxW: 380,
    bottomInset: safeBottom,
    defaultW: Math.min(
      380,
      Math.max(168, Math.min(window.innerWidth - 24, usableHeight * screenAspect))
    ),
    place: (w) => ({
      x: Math.max(12, window.innerWidth - w - 12),
      y: Math.max(12, Math.round((usableHeight - w / screenAspect) / 2))
    }),
    enabled: Boolean(open && props.screen?.on && props.screen.pane),
    isInteractive: (target) =>
      target instanceof Element && target.closest('button, [role="button"]') !== null
  })

  // Both deck edges land somewhere clean: entering shows the CARDS, leaving
  // shows the LIST. Without this a session left open from before would still be
  // open and, being an overlay now, would paint straight over the deck that was
  // just asked for -- and closing the deck would strand you on that session
  // instead of the list. Keyed on the edge, so tapping a card to open its
  // session (which happens with the deck already up) is untouched.
  const overlay = props.overlay
  const wasOverlay = useRef(overlay)
  useEffect(() => {
    // Mount is not an edge: `initialOpenLabel` restores a saved session on a
    // reload, and clearing here would throw that away every time.
    if (wasOverlay.current === overlay) return
    wasOverlay.current = overlay
    setOpenLabelState(null)
  }, [overlay])

  // "Your turn" is unread state, per surface: opening this sheet spends it.
  // Marked off the RAW session so a fresh ping while the sheet is open on that
  // session is also consumed.
  const [seenIdle, setSeenIdle] = useState<ReadonlyMap<string, number>>(() => new Map())
  useEffect(() => {
    const at = open?.idleSince
    if (at === undefined) return
    const key = open!.stated ?? open!.label
    setSeenIdle((prev) => ((prev.get(key) ?? -1) >= at ? prev : new Map(prev).set(key, at)))
  }, [open])

  useEffect(() => {
    if (!focusedFrom) return
    const match = props.sessions.find((s) => sessionMatchesFrom(s, focusedFrom))
    if (match) setOpenLabel(match.label)
    if (match || props.sessions.length > 0) onFocusedFromConsumed?.()
  }, [focusedFrom, props.sessions, onFocusedFromConsumed])

  // Newest activity first, via the same shared sort the Mac panel runs. The
  // wire order is by open time, which read as alphabetical only because that
  // was the order the agents happened to start in.
  // Same matcher the Mac pane runs, so a query that finds an agent there finds
  // it here. `now` is 0 on purpose: the haystack holds no age, and pinning it
  // keeps the minute tick from re-running every search.
  const term = query.trim()
  const matching = term
    ? props.sessions.filter((s) => matchesSession(sessionHaystack(s, sessionRow(s, 0)), term))
    : props.sessions

  const cards = matching.map((raw) => {
    // The STATED name, the same join ipc/agent-relay.ts counts by. A
    // session that never named itself matches nothing and stays at rest.
    const from = raw.stated ?? raw.label
    const session = withSeenIdle(raw, seenIdle.get(from))
    const activity = sessionActivity(from, [...props.pending, ...(props.previous ?? [])])
    return {
      entry: sessionEntry(session, activity, now),
      waiting: props.pending.filter((r) => senderMatchKey(r.params.from) === senderMatchKey(from))
        .length
    }
  })
  // The chip runs on the SEEN-filtered entry, so a hand-back you already opened
  // drops off it -- the chip answers "who is still waiting on me", not "who
  // ever finished". Same predicate the Mac pane's chips use.
  // A quiet session renders as its own name and nothing else, which is what
  // makes it noise in a list of 43. `sessionSpoke` carries the reasoning.
  const spoken = props.archived ? cards : cards.filter((c) => sessionSpoke(c.entry))

  const handedBack = spoken.filter((c) => passesFilters(c.entry, ['your-turn']))
  const handedBackCount = handedBack.length
  const showHandedBack = !props.archived && handedBackOnly && handedBackCount > 0
  const chipped = showHandedBack ? handedBack : spoken

  // Every folder the list could show, from the same `groupKeyFor` the Mac pane
  // groups by -- so a folder named here is one a card visibly states. Built off
  // the UNFILTERED cards: reading it off the filtered list would leave the
  // picker holding only the folder already picked, with no way back.
  const folders = [...new Set(spoken.map((c) => groupKeyFor(c.entry, 'folder')))].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' })
  )
  // A pinned folder whose last agent just closed would otherwise filter to
  // nothing, with no folder left in the picker to explain it.
  const pinned = folders.includes(folder) ? folder : ''
  const inFolder = pinned
    ? chipped.filter((c) => groupKeyFor(c.entry, 'folder') === pinned)
    : chipped
  const projectGroups = groupByProjectName(
    sortEntries(
      inFolder.map((c) => c.entry),
      'recent'
    ),
    (e) => cards.find((c) => c.entry === e)?.waiting ?? 0
  )
  const order = projectGroups.flatMap((g) => g.entries)
  const showProjectHeads =
    projectGroups.length > 1 || projectGroups.some((g) => g.project !== undefined)

  if (open) {
    const from = open.stated ?? open.label
    const waiting = props.pending.filter(
      (r) => senderMatchKey(r.params.from) === senderMatchKey(from)
    ).length
    // Step the open sheet along the SAME order the list is showing, so "next"
    // means the row under the one you came from. An open session that the
    // filter excludes sits at -1, where both arrows go absent rather than
    // jumping somewhere the list never offered.
    const at = order.findIndex((e) => e.session.label === open.label)
    const step = (delta: number): (() => void) | undefined => {
      const next = at < 0 ? undefined : order[at + delta]
      return next ? () => setOpenLabel(next.session.label) : undefined
    }
    const mine = (rows: RelayRequestWire[]): RelayRequestWire[] =>
      rows
        .filter((r) => senderMatchKey(r.params.from) === senderMatchKey(from))
        .sort((a, b) => b.createdAt - a.createdAt)
    // The sheet's story, which follows the Previous tab and so drops notify.
    const history = mine([...props.pending, ...(props.previous ?? [])])
    // The full-screen reading, which does NOT. An agent that has only ever sent
    // notifications has an empty `previous`, so sharing one list here rendered
    // nothing in chat AND raw -- the notifications are the conversation.
    const fullHistory = props.settled ? mine([...props.pending, ...props.settled]) : history
    const detail = (
      <SessionDetail
        session={open}
        onPrev={step(-1)}
        onNext={step(1)}
        history={history}
        waiting={waiting}
        pendingIds={new Set(props.pending.map((r) => r.id))}
        onRespond={props.onRespond}
        imageSrc={props.imageSrc}
        onPickPhoto={props.onPickPhoto}
        now={now}
        preview={previews?.[open.label]}
        previewAt={previewAges?.[open.label]}
        peekOutcome={peekOutcome?.label === open.label ? peekOutcome : null}
        flashRequestId={props.flashRequestId}
        onFlashConsumed={props.onFlashConsumed}
        onBack={() => setOpenLabel(null)}
        backLabel={props.overlay ? CONFIG.UI_LABELS.SWIPE_DECK_BACK : undefined}
        onPeek={onPeek}
        onReply={onReply}
        onStop={props.onStop}
        onAttach={props.onAttach}
        mic={props.mic}
        suggestions={props.suggestions}
        onRequestSuggestions={props.onRequestSuggestions}
        onReveal={
          waiting > 0
            ? () => {
                setOpenLabel(null)
                props.onReveal(from)
              }
            : undefined
        }
        // Gated on the same predicate the Mac's button uses, so a session with
        // no addressable origin shows no button rather than one that dead-ends.
        onGoTo={
          props.onGoTo && isOriginResolvable(open.origin)
            ? () => props.onGoTo?.(open.label)
            : undefined
        }
        goToFailed={props.goToFailed?.has(open.label)}
        onOpenFull={() => setFullOpen(true)}
        onOpenScreen={props.onOpenScreen}
        mirrorOn={props.mirrorOn}
        screen={
          props.screen && {
            ...props.screen,
            pane: undefined,
            // No pane to zoom on a plain terminal, and a button that silently
            // does nothing is worse than no button.
            zoomed: props.zoomed?.[open.label],
            onZoom:
              props.onZoom && open.origin?.tmuxPane
                ? (on: boolean) => props.onZoom?.(open.label, on)
                : undefined
          }
        }
        archived={props.archived}
        onArchive={
          props.onArchive
            ? () => {
                if (props.onArchive?.(open)) setOpenLabel(null)
              }
            : undefined
        }
      />
    )
    // Opened from the swipe deck, the detail is a layer OVER it rather than the
    // pane underneath: the deck is full-screen, so rendering in place would put
    // this behind it and force the deck closed to show it -- which is what used
    // to happen, and why dismissing the detail stranded you on the list instead
    // of the card you tapped. Portalled to `body` so the deck's own stacking
    // context cannot trap it.
    // The full-screen reading renders OVER the sheet rather than replacing it:
    // collapsing has to land you back on the agent you were reading, and an
    // unmounted sheet would have lost its scroll position and its draft.
    const layered = (
      <>
        {detail}
        <SessionFullScreen
          open={fullOpen}
          session={open}
          history={fullHistory}
          now={now}
          onCollapse={() => setFullOpen(false)}
          imageSrc={props.imageSrc}
          onReply={onReply}
          onStop={props.onStop}
          onAttach={props.onAttach}
          sent={props.sent?.[open.label]}
          onSentGet={props.onSentGet}
          // Same gate as the sheet's copy above: a session with no addressable
          // origin shows no button rather than one that dead-ends.
          onGoTo={
            props.onGoTo && isOriginResolvable(open.origin)
              ? () => props.onGoTo?.(open.label)
              : undefined
          }
          goToFailed={props.goToFailed?.has(open.label)}
          // The pane is ONE shared element and exactly one surface may mount it
          // (TouchpadLayout: a second mount drops the stream). This layer paints
          // over the sheet, so while it is up it is the surface the picture
          // belongs on -- the sheet's copy below withholds it for the same
          // reason. Handed the toggle too, so turning the screen on happens here
          // instead of closing out to the deck.
          screen={
            fullOpen && props.screen
              ? { on: props.screen.on, onToggle: props.screen.onToggle }
              : undefined
          }
          mic={props.mic}
          suggestions={props.suggestions}
          onRequestSuggestions={props.onRequestSuggestions}
        />
        {props.screen?.on && props.screen.pane && (
          <div
            ref={screenRef}
            className="sessionScreenFloat"
            style={{
              width: `${screenFloat.rect.w}px`,
              aspectRatio: screenAspect,
              transform: `translate3d(${screenFloat.rect.x}px, ${screenFloat.rect.y}px, 0)`
            }}
          >
            {props.screen.pane}
          </div>
        )}
        {props.screen?.on &&
          props.screen.controls &&
          createPortal(
            <div className="sessionScreenControlsFloat proRoot" {...themeData}>
              {props.screen.controls}
            </div>,
            document.body
          )}
      </>
    )
    return props.overlay
      ? createPortal(<div className="codeSessionDetailOver">{layered}</div>, document.body)
      : layered
  }

  // The whole pane is empty, so this is a zero state and takes .codeEmpty --
  // the same centred icon/headline/body the Needs-you tab uses one tap away.
  // It used to render .historyEmpty, which is the INLINE-note class: bare grey
  // text pinned top-left in a full-height pane, beside a sibling tab that was
  // fully designed.
  if (props.sessions.length === 0) {
    return (
      <div className="codeEmpty">
        <div className="codeEmptyIcon" aria-hidden="true">
          <Terminal size={20} strokeWidth={1.75} />
        </div>
        <p className="codeEmptyHeadline">
          {props.archived ? 'No archived sessions' : CONFIG.UI_LABELS.CODE_SESSIONS_EMPTY_HEADLINE}
        </p>
        <p className="codeEmptyBody">
          {props.archived
            ? 'Sessions you archive will appear here. Restore one to bring it back.'
            : (props.hint ?? CONFIG.UI_LABELS.CODE_SESSIONS_EMPTY_BODY)}
        </p>
        {props.footer}
      </div>
    )
  }

  // Hidden until pulled for. The top of the list is where the agent you want
  // usually already is, so the box stays out of the way until the gesture says
  // otherwise. Kept up while a query is live, or clearing the field would drop
  // the box out from under the thumb that was typing in it.
  const searchable = props.sessions.length > CONFIG.AGENT_RELAY.SESSION_SEARCH_MIN
  const showSearch = searchable && (pulled || term !== '')

  return (
    <div
      className="codeSessions"
      role="list"
      ref={setListEl}
      // Scrolling down into the list puts it away again -- it was pulled for a
      // name, and once you are reading rows instead it is only taking room.
      onScroll={(e) => {
        if (e.currentTarget.scrollTop > CONFIG.PHONE_REMOTE.SESSION_SEARCH_PULL_PX) setPulled(false)
      }}
    >
      {showSearch && (
        <div className="codeSessionSearch">
          <Search size={14} strokeWidth={2.5} aria-hidden="true" />
          <input
            className="codeSessionSearchInput"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={CONFIG.UI_LABELS.CODE_SESSIONS_SEARCH}
            aria-label="Search agents"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          {query && (
            <Button
              variant="bare"
              className="codeSessionSearchClear"
              type="button"
              aria-label="Clear search"
              onClick={() => setQuery('')}
            >
              <X size={14} strokeWidth={2.5} />
            </Button>
          )}
        </div>
      )}

      {/* Only shows once something has actually handed back, so a fresh list
          carries no control for a state that has never happened. The count sits
          on the chip because it is the reason to tap it. */}
      {(handedBackCount > 0 || folders.length > 1) && (
        <div className="codeSessionChips">
          {handedBackCount > 0 && (
            <div className="codeSessionChipTabs" role="tablist">
              <Button
                variant="bare"
                className="codeSessionChipTab"
                role="tab"
                type="button"
                aria-selected={showHandedBack}
                data-active={showHandedBack || undefined}
                onClick={() => setHandedBackOnly(true)}
              >
                {SESSION_FILTER_LABELS['your-turn']}
                {handedBackCount > 0 && (
                  <span className="codeTabCount" data-neutral="">
                    {handedBackCount}
                  </span>
                )}
              </Button>
              <Button
                variant="bare"
                className="codeSessionChipTab"
                role="tab"
                type="button"
                aria-selected={!showHandedBack}
                data-active={!showHandedBack || undefined}
                onClick={() => setHandedBackOnly(false)}
              >
                {CONFIG.UI_LABELS.CODE_SESSIONS_FILTER_ALL}
              </Button>
            </div>
          )}
          {/* Only once there are two folders to choose between -- over a single
              checkout the control cannot change what is on screen. A native
              select on purpose, the same call the Needs-you view bar makes:
              iOS opens its own wheel, which beats any sheet we could build and
              needs no keyboard. */}
          {folders.length > 1 && (
            <label className="codeFolderFilter" data-active={pinned ? '' : undefined}>
              <Filter size={13} strokeWidth={2.5} aria-hidden="true" />
              <span className="codeFolderFilterText">
                {pinned || CONFIG.UI_LABELS.CODE_SESSIONS_FOLDER_FILTER}
              </span>
              <select
                className="codeFolderFilterSel"
                value={pinned}
                onChange={(e) => setFolder(e.target.value)}
                aria-label="Filter by folder"
              >
                <option value="">{CONFIG.UI_LABELS.CODE_SESSIONS_FOLDER_ALL}</option>
                {folders.map((f) => (
                  <option key={f} value={f}>
                    {f || CONFIG.UI_LABELS.CODE_SESSIONS_FOLDER_NONE}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}

      {order.length === 0 && (
        <p className="historyEmpty">
          {term
            ? `None of your ${props.sessions.length} agents match "${term}".`
            : // Names the folder AND which chip is on: with both narrowing the
              // list, an unqualified "nothing here" reads as the folder being
              // empty when it is the chip that emptied it.
              pinned
              ? showHandedBack
                ? `No agent in ${pinned} has handed back to you yet.`
                : `No agents open in ${pinned}.`
              : CONFIG.UI_LABELS.CODE_SESSIONS_FILTER_NONE}
        </p>
      )}

      {projectGroups.map((group) => (
        <div className="codeProjectGroup" key={group.name}>
          {showProjectHeads && (
            <div className="codeProjectHead">
              <ProjectMark project={group.project} />
              <span className="codeProjectHeadName">{group.name}</span>
              <span className="codeProjectHeadCount">{group.entries.length}</span>
            </div>
          )}
          {group.entries.map((entry, i) => {
            const card = cards.find((c) => c.entry === entry)!
            return (
              <SessionCard
                key={`${entry.session.label}-${i}`}
                session={entry.session}
                waiting={card.waiting}
                lastSummary={entry.activity.lastSummary}
                derivedSubject={entry.activity.derivedSubject}
                progress={entry.session.progress}
                now={now}
                onOpen={() => setOpenLabel(entry.session.label)}
              />
            )
          })}
        </div>
      ))}
      {props.footer}
      {/* Readout off; probe still logs to the Mac. Uncomment to measure again. */}
      {/* {probeReport && createPortal(<pre className="codeWidthProbe">{probeReport}</pre>, document.body)} */}
    </div>
  )
}

type SessionProject = AgentRelaySessionInfo['project']
function groupByProjectName<E extends { session: AgentRelaySessionInfo; activity: { lastAt?: number } }>(
  entries: E[],
  waitingOf: (entry: E) => number
): { name: string; project: SessionProject; entries: E[] }[] {
  const groups = new Map<string, { name: string; project: SessionProject; entries: E[] }>()
  for (const entry of entries) {
    const project = entry.session.project
    const name = project?.name ?? CONFIG.UI_LABELS.CODE_AGENTS_NO_PROJECT
    const group = groups.get(name)
    if (group) group.entries.push(entry)
    else groups.set(name, { name, project, entries: [entry] })
  }
  const waiting = (g: { entries: E[] }): number => g.entries.reduce((n, e) => n + waitingOf(e), 0)
  const latest = (g: { entries: E[] }): number =>
    g.entries.reduce((max, e) => Math.max(max, e.activity.lastAt ?? e.session.since ?? 0), 0)
  return [...groups.values()].sort((a, b) => {
    if (!a.project !== !b.project) return a.project ? -1 : 1
    return (waiting(b) > 0 ? 1 : 0) - (waiting(a) > 0 ? 1 : 0) || latest(b) - latest(a)
  })
}

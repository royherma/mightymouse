/** One agent on its own -- the sheet opened from a row in SessionList. */

import { useEffect, useRef, useState } from 'react'
import {
  ChevronRight,
  ChevronLeft,
  SendHorizontal,
  Mic,
  Loader2,
  RefreshCw,
  ExternalLink,
  MonitorUp,
  MonitorSmartphone,
  Maximize2,
  Minimize2,
  Archive,
  ArchiveRestore,
  Sparkles,
  Square
} from 'lucide-react'
import { Button } from '@shared/ui/Button'
import { MicWaveform } from './MicWaveform'
import type { SessionPeekOutcome, SessionMicProps } from './SessionList'
import { sessionRow, sessionCanReply } from '@shared/relay-status'
import { cardSummary, resolvedOutcome, sessionActivity } from '@shared/relay-cards'
import { cardSuggestKey, suggestContext } from '@shared/swipe-suggest'
import type { Suggestion } from '@shared/swipe-suggest'
import { CONFIG } from '@shared/config'
import { ProgressMeter, PHONE_METER_CLASSES } from '@shared/progress-ring'
import type { AgentRelaySessionInfo } from '@shared/types'
import { ProjectIcon } from '../../../renderer/src/components/ProjectIcon'
import type { RelayRequestWire, RelayResponseWire } from '@shared/phone-remote-protocol'
import { RelayCard } from './RelayCard'
import { AttachPhotoButton } from './AttachPhotoButton'
import type { AttachState } from './AttachPhotoButton'

// The phone has no console the Mac can read, so render-state diagnostics ride
// the open WS via App's debugLog sink -- same pattern as setKbTraceSink.
let gateLog: ((message: string) => void) | null = null
export function setSessionDetailLogSink(sink: (message: string) => void): void {
  gateLog = sink
}

/** A row of the facts table. Absent values render NOTHING -- on a phone screen a
 *  table of "unknown" costs more than the shorter table it replaces. */
/** Exported because the full-screen header's expanded panel renders the SAME
 *  list -- a second fact component there would be two spellings of one thing,
 *  and the .codeSessionFact* rules are unscoped so they resolve on both. */
export function Fact(props: {
  label: string
  value?: string
  mono?: boolean
  /** Drawn before the value. Only the host-app row uses it. */
  mark?: React.ReactNode
}): React.JSX.Element | null {
  if (!props.value) return null
  return (
    <div className="codeSessionFact">
      <span className="codeSessionFactLabel">{props.label}</span>
      <span className="codeSessionFactValue" data-mono={props.mono ? '' : undefined}>
        {props.mark}
        {props.value}
      </span>
    </div>
  )
}

/** Exact rather than the row's coarse "5m": the row answers "new or
 *  long-running", this answers "how long exactly", which is why it was opened. */
export function exactUptime(since: number | undefined, now: number): string | undefined {
  if (!since) return undefined
  const secs = Math.max(0, Math.floor((now - since) / 1000))
  const mins = Math.floor(secs / 60)
  const hours = Math.floor(mins / 60)
  if (secs < 60) return `${secs}s`
  if (mins < 60) return `${mins}m`
  if (hours < 24) return `${hours}h ${mins % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/** Wall-clock birth, matching the Mac's sheet. No weekday here -- a phone row
 *  has half the width and the date carries the same answer without it. */
export function startedAt(since: number | undefined): string | undefined {
  if (!since) return undefined
  return new Date(since).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

export function shortWhen(at: number, now: number): string {
  const mins = Math.floor((now - at) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}

/** One agent on its own. It carries the Mac sheet's "go to this agent", plus
 *  the phone's own answer to what that used to be missing: raising a window you
 *  cannot see is only half an act, so the second button puts that screen on the
 *  phone. Everything else is the same facts from the same formatter. */
export type SessionDetailProps = {
  session: AgentRelaySessionInfo
  history: RelayRequestWire[]
  /** The card tapped on Previous, washed once so the row you came from is findable. */
  flashRequestId?: string | null
  onFlashConsumed?: () => void
  waiting: number
  now: number
  preview?: string
  /** When `preview` last changed on the Mac. Only meaningful when the preview is
   *  what's being shown -- a card carries its own `createdAt`. */
  previewAt?: number
  peekOutcome?: SessionPeekOutcome | null
  onBack: () => void
  /** What `onBack` actually returns you to. Defaults to the list; the swipe deck
   *  passes its own, because back from there lands on the card, not the list. */
  backLabel?: string
  /** Open the agent above / below this one in the list you came from. Undefined
   *  at either end, so the arrow is absent rather than a button that does
   *  nothing. */
  onPrev?: () => void
  onNext?: () => void
  onReveal?: () => void
  /** Raise this agent's window on the Mac. Undefined once the origin has
   *  nothing addressable, so the button is absent rather than dead. */
  onGoTo?: () => void
  /** Null while nothing has come back, then the Mac's verdict on the last
   *  attempt -- the phone cannot see the window it just asked for. */
  goToFailed?: boolean
  /** Read this agent's whole history full screen, with the Chat/Raw toggle.
   *  Undefined where the host has no such surface, so the title stays plain
   *  text rather than becoming a button that does nothing. */
  onOpenFull?: () => void
  /** Start the screen mirror. The same act as the deck's toggle: what this adds
   *  is doing it from the agent you were already reading. */
  onOpenScreen?: () => void
  mirrorOn?: boolean
  /** The live Mac pane + its toggle, shown inline the way the swipe deck shows
   *  it. Present only where the single `useMirror` lives, so this sheet can
   *  never open a second stream of its own. */
  screen?: {
    on: boolean
    onToggle: () => void
    pane?: React.ReactNode
    /** Fills this agent's tmux window with its own pane on the Mac. Undefined
     *  where the agent has no pane to zoom -- a plain terminal, or a proxy too
     *  old to report one. */
    zoomed?: boolean
    onZoom?: (on: boolean) => void
  }
  onArchive?: () => void
  archived?: boolean
  onPeek?: (label: string) => void
  onReply?: (label: string, text: string) => void
  onStop?: (label: string) => void
  /** Send a photo along with the reply. Absent where there is no socket to send
   *  it on -- the Mac-side host renders this same sheet off its own store. */
  onAttach?: (label: string, file: File) => Promise<boolean>
  /** Ids in `history` still waiting on an answer. Those rows render the real
   *  card with its buttons instead of a text summary, so the session screen is
   *  where a card gets answered -- there is no second screen to page to. */
  pendingIds?: ReadonlySet<string>
  onRespond?: (requestId: string, response: RelayResponseWire) => void
  imageSrc?: (requestId: string) => string
  onPickPhoto?: (requestId: string, file: File) => Promise<boolean>
  mic?: SessionMicProps
  /** The same map the deck reads, keyed by `cardSuggestKey`. */
  suggestions?: Record<string, Suggestion[]>
  /** Ask the Mac what this agent could be told next. Unlike the deck, nothing
   *  here fires on its own -- the user presses the button. */
  onRequestSuggestions?: (label: string, context: string, refresh?: boolean) => void
}

function SessionDetail(props: SessionDetailProps): React.JSX.Element {
  const { session, history, waiting, now, preview, onBack, onReveal, onPeek, onReply } = props
  const onRespond = props.onRespond ?? ((): void => {})
  const { onGoTo, goToFailed, onOpenScreen, mirrorOn, screen } = props
  const { onOpenFull } = props
  const { onMicDown, onMicUp, dictating, recording, micStreamRef, draftPatch, onDraftConsumed } =
    props.mic ?? {}
  const peekOutcome = props.peekOutcome
  const row = sessionRow(session, now)
  const title = row.name ?? row.repo ?? CONFIG.UI_LABELS.CODE_SESSION_UNNAMED
  const fromCard = history[0] ? cardSummary(history[0]) : ''
  const lastLine = fromCard || preview
  // Stamp the source that actually produced the line above: a card's own
  // createdAt, else when the pane tail last changed. "Is this three minutes or
  // three days old" is the first thing you ask of a state you're replying to.
  const lastAt = fromCard ? history[0]?.createdAt : props.previewAt
  const canReply = row.health !== 'ended' && sessionCanReply(session)
  const [draft, setDraft] = useState('')
  const [attach, setAttach] = useState<AttachState | null>(null)
  const [stoppedAt, setStoppedAt] = useState<number | null>(null)
  const stopHeld = stoppedAt !== null && (session.busySince ?? 0) <= stoppedAt
  const showStop =
    Boolean(props.onStop) && canReply && row.health === 'working' && !stopHeld && !draft.trim() && !attach
  const [factsOpen, setFactsOpen] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // State, not a ref: the effect below must re-run when the button MOUNTS, and a
  // ref's assignment fires no render. See this directory's CLAUDE.md -- keying a
  // mic listener effect on anything but the node is a bug that shipped twice.
  const [micEl, setMicEl] = useState<HTMLButtonElement | null>(null)
  // Tap time of the refresh the user is still waiting on, null when idle. The
  // spin resolves on the Mac's next answer, never on a timer alone -- a bare
  // animation duration would say "done" while the pane tail was still in flight.
  const [peekingSince, setPeekingSince] = useState<number | null>(null)

  // Keyed on the Mac's stated verdict, not on `previewAt`: an unchanged pane
  // moves no timestamp, so the clock cannot tell "nothing new" from "never
  // answered". The timeout is only a backstop for a Mac that went away.
  const peekAt = peekOutcome?.at
  useEffect(() => {
    if (peekingSince === null) return
    if (peekAt !== undefined && peekAt >= peekingSince) {
      setPeekingSince(null)
      return
    }
    const done = setTimeout(() => setPeekingSince(null), CONFIG.AGENT_RELAY.PANE_PEEK_SPIN_MAX_MS)
    return () => clearTimeout(done)
  }, [peekingSince, peekAt])

  // Shown for a beat after a manual refresh, then gone. Only a verdict from the
  // tap the user is watching counts -- the background poll sends none.
  const [verdict, setVerdict] = useState<SessionPeekOutcome | null>(null)
  useEffect(() => {
    if (peekOutcome === null || peekOutcome === undefined) return
    setVerdict(peekOutcome)
    const clear = setTimeout(() => setVerdict(null), CONFIG.AGENT_RELAY.PANE_PEEK_VERDICT_MS)
    return () => clearTimeout(clear)
  }, [peekOutcome])

  useEffect(() => {
    setDraft('')
  }, [session.label])

  // Non-passive, for the same reason ChatSheet's mic is: React's onPointerDown
  // is passive, so it cannot preventDefault() the synthetic mouse events iOS
  // fires after a touch, which stomp the toggled state on lift.
  useEffect(() => {
    const el = micEl
    if (!el || !onMicDown || !onMicUp) return
    const down = (e: PointerEvent): void => {
      e.preventDefault()
      onMicDown()
    }
    const up = (e: PointerEvent): void => {
      e.preventDefault()
      onMicUp()
    }
    el.addEventListener('pointerdown', down, { passive: false })
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
    return () => {
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
    }
  }, [micEl, onMicDown, onMicUp])

  // Append rather than replace: half-typing then dictating the rest is normal,
  // and clobbering that text would be unrecoverable.
  useEffect(() => {
    if (!draftPatch) return
    setDraft((prev) => (prev.trim() === '' ? draftPatch : `${prev.trimEnd()} ${draftPatch}`))
    onDraftConsumed?.()
  }, [draftPatch, onDraftConsumed])

  // Re-peeked on an interval while open: the agent keeps typing after the
  // sheet mounts, and a one-shot peek shows a snapshot that only gets staler.
  // Every peek spins the button, not just the tapped one -- the automatic ones
  // fetch the same pane, so a still icon during them reads as "nothing loading".
  useEffect(() => {
    if (!session.origin?.tmuxPane) return
    const peek = (): void => {
      setPeekingSince((prev) => prev ?? Date.now())
      onPeek?.(session.label)
    }
    peek()
    const tick = setInterval(peek, CONFIG.AGENT_RELAY.PANE_PREVIEW_POLL_MS)
    return () => clearInterval(tick)
  }, [session.label, session.origin?.tmuxPane, onPeek])

  const submit = (): void => {
    const text = draft.trim()
    // A photo IS a message, so an attachment with no words still sends -- the Mac
    // pairs the two by label and puts the path ahead of the (empty) text.
    if ((!text && !attach) || !canReply) return
    onReply?.(session.label, text)
    setDraft('')
    setAttach(null)
  }

  // Asked on a TAP, never on mount: the deck prefetches because a card is one
  // gesture from being answered, where opening an agent to read it is not a
  // request for a model run on every open.
  const onRequestSuggestions = props.onRequestSuggestions
  // The subject comes from the CARDS, exactly as the deck's does. Only 4 of 1264
  // sessions ever declare a TLDR, so keying on `session.tldr` alone left the
  // button hidden on every real agent -- measured on device, not reasoned.
  // Falls back to the session's name: most sessions have no cards left in the
  // capped wire snapshot, and the Mac builds the real context itself -- the
  // phone's string is a cache key plus a hint, so a name beats no button.
  // The tapped card must be reachable, and the 8-row cap can bury it: a row
  // answered a week ago is exactly the one you'd tap to remember what it was.
  // Kept in place when it already fits, appended when it doesn't -- never
  // hoisted, which would move the row under the finger that arrived.
  const flashId = props.flashRequestId ?? null
  const canAnswer = Boolean(props.onRespond)
  const pendingIds = props.pendingIds
  // Answerable only where a responder was wired: on a host without one the
  // card would render its buttons and swallow every tap.
  const live = canAnswer && pendingIds ? history.filter((r) => pendingIds.has(r.id)) : []
  const log = live.length > 0 ? history.filter((r) => !pendingIds?.has(r.id)) : history
  const capped = log.slice(0, 8)
  const shown =
    flashId && log.some((r) => r.id === flashId) && !capped.some((r) => r.id === flashId)
      ? [...capped, log.find((r) => r.id === flashId)!]
      : capped
  const flashRef = useRef<HTMLDivElement | null>(null)
  const liveRef = useRef<HTMLHeadingElement | null>(null)
  useEffect(() => {
    if (!flashId) return
    flashRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [flashId])

  const activity = sessionActivity(session.stated ?? session.label, history)
  const derivedSubject = activity.derivedSubject ?? row.name ?? row.repo
  const suggestKey = cardSuggestKey({ label: session.label, session, subject: derivedSubject })
  const suggestions = suggestKey ? props.suggestions?.[suggestKey] : undefined
  // `worthSuggesting` is the DECK's gate and does not apply here: it refuses a
  // stale session (nothing new will arrive to triage) and one with a pending ask
  // (the card already carries chips). Neither holds on this screen -- 52 of the
  // 63 live sessions are stale and every one of them is still replyable, so
  // reusing that gate hid the button on all but 11. If you can type to it, you
  // can ask what to type; a context to suggest against is the whole condition.
  const canSuggest = Boolean(onRequestSuggestions) && canReply && Boolean(suggestKey)
  // One line per open stating whether the button is on screen and which gate
  // hid it -- readable in /tmp/mightymouse-dev.log as [suggest-gate].
  useEffect(() => {
    gateLog?.(
      `[suggest-gate] ${session.label} show=${canSuggest} canReply=${canReply} subject=${Boolean(
        derivedSubject
      )} handler=${Boolean(onRequestSuggestions)}`
    )
  }, [session.label, canSuggest, canReply, derivedSubject, onRequestSuggestions])
  // When the ask the user is watching went out, null once answered. Same shape
  // as `peekingSince` above, and for the same reason: the reply is what ends the
  // spin, and the timeout is only the backstop for a Mac that went away.
  const [suggestingSince, setSuggestingSince] = useState<number | null>(null)
  useEffect(() => {
    if (suggestingSince === null) return
    if (suggestions !== undefined) {
      setSuggestingSince(null)
      return
    }
    const done = setTimeout(
      () => setSuggestingSince(null),
      CONFIG.SUGGESTIONS.PREDICT_TIMEOUT_MS
    )
    return () => clearTimeout(done)
  }, [suggestingSince, suggestions])

  // A new agent's chips are its own: the map is keyed per session, but the spin
  // is not, and it would otherwise carry across the prev/next arrows.
  useEffect(() => {
    setSuggestingSince(null)
  }, [session.label])

  const askSuggestions = (refresh: boolean): void => {
    if (!onRequestSuggestions || suggestingSince !== null) return
    const context = suggestContext(session, derivedSubject)
    if (!context) return
    setSuggestingSince(Date.now())
    onRequestSuggestions(session.label, context, refresh)
  }

  return (
    <div className="codeSessionDetail">
      <div className="codeSessionDetailBar">
        <Button variant="bare" className="codeSessionBack" onClick={onBack} type="button">
          <ChevronLeft size={14} strokeWidth={2.5} />
          {props.backLabel ?? 'All sessions'}
        </Button>
        <div className="codeSessionStep">
          {/* Only while the screen is up: zooming a pane you cannot see changes
              the Mac and shows the phone nothing. */}
          {screen?.on && screen.onZoom && (
            <Button
              variant="bare"
              className="codeSessionStepBtn codeSessionZoomBtn"
              type="button"
              aria-label={screen.zoomed ? 'Show the other agents' : 'Fill the screen with this agent'}
              aria-pressed={screen.zoomed === true}
              data-on={screen.zoomed ? '' : undefined}
              onClick={() => screen.onZoom?.(!screen.zoomed)}
            >
              {screen.zoomed ? (
                <Minimize2 size={16} strokeWidth={2.5} />
              ) : (
                <Maximize2 size={16} strokeWidth={2.5} />
              )}
            </Button>
          )}
          {/* Beside the pager rather than down with the buttons: this toggles
              what is ON SCREEN, so it belongs in the bar that owns the view,
              not in the list of things to do to the agent. */}
          {screen && (
            <Button
              variant="bare"
              className="codeSessionStepBtn codeSessionScreenBtn"
              type="button"
              aria-label={screen.on ? 'Hide the Mac screen' : 'Show the Mac screen'}
              aria-pressed={screen.on}
              data-on={screen.on ? '' : undefined}
              onClick={screen.onToggle}
            >
              <MonitorSmartphone size={16} strokeWidth={2.5} />
            </Button>
          )}
          <Button
            variant="bare"
            className="codeSessionStepBtn"
            type="button"
            aria-label="Previous agent"
            disabled={!props.onPrev}
            onClick={props.onPrev}
          >
            <ChevronLeft size={16} strokeWidth={2.5} />
          </Button>
          <Button
            variant="bare"
            className="codeSessionStepBtn"
            type="button"
            aria-label="Next agent"
            disabled={!props.onNext}
            onClick={props.onNext}
          >
            <ChevronRight size={16} strokeWidth={2.5} />
          </Button>
        </div>
      </div>

      {screen?.pane}

      <div className="codeSessionDetailBody">
        <div className="codeSessionDetailHead">
          <span className="codeSessionFace" aria-hidden="true">
            <ProjectMark project={session.project} />
          </span>
          {/* The title is the way in to the full conversation -- the agent's
              name is what you tap to read everything it has said. Plain text
              where no such surface exists, so nothing looks tappable that is
              not. */}
          {onOpenFull ? (
            <Button
              variant="bare"
              className="codeSessionDetailTitle codeSessionTitleBtn"
              type="button"
              aria-label={`Read the whole conversation with ${title}`}
              onClick={onOpenFull}
            >
              {title}
              <ChevronRight size={14} strokeWidth={2.5} />
            </Button>
          ) : (
            <h3 className="codeSessionDetailTitle">{title}</h3>
          )}
          {verdict && verdict.outcome !== 'changed' ? (
            <span className="codeSessionPeekVerdict" role="status">
              {verdict.outcome === 'unchanged'
                ? CONFIG.UI_LABELS.CODE_SESSION_PEEK_UNCHANGED
                : CONFIG.UI_LABELS.CODE_SESSION_PEEK_UNAVAILABLE}
            </span>
          ) : null}
          {session.origin?.tmuxPane ? (
            <Button
              variant="bare"
              className="codeSessionRefresh"
              type="button"
              aria-label={CONFIG.UI_LABELS.CODE_SESSION_REFRESH}
              aria-busy={peekingSince !== null}
              data-spinning={peekingSince !== null ? '' : undefined}
              onClick={() => {
                if (peekingSince !== null) return
                setPeekingSince(Date.now())
                onPeek?.(session.label)
              }}
            >
              <RefreshCw size={15} strokeWidth={2.5} />
            </Button>
          ) : null}
        </div>

        {/* What this session is ABOUT, directly under the title. It used to sit
            twelfth in the collapsed Details list, which took two taps to reach --
            the one field that tells two panes on one checkout apart. */}
        {row.tldr && (
          <div className="codeSessionDetailTldr">{row.tldr}</div>
        )}

        {/* Follows the RECAP because it measures the work that line just
            described. The same compact meter every other surface draws -- a
            full-width bar cost a whole row on a phone sheet for one number.
            Read off the SESSION, not the cards: the agent declares how far
            along IT is, so a card this sheet fails to match must not be able to
            blank the figure. */}
        {session.progress !== undefined && (
          <div className="codeSessionProgress">
            <span className="codeSessionProgressLabel">Progress</span>
            <ProgressMeter value={session.progress} classes={PHONE_METER_CLASSES} />
          </div>
        )}

        <div className="codeSessionPlace codeSessionDetailPlace" data-health={row.health}>
          {session.project && (
            <span className="codeSessionProject">
              {session.project.name}
            </span>
          )}
          {row.name && row.repo && <b className="codeSessionRepo">{row.repo}</b>}
          {row.branch && <span className="codeSessionBranch">{row.branch}</span>}
          {row.where && <span>{row.where}</span>}
          <span className="codeSessionDetailState" data-health={row.health}>
            {row.state_text}
          </span>
        </div>

        {/* The last thing the agent said and the box you answer it in are ONE
            block, directly under the title -- the reply is what you came here
            to do, so it sits above the reference facts rather than under them. */}
        <div className="codeSessionThread">
          <div className="codeSessionLastBlock">
            {lastLine || CONFIG.UI_LABELS.CODE_SESSION_LAST_EMPTY}
            {lastLine && lastAt !== undefined && (
              <span className="codeSessionLastWhen">{shortWhen(lastAt, now)}</span>
            )}
          </div>

          {row.health === 'ended' ? (
            <p className="codeSessionNote" id="codeSessionReplyWhy">
              {CONFIG.UI_LABELS.CODE_SESSION_ENDED}
            </p>
          ) : !canReply ? (
            <p className="codeSessionNote" id="codeSessionReplyWhy">
              {CONFIG.UI_LABELS.CODE_SESSION_NO_PANE}
            </p>
          ) : null}
          <div className="chatComposer" data-disabled={canReply ? undefined : ''}>
            <textarea
              ref={inputRef}
              className="chatInput"
              value={draft}
              maxLength={CONFIG.PHONE_REMOTE.CHAT_MESSAGE_MAX_CHARS}
              rows={1}
              disabled={!canReply}
              aria-describedby={canReply ? undefined : 'codeSessionReplyWhy'}
              placeholder={CONFIG.UI_LABELS.CODE_SESSION_REPLY_PLACEHOLDER}
              onChange={(e) => setDraft(e.target.value)}
              // Inside the scroller now, so the keyboard can cover it where the
              // old pinned position could not. iOS shrinks the visual viewport
              // AFTER focus, hence the rAF rather than scrolling on this tick.
              onFocus={() => {
                requestAnimationFrame(() => inputRef.current?.scrollIntoView({ block: 'center' }))
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  submit()
                }
              }}
            />
            {/* Never `disabled`: unmounting the handler mid-gesture strands the
                recorder with no way to stop it. */}
            {onMicDown && micStreamRef && (
              <Button
                variant="bare"
                ref={setMicEl}
                type="button"
                className={`chatMicBtn${recording ? ' chatMicBtnLive' : ''}${
                  dictating ? ' chatMicBtnBusy' : ''
                }`}
                aria-label={recording ? 'Stop dictating' : 'Hold to dictate'}
              >
                {dictating ? (
                  <Loader2 size={17} strokeWidth={2.5} className="chatMicSpin" />
                ) : recording ? (
                  <MicWaveform streamRef={micStreamRef} />
                ) : (
                  <Mic size={17} strokeWidth={2.5} />
                )}
              </Button>
            )}
            {props.onAttach && (
              <AttachPhotoButton
                label={session.label}
                state={attach}
                onState={setAttach}
                onSend={props.onAttach}
                disabled={!canReply}
              />
            )}
            {showStop ? (
              <Button
                variant="bare"
                type="button"
                className="chatSendBtn"
                aria-label={CONFIG.UI_LABELS.CHAT_STOP}
                onClick={() => {
                  props.onStop?.(session.label)
                  setStoppedAt(Date.now())
                }}
              >
                <Square size={12} fill="currentColor" />
              </Button>
            ) : (
              <Button
                variant="bare"
                type="button"
                className="chatSendBtn"
                disabled={!canReply || (!draft.trim() && !attach)}
                aria-label="Send"
                onClick={submit}
              >
                <SendHorizontal size={17} strokeWidth={2.5} />
              </Button>
            )}
          </div>

        </div>

        {/* Its own block under the reply thread. Tapping a chip FILLS the box
            rather than sending -- the deck sends on a chip because the chip is
            the whole answer there; here the person may still want to edit. */}
        {canSuggest && (
            <div className="codeSessionSuggest">
              <Button
                variant="bare"
                className="codeSessionSuggestAsk"
                type="button"
                disabled={suggestingSince !== null}
                aria-busy={suggestingSince !== null}
                onClick={() => askSuggestions(suggestions !== undefined)}
              >
                {suggestingSince !== null ? (
                  <Loader2 size={13} strokeWidth={2.5} className="chatMicSpin" />
                ) : (
                  <Sparkles size={13} strokeWidth={2.5} />
                )}
                {suggestingSince !== null
                  ? CONFIG.UI_LABELS.CODE_SESSION_SUGGEST_BUSY
                  : suggestions !== undefined
                    ? CONFIG.UI_LABELS.CODE_SESSION_SUGGEST_AGAIN
                    : CONFIG.UI_LABELS.CODE_SESSION_SUGGEST}
              </Button>
              {/* An empty array is the Mac's real answer ("nothing worth
                  suggesting"), not a failure -- so it says so, rather than
                  leaving a button that looks like it did nothing. */}
              {suggestions?.length === 0 && suggestingSince === null && (
                <p className="codeSessionNote">{CONFIG.UI_LABELS.CODE_SESSION_SUGGEST_NONE}</p>
              )}
              {suggestingSince === null && suggestions && suggestions.length > 0 && (
                <div className="codeSessionSuggestChips">
                  {suggestions.map((suggestion) => (
                    <Button
                      variant="bare"
                      key={suggestion.text}
                      type="button"
                      className="codeSessionSuggestChip"
                      onClick={() => {
                        setDraft(suggestion.text)
                        inputRef.current?.focus()
                      }}
                    >
                      {/* Its own element, never prepended to the text: the text
                          is what lands in the agent's terminal, and a glyph
                          glued to it would ride along. */}
                      {suggestion.emoji && (
                        <span className="codeSessionSuggestChipEmoji" aria-hidden="true">
                          {suggestion.emoji}
                        </span>
                      )}
                      <span>{suggestion.text}</span>
                    </Button>
                  ))}
                </div>
              )}
            </div>
        )}

        {/* With the cards on this screen the button is a scroll, not a jump --
            leaving the session to answer a card it is already showing is the
            detour this change removes. */}
        {(live.length > 0 || onReveal) && (
          <Button
            variant="bare"
            className="codeSessionAction"
            onClick={live.length > 0 ? () => liveRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }) : onReveal}
            type="button"
          >
            Answer {waiting === 1 ? 'the card' : `all ${waiting} cards`} waiting on you
          </Button>
        )}

        {/* The pair the Mac sheet's single "Go to this agent" becomes on a
            phone: one puts the agent on the Mac's screen, the other puts the
            Mac's screen in your hand. Side by side because they are two halves
            of one question -- which screen do you want to look at. Only the
            first can be absent; mirroring needs no origin. */}
        {(onGoTo || onOpenScreen) && (
          <div className="codeSessionActionRow">
            {onGoTo && (
              <Button
                variant="bare"
                className="codeSessionAction"
                onClick={onGoTo}
                type="button"
                disabled={goToFailed}
              >
                <ExternalLink size={13} strokeWidth={2.5} />
                {goToFailed ? 'Window not found' : 'Open on Mac'}
              </Button>
            )}
            {onOpenScreen && (
              <Button variant="bare" className="codeSessionAction" onClick={onOpenScreen} type="button">
                <MonitorUp size={13} strokeWidth={2.5} />
                {mirrorOn ? 'Go to screen' : 'Watch screen'}
              </Button>
            )}
          </div>
        )}

        <div className="codeSessionFooterRow">
          <Button
            variant="bare"
            className="codeSessionDisclosure"
            type="button"
            aria-expanded={factsOpen}
            onClick={() => setFactsOpen((v) => !v)}
          >
            <ChevronRight size={13} strokeWidth={2.5} data-open={factsOpen || undefined} />
            Details
          </Button>
          {props.onArchive && (
            <Button variant="bare" className="codeSessionFooterBtn" onClick={props.onArchive}>
              {props.archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}
              {props.archived ? 'Restore' : 'Archive'}
            </Button>
          )}
        </div>
        {factsOpen && (
          <div className="codeSessionFacts">
            <Fact label="Working on" value={row.tldr} />
            <Fact label="Name" value={row.name} />
            <Fact label="Harness" value={row.agent} />
            <Fact label="Model" value={row.model} />
            <Fact label="Effort" value={row.effort} />
            <Fact label="Started by" value={session.entrypoint} />
            <Fact label="Project" value={session.project?.name} />
            <Fact label="Repo" value={row.repo} />
            <Fact label="Branch" value={row.branch} />
            <Fact label="Running for" value={exactUptime(session.since, now)} />
            <Fact label="Started" value={startedAt(session.since)} />
            <Fact label="Folder" value={session.cwd} mono />
            <Fact label="Session id" value={session.sessionId} mono />
            {/* Where it physically is, so a card answered from the phone can be
                found on the Mac afterwards. */}
            <Fact
              label="App"
              value={session.hostAppName}
              mark={
                session.hostAppIconPngBase64 ? (
                  <img
                    className="codeSessionFactAppIcon"
                    src={`data:image/png;base64,${session.hostAppIconPngBase64}`}
                    alt=""
                  />
                ) : undefined
              }
            />
            <Fact label="Where" value={session.whereLabel} mono />
          </div>
        )}


        {/* Waiting cards render live, above the log: this screen is the one
            place a card is read, so it has to be the place it is answered. The
            8-row cap never applies to them -- an unanswered card scrolled off
            the bottom is the whole bug. */}
        {live.length > 0 && (
          <>
            <h4 className="codeSessionSection" ref={liveRef}>
              {live.length === 1 ? 'Waiting on you' : `Waiting on you (${live.length})`}
            </h4>
            {live.map((request) => (
              <div
                key={request.id}
                data-request-id={request.id}
                ref={request.id === flashId ? flashRef : undefined}
                onAnimationEnd={request.id === flashId ? props.onFlashConsumed : undefined}
              >
                <RelayCard
                  request={request}
                  // The header already names this agent; a chip per card would
                  // repeat it down the whole screen.
                  showSender={false}
                  onRespond={onRespond}
                  imageSrc={props.imageSrc ?? (() => '')}
                  justOpened={request.id === flashId}
                  onPickPhoto={props.onPickPhoto}
                />
              </div>
            ))}
          </>
        )}

        <h4 className="codeSessionSection">Recent messages</h4>
        {shown.length === 0 ? (
          <p className="historyEmpty">
            {live.length > 0
              ? 'Nothing answered yet in this session.'
              : 'This session has not sent you anything yet.'}
          </p>
        ) : (
          // Oldest first, unlike the newest-first list this arrives as: a
          // conversation is read downward, and a reply printed above the thing
          // it answers reads as two unrelated lines.
          [...shown].reverse().map((request) => (
            <div
              className={`codeSessionExchange${request.id === flashId ? ' justOpened' : ''}`}
              key={request.id}
              data-request-id={request.id}
              ref={request.id === flashId ? flashRef : undefined}
              onAnimationEnd={request.id === flashId ? props.onFlashConsumed : undefined}
            >
              <div className="codeSessionSaid">
                {cardSummary(request)}
                {/* The picture belongs with the words that came with it. A row
                    saying "you approved this" is not a record of the decision
                    if the thing being decided about is missing. */}
                {request.params.hasImage && props.imageSrc && (
                  <img
                    className="codeResolvedImage"
                    src={props.imageSrc(request.id)}
                    alt={request.params.caption ?? 'From your agent'}
                  />
                )}
              </div>
              {/* Only a card that actually settled gets a reply bubble --
                  resolvedOutcome answers a pending card with "Answered", which
                  would put words in the user's mouth. */}
              {request.status !== 'pending' && (
                <div className="codeSessionAnswered">{resolvedOutcome(request)}</div>
              )}
              <span className="codeSessionMsgWhen">{shortWhen(request.createdAt, now)}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

export default SessionDetail

export function ProjectMark({
  project,
  size = 22
}: {
  project: AgentRelaySessionInfo['project']
  size?: number
}): React.JSX.Element {
  const style = { width: size, height: size }
  if (project?.imageBase64) {
    return (
      <img
        className="codeProjectMark"
        style={style}
        src={`data:image/png;base64,${project.imageBase64}`}
        alt=""
      />
    )
  }
  return (
    <span className="codeProjectMark" data-plain={project ? undefined : ''} style={style} aria-hidden>
      <ProjectIcon id={project?.icon} size={Math.round(size * 0.6)} />
    </span>
  )
}

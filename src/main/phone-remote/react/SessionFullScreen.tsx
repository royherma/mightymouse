/**
 * One agent's relay history, full screen, with the same two readings the chat
 * surface offers.
 *
 * Why a second component rather than pointing ChatFullScreen at a relay session:
 * that one is typed on `OpenChatThread`, whose `id` is a MIGHTY chat session id
 * and is what `/chat-media?sessionId=` is fetched against. A relay agent has no
 * such id (there is no join key -- `MightySession` in shared/types.ts carries no
 * agent label), so handing it a relay label would build a thread whose every
 * picture resolves to nothing. The CSS is the shared part and is reused verbatim:
 * `.chatFull*` plus the `.chatFull-chat` / `.chatFull-raw` mode scoping, so both
 * surfaces stay one visual language even though their data never met.
 *
 * Chat mode reads the exchange as bubbles. Raw mode prints the same requests as
 * a log with the verb and status on every row -- what raw means everywhere else
 * in this app: the scaffolding, unfolded, for when you are debugging a run.
 */

import { useEffect, useRef, useState } from 'react'
import {
  ChevronLeft,
  ExternalLink,
  FileText,
  Loader2,
  Mic,
  MonitorUp,
  MoreHorizontal,
  SendHorizontal,
  Sparkles,
  Square
} from 'lucide-react'
import { sessionCanReply } from '@shared/relay-status'
import { resolvedOutcome, sessionActivity } from '@shared/relay-cards'
import { sessionRow } from '@shared/relay-status'
import { cardSuggestKey, suggestContext } from '@shared/swipe-suggest'
import type { Suggestion } from '@shared/swipe-suggest'
import { CONFIG } from '@shared/config'
import type { AgentRelaySessionInfo } from '@shared/types'
import type { RelayRequestWire } from '@shared/phone-remote-protocol'
import { hapticTick } from './haptics'
import PhoneRemoteTitleBar from './PhoneRemoteTitleBar'
import { Fact, ProjectMark, exactUptime, shortWhen, startedAt } from './SessionDetail'
import { AttachPhotoButton } from './AttachPhotoButton'
import type { AttachState } from './AttachPhotoButton'
import { MicWaveform } from './MicWaveform'
import type { SessionMicProps } from './SessionList'
import { useFreeViewport } from './useFreeViewport'
import { Button } from '@shared/ui/Button'

export type ChatViewMode = 'chat' | 'raw'

/** What the agent actually SAID, as opposed to what the card is called. The
 *  idle ping every Claude hook sends titles itself "Your Turn" and puts the
 *  sentence in `body` (same shape `deriveSubject` relies on in relay-cards.ts),
 *  so a screen of them read as the same two words over and over. */
function cardBody(request: RelayRequestWire): string {
  const p = request.params
  // `body` outranks `title`, which is why this cannot just fall back to
  // cardSummary: that ends `?? params.title`, and an idle notify HAS a title --
  // "Your Turn". So the summary was never empty, the `||` fallback never fired,
  // and every bubble rendered the label instead of the sentence. Title stays
  // last as the label of final resort.
  return (p.question ?? p.action ?? p.caption ?? p.body ?? p.title ?? '').trim()
}

/** Did a PERSON answer this card? `.chatFullAsk` is the user's side of this
 *  thread, so what goes in it has to be something the user actually said.
 *  `status !== 'pending'` is not that test: a notify resolves the instant it is
 *  minted and `resolvedOutcome` calls that "Delivered", which printed a bubble
 *  on the reader's side reporting the delivery of the agent's OWN push -- a
 *  second message, attributed to the wrong party, about nothing the reader did.
 *  The sheet already refuses the neighbouring case for the same reason
 *  (SessionDetail.tsx: "would put words in the user's mouth"); this is that rule
 *  applied to the field that decides it rather than to the status. */
function answeredByYou(request: RelayRequestWire): boolean {
  if (request.status === 'pending') return false
  // `dismissed` and `timedout` are outcomes too, and both are the reader's
  // story: "you cleared it", "nobody got to it". Only a self-resolving notify
  // is excluded, and it is excluded by having no response at all.
  if (request.status === 'dismissed' || request.status === 'timedout') return true
  const r = request.response
  return r !== null && (r.approved !== undefined || r.answer !== undefined || r.acked === true)
}

export type SessionFullScreenProps = {
  open: boolean
  session: AgentRelaySessionInfo | null
  /** Newest first, the order the sheet receives it. */
  history: RelayRequestWire[]
  now: number
  /** Drop back to the agent sheet -- deliberately not a close, the same reason
   *  ChatFullScreen's control is onCollapse: leaving full screen lands you on
   *  the agent you were reading, not on the trackpad. */
  onCollapse: () => void
  imageSrc?: (requestId: string) => string
  /** Which reading to open on. Exists for the screenshot harness: `mode` is
   *  internal state, so without this a capture can only ever show whichever
   *  mode a human clicked -- and "chat and raw look the same" is exactly the
   *  bug that needs both in one frame to judge. */
  initialMode?: ChatViewMode
  /** Open with the header already expanded. Same reason as `initialMode`: the
   *  panel is internal state and a capture cannot click. */
  initialExpanded?: boolean
  /** Say something back. Without this the screen is read-only, which is what
   *  made it feel like a transcript rather than a conversation. */
  onReply?: (label: string, text: string) => void
  onStop?: (label: string) => void
  /** Send a photo along with the reply. Absent where there is no socket to send
   *  it on -- the Mac-side host renders this same screen off its own store. */
  onAttach?: (label: string, file: File) => Promise<boolean>
  /** What YOU have already said to this agent, oldest first, echoed back by the
   *  Mac. Without it the screen showed only the agent's half: a reply is typed
   *  into a tmux pane and mints no card, so it left no trace a reload could
   *  find. Optional because the Mac-side host has no wire to ask over. */
  sent?: { text: string; at: number }[]
  /** Ask the Mac what this thread has already sent. Fired when the screen
   *  opens, which is the only moment the answer can arrive before it is read. */
  onSentGet?: (label: string) => void
  /** Raise this agent's window on the Mac. Undefined once the origin has
   *  nothing addressable, so the button is absent rather than dead -- the same
   *  gate the sheet's copy of this button is behind. */
  onGoTo?: () => void
  /** The Mac's verdict on the last attempt: the phone cannot see the window it
   *  just asked for. */
  goToFailed?: boolean
  /** Screen share toggle for the header; the floating pane is mounted once by
   *  SessionList and the movable control island is portalled above this view. */
  screen?: {
    on: boolean
    onToggle: () => void
  }
  /** Dictation, the sheet's pipeline verbatim: the transcript lands in
   *  `draftPatch` and is appended to the draft rather than sent. */
  mic?: SessionMicProps
  /** Model-written chips, keyed by `cardSuggestKey` -- the same map the sheet
   *  and the deck read, so all three ask for one session's suggestions the one
   *  way. */
  suggestions?: Record<string, Suggestion[]>
  onRequestSuggestions?: (label: string, context: string, refresh?: boolean) => void
}

/** One row of the thread. A sent turn is NOT folded into a synthetic card: the
 *  card type is the relay store's, read by the approve path and the audit rows,
 *  and a request with no verb in that shape is a lie the renderer would be the
 *  only thing keeping honest. Two kinds, branched explicitly. */
type Turn =
  | { kind: 'card'; at: number; request: RelayRequestWire }
  | { kind: 'sent'; at: number; text: string }

export default function SessionFullScreen(props: SessionFullScreenProps): React.JSX.Element | null {
  const { open, session, history, now, onCollapse, screen } = props
  const [mode, setMode] = useState<ChatViewMode>(props.initialMode ?? 'chat')
  const [expanded, setExpanded] = useState(props.initialExpanded ?? false)
  const [draft, setDraft] = useState('')
  const [attach, setAttach] = useState<AttachState | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const { onMicDown, onMicUp, dictating, recording, micStreamRef, draftPatch, onDraftConsumed } =
    props.mic ?? {}
  // State, not a ref: the listener effect below has to re-run when the button
  // MOUNTS, and a ref assignment fires no render. Keying that effect on anything
  // but the node is the bug this directory's CLAUDE.md says shipped twice.
  const [micEl, setMicEl] = useState<HTMLButtonElement | null>(null)
  /** When this phone last hit send. `relaySessionReply` is fire-and-forget --
   *  no ack -- and `sent` is deliberately NOT written optimistically (use-relay:
   *  the Mac is what survives a reload), so between the tap and the Mac's echo
   *  the screen had nothing on it at all: the words left the composer and the
   *  thread did not change. That silence is what read as a dropped message. */
  const [sendingAt, setSendingAt] = useState<number | null>(null)
  const [stoppedAt, setStoppedAt] = useState<number | null>(null)

  // The sheet asks for chips only on a tap; this screen asks on OPEN, because it
  // is the surface you land on to reply rather than to read. The Mac's cache is
  // keyed on (session, tldr), so reopening an unchanged agent re-spawns nothing.
  const { suggestions: suggestionMap, onRequestSuggestions } = props
  const activity = sessionActivity(session?.stated ?? session?.label ?? '', history)
  const derivedSubject = activity.derivedSubject
  const suggestKey = session
    ? cardSuggestKey({ label: session.label, session, subject: derivedSubject })
    : undefined
  const suggestions = suggestKey ? suggestionMap?.[suggestKey] : undefined
  // Dismissed per agent: hiding the chips is about THIS thread, and carrying
  // that across the prev/next arrows would silence an agent you never dismissed.
  const [suggestDismissed, setSuggestDismissed] = useState(false)
  /** When the ask went out. Ends on the answer; the timeout is the backstop for
   *  a Mac that went away. Same shape the sheet's copy uses. */
  const [suggestingSince, setSuggestingSince] = useState<number | null>(null)
  useEffect(() => {
    if (suggestingSince === null) return
    if (suggestions !== undefined) {
      setSuggestingSince(null)
      return
    }
    const done = setTimeout(() => setSuggestingSince(null), CONFIG.SUGGESTIONS.PREDICT_TIMEOUT_MS)
    return () => clearTimeout(done)
  }, [suggestingSince, suggestions])

  // A new agent gets its own chips and its own dismissal.
  useEffect(() => {
    setSuggestingSince(null)
    setSuggestDismissed(false)
  }, [session?.label])

  // Keyed on the suggest key, not the label, so a changed TLDR asks again -- the
  // agent saying it is doing something else is exactly when old chips stop
  // applying. `suggestions` is deliberately not a dep: the answer would re-run it.
  const askedForRef = useRef<string | null>(null)
  useEffect(() => {
    if (!open || !onRequestSuggestions || !suggestKey || !session) return
    if (askedForRef.current === suggestKey) return
    const context = suggestContext(session, derivedSubject)
    if (!context) return
    askedForRef.current = suggestKey
    setSuggestingSince(Date.now())
    onRequestSuggestions(session.label, context)
  }, [open, onRequestSuggestions, suggestKey, session, derivedSubject])

  // `inset: 0`, so the layout viewport this resolves against does not shrink for
  // a native keyboard OR the home indicator: the composer, the last child, sits
  // behind both unless the obstruction is measured. Same pair ChatFullScreen
  // takes, for the same reason.
  const freeViewport = useFreeViewport(null)
  const bottomInset = Math.max(0, window.innerHeight - (freeViewport.top + freeViewport.height))

  // Measured, not guessed: the popover is one line while it thinks and three
  // chips after, so any constant is wrong in one state. Keyed on the NODE (this
  // directory's rule) -- a ref fires no render and the height would stay 0.
  const [suggestEl, setSuggestEl] = useState<HTMLDivElement | null>(null)
  const [suggestHeight, setSuggestHeight] = useState(0)
  useEffect(() => {
    if (!suggestEl) {
      setSuggestHeight(0)
      return
    }
    const ro = new ResizeObserver(() => setSuggestHeight(suggestEl.offsetHeight))
    ro.observe(suggestEl)
    setSuggestHeight(suggestEl.offsetHeight)
    return () => ro.disconnect()
  }, [suggestEl])

  // Land on the newest exchange, and again when the reading changes: raw mode
  // is taller than chat mode, so the same scrollTop is a different place.
  // `suggestHeight` is a dep because chips arriving cover the last message, and
  // the padding that makes room for them is only reachable by scrolling again.
  useEffect(() => {
    if (!open) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [open, mode, history.length, props.sent?.length, sendingAt, suggestHeight])

  // NOT cleared on the echo. `relaySessionSent` is emitted synchronously by the
  // same handler that takes the reply (phone-remote-chat.ts), so it is the Mac
  // repeating what this phone just typed -- it comes back in milliseconds and
  // says nothing about the agent. Clearing on it killed the indicator about a
  // frame after it appeared, which is what "it disappears immediately" was.
  //
  // What actually ends the wait is the agent's turn starting, which arrives much
  // later as `health === 'working'` (busySince is stamped by the shim's rising
  // edge, http-listener.ts). So the stand-in holds until either that turn shows
  // up or the ceiling below passes -- a reply that never wakes anything must not
  // spin forever.
  // Reads `busySince` off the session rather than the derived `row.health`:
  // `row` is computed after the `!session` guard further down, so naming it here
  // is a use-before-declaration. The raw stamp is the same fact anyway -- it is
  // exactly what sessionRow turns into 'working'.
  const agentBusy = session?.busySince !== undefined
  useEffect(() => {
    if (sendingAt === null) return
    if (agentBusy) {
      setSendingAt(null)
      return
    }
    const timer = setTimeout(() => setSendingAt(null), CONFIG.PHONE_REMOTE.SESSION_SENDING_MAX_MS)
    return () => clearTimeout(timer)
  }, [sendingAt, agentBusy])

  // The Mac holds what this phone has already said -- ask on open, so a reload
  // gets its own half of the thread back instead of the agent talking to nobody.
  useEffect(() => {
    if (open && session) props.onSentGet?.(session.label)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, session?.label])

  // Non-passive, same as the sheet's mic: React's onPointerDown is passive, so
  // it cannot preventDefault() the synthetic mouse events iOS fires after a
  // touch, which stomp the toggled state on lift.
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

  if (!session) return null

  const row = sessionRow(session, now)
  const stopHeld =
    stoppedAt !== null && (session.busySince ?? 0) <= stoppedAt && (sendingAt ?? 0) <= stoppedAt
  const thinking = (sendingAt !== null || row.health === 'working') && !stopHeld
  const title = row.name ?? row.repo ?? CONFIG.UI_LABELS.CODE_SESSION_UNNAMED
  const canReply = row.health !== 'ended' && sessionCanReply(session)
  // The sheet's gate verbatim, and deliberately NOT the deck's `worthSuggesting`:
  // that one refuses a stale session, and 52 of 63 live sessions are stale while
  // still being replyable. If you can type to it, you can ask what to type.
  const canSuggest = Boolean(onRequestSuggestions) && canReply && Boolean(suggestKey)

  const submit = (): void => {
    const text = draft.trim()
    // A photo IS a message, so an attachment with no words still sends -- the Mac
    // pairs the two by label and puts the path ahead of the (empty) text.
    if ((!text && !attach) || !canReply) return
    props.onReply?.(session.label, text)
    setSendingAt(Date.now())
    setDraft('')
    setAttach(null)
  }
  // Oldest first: a conversation is read downward, and a reply printed above the
  // thing it answers reads as two unrelated lines.
  // Oldest first and INTERLEAVED by time, not two stacked blocks: the whole
  // point of echoing a sent turn is that it sits next to what it answered.
  const ordered: Turn[] = [
    ...history.map((request): Turn => ({ kind: 'card', at: request.createdAt, request })),
    ...(props.sent ?? []).map((t): Turn => ({ kind: 'sent', at: t.at, text: t.text }))
  ].sort((a, b) => a.at - b.at)

  return (
    <div
      data-sheet
      className={`chatFull${open ? ' open' : ''} chatFull-${mode}`}
      // ChatFullScreen's strategy exactly: shorten the COLUMN by the measured
      // obstruction and let the composer keep only its home-indicator padding.
      // Setting --chat-full-keyboard as well would spend the same inset twice
      // with the keyboard up -- once here, once in that rule's max().
      style={{ paddingBottom: `${bottomInset}px` }}
      role="dialog"
      aria-label={`${title} conversation`}
    >
      <PhoneRemoteTitleBar
        className="chatFullHeader"
        leading={
          <Button
            variant="bare"
            type="button"
            className="chatFullIconBtn"
            aria-label="Back to this agent"
            onClick={() => {
              hapticTick()
              onCollapse()
            }}
          >
            <ChevronLeft size={19} strokeWidth={2.5} />
          </Button>
        }
        title={
          <>
            {/* The face travels with the title so the agent remains identifiable. */}
            <span className="sessionFullFace" aria-hidden="true">
              <ProjectMark project={session.project} />
            </span>
            {/* The title opens the same details as the trailing dots button. */}
            <Button
              variant="bare"
              type="button"
              className="chatFullTitleBtn"
              aria-expanded={expanded}
              onClick={() => {
                hapticTick()
                setExpanded((v) => !v)
              }}
            >
              <span className="chatFullTitle chatFullTitleTruncate">{title}</span>
            </Button>
          </>
        }
        actions={
          <>
            {screen && (
              <Button
                variant="bare"
                type="button"
                className={`chatFullIconBtn${screen.on ? ' on' : ''}`}
                aria-label={screen.on ? 'Hide Mac screen' : 'Share Mac screen'}
                aria-pressed={screen.on}
                onClick={() => {
                  hapticTick()
                  screen.onToggle()
                }}
              >
                <MonitorUp size={18} strokeWidth={2.25} />
              </Button>
            )}
            <Button
              variant="bare"
              type="button"
              className={`chatFullIconBtn${expanded ? ' on' : ''}`}
              aria-label="About this agent"
              aria-expanded={expanded}
              onClick={() => {
                hapticTick()
                setExpanded((v) => !v)
              }}
            >
              <MoreHorizontal size={18} strokeWidth={2.25} />
            </Button>
          </>
        }
      />

      {/* The sheet's OWN facts list, same <Fact> component and same CSS -- the
          full screen otherwise states none of this, and a second fact list
          written here would be two spellings of one thing. */}
      {expanded && (
        <div className="chatFullFacts">
          <div className="codeSessionFacts">
            <Fact label="Working on" value={row.tldr} />
            {/* Dropped when it repeats the line above. An agent that never named
                itself derives both from the same recap, so the panel printed one
                sentence twice -- caught in the harness, not by reading. */}
            <Fact label="Name" value={row.name === row.tldr ? undefined : row.name} />
            <Fact label="Harness" value={row.agent} />
            <Fact label="Model" value={row.model} />
            <Fact label="Effort" value={row.effort} />
            <Fact label="Repo" value={row.repo} />
            <Fact label="Branch" value={row.branch} />
            <Fact label="Running for" value={exactUptime(session.since, now)} />
            <Fact label="Started" value={startedAt(session.since)} />
            <Fact label="Folder" value={session.cwd} mono />
            <Fact label="Session id" value={session.sessionId} mono />
          </div>
          {/* The same pair the sheet carries, in the panel the header's own
              toggle opens: reading a thread full screen is exactly when "put
              this on the Mac" or "put the Mac in my hand" is the next move, and
              collapsing out to the sheet to reach them was the detour. Shared
              handlers and shared copy -- two spellings of one act is how the two
              surfaces drift. */}
          <div className="codeSessionActionRow">
            {props.onGoTo && (
              <Button
                variant="bare"
                className="codeSessionAction"
                onClick={() => {
                  hapticTick()
                  props.onGoTo?.()
                }}
                type="button"
                disabled={props.goToFailed}
              >
                <ExternalLink size={13} strokeWidth={2.5} />
                {props.goToFailed ? 'Window not found' : 'Open on Mac'}
              </Button>
            )}
            <Button
              variant="bare"
              className="codeSessionAction"
              onClick={() => {
                hapticTick()
                setMode(mode === 'raw' ? 'chat' : 'raw')
              }}
              type="button"
              aria-pressed={mode === 'raw'}
              aria-label={mode === 'raw' ? 'Show chat view' : 'Show every step'}
            >
              <FileText size={13} strokeWidth={2.5} />
              {mode === 'raw' ? 'Chat' : 'Steps'}
            </Button>
          </div>
        </div>
      )}

      <div className="chatFullScroll" ref={scrollRef}>
        {/* The popover paints over the transcript, so the column buys back its
            height as padding -- without it the last message is unreachable at
            every scroll position. */}
        <div
          className="chatFullColumn"
          style={suggestHeight > 0 ? { paddingBottom: `${suggestHeight + 28}px` } : undefined}
        >
          {ordered.length === 0 ? (
            // Deliberately NOT the peeked pane tail. Dumping raw terminal
            // output here filled the screen with `Found …/.nvmrc` and read as
            // an error report -- on device it was the first thing that looked
            // broken. The pane is one tap away on the sheet this opened from.
            <div className="chatFullEmpty">
              {/* An agent can have plenty to say and still have sent zero relay
                  cards -- `recap` declares a subject without minting a request.
                  The sheet shows that line, so a full screen reading "it has not
                  sent you anything" beside a populated sheet reads as broken
                  even though the history really is empty. */}
              {row.tldr ? (
                <>
                  <span className="sessionFullKind">Recap</span>
                  <p>{row.tldr}</p>
                </>
              ) : (
                <p>{CONFIG.UI_LABELS.CODE_SESSION_LAST_EMPTY}</p>
              )}
              <p>Say something to start it off.</p>
            </div>
          ) : (
            ordered.map((turn) =>
              turn.kind === 'sent' ? (
                // Your own words, echoed from the Mac. `.chatFullAsk` is the
                // user's side here -- the sides invert against the chat surface
                // because on this one the AGENT is the one asking.
                <div className="chatFullTurn" key={`sent-${turn.at}`}>
                  {mode === 'raw' ? (
                    <div className="sessionFullRawRow">
                      <div className="sessionFullRawMeta">
                        you · sent · {shortWhen(turn.at, now)}
                      </div>
                      <pre className="sessionFullRawBody">{turn.text}</pre>
                    </div>
                  ) : (
                    <>
                      <div className="chatFullAsk">{turn.text}</div>
                      <div className="sessionFullWhen">{shortWhen(turn.at, now)}</div>
                    </>
                  )}
                </div>
              ) : (
                <div className="chatFullTurn" key={turn.request.id}>
                  {mode === 'raw' ? (
                    // A LOG, not bubbles. Raw used to be the same two bubbles plus
                    // one meta line, so the toggle looked like it did nothing --
                    // every idle ping renders the identical pair. Here the facts a
                    // bubble hides carry the row: which card, what happened to it,
                    // and the agent's full untruncated text.
                    <div className="sessionFullRawRow">
                      <div className="sessionFullRawMeta">
                        {turn.request.verb} · {turn.request.status} ·{' '}
                        {shortWhen(turn.request.createdAt, now)}
                        {turn.request.params.title ? ` · ${turn.request.params.title}` : ''}
                      </div>
                      <pre className="sessionFullRawBody">
                        {cardBody(turn.request) || '(no message body)'}
                      </pre>
                      {/* Raw drops FORMATTING, never content -- same rule
                        ChatFullScreen states where it renders ChatMedia outside
                        its mode branch: a `show` card whose whole point is the
                        picture becomes a caption with nothing under it. */}
                      {turn.request.params.hasImage && props.imageSrc && (
                        <img
                          src={props.imageSrc(turn.request.id)}
                          alt={turn.request.params.caption ?? 'From your agent'}
                        />
                      )}
                      {turn.request.status !== 'pending' && (
                        <div className="sessionFullRawMeta">→ {resolvedOutcome(turn.request)}</div>
                      )}
                    </div>
                  ) : (
                    <>
                      {/* The agent asks and you answer, so the sides invert against
                        the chat surface: the agent takes the reply side. */}
                      <div className="chatFullReply">
                        {/* An idle ping's title IS "Your Turn" and its sentence is
                          the body -- showing the title alone was five identical
                          bubbles down the screen. */}
                        {/* The badge is the card's LABEL, so it is worth drawing
                          only when it is saying something the sentence below it
                          does not. A notify whose body is empty falls back to
                          the title, and badging that repeats one string twice. */}
                        {turn.request.params.title &&
                          turn.request.params.title !== cardBody(turn.request) && (
                            <span className="sessionFullKind">{turn.request.params.title}</span>
                          )}
                        {cardBody(turn.request)}
                        {turn.request.params.hasImage && props.imageSrc && (
                          <img
                            src={props.imageSrc(turn.request.id)}
                            alt={turn.request.params.caption ?? 'From your agent'}
                          />
                        )}
                      </div>
                      {answeredByYou(turn.request) && (
                        <div className="chatFullAsk">{resolvedOutcome(turn.request)}</div>
                      )}
                      <div className="sessionFullWhen">
                        {shortWhen(turn.request.createdAt, now)}
                      </div>
                    </>
                  )}
                </div>
              )
            )
          )}
          {/* The stage that was missing. Two things can put it up and they are
              different moments: `sendingAt` covers the gap this phone can see
              (sent, nothing echoed yet), `working` covers the agent's own turn,
              which the Mac reports and which outlives the echo. Either alone
              leaves a hole -- the echo can land while the agent is still
              writing, and the agent can start before the echo returns. */}
          {mode === 'chat' && thinking && (
            <div className="chatFullTurn sessionFullThinking">
              <span className="sessionFullThinkingFace" aria-hidden="true">
                <ProjectMark project={session.project} />
              </span>
              {/* A bubble on the agent's side, not a bare line: this is the
                  agent taking its turn, so it reuses `.chatFullReply` geometry
                  and lands where its answer will land. A loose line beside the
                  face read as a status label about the thread rather than as
                  the agent starting to talk. */}
              <span className="chatFullReply sessionFullThinkingBubble">
                {/* `state_text` is the shared sentence every other surface
                    prints for this health ("Responding…"), so the full screen
                    says what the row and the sheet say rather than a third
                    wording. Before the Mac has spoken there is no health to
                    read yet, and the honest line is the one about what THIS
                    phone just did. */}
                <span className="sessionFullThinkingText">
                  {row.health === 'working' ? row.state_text : 'Sending…'}
                </span>
                <span className="sessionFullThinkingDots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Position-independent by design: .chatComposer is `flex: 0 0 auto` with a
          border-top, so it drops in as a sibling of the scroller exactly as it
          does on the chat surface. No mic here -- the sheet's dictation binds
          through a node-keyed effect, and a half-ported copy is a button that
          silently never records. */}
      <div className="chatComposer">
        {/* Floats over the transcript rather than pushing it up: chips arriving
            on their own must never reflow what you are reading. Tapping one
            FILLS the box and leaves the rest up -- you may still want to edit. */}
        {canSuggest && !suggestDismissed && (suggestingSince !== null || suggestions) && (
          <div className="chatFullSuggest" ref={setSuggestEl}>
            <div className="chatFullSuggestHead">
              {suggestingSince !== null ? (
                <Loader2 size={12} strokeWidth={2.5} className="chatMicSpin" />
              ) : (
                <Sparkles size={12} strokeWidth={2.5} />
              )}
              <span>
                {suggestingSince !== null
                  ? CONFIG.UI_LABELS.CODE_SESSION_SUGGEST_BUSY
                  : suggestions?.length === 0
                    ? CONFIG.UI_LABELS.CODE_SESSION_SUGGEST_NONE
                    : CONFIG.UI_LABELS.CODE_SESSION_SUGGEST}
              </span>
              <Button
                variant="bare"
                type="button"
                className="chatFullSuggestDismiss"
                aria-label="Hide suggestions"
                onClick={() => {
                  hapticTick()
                  setSuggestDismissed(true)
                }}
              >
                Hide
              </Button>
            </div>
            {suggestingSince === null && suggestions && suggestions.length > 0 && (
              <div className="chatFullSuggestChips">
                {suggestions.map((suggestion) => (
                  <Button
                    variant="bare"
                    key={suggestion.text}
                    type="button"
                    className="codeSessionSuggestChip"
                    onClick={() => {
                      hapticTick()
                      setDraft(suggestion.text)
                      inputRef.current?.focus()
                    }}
                  >
                    {/* Its own element, never prepended to the text: the text
                        is what lands in the agent's terminal, and a glyph glued
                        to it would ride along. */}
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
        <textarea
          ref={inputRef}
          className="chatInput"
          value={draft}
          maxLength={CONFIG.PHONE_REMOTE.CHAT_MESSAGE_MAX_CHARS}
          rows={1}
          disabled={!canReply}
          placeholder={CONFIG.UI_LABELS.CODE_SESSION_REPLY_PLACEHOLDER}
          onChange={(e) => setDraft(e.target.value)}
          // No scrollIntoView on focus. This root is `position: fixed; inset: 0`
          // with nothing scrollable between the field and the document, so the
          // browser satisfies the request by panning the VISUAL VIEWPORT -- the
          // whole fixed column rides up and the header, the facts panel and the
          // transcript leave the screen, composer alone still visible. The
          // padding below already lifts the bar clear of the keyboard, which is
          // all this was reaching for. ChatSheet and ChatFullScreen bind no
          // focus handler here for the same reason; the sheet's copy
          // (SessionDetail) can, because its composer sits inside a real
          // scroller.
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
        {props.onStop && canReply && thinking && !draft.trim() && !attach ? (
          <Button
            variant="bare"
            type="button"
            className="chatSendBtn"
            aria-label={CONFIG.UI_LABELS.CHAT_STOP}
            onClick={() => {
              hapticTick()
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
            aria-label="Send"
            disabled={!canReply || (!draft.trim() && !attach)}
            onClick={() => {
              hapticTick()
              submit()
            }}
          >
            <SendHorizontal size={18} strokeWidth={2.25} />
          </Button>
        )}
      </div>
    </div>
  )
}

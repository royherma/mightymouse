/**
 * One answerable relay card, plus the two small pieces every card shows
 * (`SenderChip`, `WaitingTime`).
 *
 * Lives outside CodeSheet because it now has two hosts -- the list and
 * CodeDetail's full-screen view. A second implementation of the four verbs is
 * how the two would start disagreeing about what an approve looks like, so
 * there is exactly one, imported by both.
 */

import { useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  Bell,
  Check,
  ChevronRight,
  Clock,
  CornerDownRight,
  Info,
  Maximize2,
  MinusCircle,
  Send,
  Undo2,
  Eye,
  X
} from 'lucide-react'
import { readDraft, writeDraft, clearDraft } from '@shared/relay-drafts'
import {
  levelHeading,
  waitingLabel,
  isHighRisk,
  cardSummary,
  resolvedOutcome,
  resolvedWhen,
  UNKNOWN_SENDER
} from '@shared/relay-cards'
import type { FaceSession } from '@shared/agent-face'
import { sessionMatchesFrom } from '@shared/relay-status'
import { ProjectMark } from './SessionDetail'
import { RELAY_CLEAR_DELAY_MS, useFlickDismiss } from '@shared/relay-flick'
import { interviewView, answerAt } from '@shared/relay-interview'
import { RelayInterviewNav, PHONE_NAV_CLASSES } from '@shared/relay-interview-nav'
import { ProgressMeter, PHONE_METER_CLASSES } from '@shared/progress-ring'
import { CONFIG } from '@shared/config'
import { hapticTick } from './haptics'
import { PhotoPickButton } from './PhotoPickButton'
import type { RelayRequestWire, RelayResponseWire } from '@shared/phone-remote-protocol'
import { Button } from '@shared/ui/Button'

/** Matches .chatInput's autosize ceiling -- a note field that grows past this
 *  pushes the card's buttons off a short viewport. */
const NOTE_MAX_H = 120

/** Fallback deadline for the post-keyboard re-scroll, for browsers that never
 *  fire visualViewport `resize`. Clears Safari's ~250ms keyboard slide with a
 *  little margin. On iOS the resize normally wins the race and this is just the
 *  backstop -- so a too-long value shows up as lag only where the event is
 *  missing entirely. */
const KEYBOARD_SETTLE_MS = 300

/** Returns the LABEL SessionList opens by. `sessionMatchesFrom`, never exact
 *  equality: a hook's from is `ShowAndTell · name` while the session label is
 *  `ShowAndTell - name`, so strict `===` leaves every such chip flat. */
export function senderSessionLabel(
  request: RelayRequestWire,
  sessions: ReadonlyArray<FaceSession>
): string | undefined {
  const byPane = request.sessionLabel
  if (byPane && sessions.some((s) => s.label === byPane)) return byPane
  const from = request.params.from
  if (!from) return undefined
  return sessions.find((s) => sessionMatchesFrom(s, from))?.label
}

export function SenderChip({
  from,
  sessions = [],
  onOpen,
  unmatched = false
}: {
  from?: string
  sessions?: ReadonlyArray<FaceSession>
  unmatched?: boolean
  /** Open this sender's session sheet. Absent when the sender has no live
   *  session -- the chip stays a plain label rather than a dead button. */
  onOpen?: () => void
}): React.JSX.Element {
  const label = from ?? UNKNOWN_SENDER
  const project = from ? sessions.find((s) => sessionMatchesFrom(s, from))?.project : undefined
  const [whyOpen, setWhyOpen] = useState(false)
  const inner = (
    <>
      {from ? (
        <ProjectMark project={project} size={18} />
      ) : (
        <span className="codeSenderDot" data-unknown="" aria-hidden="true" />
      )}
      <span className="codeSenderName">{label}</span>
    </>
  )
  if (!onOpen && unmatched && from) {
    return (
      <div className="codeSenderWrap">
        <div className="codeSender">
          {inner}
          <Button
            variant="bare"
            className="codeSenderWhy"
            type="button"
            aria-label="Why can't I open this agent?"
            aria-expanded={whyOpen}
            onClick={(e) => {
              e.stopPropagation()
              hapticTick()
              setWhyOpen((v) => !v)
            }}
          >
            <Info size={13} strokeWidth={2.25} aria-hidden="true" />
          </Button>
        </div>
        {whyOpen && (
          <div className="codeSenderWhyNote">
            This agent isn't running on your Mac anymore, so there's no session to open.
          </div>
        )}
      </div>
    )
  }
  if (!onOpen) return <div className="codeSender">{inner}</div>
  return (
    <Button
      variant="bare"
      className="codeSender"
      type="button"
      aria-label={`Open ${label}'s session`}
      onClick={(e) => {
        // Nested inside a tappable Previous row, which opens the request.
        e.stopPropagation()
        hapticTick()
        onOpen()
      }}
    >
      {inner}
      <ChevronRight className="codeSenderGo" size={12} strokeWidth={2.5} aria-hidden="true" />
    </Button>
  )
}

/** Recomputed on a 1s tick because both halves of the label change while the
 *  card sits on screen. The wording itself is shared -- see relay-cards.ts. */
export function WaitingTime({ request }: { request: RelayRequestWire }): React.JSX.Element | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(tick)
  }, [])

  const label = waitingLabel(request, now)
  if (!label) return null

  return (
    <div className="codeWaiting" data-urgent={label.urgent ? '' : undefined}>
      {label.text}
    </div>
  )
}

export function RelayCard(props: {
  request: RelayRequestWire
  /** False when the group header already states the sender above this card. */
  showSender: boolean
  onRespond: (requestId: string, response: RelayResponseWire) => void
  imageSrc: (requestId: string) => string
  /** The card a notification tap opened straight to -- see CodeSheet's
   *  `justOpenedId`. */
  justOpened?: boolean
  onJustOpenedEnd?: () => void
  /** Open this card on its own screen. Absent when the card IS the detail view,
   *  which is what stops it offering to open itself. */
  onExpand?: () => void
  /** List only. Detail pages by swipe, so a flick there would steal paging. */
  allowFlick?: boolean
  sessions?: ReadonlyArray<FaceSession>
  /** Tapping the sender chip opens that agent's session, by label. */
  onOpenSession?: (label: string) => void
  /** Send a picked photo up to the Mac. Absent on the Mac-side host, which has
   *  no socket -- and a photos_get card there simply offers no picker, since
   *  the photo it wants is on the phone. */
  onPickPhoto?: (requestId: string, file: File) => Promise<boolean>
}): React.JSX.Element {
  const {
    request,
    showSender,
    onRespond,
    imageSrc,
    justOpened,
    onJustOpenedEnd,
    onExpand,
    allowFlick,
    sessions = [],
    onOpenSession,
    onPickPhoto
  } = props
  const sessionLabel = senderSessionLabel(props.request, sessions)
  const { params, verb, id } = request
  const highRisk = isHighRisk(request)
  // Seeded from storage, not '': this card unmounts on every relayPending
  // snapshot, so a fresh useState('') is what used to eat a half-typed answer
  // the moment any other agent sent anything.
  const [draft, setDraft] = useState(() => readDraft(id))
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  const editDraft = (text: string): void => {
    setDraft(text)
    writeDraft(id, text)
  }

  // Which question is being LOOKED at, when that is not the one the interview is
  // waiting on. null means "follow the cursor", which is every card until
  // someone taps Back -- so an untouched interview behaves exactly as before.
  const [viewIndex, setViewIndex] = useState<number | null>(null)

  // One question at a time (PRD §7.3). For N=1 `isInterview` is false and every
  // field below falls back to the single-question params, so today's verified
  // flow renders byte-for-byte as it did.
  const interview = interviewView(
    params.questions,
    params.buffered,
    params.canReadPane ?? false,
    params.options,
    viewIndex ?? undefined
  )
  const shown = interview.isInterview ? interview.current : null
  const askQuestion = shown?.question ?? params.question
  const askOptions = shown?.options ?? params.options
  // Blocked, or past what this surface may collect: the remaining questions are
  // the Mac's, so no controls are offered for them.
  const askDone = interview.isInterview && shown === null
  const hasOptions = verb === 'ask' && !askDone && (askOptions?.length ?? 0) > 0

  const [clearingAt, setClearingAt] = useState<number | null>(null)

  const dismiss = (): void => {
    hapticTick()
    onRespond(id, { dismissed: true, via: 'dismiss' })
    clearDraft(id)
    setClearingAt(null)
  }

  useEffect(() => {
    if (clearingAt === null) return
    const timer = window.setTimeout(dismiss, RELAY_CLEAR_DELAY_MS)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearingAt])

  const flick = useFlickDismiss(allowFlick && clearingAt === null ? dismiss : undefined)

  const autosize = (el: HTMLTextAreaElement): void => {
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, NOTE_MAX_H)}px`
  }

  /**
   * Brings the focused field into view inside the sheet's scroller.
   *
   * Unlike ChatSheet -- whose single composer is a SIBLING of `.chatScroll` and
   * so is pinned above the keys by flex alone -- every card here carries its own
   * field INSIDE that scroller. There is no composer to pin: only the focused
   * one should come up, and which one that is isn't known until focus lands.
   * Without this the field is just list content, and the keyboard covers
   * whatever it happens to be sitting under.
   *
   * Scrolls TWICE, and both are load-bearing:
   *
   *  - immediately, so a tap always produces motion. When the keyboard is
   *    ALREADY up (tapping from one card's field straight into another's) there
   *    is no resize coming at all, so a delay-only version just sat still for
   *    a third of a second -- which is what "doesn't scroll to it immediately"
   *    was. This pass is the whole fix in that case.
   *  - again once the viewport settles, because on the first tap the keyboard
   *    has not moved yet: the first scroll lands against a viewport iOS is
   *    about to shrink by ~300px, leaving the field low or back under the keys.
   *
   * Driven off visualViewport's own `resize` rather than a fixed timer where
   * possible -- the timer is the fallback for browsers that do not fire it.
   * `block: 'center'` not 'nearest': at focus time the field is technically
   * already in view, so 'nearest' no-ops and then the keyboard rises over it.
   */
  const revealOnFocus = (el: HTMLTextAreaElement): void => {
    const reveal = (): void => {
      // The card can be answered/dismissed inside the delay, which unmounts it.
      if (el.isConnected) el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
    reveal()

    const vv = window.visualViewport
    const settle = window.setTimeout(done, KEYBOARD_SETTLE_MS)
    function done(): void {
      vv?.removeEventListener('resize', done)
      window.clearTimeout(settle)
      reveal()
    }
    vv?.addEventListener('resize', done, { once: true })
  }

  const answer = (text: string, via: RelayResponseWire['via']): void => {
    const trimmed = text.trim()
    if (trimmed === '') return
    hapticTick()
    // The card states the index it is SHOWING rather than letting the Mac
    // re-derive a cursor -- two derivations of one decision is the bug that
    // shipped three times in app-switching (phone-remote/CLAUDE.md).
    onRespond(id, {
      answer: trimmed,
      via,
      questionIndex: interview.isInterview ? interview.index : undefined,
      // Answering a question that already holds an answer can only be a change:
      // you had to step back onto it to be here. Without this the store keeps
      // the first answer and the tap does nothing visible.
      revise: interview.answered !== undefined
    })
    // Back on the rails: an answer given while stepped back moves to whatever
    // the interview is waiting on, rather than stranding the person on a
    // question they have now finished twice.
    setViewIndex(null)
    setDraft('')
    clearDraft(id)
  }

  /** Send the whole set. Needed because a revision deliberately does NOT settle
   *  the request -- changing an earlier answer must not fire the burst out from
   *  under someone still stepping through -- so the last question's answer has
   *  to be re-sent, without `revise`, to end the interview. */
  const sendAll = (): void => {
    const last = params.questions ? params.questions.length - 1 : -1
    const held = answerAt(params.buffered, last)
    if (last < 0 || held === undefined) return
    hapticTick()
    onRespond(id, { answer: held, via: 'chip', questionIndex: last })
    setViewIndex(null)
  }

  return (
    <div
      className={`codeCard${justOpened ? ' justOpened' : ''}`}
      data-request-id={id}
      data-risk={highRisk ? 'high' : undefined}
      data-level={params.level}
      style={flick.style}
      onAnimationEnd={justOpened ? onJustOpenedEnd : undefined}
      {...flick.handlers}
    >
      {showSender && (
        <SenderChip
          from={params.from}
          sessions={sessions}
          onOpen={
            onOpenSession && sessionLabel ? () => onOpenSession(sessionLabel) : undefined
          }
          unmatched={Boolean(onOpenSession)}
        />
      )}
      <div className="codeCardHead">
        <div className="codeCardVerb">
          {levelHeading(verb, params.level, params.test)}
          {highRisk && <span className="codeRiskTag">Hard to undo</span>}
        </div>
        <WaitingTime request={request} />
        <Button
          variant="bare"
          className="codeDismiss"
          onClick={() => setClearingAt(Date.now())}
          aria-label="Clear without answering"
          type="button"
        >
          <X size={16} strokeWidth={2.5} />
        </Button>
      </div>

      {clearingAt !== null && (
        <div className="codeDismissBar" key={clearingAt}>
          <span
            className="codeDismissSweep"
            style={{ animationDuration: `${RELAY_CLEAR_DELAY_MS}ms` }}
            aria-hidden="true"
          />
          <span className="codeDismissAsk">Clearing. The agent gets told you skipped it.</span>
          <Button variant="bare" className="codeDismissCancel" onClick={() => setClearingAt(null)} type="button">
            Keep it
          </Button>
        </div>
      )}

      {/* Above the verb blocks, not inside `show`'s: ask/approve can carry a
          picture too, and the whole point is seeing it in the same glance as the
          question -- an image below the buttons is one you decide without. */}
      {params.hasImage && (
        <img
          className="codeCardImage"
          src={imageSrc(id)}
          alt={params.caption ?? 'From your agent'}
        />
      )}

      {/* Under the picture, above the verb blocks: it answers "how far", which
          you want before the question, not after the buttons. A ring rather
          than a bar, so one glance reads the same on a card as on a row --
          only the detail sheet is wide enough to earn a bar. */}
      {params.progress !== undefined && (
        <ProgressMeter value={params.progress} classes={PHONE_METER_CLASSES} />
      )}

      {verb === 'ask' && (
        <>
          <RelayInterviewNav interview={interview} onGo={setViewIndex} classes={PHONE_NAV_CLASSES} />
          {!askDone && <div className="codeCardBody">{askQuestion}</div>}
          {askDone && (
            <div className="codeCardBody">
              {interview.blockedCopy ?? CONFIG.UI_LABELS.CODE_ASK_ALL_ANSWERED}
            </div>
          )}
          {hasOptions && (
            <div className="codeChips">
              {askOptions?.map((option) => (
                <Button
                  variant="bare"
                  key={option}
                  className="codeChip"
                  // The tick is what makes a stepped-back question readable: the
                  // question alone cannot say which of three chips you picked.
                  data-picked={interview.answered === option ? '' : undefined}
                  onClick={() => answer(option, 'chip')}
                >
                  {option}
                </Button>
              ))}
            </div>
          )}
          {interview.answered !== undefined && hasOptions && (
            <div className="codeCardHint">{CONFIG.UI_LABELS.CODE_ASK_CHANGE_HINT}</div>
          )}
          {/* Only when the whole set is held: a blocked interview shows its own
              copy and has nothing to send from here. */}
          {askDone && !interview.blockedCopy && (
            <div className="codeActions">
              <Button variant="primary" size="lg" className="codeBtnApprove" onClick={sendAll} type="button">
                <Send size={16} />
                {CONFIG.UI_LABELS.CODE_ASK_SEND_ALL}
              </Button>
            </div>
          )}
          {!askDone && interview.canType && (
            <div className="chatComposer">
              <textarea
                ref={inputRef}
                className="chatInput"
                value={draft}
                rows={1}
                // Under chips the box needs to say it's the way out when none of
                // them fit; on its own there's nothing to be an alternative to.
                placeholder={hasOptions ? 'Or say it your own way' : 'Type your answer'}
                onFocus={(e) => revealOnFocus(e.currentTarget)}
                onChange={(e) => {
                  editDraft(e.target.value)
                  autosize(e.target)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    answer(draft, 'typed')
                  }
                }}
              />
              <Button
                variant="bare"
                className="chatSendBtn"
                disabled={draft.trim() === ''}
                aria-label="Send answer"
                onClick={() => answer(draft, 'typed')}
              >
                <Send size={18} />
              </Button>
            </div>
          )}
        </>
      )}

      {verb === 'approve' && (
        <>
          <div className="codeCardBody">{params.action}</div>
          {params.detail && <div className="codeCardDetail">{params.detail}</div>}
          <textarea
            className="chatInput codeNote"
            value={draft}
            rows={1}
            placeholder="Add a note (optional)"
            onFocus={(e) => revealOnFocus(e.currentTarget)}
            onChange={(e) => {
              editDraft(e.target.value)
              autosize(e.target)
            }}
          />
          <div className="codeActions">
            <Button
              variant={highRisk ? 'danger' : 'primary'} size="lg"
              className="codeBtnApprove"
              onClick={() => {
                hapticTick()
                onRespond(id, { approved: true, note: draft.trim() || undefined, via: 'chip' })
                clearDraft(id)
              }}
            >
              {highRisk ? <AlertTriangle size={16} /> : <Check size={16} />}
              {/* A destructive approval names what it is doing. "Approve" on a
                  card that drops a prod table is the same pixel as "Approve" on
                  a library preference, and a blind tap must not read alike. */}
              {highRisk ? 'Yes, do it' : 'Approve'}
            </Button>
            <Button
              variant="secondary" size="lg"
              className="codeBtnDeny"
              onClick={() => {
                hapticTick()
                onRespond(id, { approved: false, note: draft.trim() || undefined, via: 'chip' })
                clearDraft(id)
              }}
            >
              <X size={16} />
              Don&apos;t
            </Button>
          </div>
        </>
      )}

      {verb === 'show' && (
        <>
          {params.caption && <div className="codeCardBody">{params.caption}</div>}
          {params.waitForAck && (
            <div className="codeActions">
              <Button
                variant="primary" size="lg"
                className="codeBtnApprove"
                onClick={() => {
                  hapticTick()
                  onRespond(id, { acked: true, via: 'chip' })
                }}
              >
                <Check size={16} />
                Got it
              </Button>
            </div>
          )}
        </>
      )}

      {verb === 'photos_get' && onPickPhoto && (
        <PhotoPickButton requestId={id} onSend={onPickPhoto} />
      )}

      {onExpand && (
        <Button variant="bare" className="codeExpand" onClick={onExpand}>
          <Maximize2 size={14} />
          Open on its own
        </Button>
      )}
    </div>
  )
}

/** Read-only tail (§6b). Shows what the answer WAS so a card that resolved on
 *  another surface explains itself rather than just vanishing. Lives here, not
 *  in CodeSheet: CodeDetail renders it too, and CodeSheet imports CodeDetail. */
export function ResolvedCard({
  request,
  justOpened,
  onJustOpenedEnd,
  onUndismiss,
  onExpand,
  imageSrc,
  sessions = [],
  onOpenSession
}: {
  request: RelayRequestWire
  justOpened?: boolean
  onJustOpenedEnd?: () => void
  onUndismiss?: (requestId: string) => void
  /** Absent inside CodeDetail -- an open card must not offer to open itself. */
  onExpand?: () => void
  imageSrc: (requestId: string) => string
  sessions?: ReadonlyArray<FaceSession>
  /** Tapping the sender chip opens that agent's session, by label. */
  onOpenSession?: (label: string) => void
}): React.JSX.Element {
  const { params, id } = request
  const sessionLabel = senderSessionLabel(request, sessions)
  const summary = cardSummary(request)
  // The body only when it says something the summary did not -- a notify whose
  // title IS its message would otherwise print the same line twice.
  const body = params.body ?? params.detail
  const extra = body && body !== summary ? body : null
  const answered = request.status === 'resolved' || request.status === 'dismissed'

  return (
    // A ROW, not a card: a card says "do something", and there is nothing left
    // to do here. Same hairline vocabulary the History list uses one tab away,
    // so "a past thing" looks the same on both screens.
    // The whole row opens it -- one action per row, biggest possible target,
    // and it drops the "Open on its own" link that was shouting over the
    // outcome on every single row.
    <div
      className={`codeResolvedRow${justOpened ? ' justOpened' : ''}${onExpand ? ' tappable' : ''}`}
      data-request-id={id}
      data-level={params.level}
      role={onExpand ? 'button' : undefined}
      tabIndex={onExpand ? 0 : undefined}
      onClick={onExpand}
      onKeyDown={
        onExpand
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onExpand()
              }
            }
          : undefined
      }
      onAnimationEnd={justOpened ? onJustOpenedEnd : undefined}
    >
      <div className="codeResolvedTop">
        {params.from && (
          <SenderChip
            from={params.from}
            sessions={sessions}
            onOpen={onOpenSession && sessionLabel ? () => onOpenSession(sessionLabel) : undefined}
            unmatched={Boolean(onOpenSession)}
          />
        )}
        {/* Every row in this list words its outcome the same way, so the time is
            what makes it scannable. Minute-granular, so it needs no ticker. */}
        <span className="codeCardWhen">{resolvedWhen(request, Date.now())}</span>
      </div>
      {/* No verb eyebrow here, unlike the answerable card: resolvedOutcome below
          already opens with it ("You approved it", "You said no"), so printing
          APPROVAL NEEDED above every row said the same word twice and gave a
          list of finished things the visual weight of a pending one. Level and
          test still ride data-level, which tints the row. */}
      {/* History keeps the picture too: a row saying "you approved this" is not
          a record of the decision if the thing you were deciding about is gone. */}
      {params.hasImage && (
        <img
          className="codeResolvedImage"
          src={imageSrc(id)}
          alt={params.caption ?? 'From your agent'}
        />
      )}
      {params.progress !== undefined && (
        <ProgressMeter value={params.progress} classes={PHONE_METER_CLASSES} />
      )}
      <div className="codeResolvedBody">{summary}</div>
      {extra && <div className="codeResolvedDetail">{extra}</div>}
      <div className="codeCardOutcome" data-answered={answered ? '' : undefined}>
        <OutcomeIcon request={request} />
        <span className="codeOutcomeText">{request.response?.answer ?? resolvedOutcome(request)}</span>
        {/* Only while the store still says so. `undoable` goes false the moment
            the agent is told, and the snapshot that carries that also removes
            this button -- there is nothing to call back after that. */}
        {request.undoable && onUndismiss && (
          <Button
            variant="bare"
            className="codeUndo"
            onClick={(e) => {
              // The row itself opens the request now, so Undo has to keep its
              // click to itself.
              e.stopPropagation()
              hapticTick()
              onUndismiss(request.id)
            }}
          >
            <Undo2 size={12} strokeWidth={2.5} />
            Undo
          </Button>
        )}
      </div>
    </div>
  )
}

function OutcomeIcon({ request }: { request: RelayRequestWire }): React.JSX.Element {
  const { response, status } = request
  if (status === 'timedout') return <Clock className="codeOutcomeIcon" size={14} strokeWidth={2.25} />
  if (status === 'dismissed')
    return <MinusCircle className="codeOutcomeIcon" size={14} strokeWidth={2.25} />
  if (response?.approved === true)
    return <Check className="codeOutcomeIcon" data-kind="yes" size={14} strokeWidth={2.5} />
  if (response?.approved === false)
    return <X className="codeOutcomeIcon" data-kind="no" size={14} strokeWidth={2.5} />
  if (response?.answer)
    return <CornerDownRight className="codeOutcomeIcon" size={14} strokeWidth={2.25} />
  if (response?.acked) return <Eye className="codeOutcomeIcon" size={14} strokeWidth={2.25} />
  return <Bell className="codeOutcomeIcon" size={14} strokeWidth={2.25} />
}

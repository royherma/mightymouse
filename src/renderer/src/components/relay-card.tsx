/**
 * The Mac Code panel's answerable card, plus the two small pieces every card
 * shows (`SenderChip`, `WaitingTime`).
 *
 * Split out of CodePanel.tsx so the panel file stays about the panel -- status,
 * tabs, sort/filter, grouping -- and the card stays about one request. Shares
 * nothing visual with the phone's card by design: only the decisions with a
 * right answer come from `@shared/relay-cards`.
 */

import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, CornerDownLeft, Maximize2, X } from 'lucide-react'
import { levelHeading, waitingLabel, isHighRisk, UNKNOWN_SENDER } from '../../../shared/relay-cards'
import { ProjectAvatar } from './ProjectIcon'
import { readDraft, writeDraft, clearDraft } from '../../../shared/relay-drafts'
import { RELAY_CLEAR_DELAY_MS, useFlickDismiss } from '../../../shared/relay-flick'
import { interviewView, answerAt } from '../../../shared/relay-interview'
import { RelayInterviewNav, MAC_NAV_CLASSES } from '../../../shared/relay-interview-nav'
import { CONFIG } from '../../../shared/config'
import { ScoredAsk } from './scored-ask'
import type { RelayRequestWire, RelayResponseWire } from '../../../shared/phone-remote-protocol'
import { Button } from './Button'

export type SenderProject = { icon?: string; imagePath?: string }

export function SenderChip({
  from,
  project,
  onOpen
}: {
  from?: string
  project?: SenderProject
  /** Open this sender's own sheet. Absent on a card that IS already inside that
   *  sheet, and on an unnamed sender -- there is nothing to key a history on. */
  onOpen?: () => void
}): React.JSX.Element {
  const inner = (
    <>
      {from && project ? (
        <ProjectAvatar icon={project.icon} imagePath={project.imagePath} size={14} className="rounded-sm" />
      ) : (
        <span className="code-sender-dot" data-unknown="" aria-hidden="true" />
      )}
      {from ?? UNKNOWN_SENDER}
    </>
  )
  if (!onOpen || !from) return <span className="code-sender">{inner}</span>
  // A button rather than a click handler on the span: this is the one route
  // from a card to the agent behind it, and it has to be reachable by keyboard
  // and announce itself as an action.
  return (
    <Button
      variant="bare"
      className="code-sender code-sender-open"
      onClick={onOpen}
      title={`See everything ${from} has sent`}
    >
      {inner}
    </Button>
  )
}

/** 1s tick because both halves of the label change while the card is on screen.
 *  The wording itself is shared with the phone. */
export function WaitingTime({ request }: { request: RelayRequestWire }): React.JSX.Element | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(tick)
  }, [])

  const label = waitingLabel(request, now)
  if (!label) return null
  return (
    <span className="code-waiting" data-urgent={label.urgent ? '' : undefined}>
      {label.text}
    </span>
  )
}

export function RelayCard(props: {
  request: RelayRequestWire
  /** False when the group header already states the sender above this card. */
  showSender: boolean
  onRespond: (requestId: string, response: RelayResponseWire) => void
  /** Open this card on its own. Absent when the card IS the detail view, which
   *  is what stops it offering to open itself. */
  onExpand?: () => void
  /** List only. Detail treats a pointer-drag as text selection. */
  allowFlick?: boolean
  project?: SenderProject
}): React.JSX.Element {
  const { request, showSender, onRespond, onExpand, allowFlick, project } = props
  const { params, verb, id } = request
  const highRisk = isHighRisk(request)
  // Seeded from storage for the same reason as the phone sheet: this card
  // unmounts on every relay snapshot, and a fresh useState('') dropped a
  // half-typed answer whenever any other agent sent anything.
  const [draft, setDraft] = useState(() => readDraft(id))
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  const editDraft = (text: string): void => {
    setDraft(text)
    writeDraft(id, text)
  }

  // Same derivation as the phone card, from the same shared helper -- the two
  // cards render one interview and must not hold separate cursors (PRD §7.3).
  // Which question is being LOOKED at, when that is not the one the interview is
  // waiting on. null means "follow the cursor" -- an untouched interview behaves
  // exactly as it did before back-nav existed.
  const [viewIndex, setViewIndex] = useState<number | null>(null)

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
  const askDone = interview.isInterview && shown === null

  const [clearingAt, setClearingAt] = useState<number | null>(null)

  const dismiss = (): void => {
    onRespond(id, { dismissed: true, via: 'dismiss' })
    clearDraft(id)
    setClearingAt(null)
  }

  useEffect(() => {
    if (clearingAt === null) return
    const timer = setTimeout(dismiss, RELAY_CLEAR_DELAY_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearingAt])

  const flick = useFlickDismiss(allowFlick && clearingAt === null ? dismiss : undefined)

  const autosize = (el: HTMLTextAreaElement): void => {
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 90)}px`
  }

  const answer = (text: string, via: RelayResponseWire['via']): void => {
    const trimmed = text.trim()
    if (trimmed === '') return
    onRespond(id, {
      answer: trimmed,
      via,
      questionIndex: interview.isInterview ? interview.index : undefined,
      // Answering a question that already holds an answer can only be a change:
      // you had to step back onto it to be here. Without this the store keeps
      // the first answer and the click does nothing visible.
      revise: interview.answered !== undefined
    })
    setViewIndex(null)
    setDraft('')
    clearDraft(id)
  }

  /** Send the whole set. A revision deliberately does NOT settle the request, so
   *  the last question's answer is re-sent without `revise` to end it. */
  const sendAll = (): void => {
    const last = params.questions ? params.questions.length - 1 : -1
    const held = answerAt(params.buffered, last)
    if (last < 0 || held === undefined) return
    onRespond(id, { answer: held, via: 'chip', questionIndex: last })
    setViewIndex(null)
  }

  return (
    <div
      className="code-card"
      data-request-id={request.id}
      data-risk={highRisk ? 'high' : undefined}
      data-level={params.level}
      style={flick.style}
      {...flick.handlers}
    >
      <div className="code-card-head">
        {showSender && <SenderChip from={params.from} project={project} />}
        <span className="code-verb">
          {levelHeading(verb, params.level, params.test)}
          {highRisk && <span className="code-risk-tag">Hard to undo</span>}
        </span>
        <WaitingTime request={request} />
        {/* In the head beside the ×, not a row under the actions: the Mac has
            hover, so the two card-level controls belong together in the corner
            the eye already goes to for them. */}
        {onExpand && (
          <Button
            variant="bare"
            className="code-expand"
            onClick={onExpand}
            title="Open on its own"
            aria-label="Open on its own"
          >
            <Maximize2 size={12} strokeWidth={2.5} />
          </Button>
        )}
        <Button
          variant="bare"
          className="code-dismiss"
          onClick={() => setClearingAt(Date.now())}
          title="Clear without answering"
          aria-label="Clear without answering"
        >
          <X size={12} strokeWidth={2.5} />
        </Button>
      </div>

      {clearingAt !== null && (
        // Keyed on the click time so a second × restarts the sweep from full
        // rather than leaving a bar that has already drained.
        <div className="code-dismiss-bar" key={clearingAt}>
          <span
            className="code-dismiss-sweep"
            style={{ animationDuration: `${RELAY_CLEAR_DELAY_MS}ms` }}
            aria-hidden="true"
          />
          <span className="code-dismiss-text">Clearing. The agent gets told you skipped it.</span>
          <Button variant="secondary"  onClick={() => setClearingAt(null)}>
            Keep it
          </Button>
        </div>
      )}

      {/* Above the verb blocks, not inside `show`'s: ask/approve can carry a
          picture too, and the whole point is seeing it in the same glance as the
          question -- an image below the buttons is one you decide without. */}
      {params.imagePath && (
        <img
          className="code-card-image"
          src={window.api.mediaUrl(params.imagePath)}
          alt={params.caption ?? 'From your agent'}
        />
      )}

      {verb === 'ask' && params.decision && !params.questions?.length && (
        <ScoredAsk request={request} decision={params.decision} onRespond={onRespond} />
      )}

      {verb === 'ask' && !(params.decision && !params.questions?.length) && (
        <>
          <RelayInterviewNav interview={interview} onGo={setViewIndex} classes={MAC_NAV_CLASSES} />
          <div className="code-card-body">
            {askDone
              ? (interview.blockedCopy ?? CONFIG.UI_LABELS.CODE_ASK_ALL_ANSWERED)
              : askQuestion}
          </div>
          {!askDone && askOptions && askOptions.length > 0 && (
            <div className="code-chips">
              {askOptions.map((option) => (
                <Button
                  variant="bare"
                  key={option}
                  className="code-chip"
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
          {interview.answered !== undefined && (askOptions?.length ?? 0) > 0 && (
            <div className="code-card-hint">{CONFIG.UI_LABELS.CODE_ASK_CHANGE_HINT}</div>
          )}
          {askDone && !interview.blockedCopy && (
            <div className="code-actions">
              <Button variant="bare" className="code-btn-approve" onClick={sendAll}>
                {CONFIG.UI_LABELS.CODE_ASK_SEND_ALL}
              </Button>
            </div>
          )}
          {!askDone && interview.canType && (
            <div className="code-composer">
              <textarea
                ref={inputRef}
                className="code-input"
                value={draft}
                rows={1}
                placeholder="Type your answer"
                onChange={(e) => {
                  editDraft(e.target.value)
                  autosize(e.target)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    answer(draft, 'typed')
                  }
                  // Esc closes the field's own draft, not the flyout, or the
                  // panel handler eats a half-typed answer. Clears storage too:
                  // a draft surviving there reappears on the next render.
                  if (e.key === 'Escape' && draft !== '') {
                    e.stopPropagation()
                    setDraft('')
                    clearDraft(id)
                  }
                }}
              />
              <Button
                variant="bare"
                className="code-send"
                disabled={draft.trim() === ''}
                aria-label="Send answer"
                onClick={() => answer(draft, 'typed')}
              >
                <CornerDownLeft size={13} strokeWidth={2.5} />
              </Button>
            </div>
          )}
        </>
      )}

      {verb === 'approve' && (
        <>
          <div className="code-card-body">{params.action}</div>
          {params.detail && <div className="code-card-detail">{params.detail}</div>}
          <textarea
            className="code-input code-note"
            value={draft}
            rows={1}
            placeholder="Add a note (optional)"
            onChange={(e) => {
              editDraft(e.target.value)
              autosize(e.target)
            }}
          />
          <div className="code-actions">
            <Button
              variant="bare"
              className="code-btn-approve"
              onClick={() => {
                onRespond(id, { approved: true, note: draft.trim() || undefined, via: 'chip' })
                clearDraft(id)
              }}
            >
              {highRisk ? <AlertTriangle size={13} /> : <Check size={13} />}
              {/* A destructive approval names what it is doing — "Approve" on a
                  card that drops a prod table must not read like "Approve" on a
                  library preference. */}
              {highRisk ? 'Yes, do it' : 'Approve'}
            </Button>
            <Button
              variant="bare"
              className="code-btn-deny"
              onClick={() => {
                onRespond(id, { approved: false, note: draft.trim() || undefined, via: 'chip' })
                clearDraft(id)
              }}
            >
              <X size={13} />
              Don&apos;t
            </Button>
          </div>
        </>
      )}

      {verb === 'show' && (
        <>
          {params.caption && <div className="code-card-body">{params.caption}</div>}
          {params.waitForAck && (
            <div className="code-actions">
              <Button
                variant="bare"
                className="code-btn-approve"
                onClick={() => onRespond(id, { acked: true, via: 'chip' })}
              >
                <Check size={13} />
                Got it
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

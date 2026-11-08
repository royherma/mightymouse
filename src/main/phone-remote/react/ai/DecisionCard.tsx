import { useState } from 'react'
import { Check, ChevronLeft } from 'lucide-react'
import { answerAt, interviewView, type RelayQuestion } from '@shared/relay-interview'
import type { RelayRequestWire, RelayResponseWire } from '@shared/phone-remote-protocol'
import { RelayCard, WaitingTime } from '../RelayCard'
import { hapticTick } from '../haptics'
import type { AgentRelaySessionInfo } from '@shared/types'
import type { ComposerMic } from './Composer'
import { ScoredAsk } from './ScoredAsk'
import { Button } from '@shared/ui/Button'

type Pick = { answer: string; picks?: number[] }

function questionsOf(request: RelayRequestWire): RelayQuestion[] {
  const { params } = request
  if (params.questions?.length) return params.questions
  return [{ question: params.question ?? params.title ?? '', options: params.options }]
}

function seedPicks(request: RelayRequestWire, total: number): Record<number, Pick> {
  const seeded: Record<number, Pick> = {}
  for (let i = 0; i < total; i++) {
    const held = answerAt(request.params.buffered, i)
    if (held !== undefined) seeded[i] = { answer: held }
  }
  return seeded
}

export function DecisionCard(props: {
  request: RelayRequestWire
  onRespond: (requestId: string, response: RelayResponseWire) => void
  imageSrc: (requestId: string) => string
  onPickPhoto?: (requestId: string, file: File) => Promise<boolean>
  title?: string
  session?: AgentRelaySessionInfo
  mic?: ComposerMic
  onOpenSession?: () => void
}): React.JSX.Element {
  const { request, onRespond } = props
  const decision = request.params.decision
  if (request.verb === 'ask' && decision && !request.params.questions?.length && request.params.options?.length) {
    return (
      <ScoredAsk
        request={request}
        decision={decision}
        session={props.session}
        mic={props.mic}
        imageSrc={props.imageSrc}
        onRespond={onRespond}
        onOpenSession={props.onOpenSession}
      />
    )
  }
  if (request.verb !== 'ask') {
    return (
      <RelayCard
        request={request}
        showSender={false}
        onRespond={onRespond}
        imageSrc={props.imageSrc}
        onPickPhoto={props.onPickPhoto}
      />
    )
  }
  return <AskCard request={request} onRespond={onRespond} title={props.title} />
}

function AskCard(props: {
  request: RelayRequestWire
  onRespond: (requestId: string, response: RelayResponseWire) => void
  title?: string
}): React.JSX.Element {
  const { request, onRespond } = props
  const questions = questionsOf(request)
  const total = questions.length
  const [index, setIndex] = useState(() => {
    const first = questions.findIndex((_, i) => answerAt(request.params.buffered, i) === undefined)
    return first === -1 ? total - 1 : first
  })
  const [picked, setPicked] = useState<Record<number, Pick>>(() => seedPicks(request, total))
  const [typed, setTyped] = useState('')
  const [sent, setSent] = useState(false)
  const [editing, setEditing] = useState(false)

  const view = interviewView(questions, request.params.buffered, request.params.canReadPane ?? false, request.params.options, index)
  const q = questions[index]
  const multi = q?.multiSelect === true
  const current = picked[index]
  const answeredCount = Object.keys(picked).length
  const allAnswered = answeredCount === total
  const reviewing = total > 1 && allAnswered && !editing

  const sendOne = (i: number, pick: Pick, via: RelayResponseWire['via'], revise: boolean): void => {
    onRespond(request.id, {
      answer: pick.answer,
      picks: pick.picks,
      via,
      questionIndex: total > 1 ? i : undefined,
      revise: revise || undefined
    })
  }

  const sendAll = (overrides: Record<number, Pick> = picked, via: RelayResponseWire['via'] = 'chip'): void => {
    hapticTick()
    setSent(true)
    if (total === 1) {
      sendOne(0, overrides[0], via, false)
      return
    }
    const buffered = request.params.buffered
    let finalSent = false
    for (let i = 0; i < total; i++) {
      const held = answerAt(buffered, i)
      if (held === overrides[i].answer) continue
      sendOne(i, overrides[i], via, held !== undefined)
      finalSent = i === total - 1 && held === undefined
    }
    if (!finalSent) sendOne(total - 1, overrides[total - 1], via, false)
  }

  const commit = (pick: Pick, via: RelayResponseWire['via'] = 'chip'): void => {
    const next = { ...picked, [index]: pick }
    setPicked(next)
    setTyped('')
    if (total === 1) {
      if (via === 'typed') sendAll(next, via)
      else hapticTick()
      return
    }
    const unanswered = questions.findIndex((_, i) => next[i] === undefined)
    if (unanswered === -1) setEditing(false)
    else setIndex(unanswered > index ? unanswered : Math.min(index + 1, total - 1))
  }

  const toggle = (option: number): void => {
    hapticTick()
    const was = current?.picks ?? []
    const picks = was.includes(option) ? was.filter((p) => p !== option) : [...was, option].sort((a, b) => a - b)
    const answer = picks.map((p) => q.options?.[p] ?? '').join(', ')
    setPicked((prev) => {
      const next = { ...prev }
      if (picks.length) next[index] = { answer, picks }
      else delete next[index]
      return next
    })
  }

  const dismiss = (): void => {
    hapticTick()
    setSent(true)
    onRespond(request.id, { dismissed: true, via: 'dismiss' })
  }

  if (sent) {
    return (
      <div className="aiDecision" data-request-id={request.id}>
        <div className="aiDecisionHead">
          <Check size={16} /> Sent
        </div>
      </div>
    )
  }

  return (
    <div className="aiDecision" data-request-id={request.id}>
      {total > 1 && (
        <div className="aiQSteps" aria-hidden="true">
          {questions.map((_, i) => (
            <i key={i} data-done={picked[i] ? '' : undefined} data-on={i === index && !reviewing ? '' : undefined} />
          ))}
        </div>
      )}
      <div className="aiDecisionHead">
        <span style={{ flex: 1 }}>
          {(reviewing
            ? [props.title, 'Check your answers']
            : [
                props.title,
                total > 1 ? `Question ${index + 1} of ${total}` : null,
                multi ? 'Pick all that apply' : null,
                total === 1 && !multi ? 'Needs your answer' : null
              ]
          )
            .filter(Boolean)
            .join(' · ')}
        </span>
        <WaitingTime request={request} />
      </div>
      {reviewing ? (
        <>
        <div className="aiMuted">Tap an answer to change it</div>
        <div className="aiQReview">
          {questions.map((item, i) => (
            <Button
              variant="bare"
              key={i}
              type="button"
              className="aiQReviewRow"
              onClick={() => {
                setIndex(i)
                setEditing(true)
              }}
            >
              <span>{item.question}</span>
              <b>{picked[i]?.answer}</b>
            </Button>
          ))}
        </div>
        </>
      ) : view.blockedCopy ? (
        <div className="aiMuted">{view.blockedCopy}</div>
      ) : (
        <>
          <div className="aiDecisionQ">{q?.question}</div>
          {q?.options?.map((label, i) => {
            const on = multi ? (current?.picks ?? []).includes(i) : current?.answer === label
            return (
              <Button
                variant="bare"
                key={`${i}:${label}`}
                type="button"
                className="aiOption"
                aria-pressed={on}
                data-multi={multi ? '' : undefined}
                onClick={() => (multi ? toggle(i) : commit({ answer: label }))}
              >
                <span className="aiOptionMark">{on && <Check size={14} strokeWidth={3} />}</span>
                <span>{label}</span>
              </Button>
            )
          })}
          {view.canType && !multi && (
            <textarea
              className="aiInput"
              rows={1}
              value={typed}
              placeholder={q?.options?.length ? '✎ Type your own' : 'Type your answer'}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && typed.trim()) {
                  e.preventDefault()
                  commit({ answer: typed.trim() }, 'typed')
                }
              }}
            />
          )}
        </>
      )}
      <div className="aiDecisionNav">
        {total > 1 && index > 0 && !reviewing && (
          <Button variant="secondary" size="lg" type="button" className="aiSecondary" onClick={() => setIndex(index - 1)}>
            <ChevronLeft size={16} strokeWidth={2.5} />
            Back
          </Button>
        )}
        <Button variant="secondary" size="lg" type="button" className="aiSecondary" onClick={dismiss}>
          {total > 1 ? 'Skip all' : 'Skip'}
        </Button>
        {typed.trim() && !multi ? (
          <Button variant="primary" size="lg" type="button" className="aiPrimary" onClick={() => commit({ answer: typed.trim() }, 'typed')}>
            {total === 1 ? 'Send' : 'Next'}
          </Button>
        ) : total === 1 ? (
          <Button variant="primary" size="lg" type="button" className="aiPrimary" disabled={!current} onClick={() => sendAll()}>
            Send
          </Button>
        ) : reviewing ? (
          <Button variant="primary" size="lg" type="button" className="aiPrimary" onClick={() => sendAll()}>
            {`Send all ${total}`}
          </Button>
        ) : total > 1 && allAnswered ? (
          <Button variant="primary" size="lg" type="button" className="aiPrimary" disabled={!current} onClick={() => setEditing(false)}>
            Done
          </Button>
        ) : total > 1 && multi ? (
          <Button variant="primary" size="lg" type="button" className="aiPrimary" disabled={!current} onClick={() => current && commit(current)}>
            Next
          </Button>
        ) : null}
      </div>
    </div>
  )
}

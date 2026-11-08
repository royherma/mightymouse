import { useEffect, useMemo, useState, type JSX } from 'react'
import { Bell, Check, Clock, CornerDownLeft, Eye, EyeOff, Undo2, X } from 'lucide-react'
import {
  cardSummary,
  resolvedOutcome,
  resolvedWhen
} from '../../../shared/relay-cards'
import type { RelayRequestWire } from '../../../shared/phone-remote-protocol'
import { Button } from './Button'
import { SenderChip, type SenderProject } from './relay-card'
import './PreviousList.css'

const PLACEHOLDER = new Set(['???', 'Unknown agent'])

function shownText(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  if (!trimmed || PLACEHOLDER.has(trimmed)) return null
  return trimmed
}

function endedAt(request: RelayRequestWire): number {
  return request.resolvedAt ?? request.createdAt
}

function startOfLocalDay(at: number): number {
  const day = new Date(at)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

function dayLabel(dayStart: number, now: number): string {
  const today = startOfLocalDay(now)
  if (dayStart === today) return 'Today'
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  if (dayStart === yesterday.getTime()) return 'Yesterday'
  const day = new Date(dayStart)
  const sameYear = day.getFullYear() === new Date(now).getFullYear()
  return day.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' })
  })
}

function questionText(request: RelayRequestWire): { question: string; detail: string | null } {
  const summary = shownText(cardSummary(request))
  const body = shownText(request.params.body ?? request.params.detail)
  return {
    question: summary ?? body ?? 'No message',
    detail: summary && body && body !== summary ? body : null
  }
}

function useMinuteNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(tick)
  }, [])
  return now
}

type OutcomeKind = 'approved' | 'declined' | 'answered' | 'cleared' | 'timedout' | 'seen' | 'delivered'

function outcomeKind(request: RelayRequestWire): OutcomeKind {
  const { response, status, verb } = request
  if (status === 'timedout') return 'timedout'
  if (status === 'dismissed') return 'cleared'
  if (response?.approved === true) return 'approved'
  if (response?.approved === false) return 'declined'
  if (response?.answer) return 'answered'
  if (response?.acked) return 'seen'
  return verb === 'notify' ? 'delivered' : 'answered'
}

const OUTCOME_ICON: Record<OutcomeKind, typeof Check> = {
  approved: Check,
  declined: X,
  answered: CornerDownLeft,
  cleared: EyeOff,
  timedout: Clock,
  seen: Eye,
  delivered: Bell
}

function ResolvedCard({
  request,
  now,
  projectOf,
  onUndismiss,
  onOpenSender
}: {
  request: RelayRequestWire
  now: number
  projectOf: (from: string) => SenderProject | undefined
  onUndismiss?: (requestId: string) => void
  onOpenSender?: (from: string) => void
}): JSX.Element {
  const from = shownText(request.params.from)
  const { question, detail } = questionText(request)
  const kind = outcomeKind(request)
  const Icon = OUTCOME_ICON[kind]
  return (
    <div className="code-answered" data-outcome={kind}>
      <span className="code-answered-icon" aria-hidden="true">
        <Icon size={13} strokeWidth={2.5} />
      </span>
      <div className="code-answered-body">
        <div className="code-answered-question" title={detail ? `${question}\n\n${detail}` : question}>
          {question}
        </div>
        <div className="code-answered-meta">
          <span className="code-answered-outcome">{resolvedOutcome(request)}</span>
          {from && (
            <SenderChip
              from={from}
              project={projectOf(from)}
              onOpen={onOpenSender ? () => onOpenSender(from) : undefined}
            />
          )}
        </div>
      </div>
      <div className="code-answered-side">
        {request.undoable && onUndismiss && (
          <Button variant="ghost" className="code-answered-undo" onClick={() => onUndismiss(request.id)}>
            <Undo2 size={11} strokeWidth={2.5} />
            Undo
          </Button>
        )}
        <span className="code-answered-when">{resolvedWhen(request, now)}</span>
      </div>
    </div>
  )
}

export function PreviousList(props: {
  requests: RelayRequestWire[]
  projectOf: (from: string) => SenderProject | undefined
  onUndismiss?: (requestId: string) => void
  onOpenSender?: (from: string) => void
}): JSX.Element {
  const now = useMinuteNow()
  const [testsOpen, setTestsOpen] = useState(false)
  const { days, tests } = useMemo(() => {
    const tests: RelayRequestWire[] = []
    const rest: RelayRequestWire[] = []
    for (const request of props.requests) {
      if (request.params.test === true) tests.push(request)
      else rest.push(request)
    }
    const byNewest = (a: RelayRequestWire, b: RelayRequestWire): number => endedAt(b) - endedAt(a)
    tests.sort(byNewest)
    rest.sort(byNewest)
    const days: { key: number; label: string; requests: RelayRequestWire[] }[] = []
    for (const request of rest) {
      const key = startOfLocalDay(endedAt(request))
      const last = days[days.length - 1]
      if (last && last.key === key) last.requests.push(request)
      else days.push({ key, label: dayLabel(key, now), requests: [request] })
    }
    return { days, tests }
  }, [props.requests, now])

  return (
    <div className="code-previous">
      {days.map((day) => (
        <section key={day.key} className="code-previous-day-group">
          <h3 className="code-previous-day">{day.label}</h3>
          <div className="code-previous-cards">
            {day.requests.map((request) => (
              <ResolvedCard
                key={request.id}
                request={request}
                now={now}
                projectOf={props.projectOf}
                onUndismiss={props.onUndismiss}
                onOpenSender={props.onOpenSender}
              />
            ))}
          </div>
        </section>
      ))}
      {tests.length > 0 && (
        <div className="code-previous-tests-block">
          <Button
            variant="bare"
            className="code-previous-tests"
            aria-expanded={testsOpen}
            onClick={() => setTestsOpen((open) => !open)}
          >
            Tests · {tests.length}
          </Button>
          {testsOpen && (
            <div className="code-previous-cards">
              {tests.map((request) => (
                <ResolvedCard
                  key={request.id}
                  request={request}
                  now={now}
                  projectOf={props.projectOf}
                  onUndismiss={props.onUndismiss}
                  onOpenSender={props.onOpenSender}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

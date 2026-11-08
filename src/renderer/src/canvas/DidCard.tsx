import type { ReactElement } from 'react'
import { AlertCircle, ArrowUpRight, Check, MessageSquare, Sparkles, X } from 'lucide-react'
import { Button } from '../components/Button'
import { CANVAS_SANDBOX, canvasFailText, type CanvasBubble } from '@shared/canvas'
import type { DidCard, LiveRun } from './useDispatcher'

export interface CardLink {
  id: string
  text: string
}

interface Props {
  card: DidCard
  live?: LiveRun
  bubble: CanvasBubble
  links: CardLink[]
  chips: Array<{ id: string; name: string }>
  planetName: (id: string) => string
  onMove: (planet: string) => void
  onRunIn: (planet?: string) => void
  onUnlink: (linkId: string) => void
  onAsk: () => void
  onOpen: () => void
  onRetry: () => void
  onClose: () => void
}

const LIVE_CARD_CHARS = 420

const short = (t: string, n = 46): string => (t.length > n ? `${t.slice(0, n).trimEnd()}...` : t)

function headline(card: DidCard, bubble: CanvasBubble, name: string): string {
  const chatName = card.sentTo
  if (card.phase === 'reading') return 'Reading it...'
  if (card.phase === 'failed') return card.fail ?? 'Something went wrong'
  if (card.phase === 'pick') return 'Which project is this for?'
  if (card.phase === 'working')
    return card.sent === 'continue' && chatName ? `Sent to ${chatName}` : `Asking in ${name}`
  if (card.phase === 'answered')
    return card.sent === 'continue' && chatName ? `Answered in ${chatName}` : `Answered in ${name}`
  return bubble.planet === CANVAS_SANDBOX
    ? 'Kept in Sandbox - no project fit'
    : `Filed under ${name}`
}

/** What the dispatcher just did with one input, with a one-click fix for each decision. */
export function DidCardView(p: Props): ReactElement {
  const { card, bubble } = p
  const name = p.planetName(bubble.planet)
  const busy = card.phase === 'reading' || card.phase === 'working'
  const picking = card.phase === 'pick'
  const picks = picking ? (card.picks ?? []) : []
  const chips = [
    ...picks.map((id) => ({ id, name: p.planetName(id) })),
    ...p.chips.filter((c) => !picks.includes(c.id) && !(picking && c.id === CANVAS_SANDBOX))
  ]
  const outOfRoom =
    card.phase === 'failed' &&
    (bubble.stuck?.reason === 'out_of_credits' ||
      card.fail === canvasFailText('chat', 'out_of_credits') ||
      card.fail === canvasFailText('file', 'out_of_credits'))
  const Icon =
    card.phase === 'failed'
      ? AlertCircle
      : card.phase === 'filed'
        ? Check
        : card.phase === 'answered'
          ? MessageSquare
          : Sparkles
  return (
    <div
      className={`cv-card ${card.phase === 'failed' ? 'cv-card-bad' : ''}`}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="cv-card-head">
        <Icon size={15} className={busy ? 'cv-spin' : ''} />
        <b>{headline(card, bubble, name)}</b>
        <span className="cv-card-you">"{short(bubble.text, 60)}"</span>
        <Button variant="icon" aria-label="Close" onClick={p.onClose}>
          <X size={12} />
        </Button>
      </div>
      {card.answer ? (
        <div className="cv-card-answer">{card.answer}</div>
      ) : card.phase === 'working' && p.live?.text ? (
        <div className="cv-card-answer cv-card-live">
          <span>
            {p.live.text.slice(-LIVE_CARD_CHARS)}
            <span className="cv-caret" />
          </span>
        </div>
      ) : null}
      {card.phase !== 'reading' ? (
        <div className="cv-card-row">
          <span className="cv-card-label">{picking ? 'Run it in' : 'Move to'}</span>
          {chips
            .filter((c) => c.id !== bubble.planet)
            .map((c) => (
              <Button
                key={c.id}
                variant="bare"
                data-planet={c.id}
                className={`cv-chip ${picks.includes(c.id) ? 'cv-chip-on' : ''}`}
                onClick={() => (picking ? p.onRunIn(c.id) : p.onMove(c.id))}
              >
                {c.name}
              </Button>
            ))}
        </div>
      ) : null}
      {p.links.length ? (
        <div className="cv-card-row">
          <span className="cv-card-label">Linked to</span>
          {p.links.map((l) => (
            <span key={l.id} className="cv-chip cv-chip-link">
              {short(l.text, 34)}
              <Button
                variant="bare"
                data-unlink={l.id}
                aria-label="Remove link"
                className="cv-chip-x"
                onClick={() => p.onUnlink(l.id)}
              >
                <X size={10} />
              </Button>
            </span>
          ))}
        </div>
      ) : null}
      {card.phase === 'working' ? (
        <div className="cv-work cv-card-work">
          <i />
          <i />
          <i />
          {p.live?.phase ?? 'Working on it'}
        </div>
      ) : null}
      <div className="cv-card-foot">
        {card.ran ? <span className="cv-ran">{card.ran}</span> : <span />}
        {outOfRoom ? (
          <Button variant="secondary" onClick={() => void window.api.openBillingWindow()}>
            See plans
          </Button>
        ) : null}
        {card.phase === 'failed' ? (
          <Button variant="primary" className="cv-retry" onClick={p.onRetry}>
            Try again
          </Button>
        ) : null}
        {picking ? (
          <Button variant="secondary" data-act="no-project" onClick={() => p.onRunIn()}>
            Ask without a project
          </Button>
        ) : null}
        {card.phase === 'filed' ? (
          <Button variant="secondary" data-act="chat" onClick={p.onAsk}>
            Ask AI about it
          </Button>
        ) : null}
        {card.phase === 'filed' || card.sessionId ? (
          <Button variant={card.sessionId ? 'primary' : 'ghost'} data-open onClick={p.onOpen}>
            {card.sessionId ? 'Open chat' : 'Plan it'}
            <ArrowUpRight size={13} className="inline ml-1 -mt-px" />
          </Button>
        ) : null}
      </div>
    </div>
  )
}

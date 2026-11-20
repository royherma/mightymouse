import { useEffect, useRef } from 'react'
import { Bot, Check, Laptop, Loader2, Plus, Square, X } from 'lucide-react'
import type { TalkOptionWire } from '@shared/phone-remote-protocol'
import { TALK, TALK_LABELS } from '@shared/talk'
import { Button } from '@shared/ui/Button'
import PhoneRemoteTitleBar from './PhoneRemoteTitleBar'
import { StepRow } from './ActProgressSheet'
import { Avatar } from './ai/AiHome'
import { Composer, type ComposerMic } from './ai/Composer'
import { hapticTick } from './haptics'
import { talkHeadline, type TalkState, type TalkTurnView } from './hooks/use-talk'
import './talk.css'

const VISIBLE_STEPS = 3
const TALK_LIST_PAD_PX = 8

function OptionIcon({ option }: { option: TalkOptionWire }): React.JSX.Element {
  if (option.kind === 'computer') {
    return (
      <Avatar size={34}>
        <Laptop size={17} strokeWidth={2.25} />
      </Avatar>
    )
  }
  return (
    <span className="talkOptionAv">
      <Avatar project={option.project} size={34} />
      <span className="talkOptionBadge">
        {option.kind === 'new-agent' ? (
          <Plus size={10} strokeWidth={3} />
        ) : (
          <Bot size={10} strokeWidth={2.5} />
        )}
      </span>
    </span>
  )
}

function OptionRow({
  option,
  lead,
  onPick
}: {
  option: TalkOptionWire
  lead: boolean
  onPick: () => void
}): React.JSX.Element {
  const name =
    option.kind === 'new-agent'
      ? `${TALK_LABELS.newAgentIn} ${option.project?.name ?? option.label}`
      : option.label
  return (
    <Button variant="bare" className={`talkOption${lead ? ' lead' : ''}`} onClick={onPick}>
      <OptionIcon option={option} />
      <span className="talkOptionText">
        <span className="talkOptionName">{name}</span>
        {option.detail !== '' && <span className="talkOptionDetail">{option.detail}</span>}
      </span>
      <span className="talkOptionPct">{option.percent}%</span>
    </Button>
  )
}

function Countdown(): React.JSX.Element {
  return (
    <span className="talkCountdown">
      <span className="talkCountdownFill" style={{ animationDuration: `${TALK.AUTO_GO_MS}ms` }} />
    </span>
  )
}

function TurnBody({
  turn,
  talk,
  onOpenCode
}: {
  turn: TalkTurnView
  talk: TalkState
  onOpenCode?: () => void
}): React.JSX.Element {
  if (turn.phase === 'deciding') {
    return (
      <div className="talkStatus">
        <Loader2 size={14} className="animate-spin" />
        {TALK_LABELS.deciding}
      </div>
    )
  }
  if (turn.phase === 'counting') {
    return (
      <>
        <div className="talkHeadline">{talkHeadline(turn)}</div>
        <Countdown key={turn.goAt} />
        <div className="talkActions">
          <Button variant="bare" className="talkPill" onClick={() => talk.go(turn.id, turn.pick)}>
            {TALK_LABELS.goNow}
          </Button>
          <Button variant="bare" className="talkPill quiet" onClick={() => talk.change(turn.id)}>
            {TALK_LABELS.change}
          </Button>
          <Button variant="bare" className="talkLink" onClick={() => talk.cancel(turn.id)}>
            {TALK_LABELS.cancel}
          </Button>
        </div>
      </>
    )
  }
  if (turn.phase === 'choosing') {
    return (
      <>
        <div className="talkHeadline">{TALK_LABELS.pickOne}</div>
        <div className="talkOptions">
          {turn.options.map((option, i) => (
            <OptionRow
              key={option.id}
              option={option}
              lead={i === 0}
              onPick={() => {
                hapticTick()
                talk.go(turn.id, option.id)
              }}
            />
          ))}
        </div>
        <Button
          variant="bare"
          className="talkLink talkCancelLink"
          onClick={() => talk.cancel(turn.id)}
        >
          {TALK_LABELS.cancel}
        </Button>
      </>
    )
  }
  if (turn.phase === 'running') {
    const steps = turn.steps.slice(-VISIBLE_STEPS)
    return (
      <>
        <div className="talkHeadline">{talkHeadline(turn)}</div>
        {steps.length > 0 && (
          <div className="chatStepList">
            {steps.map((step, i) => (
              <StepRow
                key={`${turn.steps.length - steps.length + i}`}
                step={step}
                active={i === steps.length - 1}
              />
            ))}
          </div>
        )}
        {turn.streamed !== '' && <div className="talkStreamed">{turn.streamed}</div>}
        <div className="talkActions">
          <Button variant="bare" className="chatStopBtn" onClick={() => talk.cancel(turn.id)}>
            <Square size={13} strokeWidth={2.5} />
            {TALK_LABELS.stop}
          </Button>
        </div>
      </>
    )
  }
  const ok = turn.phase === 'done'
  return (
    <>
      <div className={`talkReply${ok ? '' : ' failed'}`}>
        {turn.reply || (ok ? TALK_LABELS.done : TALK_LABELS.failed)}
      </div>
      <div className="talkFooter">
        {turn.target !== '' && (
          <span className="talkTarget">
            {ok && <Check size={12} strokeWidth={3} />}
            {turn.target}
          </span>
        )}
        {ok && turn.openLabel && onOpenCode && (
          <Button variant="bare" className="talkLink talkFooterBtn" onClick={onOpenCode}>
            {TALK_LABELS.open}
          </Button>
        )}
        {!ok && (
          <Button
            variant="bare"
            className="talkLink talkFooterBtn"
            onClick={() => talk.say(turn.text)}
          >
            {TALK_LABELS.tryAgain}
          </Button>
        )}
      </div>
    </>
  )
}

function TalkTurn({
  turn,
  talk,
  onOpenCode
}: {
  turn: TalkTurnView
  talk: TalkState
  onOpenCode?: () => void
}): React.JSX.Element {
  return (
    <article className="talkTurn" data-phase={turn.phase}>
      <p className="talkSaid">{turn.text}</p>
      <div className="talkCard">
        <TurnBody turn={turn} talk={talk} onOpenCode={onOpenCode} />
      </div>
    </article>
  )
}

function TalkEmpty({ talk }: { talk: TalkState }): React.JSX.Element {
  return (
    <div className="talkEmpty">
      <span className="talkEmptyMark">
        <Laptop size={26} strokeWidth={2} />
      </span>
      <p className="talkEmptyLead">{TALK_LABELS.emptyLead}</p>
      <p className="talkEmptySub">{TALK_LABELS.emptySub}</p>
      <div className="talkIdeas">
        {TALK_LABELS.ideas.map((idea) => (
          <Button key={idea} variant="bare" className="talkIdea" onClick={() => talk.say(idea)}>
            {idea}
          </Button>
        ))}
      </div>
    </div>
  )
}

export default function TalkSheet({
  open,
  talk,
  mic,
  onClose,
  onOpenCode
}: {
  open: boolean
  talk: TalkState
  mic?: ComposerMic
  onClose: () => void
  onOpenCode?: () => void
}): React.JSX.Element {
  const listRef = useRef<HTMLDivElement | null>(null)
  const last = talk.turns.at(-1)
  const lastKey = last
    ? `${last.id}:${last.phase}:${last.steps.length}:${last.streamed.length}`
    : ''

  useEffect(() => {
    const list = listRef.current
    const newest = list?.lastElementChild
    if (open && list && newest instanceof HTMLElement)
      list.scrollTo({ top: newest.offsetTop - TALK_LIST_PAD_PX, behavior: 'smooth' })
  }, [open, lastKey])

  return (
    <>
      {open && <div className="historyScrim talkScrim" onClick={onClose} />}
      <div
        data-sheet
        className={`historySheet talkSheet${open ? ' open' : ''}`}
        role="dialog"
        aria-label={TALK_LABELS.title}
      >
        <PhoneRemoteTitleBar
          className="historyHeader"
          title={
            <>
              <Laptop size={17} strokeWidth={2.25} />
              <span className="historyTitle">{TALK_LABELS.title}</span>
            </>
          }
          actions={
            <Button
              variant="bare"
              className="historyCloseBtn phoneRemoteTitleBarCloseButton"
              aria-label={TALK_LABELS.close}
              onClick={onClose}
            >
              <X size={20} strokeWidth={2.25} />
            </Button>
          }
        />
        <div ref={listRef} className="talkList">
          {talk.turns.length === 0 ? (
            <TalkEmpty talk={talk} />
          ) : (
            talk.turns.map((turn) => (
              <TalkTurn key={turn.id} turn={turn} talk={talk} onOpenCode={onOpenCode} />
            ))
          )}
        </div>
        <div className="talkDock">
          <Composer
            placeholder={TALK_LABELS.typePlaceholder}
            mic={open ? mic : undefined}
            onSend={(text) => talk.say(text)}
          />
        </div>
      </div>
    </>
  )
}

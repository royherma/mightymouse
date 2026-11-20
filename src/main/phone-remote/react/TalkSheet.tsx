import { Bot, Laptop, Plus } from 'lucide-react'
import type { TalkOptionWire } from '@shared/phone-remote-protocol'
import { TALK, TALK_LABELS, talkOptionName } from '@shared/talk'
import { Button } from '@shared/ui/Button'
import { Avatar } from './ai/AiHome'
import { Conversation } from './ai/Conversation'
import type { ComposerMic } from './ai/Composer'
import { chatMediaUrl, type MediaRef, type ThreadItem } from './ai/use-ai-session'
import { hapticTick } from './haptics'
import { talkHeadline, type TalkState, type TalkTurnView } from './hooks/use-talk'
import './talk.css'

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
  const name = talkOptionName(option)
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

function Decision({ turn, talk }: { turn: TalkTurnView; talk: TalkState }): React.JSX.Element {
  if (turn.phase === 'counting') {
    return (
      <div className="talkCard">
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
      </div>
    )
  }
  return (
    <div className="talkCard">
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
      <Button variant="bare" className="talkLink talkCancelLink" onClick={() => talk.cancel(turn.id)}>
        {TALK_LABELS.cancel}
      </Button>
    </div>
  )
}

function turnAt(turn: TalkTurnView): number {
  return Number.parseInt(turn.id.split('-')[1] ?? '', 36) || 0
}

function threadOf(turns: TalkTurnView[]): ThreadItem[] {
  return turns.flatMap((turn): ThreadItem[] => {
    const at = turnAt(turn)
    const photo: MediaRef[] = turn.photo ? [{ key: `${turn.id}:photo`, src: turn.photo, name: TALK_LABELS.yourPhoto }] : []
    const you: ThreadItem = { kind: 'you', key: `q${turn.id}`, at, text: turn.text, media: photo }
    if (turn.phase !== 'done' && turn.phase !== 'failed') return [you]
    const shown = turn.media
    const media: MediaRef[] = shown
      ? shown.items.map((m) => ({
          key: `${turn.id}:${m.item}`,
          src: chatMediaUrl(shown.sessionId, shown.turn, m.item),
          name: m.name,
          video: m.kind === 'video' || undefined
        }))
      : []
    const reply = turn.reply || (turn.phase === 'done' ? TALK_LABELS.done : TALK_LABELS.failed)
    const handedOff = turn.target !== '' && turn.target !== TALK_LABELS.done_.computer
    const text = handedOff ? `${reply}\n\n_${turn.target}_` : reply
    return [you, { kind: 'agent', key: `a${turn.id}`, at, text, failed: turn.phase === 'failed' || undefined, media }]
  })
}

function statusOf(turn: TalkTurnView | undefined): string | null {
  if (!turn) return null
  if (turn.phase === 'deciding') return TALK_LABELS.deciding
  if (turn.phase !== 'running') return null
  const step = turn.steps.at(-1)
  return step ? `${step.phase} ${step.detail}`.trim() : talkHeadline(turn)
}

export default function TalkSheet({
  open,
  talk,
  mic,
  macName,
  onWatch,
  onClose
}: {
  open: boolean
  talk: TalkState
  mic?: ComposerMic
  macName?: string | null
  onWatch?: () => void
  onClose: () => void
}): React.JSX.Element | null {
  if (!open) return null
  const live = talk.turns.at(-1)
  const deciding = live?.phase === 'counting' || live?.phase === 'choosing'
  const busy = live?.phase === 'running' || live?.phase === 'deciding'
  return (
    <div className="ai talkScreen">
      <Conversation
        title={TALK_LABELS.title}
        subtitle={macName || TALK_LABELS.yourComputer}
        project={null}
        icon={<Laptop size={17} />}
        items={threadOf(talk.turns)}
        streamed={live?.phase === 'running' ? live.streamed : undefined}
        statusText={statusOf(live)}
        decisions={live && deciding ? <Decision turn={live} talk={talk} /> : undefined}
        suggestions={talk.turns.length === 0 ? talk.ideas.map((text) => ({ text })) : undefined}
        onBack={onClose}
        onWatch={onWatch}
        placeholder={TALK_LABELS.typePlaceholder}
        busy={busy}
        onStop={live ? () => talk.cancel(live.id) : undefined}
        mic={mic}
        allowPhoto
        emptyText={TALK_LABELS.emptyLead}
        onSend={(text, file) => talk.say(text, file)}
      />
    </div>
  )
}

import { useEffect, useState, type JSX } from 'react'
import { Check, ChevronRight, Hammer, Hand, MessageCircle, Mic, Mouse, MousePointer2, type LucideIcon } from 'lucide-react'
import {
  PHONE_FIRST_STEPS,
  type PhoneFirstStep,
  type PhoneWelcomePick,
  type PhoneRemoteEvent
} from '@shared/phone-remote-protocol'
import { capabilities } from './host-capabilities'
import './first-steps.css'
import { Button } from '@shared/ui/Button'

export type FirstStepsState = Extract<PhoneRemoteEvent, { type: 'firstSteps' }>

const STEP_COPY: Record<PhoneFirstStep, { icon: LucideIcon; todo: string; done: string; hint?: string }> = {
  move: {
    icon: Hand,
    todo: 'Slide a finger here - the pointer on your computer moves',
    done: 'You moved the pointer'
  },
  tap: {
    icon: MousePointer2,
    todo: 'Tap once - that is a click',
    done: 'You clicked'
  },
  talk: {
    icon: Mic,
    todo: 'Press the mic and talk - your words get typed for you',
    hint: 'Your phone will ask to use the mic. Tap Allow.',
    done: 'You typed by talking'
  }
}

const MIC_BLOCKED = `The mic is turned off for ${capabilities.shell === 'native' ? 'MightyMouse' : 'this page'}. Open your phone's Settings, allow the microphone, then press the mic again`

export function useFirstSteps(
  onMessage: (handler: (msg: PhoneRemoteEvent) => void) => () => void
): FirstStepsState | null {
  const [state, setState] = useState<FirstStepsState | null>(null)
  useEffect(
    () =>
      onMessage((msg) => {
        if (msg.type === 'firstSteps') setState(msg)
      }),
    [onMessage]
  )
  return state
}

export function FirstSteps({ state }: { state: FirstStepsState }): JSX.Element {
  const current = PHONE_FIRST_STEPS.find((step) => !state[step])
  const doneCount = PHONE_FIRST_STEPS.filter((step) => state[step]).length
  return (
    <ol
      className="firstSteps"
      aria-label={`Getting started, ${doneCount} of ${PHONE_FIRST_STEPS.length} done`}
    >
      {PHONE_FIRST_STEPS.map((step) => {
        const { icon: Icon, todo, done, hint } = STEP_COPY[step]
        const isDone = state[step]
        const blocked = step === 'talk' && state.micBlocked && !isDone
        return (
          <li
            key={step}
            className="firstStep"
            data-state={isDone ? 'done' : step === current ? 'current' : 'next'}
          >
            <span className="firstStepIcon">
              {isDone ? <Check size={16} strokeWidth={3} /> : <Icon size={16} />}
            </span>
            <span>
              {isDone ? done : blocked ? MIC_BLOCKED : todo}
              {!isDone && !blocked && step === current && hint && <small>{hint}</small>}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

const WELCOME_ROWS: { pick: PhoneWelcomePick; icon: LucideIcon; title: string; body: string }[] = [
  { pick: 'chat', icon: MessageCircle, title: 'Ask a question', body: 'The best AI answers, right here' },
  { pick: 'code', icon: Hammer, title: 'Build something', body: 'Say what you want and it gets made' },
  { pick: 'trackpad', icon: Mouse, title: 'Run your Mac from here', body: 'Point, click and type by talking' }
]

export function Welcome(props: { onPick: (pick: PhoneWelcomePick) => void }): JSX.Element {
  return (
    <section className="welcome" aria-label="Welcome">
      <h2>Welcome to MightyMouse</h2>
      <p>Three things you can do from this phone. Tap one to try it.</p>
      {WELCOME_ROWS.map(({ pick, icon: Icon, title, body }) => (
        <Button variant="bare" key={pick} type="button" className="welcomeRow" onClick={() => props.onPick(pick)}>
          <span className="firstStepIcon">
            <Icon size={16} />
          </span>
          <span>
            <b>{title}</b>
            <span>{body}</span>
          </span>
          <ChevronRight size={18} />
        </Button>
      ))}
      <Button variant="bare" type="button" className="welcomeClose" onClick={() => props.onPick('dismiss')}>
        Got it
      </Button>
    </section>
  )
}

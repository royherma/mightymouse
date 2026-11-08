import { useEffect, useState } from 'react'
import { CircleAlert, Loader2 } from 'lucide-react'
import type { AgentRelaySessionInfo, StartupPeek } from '../../../shared/types'
import { Button } from './Button'

const PEEK_MS = 1000
const SLOW_MS = 20_000
const CLOCK_SLACK_MS = 5_000

/** `pane` undefined = spawn not back yet; '' = opened in a terminal app we can't address. */
export function startedSession(
  sessions: AgentRelaySessionInfo[],
  started: { pane?: string; cwd: string; since: number }
): AgentRelaySessionInfo | undefined {
  if (started.pane) return sessions.find((s) => !s.stale && s.origin?.tmuxPane === started.pane)
  if (started.pane === undefined) return undefined
  const inFolder = (cwd?: string): boolean =>
    !!cwd && (cwd === started.cwd || cwd.startsWith(`${started.cwd}/`))
  return sessions
    .filter((s) => inFolder(s.cwd) && (s.since ?? 0) >= started.since - CLOCK_SLACK_MS)
    .sort((a, b) => (b.since ?? 0) - (a.since ?? 0))[0]
}

type StepState = 'active' | 'ask'

function Step(props: { state: StepState; label: string; hint?: string }): React.JSX.Element {
  const { state, label, hint } = props
  return (
    <li className="starting-agent-step" data-state={state}>
      <span className="starting-agent-mark" aria-hidden="true">
        {state === 'active' ? (
          <Loader2 size={13} strokeWidth={2.5} className="starting-agent-spin" />
        ) : (
          <CircleAlert size={13} strokeWidth={2.5} />
        )}
      </span>
      <span className="starting-agent-label">{label}</span>
      {hint && <span className="starting-agent-hint">{hint}</span>}
    </li>
  )
}

export interface StartingInfo {
  pane?: string
  project: string
  since: number
  onRetry?: () => void
  onClose?: () => void
  askedAbove?: string[]
}

function usePaneQuestion(pane: string | undefined): {
  peek: StartupPeek | null
  prompt: StartupPeek['prompt']
  answer: (index: number) => void
} {
  const [peek, setPeek] = useState<StartupPeek | null>(null)
  const [answering, setAnswering] = useState<string | null>(null)

  useEffect(() => {
    if (!pane) return
    let live = true
    const read = (): void => {
      void window.api.codeStartupPeek(pane).then((next) => {
        if (!live) return
        setPeek((prev) => (next.alive ? next : { ...next, tail: prev?.tail ?? [] }))
        setAnswering((was) => (was !== null && next.prompt?.question === was ? was : null))
      })
    }
    read()
    const poll = setInterval(read, PEEK_MS)
    return () => {
      live = false
      clearInterval(poll)
    }
  }, [pane])

  const answer = (index: number): void => {
    if (!pane || !peek?.prompt || answering !== null) return
    setAnswering(peek.prompt.question)
    void window.api.codeStartupAnswer(pane, index).then((ok) => {
      if (!ok) setAnswering(null)
    })
  }
  return { peek, prompt: answering === null ? (peek?.prompt ?? null) : null, answer }
}

function PaneAsk(props: { prompt: NonNullable<StartupPeek['prompt']>; answer: (index: number) => void }): React.JSX.Element {
  const { prompt, answer } = props
  return (
    <div className="starting-agent-ask">
      {prompt.question && <p className="starting-agent-question">{prompt.question}</p>}
      {prompt.detail && <p className="starting-agent-detail">{prompt.detail}</p>}
      <div className="starting-agent-options">
        {prompt.options.map((option, i) =>
          /^Type something/.test(option) ? null : (
            <Button
              key={option}
              variant={i === prompt.selected ? 'primary' : 'ghost'}
              className="starting-agent-option"
              onClick={() => answer(i)}
            >
              {option}
            </Button>
          )
        )}
      </div>
    </div>
  )
}

export function AgentQuestion(props: { pane?: string; children: React.ReactNode }): React.JSX.Element {
  const { prompt, answer } = usePaneQuestion(props.pane)
  if (!prompt) return <>{props.children}</>
  return (
    <div className="starting-agent" aria-live="polite">
      <ol className="starting-agent-steps">
        <Step state="ask" label="It needs your answer to keep going" />
      </ol>
      <PaneAsk prompt={prompt} answer={answer} />
    </div>
  )
}

export function StartingAgent(props: StartingInfo & { now: number }): React.JSX.Element {
  const { pane, since, now, onRetry, onClose, askedAbove } = props
  const { peek, prompt, answer } = usePaneQuestion(pane)
  const closed = peek !== null && !peek.alive
  const inTerminal = pane === ''
  const slow = !prompt && !closed && now - since > SLOW_MS && (peek?.tail.length ?? 0) > 0

  return (
    <div className="starting-agent" aria-live="polite">
      <ol className="starting-agent-steps">
        <Step
          state={closed || prompt ? 'ask' : 'active'}
          label={
            closed
              ? 'It closed before it started'
              : prompt
                ? 'It needs your answer to start'
                : inTerminal
                  ? 'Starting in a Terminal window'
                  : 'Starting'
          }
        />
      </ol>

      {prompt && !askedAbove?.includes(prompt.question) && <PaneAsk prompt={prompt} answer={answer} />}

      {inTerminal && (
        <p className="starting-agent-detail">If it asks you anything, answer it in that window.</p>
      )}

      {closed && (
        <div className="starting-agent-screen">
          {peek.tail.length > 0 && (
            <>
              <p className="starting-agent-detail">The last thing it showed:</p>
              <pre>{peek.tail.join('\n')}</pre>
            </>
          )}
          <div className="starting-agent-actions">
            {onRetry && (
              <Button variant="primary" onClick={onRetry}>
                Try again
              </Button>
            )}
            {onClose && (
              <Button variant="ghost" onClick={onClose}>
                Close
              </Button>
            )}
          </div>
        </div>
      )}

      {slow && peek && (
        <div className="starting-agent-screen">
          <p className="starting-agent-detail">Taking longer than usual. This is what it shows:</p>
          <pre>{peek.tail.join('\n')}</pre>
        </div>
      )}
    </div>
  )
}

import { useEffect, useState } from 'react'
import type { JSX, RefObject } from 'react'
import { ArrowUp, Mic, Square } from 'lucide-react'
import { CONFIG } from '../../../shared/config'
import { Button } from './Button'
import { WaveformViz } from './WaveformViz'
import './TalkButton.css'

export function TalkSendButton({ className }: { className: string }): JSX.Element {
  return (
    <Button
      variant="bare"
      className={className}
      aria-label={CONFIG.UI_LABELS.TALK_SEND}
      title={CONFIG.UI_LABELS.TALK_SEND}
      onClick={() => void window.api.navigator.run('shortcut:listenSend')}
    >
      <ArrowUp size={16} strokeWidth={2.25} />
    </Button>
  )
}

export function TalkButton({
  inputRef,
  label = false,
  onLiveChange
}: {
  inputRef: RefObject<HTMLTextAreaElement | null>
  label?: boolean
  onLiveChange?: (live: boolean) => void
}): JSX.Element {
  const [phase, setPhase] = useState<'idle' | 'listening' | 'transcribing'>('idle')

  useEffect(() => onLiveChange?.(phase === 'listening'), [phase, onLiveChange])

  useEffect(
    () =>
      window.api.onIslandActivity(({ state }) => {
        if (state === 'listening') setPhase(document.hasFocus() && document.activeElement === inputRef.current ? 'listening' : 'idle')
        else if (state === 'thinking') setPhase((p) => (p === 'listening' ? 'transcribing' : p))
        else setPhase('idle')
      }),
    [inputRef]
  )

  useEffect(() => {
    if (phase !== 'transcribing') return
    const t = setTimeout(() => setPhase('idle'), CONFIG.TALK_TRANSCRIBING_MAX_MS)
    return () => clearTimeout(t)
  }, [phase])

  const toggle = (): void => {
    inputRef.current?.focus()
    void window.api.navigator.run('shortcut:listen')
  }

  if (phase === 'listening') {
    return (
      <Button
        variant="bare"
        className="talk-btn talk-live"
        title={CONFIG.UI_LABELS.TALK_STOP}
        aria-label={CONFIG.UI_LABELS.TALK_STOP}
        onClick={toggle}
      >
        <WaveformViz />
        <Square size={11} fill="currentColor" />
      </Button>
    )
  }

  return (
    <Button
      variant="bare"
      className="talk-btn"
      data-icon-only={label ? undefined : ''}
      data-busy={phase === 'transcribing' ? '' : undefined}
      title={CONFIG.UI_LABELS.CODE_SESSION_TALK_TITLE}
      aria-label={CONFIG.UI_LABELS.CODE_SESSION_TALK_ARIA}
      onClick={toggle}
    >
      {phase === 'transcribing' ? <span className="talk-busy">{CONFIG.UI_LABELS.TALK_TRANSCRIBING}</span> : (
        <>
          <Mic size={15} strokeWidth={2.25} className="talk-mic" />
          {label && (
            <>
              <span>{CONFIG.UI_LABELS.TALK_LABEL}</span>
              <kbd>{CONFIG.UI_LABELS.TALK_KEY}</kbd>
            </>
          )}
        </>
      )}
    </Button>
  )
}

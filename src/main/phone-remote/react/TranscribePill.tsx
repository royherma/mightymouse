import { useEffect, useRef, useState } from 'react'
import { Loader2, RotateCcw, X } from 'lucide-react'
import { Button } from '@shared/ui/Button'

/**
 * The post-release wait indicator, and the only place to cancel or retry a
 * dictation from the phone.
 *
 * Three states, one pill, one position: waiting (spinner + stage label +
 * elapsed), waiting-with-Cancel-showing (tap once to reveal, per Roy's ask),
 * and failed-but-retryable (Retry + dismiss). Keeping all three in the same
 * fixed band means a transcription that goes wrong never moves the thing the
 * user is looking at -- it just changes what that thing offers.
 */

// The pill is otherwise pointer-events:none so it can't eat touchpad drags;
// it only becomes tappable while there is actually something to cancel.
export interface TranscribePillProps {
  stage: 'received' | 'transcribing' | null
  /** Non-null while a clip is in flight -- also the reset key for local state. */
  clipId: string | null
  /** A clip failed and its audio is still in hand, so Retry can work. */
  retryable: boolean
  onCancel: () => void
  onRetry: () => void
  onDismiss: () => void
  /** Touchpad deck needs its skin class; classic passes nothing. */
  className?: string
}

// Elapsed is deliberately absent for the first few seconds: a counter that
// starts at 0s on every single dictation trains you to read the number, when
// the only time it carries information is when it gets uncomfortably large.
const ELAPSED_VISIBLE_AFTER_MS = 4000

export function TranscribePill({
  stage,
  clipId,
  retryable,
  onCancel,
  onRetry,
  onDismiss,
  className
}: TranscribePillProps): React.JSX.Element | null {
  const [cancelShown, setCancelShown] = useState(false)
  const [elapsedMs, setElapsedMs] = useState(0)
  const startedAtRef = useRef(0)

  // Keyed off clipId, not mount: the pill stays mounted across a retry (same
  // element, new clip), and a retry that inherited the previous clip's elapsed
  // count would show a wait far longer than the one actually running.
  useEffect(() => {
    setCancelShown(false)
    setElapsedMs(0)
    if (clipId === null) return
    startedAtRef.current = Date.now()
    const tick = window.setInterval(() => {
      setElapsedMs(Date.now() - startedAtRef.current)
    }, 500)
    return () => window.clearInterval(tick)
  }, [clipId])

  const waiting = clipId !== null
  if (!waiting && !retryable) return null

  const elapsedLabel =
    waiting && elapsedMs >= ELAPSED_VISIBLE_AFTER_MS ? ` ${Math.round(elapsedMs / 1000)}s` : ''

  // 'received' means the audio is up and whisper hasn't started; before any
  // stage arrives the upload itself is still in progress. Naming the actual
  // step is the difference between "it's working" and "it's stuck".
  const label = stage === 'transcribing' ? 'Transcribing…' : 'Uploading…'

  if (retryable) {
    return (
      <div
        className={`micTranscribing micTranscribeFailed${className ? ` ${className}` : ''}`}
        role="status"
        aria-live="polite"
      >
        <Button variant="bare" type="button" className="micTranscribeAction" onClick={onRetry}>
          <RotateCcw size={14} strokeWidth={2.5} />
          Retry
        </Button>
        <Button
          variant="bare"
          type="button"
          className="micTranscribeDismiss"
          onClick={onDismiss}
          aria-label="Dismiss"
        >
          <X size={14} strokeWidth={2.5} />
        </Button>
      </div>
    )
  }

  return (
    <div
      className={`micTranscribing micTranscribeLive${className ? ` ${className}` : ''}`}
      role="status"
      aria-live="polite"
      onClick={() => setCancelShown(true)}
    >
      <Loader2 size={16} className="micTranscribingSpin" strokeWidth={2.5} />
      {label}
      {elapsedLabel}
      {cancelShown && (
        <Button
          variant="bare"
          type="button"
          className="micTranscribeAction"
          onClick={(e) => {
            // The pill's own onClick would otherwise re-show what we're leaving.
            e.stopPropagation()
            onCancel()
          }}
        >
          <X size={14} strokeWidth={2.5} />
          Cancel
        </Button>
      )}
    </div>
  )
}

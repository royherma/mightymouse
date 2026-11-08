import { useEffect, useRef } from 'react'
import { Button } from '@shared/ui/Button'

/**
 * TEMPORARY: the one-pinch way onto the mirror from Meta Ray-Ban Display.
 *
 * The only mirror on/off control is a checkbox inside Settings, which on a
 * cursorless host sits ~60 swipe stops away and cannot be toggled at all yet.
 * Until sheet navigation lands this asks the question up front, where the
 * glasses' first Enter can answer it.
 */
export function CursorlessMirrorPrompt({
  onAnswer
}: {
  onAnswer: (share: boolean) => void
}): React.JSX.Element {
  const yesRef = useRef<HTMLButtonElement | null>(null)

  // The glasses' select lands on whatever the OS focus ring is on, and nothing
  // moves that ring for us -- an unfocused prompt is an unanswerable one.
  useEffect(() => {
    yesRef.current?.focus()
  }, [])

  return (
    <div className="cursorlessAsk" role="dialog" aria-modal="true" aria-label="Screen share">
      <div className="cursorlessAskTitle">See your Mac here?</div>
      <div className="cursorlessAskRow">
        <Button variant="bare" ref={yesRef} className="cursorlessAskBtn" onClick={() => onAnswer(true)}>
          Yes
        </Button>
        <Button variant="bare" className="cursorlessAskBtn" onClick={() => onAnswer(false)}>
          No
        </Button>
      </div>
    </div>
  )
}

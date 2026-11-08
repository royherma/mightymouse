import { useEffect, useRef, useState } from 'react'
import { Button } from '@shared/ui/Button'

/** Counts down to the same instant the Mac stops honouring the verdict. */
function useSecondsLeft(expiresAt: number): number {
  const [secondsLeft, setSecondsLeft] = useState(() =>
    Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000))
  )
  useEffect(() => {
    const tick = setInterval(() => {
      setSecondsLeft(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)))
    }, 1000)
    return () => clearInterval(tick)
  }, [expiresAt])
  return secondsLeft
}

/**
 * The WAITING side of the same handshake: shown on the device that has no
 * credential, while the phone is being asked about it. Its own screen, because
 * without one it fell through to the generic pairing-code form and looked
 * refused at the exact moment it was being approved.
 */
export function ApprovalWaiting({ expiresAt }: { expiresAt: number }): React.JSX.Element {
  const secondsLeft = useSecondsLeft(expiresAt)
  return (
    <div className="approvalWaiting" role="status" aria-live="polite">
      <div className="approvalWaitingDots" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      <div className="approvalWaitingCount">
        {secondsLeft}s left. After that, connect with the code from your Mac.
      </div>
    </div>
  )
}

/**
 * "Let your glasses watch?" — the paired phone vouching for a device that has
 * no credential of its own, so a second device costs one tap here instead of
 * reading six digits off the Mac and typing them on something you are wearing.
 *
 * Reuses `.cursorlessAsk` styling: same shape of question, and a second nearly
 * identical block of CSS is how the two keyboard-bar hosts drifted apart.
 */
export function ApprovalPrompt({
  label,
  expiresAt,
  onAnswer
}: {
  label: string
  expiresAt: number
  onAnswer: (allow: boolean) => void
}): React.JSX.Element {
  const denyRef = useRef<HTMLButtonElement | null>(null)
  const secondsLeft = useSecondsLeft(expiresAt)

  // Deny holds the focus ring, not Allow: this prompt can be raised by anyone
  // who has the tunnel URL, so a blind tap or a pocket press must fall on the
  // safe answer. The mirror prompt focuses Yes because only its wearer can
  // summon it.
  useEffect(() => {
    denyRef.current?.focus()
  }, [])

  return (
    <div className="cursorlessAsk" role="dialog" aria-modal="true" aria-label="Let a device watch">
      <div className="cursorlessAskTitle">Let {label} watch your Mac?</div>
      <div className="cursorlessAskSub">Asking for access right now</div>
      <div className="cursorlessAskRow">
        <Button variant="bare" className="cursorlessAskBtn" onClick={() => onAnswer(true)}>
          Allow ({secondsLeft}s)
        </Button>
        <Button variant="bare" ref={denyRef} className="cursorlessAskBtn" onClick={() => onAnswer(false)}>
          Not now
        </Button>
      </div>
    </div>
  )
}

import { Zap, Square, ChevronUp } from 'lucide-react'
import type { ChatStep } from './chat-steps'
import { Button } from '@shared/ui/Button'

/** `detail` is monospaced: it is a filename or a shell command. */
function StepRow({ step, active }: { step: ChatStep; active: boolean }): React.JSX.Element {
  return (
    <div className={`chatStep${active ? ' chatStepActive' : ''}`}>
      <span className="chatStepDot" />
      <span className="chatStepPhase">{step.phase}</span>
      {step.detail !== '' && <span className="chatStepDetail">{step.detail}</span>}
    </div>
  )
}

/** Tail of the step list the live card shows -- enough to read the run's shape
 *  without growing down into the trackpad. Paired with .actCard's max-height. */
const VISIBLE_STEPS = 3

/**
 * Live progress for a phone-triggered act-dictation replay (actDictation in
 * phone-remote.ts). This run has no Mighty thread -- History rows aren't chat
 * sessions -- so it can't reuse ChatSheet itself, but it renders the SAME
 * StepRow language so "the Mac is doing something" looks identical everywhere.
 *
 * NON-MODAL, unlike every other sheet here: no .historyScrim, and .actCard caps
 * the height so it clears the trackpad. A run takes minutes and watching it must
 * not cost you the pad -- the user, on-device. That also removes the usual dismiss
 * (tap the scrim), which for a while left Stop as the only control on the card:
 * the sole way to get the steps off screen was to kill the run. Hide is that
 * missing dismiss. The "Running…" toast stays up either way and re-opens the
 * card on tap, so hiding is never a one-way door.
 *
 * App.tsx only forwards 'actProgress' events into `steps` while this card is
 * open for the matching runId, so a run in the background never pushes an unread
 * notification -- same gating ChatSheet applies to chatChunk vs the open thread.
 *
 * This is also the ONLY way to cancel a phone-started act run -- there is no
 * Escape key on a phone, so without the Stop button an agentic run can only be
 * killed from the Mac. `onStop` closes the card itself; the Mac's runDone (which
 * the kill triggers) clears the toast on its own.
 */
export default function ActProgressSheet(props: {
  open: boolean
  instruction: string
  steps: ChatStep[]
  onHide: () => void
  onStop: () => void
}): React.JSX.Element {
  const { open, instruction, steps, onHide, onStop } = props

  return (
    <>
      <div
        data-sheet
        className={`historySheet actCard${open ? ' open' : ''}`}
        role="status"
        aria-label="Acting"
      >
        <div className="historyHeader">
          <Zap size={17} strokeWidth={2.25} />
          <span className="historyTitle">Acting on: {instruction}</span>
          {/* Hiding is the common action and stopping is destructive, so Hide sits
              first -- the thumb reaches it without passing over Stop. */}
          <Button
            variant="ghost"
            type="button"
            className="actHideBtn"
            aria-label="Hide these steps, keep running"
            onPointerDown={(e) => {
              e.preventDefault()
              onHide()
            }}
          >
            <ChevronUp size={14} strokeWidth={2.75} />
            Hide
          </Button>
          {/* pointerdown, not click: a click needs the touch to END, and ending it
              on a non-input can tear this sheet's host out from under the finger. */}
          <Button
            variant="bare"
            type="button"
            className="actStopBtn"
            aria-label="Stop this run"
            onPointerDown={(e) => {
              e.preventDefault()
              onStop()
            }}
          >
            <Square size={13} strokeWidth={3} fill="currentColor" />
            Stop
          </Button>
        </div>
        <div className="chatStepList">
          {steps.length === 0 ? (
            <StepRow step={{ phase: 'Starting…', detail: '', n: 1 }} active />
          ) : (
            // Only the tail. A long run's earlier steps are scrollback nobody
            // reads while it's live, and every extra row is trackpad the card
            // eats -- the whole point of this being non-modal. The full list
            // lands in History once the run settles.
            steps.slice(-VISIBLE_STEPS).map((s, i, shown) => (
              <StepRow
                key={`${s.phase}-${s.detail}-${steps.length - shown.length + i}`}
                step={s}
                active={i === shown.length - 1}
              />
            ))
          )}
        </div>
      </div>
    </>
  )
}

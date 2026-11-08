import { Zap, AlertCircle, CloudOff, ChevronUp } from 'lucide-react'

/**
 * The toast that lands after a run finishes -- most often the transcript of
 * what you just dictated.
 *
 * Two gestures, both only on a toast the Mac gave a history id:
 *   tap  -> open that entry in History (check what it heard)
 *   hold -> run the same text as an Act on the Mac
 *
 * The hold exists because the transcript toast is the ONE moment the text and
 * its run id are both already on screen -- every other route to Act costs a
 * sheet open plus a scroll. While arming, the toast fills left-to-right with
 * an accent wash and shows a ⚡ Act hint, so the gesture announces both that
 * it's happening and what it will do; a silent one-second wait is
 * indistinguishable from a dead control.
 *
 * Shared by both layouts (classic + pro) rather than duplicated: the hold's
 * cancel-on-leave/cancel-on-cancel wiring is easy to get subtly wrong in one
 * copy and not the other.
 */
/**
 * Is the toast a live gesture target right now?
 *
 * `tappable` alone is NOT the answer, and assuming it was is the bug this
 * predicate exists to prevent: the toast hides by fading `opacity` and keeps
 * its full box, while `toastHistoryId` (which drives `tappable`) is deliberately
 * never cleared on auto-hide. So after the first dictation of a session, an
 * invisible tap target sat over the trackpad permanently and every tap that
 * landed in that strip opened History.
 */
export function toastIsLive(tappable: boolean, shown: boolean): boolean {
  return tappable && shown
}

export default function TranscriptToast(props: {
  text: string
  shown: boolean
  /** A run is still in flight, so `text` is a live phase rather than a result.
   *  Drives the accent tint + pulsing dot that tell the two apart at a glance. */
  running: boolean
  /** The Mac linked this toast to a history entry, so tap/hold have something
   *  to point at. Plain acks ("Pasted", "Running…") pass false and stay inert. */
  tappable: boolean
  /** The run failed, so `text` already carries the reason -- reads red with an
   *  alert icon. Tap still opens the History row, where the detail lives. */
  failed: boolean
  /** The phone wrote these words itself because the Mac wasn't reachable. The
   *  icon is the whole message -- `text` stays the bare transcript. */
  offline: boolean
  /** A hold is in progress -- drives the fill animation. */
  actArming: boolean
  onTap: () => void
  onHoldStart: () => void
  onHoldEnd: () => void
}): React.JSX.Element {
  const { text, shown, running, failed, offline, tappable, actArming, onTap, onHoldStart, onHoldEnd } =
    props

  // Gated here as well as in CSS so neither one alone can bring the ghost back.
  const live = toastIsLive(tappable, shown)

  return (
    <div
      className={`toast${shown ? ' show' : ''}${running ? ' running' : ''}${failed ? ' failed' : ''}${offline ? ' offline' : ''}${tappable ? ' tappable' : ''}${actArming ? ' arming' : ''}`}
      onClick={live ? onTap : undefined}
      // Pointer events, not touch: they cover the phone (the real target) and
      // a desktop browser during development with one set of handlers.
      onPointerDown={live ? onHoldStart : undefined}
      onPointerUp={live ? onHoldEnd : undefined}
      // A finger that slides off the toast has abandoned the hold. Without
      // this the timer keeps running and Act fires for a gesture the user
      // visibly walked away from.
      onPointerLeave={live ? onHoldEnd : undefined}
      // iOS steals the pointer for scroll/system gestures without ever
      // sending pointerup, which would strand the arming state on screen.
      onPointerCancel={live ? onHoldEnd : undefined}
      // Suppress the iOS callout/selection that a long press on text
      // otherwise raises right on top of the gesture we're claiming.
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* Same dot the live step row uses, so "the Mac is working" is one
          visual language whether you're looking at the toast or the card. */}
      {running && <span className="toastDot" />}
      {failed && <AlertCircle className="toastFailIcon" size={14} strokeWidth={2.25} />}
      {offline && !failed && <CloudOff className="toastOfflineIcon" size={14} strokeWidth={2.25} />}
      <span className="toastText">{text}</span>
      {/* The steps card is reachable ONLY by tapping this toast, and an
          underline on a phone reads as styling rather than a control -- so a
          live run says so with a glyph. Hidden while arming: that gesture is
          already announcing itself as Act, and two hints contradict. */}
      {running && live && !actArming && (
        <ChevronUp className="toastStepsHint" size={13} strokeWidth={2.5} />
      )}
      {/* Rendered only while arming so it can't shift the toast's layout at
          rest -- it's an overlay on the fill, not a second line of content. */}
      {actArming && (
        <span className="toastActHint">
          <Zap size={12} strokeWidth={2.5} />
          Act
        </span>
      )}
    </div>
  )
}

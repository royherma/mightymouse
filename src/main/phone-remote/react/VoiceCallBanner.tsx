import { PhoneOff, Mic, MicOff } from 'lucide-react'
import { Button } from '@shared/ui/Button'

/**
 * The one thing on screen that says a voice call is running, wherever you are.
 *
 * `VoiceCallPane` only exists inside a mirror host, and every host unmounts it:
 * open the deck, open a session, background the app and come back to a surface
 * that never mounts a pane, and a live call with an open microphone has no
 * representation at all. The only remaining signal was the iOS Live Activity,
 * which is outside the app and gone the moment you are looking at the app.
 *
 * So this mounts at the root, beside the toast, and outlives every surface
 * switch. It duplicates the pane's mute + end controls on purpose: a banner
 * that only announces the call makes the user hunt for the surface that can
 * end it, which is the problem restated.
 */
export default function VoiceCallBanner(props: {
  micOn: boolean
  connected: boolean
  onMicChange: (on: boolean) => void
  onEnd: () => void
}): React.JSX.Element {
  const { micOn, connected, onMicChange, onEnd } = props

  return (
    <div className="voiceCallBanner" role="status" aria-live="polite">
      <span className={`voiceCallDot${connected && micOn ? ' live' : ''}`} aria-hidden="true" />
      <span className="voiceCallBannerLabel">
        {!connected ? 'Connecting…' : micOn ? 'Your phone is the mic' : 'Muted'}
      </span>
      {/* pointerdown, not click: a click needs the touch to end, and these sit
          over surfaces whose own handlers claim the gesture first. */}
      <Button
        variant="bare"
        type="button"
        className={`voiceCallBannerBtn${micOn ? ' on' : ''}`}
        onPointerDown={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onMicChange(!micOn)
        }}
        aria-label={micOn ? 'Mute the phone mic' : 'Unmute the phone mic'}
        aria-pressed={!micOn}
      >
        {micOn ? <Mic size={15} strokeWidth={2.25} /> : <MicOff size={15} strokeWidth={2.25} />}
      </Button>
      <Button
        variant="bare"
        type="button"
        className="voiceCallBannerBtn end"
        onPointerDown={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onEnd()
        }}
        aria-label="End the voice call"
      >
        <PhoneOff size={15} strokeWidth={2.25} />
      </Button>
    </div>
  )
}

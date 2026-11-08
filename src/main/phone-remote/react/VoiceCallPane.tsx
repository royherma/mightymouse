import type { RefObject } from 'react'
import { Mic, MicOff, PhoneOff } from 'lucide-react'
import { MicWaveform } from './MicWaveform'
import { Button } from '@shared/ui/Button'

/**
 * What the phone shows while it is acting as the Mac's microphone for a voice
 * call (ChatGPT today). NOT a mirror: there is no video track in this mode, so
 * MirrorPane's <video>, zoom bar and stats overlay would render a black box
 * with dead controls on top of it.
 *
 * Named for the call rather than the transport ("audio mirror") because that is
 * what the user is in the middle of, and the word the copy has to use anyway.
 *
 * The waveform is the whole point of the screen. An open microphone the user
 * has forgotten about is this feature's failure mode, and on a voice call the
 * phone is face-down in a pocket -- so the ONE thing the screen owes them when
 * they pick it up is proof it is still hearing them.
 */
export function VoiceCallPane(props: {
  connected: boolean
  micOn: boolean
  onMicChange: (on: boolean) => void
  onEnd: () => void
  micStreamRef: RefObject<MediaStream | null>
}): React.JSX.Element {
  const { connected, micOn, onMicChange, onEnd, micStreamRef } = props

  return (
    <div className="voiceCallPane" role="status" aria-live="polite">
      <div className="voiceCallStatus">
        <span className={`voiceCallDot${connected && micOn ? ' live' : ''}`} aria-hidden="true" />
        <span className="voiceCallLabel">
          {!connected
            ? 'Connecting your mic'
            : micOn
              ? 'Your phone is the mic'
              : 'Muted — tap to speak'}
        </span>
      </div>

      {/* Mounted only while live: the analyser's rAF loop has nothing to draw
          from a muted track, and an idle meter reads as "hearing silence"
          rather than "off". Same rule as MicInputBadge. */}
      <div className="voiceCallWave">
        {connected && micOn ? <MicWaveform streamRef={micStreamRef} /> : null}
      </div>

      <div className="voiceCallActions">
        <Button
          variant="bare"
          type="button"
          className={`voiceCallMute${micOn ? ' on' : ''}`}
          onClick={() => onMicChange(!micOn)}
          aria-pressed={micOn}
          aria-label={micOn ? 'Mute your microphone' : 'Unmute your microphone'}
        >
          {micOn ? <Mic size={20} strokeWidth={2.25} /> : <MicOff size={20} strokeWidth={2.25} />}
        </Button>
        <Button
          variant="bare"
          type="button"
          className="voiceCallEnd"
          onClick={onEnd}
          aria-label="End the voice call"
        >
          <PhoneOff size={20} strokeWidth={2.25} />
        </Button>
      </div>
    </div>
  )
}

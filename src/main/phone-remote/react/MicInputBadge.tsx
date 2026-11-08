import { useRef } from 'react'
import type { RefObject } from 'react'
import { Mic, MicOff } from 'lucide-react'
import { MicWaveform } from './MicWaveform'
import { Button } from '@shared/ui/Button'

// The phone-mic control: TAP sends this phone's microphone to the Mac, where it
// becomes an input device other apps can select.
//
// Both layouts render this, for the reason MirrorAudioBadge's header records --
// duplicated per-layout JSX broke twice. One component, two call sites.
//
// Live state is deliberately loud (pulsing ring, not a subtle tint): an open
// microphone the user has forgotten about is the failure mode this whole
// feature has to design against.

export default function MicInputBadge(props: {
  micOn: boolean
  onMicChange: (on: boolean) => void
  micStreamRef: RefObject<MediaStream | null>
}): React.JSX.Element {
  const { micOn, onMicChange, micStreamRef } = props
  // Latched by any touch, so the click handler stays a mouse-only path for the
  // desktop deck viewer.
  const sawTouchRef = useRef(false)

  function onTouchEnd(e: React.TouchEvent<HTMLButtonElement>): void {
    sawTouchRef.current = true
    // Suppress the synthetic click iOS fires ~300ms later, which would toggle a
    // second time and read on device as a tap that did nothing.
    e.preventDefault()
    onMicChange(!micOn)
  }

  // Mounted only while live: the analyser's rAF loop has nothing to draw from a
  // muted track, and an idle meter reads as "hearing silence" rather than "off".
  return (
    <>
      {micOn ? (
        <span className="micInputLevel">
          <MicWaveform streamRef={micStreamRef} />
        </span>
      ) : null}
    <Button
      variant="bare"
      className={`micInputBadge${micOn ? ' on' : ''}`}
      onTouchEnd={onTouchEnd}
      onClick={() => {
        if (sawTouchRef.current) return
        onMicChange(!micOn)
      }}
      aria-label={micOn ? 'Stop sending your microphone' : 'Send your microphone to the computer'}
      aria-pressed={micOn}
    >
      {micOn ? <Mic size={17} strokeWidth={2.25} /> : <MicOff size={17} strokeWidth={2.25} />}
    </Button>
    </>
  )
}

import { useEffect, useRef, useState } from 'react'
import { Volume2, VolumeX } from 'lucide-react'
import { CONFIG } from '@shared/config'
import { hapticTick } from './haptics'
import { crossedDetent, volumeFromTouch } from './volume-slider-geometry'
import { Button } from '@shared/ui/Button'

// The mirror's audio control: TAP toggles whether the Mac's sound streams to
// the phone, HOLD opens a vertical slider for the Mac's own output volume.
//
// Both layouts render this -- the badge used to be duplicated JSX in each, and
// this directory's memory records that shape breaking twice (a fix landing in
// one host only). One component, two call sites, no host-local behavior.
//
// The slider drives the MAC's volume, not the <video> element's: iOS Safari
// ignores programmatic volume on media elements entirely (hardware buttons
// only), so a phone-side slider would be a silent no-op.

export default function MirrorAudioBadge(props: {
  shareAudio: boolean
  onShareAudioChange: (on: boolean) => void
  systemVolume: number | null
  onSystemVolumeChange: (volume: number) => void
  onRequestSystemVolume: () => void
}): React.JSX.Element {
  const {
    shareAudio,
    onShareAudioChange,
    systemVolume,
    onSystemVolumeChange,
    onRequestSystemVolume
  } = props

  const [open, setOpen] = useState(false)
  const trackRef = useRef<HTMLDivElement | null>(null)
  const holdTimerRef = useRef<number | null>(null)
  const holdStartRef = useRef<{ x: number; y: number } | null>(null)
  // Set once the hold fires, so touchend can tell "this press opened the
  // slider" from "this press was a mute tap".
  const holdFiredRef = useRef(false)
  // Latched by any touch, so the click handler below stays a mouse-only path.
  const sawTouchRef = useRef(false)
  // The last value we sent, for detent comparison. Reading `systemVolume`
  // instead would compare against the Mac's echo, which lands a frame late.
  const lastSentRef = useRef(0)

  // The Mac is the source of truth and the user changes its volume by other
  // means (keyboard keys, another app), so re-read on open rather than trusting
  // a value cached since the last time the slider was up.
  useEffect(() => {
    if (open) onRequestSystemVolume()
  }, [open, onRequestSystemVolume])

  useEffect(() => {
    return () => {
      if (holdTimerRef.current !== null) window.clearTimeout(holdTimerRef.current)
    }
  }, [])

  function clearHold(): void {
    if (holdTimerRef.current !== null) window.clearTimeout(holdTimerRef.current)
    holdTimerRef.current = null
    holdStartRef.current = null
  }

  function onBadgeTouchStart(e: React.TouchEvent<HTMLButtonElement>): void {
    const touch = e.touches[0]
    if (!touch) return
    sawTouchRef.current = true
    holdFiredRef.current = false
    holdStartRef.current = { x: touch.clientX, y: touch.clientY }
    holdTimerRef.current = window.setTimeout(() => {
      holdFiredRef.current = true
      holdTimerRef.current = null
      setOpen(true)
      hapticTick()
    }, CONFIG.PHONE_REMOTE.VOLUME_HOLD_MS)
  }

  function onBadgeTouchMove(e: React.TouchEvent<HTMLButtonElement>): void {
    const touch = e.touches[0]
    const start = holdStartRef.current
    if (!touch || !start) return
    const moved = Math.hypot(touch.clientX - start.x, touch.clientY - start.y)
    if (moved > CONFIG.PHONE_REMOTE.VOLUME_HOLD_SLOP_PX) clearHold()
  }

  function onBadgeTouchEnd(e: React.TouchEvent<HTMLButtonElement>): void {
    const wasPendingHold = holdStartRef.current !== null
    clearHold()
    // Consuming the touch suppresses the synthetic click iOS fires ~300ms
    // later, which would otherwise toggle a SECOND time -- reading on device
    // as a tap that did nothing, while restarting the audio track twice.
    e.preventDefault()
    // The hold already opened the slider -- releasing must not also toggle mute.
    if (holdFiredRef.current) return
    if (wasPendingHold) onShareAudioChange(!shareAudio)
  }

  function applyFromTouch(clientY: number): void {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect) return
    const next = volumeFromTouch(clientY, rect.top, rect.height)
    if (crossedDetent(lastSentRef.current, next)) hapticTick()
    lastSentRef.current = next
    onSystemVolumeChange(next)
  }

  function onTrackTouch(e: React.TouchEvent<HTMLDivElement>): void {
    const touch = e.touches[0] ?? e.changedTouches[0]
    if (touch) applyFromTouch(touch.clientY)
  }

  const level = systemVolume ?? 0
  // A device that doesn't report volume (some AirPlay targets) gets no slider
  // rather than a fake 0 the user can drag against nothing.
  const sliderUsable = systemVolume !== null

  return (
    <div className="mirrorAudioControl">
      {open && (
        <>
          {/* Full-screen catcher: tapping anywhere else dismisses. Must sit
              BELOW the panel in stacking order, hence its own element rather
              than a handler on the pane. */}
          <div
            className="mirrorVolumeScrim"
            onTouchStart={() => setOpen(false)}
            onClick={() => setOpen(false)}
          />
          <div className="mirrorVolumePanel" role="group" aria-label="Computer volume">
            {sliderUsable ? (
              <>
                <div className="mirrorVolumeValue">{level}</div>
                {/* touchAction:none in CSS so a vertical drag scrubs volume
                    instead of being claimed by Safari's scroll handling. */}
                <div
                  className="mirrorVolumeTrack"
                  ref={trackRef}
                  role="slider"
                  aria-label="Computer volume"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={level}
                  onTouchStart={onTrackTouch}
                  onTouchMove={onTrackTouch}
                  onTouchEnd={onTrackTouch}
                >
                  <div className="mirrorVolumeFill" style={{ height: `${level}%` }} />
                  <div className="mirrorVolumeKnob" style={{ bottom: `${level}%` }} />
                </div>
              </>
            ) : (
              <div className="mirrorVolumeUnavailable">No volume control</div>
            )}
          </div>
        </>
      )}

      <Button
        variant="bare"
        className={`mirrorAudioBadge${shareAudio ? ' on' : ''}${open ? ' sliderOpen' : ''}`}
        onTouchStart={onBadgeTouchStart}
        onTouchMove={onBadgeTouchMove}
        onTouchEnd={onBadgeTouchEnd}
        onTouchCancel={clearHold}
        // Mouse fallback for the desktop deck viewer, which drives this with a
        // pointer and never fires touch events.
        onClick={() => {
          if (sawTouchRef.current) return
          onShareAudioChange(!shareAudio)
        }}
        aria-label={shareAudio ? 'Turn computer audio off' : 'Turn computer audio on'}
        aria-pressed={shareAudio}
      >
        {shareAudio ? (
          <Volume2 size={17} strokeWidth={2.25} />
        ) : (
          <VolumeX size={17} strokeWidth={2.25} />
        )}
      </Button>
    </div>
  )
}

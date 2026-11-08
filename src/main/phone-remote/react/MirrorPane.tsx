import { Lock, LockOpen, Maximize2, Move, MousePointer2, Search } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { AppContext } from '@shared/app-context'
import type { PhoneRemoteMirrorPlacement } from '@shared/types'
import MicInputBadge from './MicInputBadge'
import MirrorAudioBadge from './MirrorAudioBadge'
import { MirrorConnecting } from './MirrorConnecting'
import { MirrorStatsOverlay, type MirrorRigStatus } from './MirrorStatsOverlay'
import type { FullscreenMirror } from './fullscreen-mirror'
import type { MirrorMode } from './mirror-quality'
import { Button } from '@shared/ui/Button'

/**
 * The live Mac picture and everything painted on top of it: the stats overlay,
 * the audio/mic badges, the connecting state, and the three snackbar pills.
 *
 * Extracted from TouchpadLayout so a second surface (the swipe deck) can mount
 * the same picture. The stream itself is NOT owned here -- `useMirror` stays
 * called exactly once, at App.tsx, and hands this component the `videoRef` it
 * already owns. A second useMirror() would mean a second WebRTC connection, and
 * there is no Mac-side start path to open one with.
 */
export type MirrorPaneProps = {
  videoRef: RefObject<HTMLVideoElement | null>
  mirrorPaneRef: RefObject<HTMLDivElement | null>
  mirrorActive: boolean
  mirrorMode: MirrorMode
  mirrorZoom: { x: number; y: number; scale: number }
  mirrorPaneHeight: number | null
  mirrorPlacement: PhoneRemoteMirrorPlacement
  isLandscape: boolean
  fullMirror: FullscreenMirror
  onMirrorLoadedMetadata: () => void

  shareAudio: boolean
  onShareAudioChange: (v: boolean) => void
  systemVolume: number | null
  onSystemVolumeChange: (v: number) => void
  onRequestSystemVolume: () => void
  micOn: boolean
  onMicChange: (v: boolean) => void
  phoneMicStreamRef: RefObject<MediaStream | null>

  touchModeActive: boolean
  touchModeLocked: boolean
  onToggleTouchModeLock: () => void
  /** Off in the deck: that copy is a picture to look at, not a pad to drive. */
  showTouchMode?: boolean
  /** Show the direct cursor-mode toggle beside the speaker while mirroring. */
  showCursorControl?: boolean
  onFullScreen?: () => void
  zoomFollowLocked: boolean
  zoomFollowToast: boolean

  benchSummary: Parameters<typeof MirrorStatsOverlay>[0]['summary']
  benchEstimateKbps: number | null
  benchCode: string | null
  rigStatus: MirrorRigStatus | null
  appContext: AppContext | null
}

export function MirrorPane(props: MirrorPaneProps): React.JSX.Element {
  const {
    videoRef,
    mirrorPaneRef,
    mirrorActive,
    mirrorMode,
    mirrorZoom,
    mirrorPaneHeight,
    mirrorPlacement,
    isLandscape,
    fullMirror,
    onMirrorLoadedMetadata,
    shareAudio,
    onShareAudioChange,
    systemVolume,
    onSystemVolumeChange,
    onRequestSystemVolume,
    micOn,
    onMicChange,
    phoneMicStreamRef,
    touchModeActive,
    touchModeLocked,
    onToggleTouchModeLock,
    showTouchMode = true,
    showCursorControl = false,
    onFullScreen,
    zoomFollowLocked,
    zoomFollowToast,
    benchSummary,
    benchEstimateKbps,
    benchCode,
    rigStatus,
    appContext
  } = props

  // Derived here rather than passed so the two surfaces cannot drift: both are
  // pure functions of the placement pref and the orientation.
  const padStacksBelowMirror = isLandscape || mirrorPlacement === 'stacked'
  const badgesRideZoomBar = !isLandscape && mirrorPlacement === 'glass'

  return (
    <div
      className="mirrorPane proMirrorPane"
      ref={mirrorPaneRef}
      // Only the stacked portrait mode sizes inline. Landscape and the
      // inside-the-pad modes size from CSS -- an inline height here would
      // beat their stylesheet with a stale portrait number.
      style={
        padStacksBelowMirror && !isLandscape && mirrorPaneHeight && !fullMirror.active
          ? { height: mirrorPaneHeight }
          : undefined
      }
    >
      <video
        ref={videoRef}
        className={`mirrorVideo${mirrorActive ? ' active' : ''}`}
        style={{
          transform: `translate(${mirrorZoom.x}px, ${mirrorZoom.y}px) scale(${mirrorZoom.scale})`
        }}
        autoPlay
        playsInline
        // Must follow the pref: a muted element plays no audio whatever
        // track arrives. Kept muted otherwise because iOS only autoplays
        // a muted element unattended.
        muted={!shareAudio}
        onLoadedMetadata={onMirrorLoadedMetadata}
        // Fires whenever videoWidth/Height CHANGE, including 0 -> real.
        // loadedmetadata can beat the dimensions on iOS, and this is the
        // only event that cannot.
        onResize={onMirrorLoadedMetadata}
      />
      {showCursorControl && mirrorActive && touchModeActive && (
        <CursorModeDim paneRef={mirrorPaneRef} />
      )}
      <MirrorStatsOverlay
        summary={benchSummary}
        estimateKbps={benchEstimateKbps}
        sessionCode={benchCode}
        rig={rigStatus}
        appName={appContext?.appName ?? null}
      />
      {/* Both badges control the audio leg, which does not exist until the
          peer connects -- while connecting they are dead controls sitting
          on top of MirrorConnecting, and the mic one would open the mic
          against a peer that isn't up. Gated on mirrorActive, the same
          flag that dismisses the connecting state. */}
      {mirrorActive && !badgesRideZoomBar && (
        <div className="mirrorShareControls">
          <MicInputBadge micOn={micOn} onMicChange={onMicChange} micStreamRef={phoneMicStreamRef} />
          {/* Tap = stream the Mac's audio here; hold = the Mac's own volume. */}
          <MirrorAudioBadge
            shareAudio={shareAudio}
            onShareAudioChange={onShareAudioChange}
            systemVolume={systemVolume}
            onSystemVolumeChange={onSystemVolumeChange}
            onRequestSystemVolume={onRequestSystemVolume}
          />
          {showCursorControl && (
            <MirrorTouchModeBadge
              active={touchModeActive}
              locked={touchModeLocked}
              onToggle={onToggleTouchModeLock}
            />
          )}
          {onFullScreen && <MirrorFullScreenBadge onPress={onFullScreen} />}
        </div>
      )}
      {!mirrorActive && <MirrorConnecting mode={mirrorMode} />}

      {/* Nested inside .mirrorPane (not the stage root) so it's
          automatically scoped to the mirror's own box regardless of
          portrait/landscape sizing -- no separate coordinate math to
          keep in sync with the pane. */}
      {showTouchMode && (
        <div
          className={`mirrorSnackbar${touchModeActive ? ' show' : ''}${touchModeLocked ? ' locked' : ''}`}
          // Tapping the snackbar itself must never fall through to the
          // mirror's own touch-mode listener underneath it.
          onTouchStart={(e) => e.stopPropagation()}
          onClick={onToggleTouchModeLock}
          role="button"
          aria-label={touchModeLocked ? 'Unlock touch mode' : 'Lock touch mode'}
        >
          {touchModeLocked ? (
            <Lock size={15} strokeWidth={2.25} />
          ) : (
            <LockOpen size={15} strokeWidth={2.25} />
          )}
          <span>Touch mode</span>
        </div>
      )}

      {/* Same pill, second message: confirms the zoom follow-lock toggle.
          Purely a confirmation, so it's not tappable -- the knob that
          toggled it is the control. Auto-hides via zoomFollowToast. */}
      <div
        className={`mirrorSnackbar isZoomFollow${zoomFollowToast ? ' show' : ''}${zoomFollowLocked ? ' locked' : ''}`}
        role="status"
      >
        {zoomFollowLocked ? (
          <Lock size={15} strokeWidth={2.25} />
        ) : (
          <LockOpen size={15} strokeWidth={2.25} />
        )}
        <span>{zoomFollowLocked ? 'Cursor tracking locked' : 'Cursor tracking off'}</span>
      </div>

      {/* Same pill, third message: what the glasses' swipes now do. The
          only thing the D-pad paints, and only on the toggle -- see
          fullscreen-mirror.ts. Exempt from the data-mirror-full hide
          below, which takes the other two down. */}
      <div className={`mirrorSnackbar isDpadMode${fullMirror.modeToast ? ' show' : ''}`} role="status">
        {fullMirror.mode === 'zoom' ? (
          <Search size={15} strokeWidth={2.25} />
        ) : (
          <Move size={15} strokeWidth={2.25} />
        )}
        <span>{fullMirror.mode === 'zoom' ? 'Zooming' : 'Moving around'}</span>
      </div>
    </div>
  )
}

export function MirrorTouchModeBadge(props: {
  active: boolean
  locked: boolean
  onToggle: () => void
}): React.JSX.Element {
  const { active, locked, onToggle } = props
  return (
    <Button
      variant="bare"
      type="button"
      className={`mirrorTouchModeBadge mirrorAudioControl${active ? ' on' : ''}${locked ? ' locked' : ''}`}
      onClick={onToggle}
      aria-label={active ? 'Turn cursor mode off' : 'Use screen as trackpad'}
      aria-pressed={active}
      title={active ? 'Cursor mode on' : 'Touch anywhere to move the cursor'}
    >
      <MousePointer2 size={17} strokeWidth={2.25} />
    </Button>
  )
}

export function MirrorFullScreenBadge(props: { onPress: () => void }): React.JSX.Element {
  return (
    <Button
      variant="bare"
      type="button"
      className="mirrorTouchModeBadge mirrorAudioControl"
      onClick={props.onPress}
      aria-label="Make the Mac screen full screen"
    >
      <Maximize2 size={17} strokeWidth={2.25} />
    </Button>
  )
}

export default MirrorPane

function CursorModeDim(props: { paneRef: RefObject<HTMLDivElement | null> }): React.JSX.Element {
  const { paneRef } = props
  const holeRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let frame = 0
    const track = (): void => {
      const pane = paneRef.current
      const hole = holeRef.current
      if (pane && hole) {
        const r = pane.getBoundingClientRect()
        hole.style.transform = `translate(${r.left}px, ${r.top}px)`
        hole.style.width = `${r.width}px`
        hole.style.height = `${r.height}px`
        hole.style.borderRadius = getComputedStyle(pane).borderRadius
      }
      frame = requestAnimationFrame(track)
    }
    track()
    return () => cancelAnimationFrame(frame)
  }, [paneRef])
  return createPortal(
    <div ref={holeRef} className="mirrorCursorDim" aria-hidden="true" />,
    document.body
  )
}

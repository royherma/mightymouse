import type { MirrorMode } from './mirror-quality'

/** What the placeholder says while the stream is still coming up. Mirror and
 *  extended are genuinely different things arriving, so the wait names which
 *  one -- "connecting" alone left the user unsure the mode toggle had taken. */
const MIRROR_CONNECTING_LABEL: Record<MirrorMode, string> = {
  mirror: 'Bringing your Mac over',
  extended: 'Opening your second screen',
  audio: 'Connecting your mic'
}

/** Shown over the black mirror pane until the first frame lands. */
export function MirrorConnecting({ mode }: { mode: MirrorMode }): React.JSX.Element {
  return (
    <div className="mirrorLoading" role="status" aria-live="polite">
      <span className="mirrorLoadingLabel">{MIRROR_CONNECTING_LABEL[mode]}</span>
      <span className="mirrorLoadingDots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    </div>
  )
}

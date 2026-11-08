import { LoaderCircle } from 'lucide-react'
import type { TunnelReach } from '@shared/types'
import { Button } from '@shared/ui/Button'

// Persistent banner while the WS is down. Distinct from the
// small inline status line -- a dead connection is a state the user should be
// able to act on (Retry now), not just read.
export default function ReconnectBanner(props: {
  attempt: number
  /** Rediscovery sweep in flight -- either the ladder's own escalation or a
   *  tap on "Retry now" (same call, `forceRediscover`). Distinct copy so a
   *  sweep reads as progress rather than the same stuck "attempt N". */
  searching: boolean
  onRetryNow: () => void
  /** Non-null when the Mac is quitting/relaunching for an admin env switch.
   *  The socket dropping is EXPECTED here, so the generic "Reconnecting…
   *  (attempt 4)" copy reads as a failure the user should act on when nothing
   *  is wrong. Same banner, different sentence -- and no Retry button, since
   *  retrying can't shorten a relaunch. */
  switchingTo: 'staging' | 'prod' | null
  /** What the Mac last said about its tunnel. Only consulted once retries have
   *  clearly failed: until then "Reconnecting…" is the honest answer, and a
   *  reach note would be noise on a connection that's about to come back. */
  tunnelReach: TunnelReach | null
}): React.JSX.Element {
  const { attempt, searching, onRetryNow, switchingTo, tunnelReach } = props
  if (switchingTo) {
    return (
      <div className="reconnectBanner" data-calm="">
        <LoaderCircle className="reconnectBannerSpin" size={15} aria-hidden="true" />
        <span className="reconnectBannerText">
          Restarting your Mac app…
        </span>
      </div>
    )
  }
  return (
    <div className="reconnectBanner" data-calm={attempt <= REACH_NOTE_AFTER_ATTEMPT ? '' : undefined}>
      <LoaderCircle className="reconnectBannerSpin" size={15} aria-hidden="true" />
      <span className="reconnectBannerText">
        {searching
          ? 'Looking for your Mac…'
          : (reachNote(attempt, tunnelReach) ??
            (attempt <= REACH_NOTE_AFTER_ATTEMPT
              ? 'Reconnecting to your Mac…'
              : 'Can’t reach your Mac. Is it awake?'))}
      </span>
      {/* Disabled mid-sweep rather than hidden: onRetryNow (forceRediscover)
          is a no-op while one is already running, and a button that vanishes
          on tap reads as broken. */}
      <Button variant="bare" className="reconnectBannerBtn" onClick={onRetryNow} disabled={searching}>
        Retry now
      </Button>
    </div>
  )
}

// Held back until the backoff ladder has visibly failed -- naming a cause on
// attempt 1 blames the tunnel for a blip that fixes itself.
const REACH_NOTE_AFTER_ATTEMPT = 3

/** The sentence that separates the three silences. Null keeps the plain
 *  reconnect copy, which is right whenever the cause isn't actually known:
 *  'up' means the tunnel was fine, so the Mac itself is asleep or quit. */
function reachNote(attempt: number, reach: TunnelReach | null): string | null {
  if (attempt <= REACH_NOTE_AFTER_ATTEMPT || !reach) return null
  if (reach === 'signed-out') return 'Your Mac can only be reached on the same Wi-Fi. Sign in on your Mac to fix.'
  if (reach === 'error' || reach === 'off') return 'Your Mac can only be reached on the same Wi-Fi right now.'
  if (reach === 'starting') return 'Your Mac is still getting ready to be reached from anywhere…'
  return null
}

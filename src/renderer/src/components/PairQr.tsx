import { JSX } from 'react'
import { Button } from './Button'

// derivePairing() decides WHETHER there's something to scan; this decides how
// it LOOKS -- never re-derive the condition here.

/** Named sizes, not a px prop: radius and padding scale with the code. */
export const PAIR_QR_SIZE = {
  sm: 'sm',
  /** Fits the fixed 480x540 tour window alongside its chrome. */
  md: 'md',
  lg: 'lg'
} as const

export type PairQrSize = (typeof PAIR_QR_SIZE)[keyof typeof PAIR_QR_SIZE]

const SIZE_CLASS: Record<PairQrSize, { box: string; frame: string }> = {
  [PAIR_QR_SIZE.sm]: { box: 'w-40 h-40', frame: 'rounded-lg p-2' },
  [PAIR_QR_SIZE.md]: { box: 'w-[180px] h-[180px]', frame: 'rounded-lg p-2' },
  [PAIR_QR_SIZE.lg]: { box: 'w-64 h-64', frame: 'rounded-xl p-3' }
}

export function PairQr({
  qrDataUrl,
  size = PAIR_QR_SIZE.lg,
  alt = "Scan with your phone's camera to pair",
  error,
  onRetry
}: {
  /** From derivePairing().qrDataUrl. Null renders the generating/error box. */
  qrDataUrl: string | null
  size?: PairQrSize
  alt?: string
  error?: string | null
  onRetry?: () => void
}): JSX.Element {
  const { box, frame } = SIZE_CLASS[size]

  if (qrDataUrl) {
    // Fades in rather than popping -- after a multi-second wait, an instant
    // swap reads as a glitch.
    return <img src={qrDataUrl} alt={alt} className={`${box} ${frame} bg-white pair-qr-in`} />
  }

  if (error) {
    return (
      <div
        className={`${box} ${frame} bg-white/5 flex flex-col items-center justify-center gap-3 text-center px-4`}
      >
        <div className="text-red-400 text-sm">{error}</div>
        {onRetry && (
          <Button variant="bare" onClick={onRetry} className="text-sm font-medium underline">
            Try again
          </Button>
        )}
      </div>
    )
  }

  return (
    <div
      className={`${box} ${frame} bg-white/5 flex items-center justify-center text-muted text-sm`}
    >
      Generating QR…
    </div>
  )
}

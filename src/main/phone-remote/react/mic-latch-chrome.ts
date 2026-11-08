/** iOS leftover pointer events after latch or Cancel/Stop mount. */
export const MIC_LATCH_CHROME_MS = 400

export type MicLiveState = 'idle' | 'opening' | 'recording' | 'toggled'

/** Ghost micDown on the mic button while live — causes tap-while-live + Hold longer. */
export function micIgnoreStopTap(
  state: MicLiveState,
  now: number,
  inertSince: number | null
): boolean {
  if (state !== 'toggled' && state !== 'recording') return false
  return micChromeIsInert(now, inertSince)
}

export type MicSidePressKind = 'cancel' | 'stop'

export function micChromeIsInert(now: number, inertSince: number | null): boolean {
  return inertSince !== null && now - inertSince < MIC_LATCH_CHROME_MS
}

/** True when Cancel/Stop should be on screen. */
export function micChromeVisible(
  micLatched: boolean,
  recording: boolean,
  chatOpen: boolean
): boolean {
  if (!micLatched || chatOpen) return false
  return recording
}

/** Text nodes have no closest(); Cancel/Stop leftovers land on the label. */
export function micChromeHitNode(target: EventTarget | null): Element | null {
  if (target == null) return null
  if (typeof (target as Element).closest === 'function') return target as Element
  return (target as Node).parentElement ?? null
}

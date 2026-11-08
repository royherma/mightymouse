import { CONFIG } from '@shared/config'

/** Maps a touch's Y onto a vertical track's box -> a 0-100 volume.
 *
 *  Inverted on purpose: screen Y grows DOWNWARD, so the track's top edge is
 *  100 and its bottom is 0. Clamped, because a drag that starts on the track
 *  and slides off either end should pin to that extreme rather than compute an
 *  out-of-range value. */
export function volumeFromTouch(clientY: number, trackTop: number, trackHeight: number): number {
  if (!trackHeight) return 0
  const t = Math.min(1, Math.max(0, (clientY - trackTop) / trackHeight))
  return Math.round((1 - t) * 100)
}

/** True when the volume crossed a detent boundary between two values, so the
 *  drag ticks once per step rather than once per touchmove frame. */
export function crossedDetent(previous: number, next: number): boolean {
  const step = CONFIG.PHONE_REMOTE.VOLUME_DETENT_STEP
  return Math.floor(previous / step) !== Math.floor(next / step)
}

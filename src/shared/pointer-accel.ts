/** Pointer acceleration for the phone-remote trackpad — how much of the user's
 *  sensitivity multiplier to actually apply, based on how fast the finger is
 *  moving. Pure math, no Electron, so it can be unit-tested directly.
 *
 *  Why it exists: sensitivity was a straight multiplier, so at the top of the
 *  slider it scaled hand JITTER exactly as hard as intent. At 11.2x a resting
 *  hand's ±1px wobble reached the cursor as ±11px, and a 1.5px fine-positioning
 *  nudge overshot by ~17px — the cursor couldn't be walked onto a small target.
 *  Turning the slider down fixed the sharpness but gave up the reach that made
 *  someone raise it. Applying less of the multiplier while slow and the full one
 *  while fast is what macOS does for a physical trackpad, and it was the missing
 *  piece here.
 */

/** Effective multiplier a slow finger resolves to, whatever the slider says.
 *  This is an ABSOLUTE speed, not a fraction of the user's setting, and that
 *  distinction is the whole point. The first version cut to a FRACTION (0.5),
 *  which meant raising the slider raised the precision end in lockstep: at 20x
 *  a careful 1.5px nudge still moved the cursor 15px, so accuracy was
 *  unreachable at high settings by construction (Roy: "I'm on 20 and I don't
 *  feel like that exists", 2026-07-26). Pinning the slow end means precision
 *  feels identical at 5x and at 20x, and the slider only decides how much reach
 *  a deliberate swipe gets — which is what someone raising it actually wants.
 *
 *  The VALUE is calibrated to the old fraction at the setting Roy actually
 *  runs (~10.6 × 0.5 ≈ 5), not picked for theoretical tightness. 2.5 was
 *  tried first and read as "very slow and jumpy" on-device: at 10.6x it
 *  halved every sub-swipe movement, which both felt sluggish AND dropped the
 *  cursor gap under GLIDE_MIN_PX so smooth arcs stopped being subdivided.
 *  Pinning at 5 keeps the feel he had approved at his own setting while still
 *  capping the slow end at 20x, where the fraction would have meant 10x. */
export const MOVE_SLOW_MULTIPLIER = 5
/** At/below this per-tick travel, treat the motion as jitter/fine positioning. */
export const MOVE_SLOW_PX = 1.5
/** At/above this per-tick travel, the finger is clearly moving on purpose. */
export const MOVE_FAST_PX = 14

/** Fraction of the sensitivity multiplier to apply at a given per-tick finger
 *  speed. Eased (t²) so the handover from precision to full gain ramps rather
 *  than steps.
 *
 *  Takes the sensitivity because the slow end targets an absolute speed: the
 *  floor is whatever fraction lands on MOVE_SLOW_MULTIPLIER. Capped at 1 so a
 *  slider set BELOW the precision speed is never accelerated past what the user
 *  asked for — at 0.5x the curve flattens out entirely and the multiplier
 *  passes through untouched. */
export function moveGainForSpeed(speedPx: number, sensitivity: number): number {
  const floor = sensitivity > 0 ? Math.min(1, MOVE_SLOW_MULTIPLIER / sensitivity) : 1
  if (speedPx <= MOVE_SLOW_PX) return floor
  if (speedPx >= MOVE_FAST_PX) return 1
  const t = (speedPx - MOVE_SLOW_PX) / (MOVE_FAST_PX - MOVE_SLOW_PX)
  return floor + (1 - floor) * t * t
}

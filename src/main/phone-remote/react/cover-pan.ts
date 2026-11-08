/**
 * Fill-and-pan math for the full-mirror pane on a cursorless host.
 *
 * The panel is square (600x600) and the Mac is 16:10, so `object-fit: contain`
 * paints the desktop at 600x386 with 36% of the panel black. `object-fit:
 * cover` looks like the fix and is not: it crops inside the video element's own
 * box, so the overflowing third is never painted and a transform can only slide
 * the crop around, opening a gutter on the side it pans away from.
 *
 * So the video stays `contain` -- the whole desktop is always painted -- and
 * the enlargement becomes a SCALE, applied directly as the user's zoom. Zoom 1
 * is therefore an honest 1x: the whole desktop, letterboxed. The glasses START
 * at MIRROR_ZOOM_CURSORLESS_BASE so text is legible on connect, and zooming to
 * the floor is how you get the whole-screen view back.
 *
 * `coverBaselineScale` is the factor at which the contained picture just covers
 * the pane. Zoom used to be multiplied by it, which made 1x mean "fill" and
 * silently cropped a third of a 16:10 desktop at the bottom of the range. It is
 * kept as the documented name for that geometry -- it is what "fill" means in
 * numbers -- but nothing multiplies by it anymore.
 *
 * Pan limits measure the real rendered content, so cursor-follow can travel to
 * the true desktop edge with no gutter, and clamp to zero pan at 1x where the
 * whole desktop already fits.
 */

export interface PanLimits {
  /** Max |x| translation in CSS px. Pan beyond this exposes an empty gutter. */
  maxX: number
  maxY: number
}

/**
 * The scale at which a `contain`-fitted source just covers the pane. 1 when
 * the aspect ratios already match, and 1 (not NaN) before loadedmetadata
 * reports an intrinsic size.
 */
export function coverBaselineScale(
  paneW: number,
  paneH: number,
  videoW: number,
  videoH: number
): number {
  if (!(paneW > 0) || !(paneH > 0) || !(videoW > 0) || !(videoH > 0)) return 1
  const contain = Math.min(paneW / videoW, paneH / videoH)
  const cover = Math.max(paneW / videoW, paneH / videoH)
  return cover / contain
}

/**
 * Limits for the contained video at `scale`. `videoW`/`videoH` are the
 * INTRINSIC dimensions (HTMLVideoElement.videoWidth/videoHeight); `scale` is
 * the EFFECTIVE scale already including the baseline above.
 *
 * Measured against the rendered CONTENT, never the pane box: the pane-box
 * clamp over-allows on the letterboxed axis and would pan into the black bars.
 * Falls back to that clamp only when the intrinsic size isn't known yet, since
 * videoWidth is 0 until loadedmetadata.
 */
export function coverPanLimits(
  paneW: number,
  paneH: number,
  videoW: number,
  videoH: number,
  scale: number
): PanLimits {
  const containLimit = (extent: number): number => Math.max(0, (extent * (scale - 1)) / 2)
  if (!(paneW > 0) || !(paneH > 0) || !(videoW > 0) || !(videoH > 0)) {
    return { maxX: containLimit(paneW), maxY: containLimit(paneH) }
  }

  const fit = Math.min(paneW / videoW, paneH / videoH)
  const renderedW = videoW * fit * scale
  const renderedH = videoH * fit * scale

  // Half the overflow each way -- the pane is centred on the video, so the
  // picture can travel that far in either direction before an edge shows.
  return {
    maxX: Math.max(0, (renderedW - paneW) / 2),
    maxY: Math.max(0, (renderedH - paneH) / 2)
  }
}

/**
 * Steps a manual pan by a fraction of the PANNABLE EXTENT, clamped.
 *
 * A fraction rather than px so the number of swipes to cross the desktop is
 * constant at every zoom: a fixed px step crosses in 3 swipes at 1.2x and 30 at
 * 4x. Passing the current offset back in (rather than accumulating a count)
 * keeps the clamp the only thing that decides where the edge is.
 */
export function coverPanStep(
  paneW: number,
  paneH: number,
  videoW: number,
  videoH: number,
  scale: number,
  from: { x: number; y: number },
  dx: number,
  dy: number
): { x: number; y: number } {
  const { maxX, maxY } = coverPanLimits(paneW, paneH, videoW, videoH, scale)
  return {
    x: Math.min(maxX, Math.max(-maxX, from.x + dx * maxX * 2)),
    y: Math.min(maxY, Math.max(-maxY, from.y + dy * maxY * 2))
  }
}

/**
 * Re-clamps an existing offset to the limits at `scale`. Zooming OUT shrinks
 * the pannable extent, so an offset that was legal at 3x exposes a black gutter
 * at 1.2x -- silent on the way in, visible only on the way out.
 */
export function clampCoverPan(
  paneW: number,
  paneH: number,
  videoW: number,
  videoH: number,
  scale: number,
  pan: { x: number; y: number }
): { x: number; y: number } {
  const { maxX, maxY } = coverPanLimits(paneW, paneH, videoW, videoH, scale)
  return {
    x: Math.min(maxX, Math.max(-maxX, pan.x)),
    y: Math.min(maxY, Math.max(-maxY, pan.y))
  }
}

/**
 * Translation that centres the pane on a normalized cursor position (0..1 in
 * desktop space), clamped to the limits above.
 *
 * Returns SCREEN px. `transform: translate(x,y) scale(s)` is T·S -- the scale
 * applies to the point, the translation passes through unscaled -- so these go
 * straight into the transform with no division. (An earlier version divided by
 * `scale` on the belief that translate was multiplied; that under-panned by a
 * factor of s and left the edge unreachable at any zoom above 1.)
 */
export function coverPanForCursor(
  paneW: number,
  paneH: number,
  videoW: number,
  videoH: number,
  scale: number,
  cursor: { x: number; y: number }
): { x: number; y: number } {
  const { maxX, maxY } = coverPanLimits(paneW, paneH, videoW, videoH, scale)
  const known = videoW > 0 && videoH > 0 && paneW > 0 && paneH > 0
  const fit = known ? Math.min(paneW / videoW, paneH / videoH) : 0
  // Offset from the video's own centre: a cursor at x=0 must pull the picture
  // right by half its rendered width, not half the pane's.
  const renderedW = known ? videoW * fit * scale : paneW * scale
  const renderedH = known ? videoH * fit * scale : paneH * scale
  const rawX = (0.5 - cursor.x) * renderedW
  const rawY = (0.5 - cursor.y) * renderedH
  return {
    x: Math.min(maxX, Math.max(-maxX, rawX)),
    y: Math.min(maxY, Math.max(-maxY, rawY))
  }
}

// The audio badge and its volume slider render INSIDE .mirrorPane, so their
// touches reach the pane's three native listener sets (pinch/pan, touch-mode
// gestures, warp). React's stopPropagation can't stop a native listener on an
// ancestor, so every pane entry point asks this instead.

/** Marks the subtree whose touches belong to a control, not to the mirror. */
export const MIRROR_PANE_CONTROL_SELECTOR = '.mirrorAudioControl'

export function isMirrorPaneControlTouch(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return target.closest(MIRROR_PANE_CONTROL_SELECTOR) !== null
}

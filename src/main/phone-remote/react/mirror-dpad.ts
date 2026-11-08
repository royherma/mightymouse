/**
 * What a Neural Band swipe means while the mirror is fullscreen on the glasses.
 *
 * Nothing here is painted. There is no D-pad widget, no mode chip -- the arrows
 * simply do something different depending on the mode, and Select toggles it.
 * Roy's call: "it doesn't get drawn anywhere. it just works."
 *
 * Pure and DOM-free, because this repo's vitest has no DOM -- same reason
 * `arrow-focus-nav.ts` reduces its inputs to plain shapes.
 */

import { CONFIG } from '@shared/config'

import type { Direction } from './arrow-focus-nav'

export type DpadMode = 'pan' | 'zoom'

export type DpadAction =
  /** Fractions of the pannable extent, not px -- see MIRROR_DPAD_PAN_STEP. */
  | { kind: 'pan'; dx: number; dy: number }
  /** Multiplies the current scale. Never an addend: at 1x-4x a fixed +0.2 is a
   *  20% change at the bottom and 5% at the top, so the control goes dead
   *  exactly where you are most zoomed in and most want fine steps. */
  | { kind: 'zoom'; factor: number }

export function nextDpadMode(mode: DpadMode): DpadMode {
  return mode === 'pan' ? 'zoom' : 'pan'
}

/** Every direction resolves in both modes -- no swipe is ever dead, the same
 *  rule `resolveArrowAction` follows. In zoom mode Left/Right are the COARSE
 *  pair rather than a duplicate of Up/Down, which would waste two of the four
 *  gestures the band has.
 *
 *  Up/Right = forward (in), Left/Down = back (out): the pairing Roy set on the
 *  band, locked in memory `cursorless-arrow-direction-pairing`. Do not re-pair
 *  these to reading order. */
export function resolveDpad(mode: DpadMode, dir: Direction): DpadAction {
  const pan = CONFIG.PHONE_REMOTE.MIRROR_DPAD_PAN_STEP
  const fine = CONFIG.PHONE_REMOTE.MIRROR_DPAD_ZOOM_STEP
  const coarse = CONFIG.PHONE_REMOTE.MIRROR_DPAD_ZOOM_STEP_COARSE

  if (mode === 'zoom') {
    switch (dir) {
      case 'up':
        return { kind: 'zoom', factor: fine }
      case 'down':
        return { kind: 'zoom', factor: 1 / fine }
      case 'right':
        return { kind: 'zoom', factor: coarse }
      case 'left':
        return { kind: 'zoom', factor: 1 / coarse }
    }
  }

  // Panning "up" moves the VIEW up, which slides the picture DOWN -- the
  // translation is the negative of the intended travel. Getting this backwards
  // is invisible in a unit test that only checks magnitude, so the test asserts
  // the sign against the direction's meaning.
  switch (dir) {
    case 'up':
      return { kind: 'pan', dx: 0, dy: pan }
    case 'down':
      return { kind: 'pan', dx: 0, dy: -pan }
    case 'left':
      return { kind: 'pan', dx: pan, dy: 0 }
    case 'right':
      return { kind: 'pan', dx: -pan, dy: 0 }
  }
}

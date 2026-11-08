import type { CSSProperties, JSX } from 'react'
import { TOUR } from '../../../shared/tour/constants'
import type { HotkeyConfirmState } from '../../../shared/tour/types'

/**
 * One large key cap — the tour's primary visual. Sized to be read from across
 * the desk rather than squinted at: a 76px rounded square with the glyph at
 * 32px, versus the 28px inline <kbd> it replaces.
 *
 * Reads as a physical BUTTON, not a bordered box. A hairline outline made the
 * caps look like empty input fields; the raised look comes from the neumorphic
 * `shadow-card` pair (warm shadow below-right, white highlight above-left)
 * against a light face, which is how every other raised control in this app is
 * built. States change the face and the elevation together — pressing sinks the
 * cap and collapses its shadow, so it physically depresses.
 *
 * Owns the four press-to-confirm treatments (idle / held / confirmed / wrong)
 * so HotkeyConfirm stays pure layout. `size` covers the two places a cap shows
 * up: `lg` for the confirm rows, `md` for denser inline runs.
 */
export type KeyCapSize = 'md' | 'lg'

const BOX: Record<KeyCapSize, string> = {
  md: 'w-[52px] h-[52px] text-[22px] rounded-[14px]',
  lg: 'w-[76px] h-[76px] text-[32px] rounded-[20px]'
}

/**
 * Face + elevation per state. `held` and `wrong` drop to `shadow-inset` so the
 * cap reads as pushed INTO the surface rather than just recolored.
 *
 * Idle sits still. A caps row that animates on its own competed with the press
 * feedback: the untouched caps kept moving while the pressed ones sank, so the
 * row read as one running animation rather than four keys answering the hands.
 */
const STATE_CLS: Record<HotkeyConfirmState, string> = {
  idle: 'bg-surface1 text-on-surface shadow-card',
  // Green, not accent-orange: `held` and `confirmed` are the same story to the
  // user ("this key is down / correct"), and an orange beat in between read as
  // a distinct warning state — it flashed across the whole row on the chord
  // press, including the letter cap nobody had touched yet.
  held: 'text-green shadow-inset tour-cap-held',
  confirmed: 'text-green shadow-card tour-cap-confirmed',
  wrong: 'text-amber shadow-inset tour-cap-wrong'
}

/**
 * Tinted faces for the non-idle states. These are `color-mix` against the
 * theme tokens rather than Tailwind opacity utilities (`bg-accent/15`) because
 * the caps sit on a translucent surface — a semi-transparent face let the panel
 * behind bleed through and muddied the color.
 */
const FACE: Partial<Record<HotkeyConfirmState, CSSProperties>> = {
  held: { background: 'color-mix(in srgb, var(--green) 16%, var(--surface1))' },
  confirmed: { background: 'color-mix(in srgb, var(--green) 16%, var(--surface1))' },
  wrong: { background: 'color-mix(in srgb, var(--amber) 14%, var(--surface1))' }
}

export function KeyCap({
  glyph,
  state = TOUR.CONFIRM_STATE.idle,
  held = false,
  size = 'lg'
}: {
  glyph: string
  state?: HotkeyConfirmState
  /** Live physical key state. Only tints while otherwise idle — a confirmed or
   *  wrong cap keeps its own treatment regardless of what the fingers do next. */
  held?: boolean
  size?: KeyCapSize
}): JSX.Element {
  const effective: HotkeyConfirmState =
    state === TOUR.CONFIRM_STATE.idle && held ? TOUR.CONFIRM_STATE.held : state

  return (
    <kbd
      // NOT font-mono: in a monospace face a capital O is near-identical to a
      // zero, and users read the `capture` cap as "0". The UI font's O/0 are
      // clearly different shapes. No border either — the elevation carries the
      // edge, and the shadow transition makes idle→held visibly sink.
      //
      // The transition lists box-shadow/transform EXPLICITLY rather than using
      // `transition-all`: with `all`, `color` and `background` interpolate too,
      // and grey→green passes through a warm brown midpoint that flashes ORANGE
      // across the whole row on the chord press — repeatedly misread as the
      // letter cap lighting up before it was pressed. Colors must snap.
      className={`inline-flex items-center justify-center font-semibold leading-none transition-[box-shadow,transform] duration-150 ${BOX[size]} ${STATE_CLS[effective]}`}
      style={FACE[effective]}
    >
      {glyph}
    </kbd>
  )
}

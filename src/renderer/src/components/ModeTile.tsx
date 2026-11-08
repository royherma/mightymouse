import type { JSX, ReactNode } from 'react'

/**
 * A big icon-over-label tile — the tour's way of showing the three modes
 * (rewrite / ask / act) as things you can SEE rather than as a row of small
 * text chips nobody reads.
 *
 * Presentational and inert by default: the tour uses these to teach, not to
 * choose, so there's no click handler. `accent` takes a color token (see
 * MODE_COLORS) and tints the icon puck + the highlighted border, so a tile can
 * never end up a different hue than the same mode elsewhere in the app.
 */
export function ModeTile({
  icon,
  label,
  accent,
  highlighted = false
}: {
  icon: ReactNode
  label: string
  /** A CSS color token, e.g. `var(--rose)`. Tints the icon puck. */
  accent: string
  /** Lifts one tile as the example being described. */
  highlighted?: boolean
}): JSX.Element {
  return (
    // Flat at rest so it never competes with the floating key caps (those are
    // the only thing on a hotkey step meant to be operated — a bordered,
    // elevated tile had users clicking these instead). But it DOES respond to
    // hover and press: a tile that looks tappable and does nothing when touched
    // feels broken, so it lifts on hover and depresses on click even though the
    // click itself is intentionally a no-op.
    <div
      className="tour-mode-tile flex-1 flex flex-col items-center justify-center gap-2 rounded-lg px-2 py-3.5"
      style={
        highlighted
          ? { background: `color-mix(in srgb, ${accent} 10%, transparent)` }
          : undefined
      }
    >
      <span
        className="flex items-center justify-center w-10 h-10 rounded-full"
        style={{ background: `color-mix(in srgb, ${accent} 18%, transparent)`, color: accent }}
      >
        {icon}
      </span>
      <span
        className={`text-sm leading-tight text-center ${
          highlighted ? 'font-semibold text-on-surface' : 'font-medium text-muted'
        }`}
      >
        {label}
      </span>
    </div>
  )
}

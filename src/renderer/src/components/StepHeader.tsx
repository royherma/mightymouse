import type { JSX } from 'react'
import { ProgressBar } from './ProgressBar'

/**
 * The step-count / percent row over a full-bleed progress bar — the top of any
 * multi-step wizard surface (the value tour, the permissions onboarding).
 *
 * Deliberately does NOT own the step title. In the landscape layout the title
 * lives in the content column beside the art, so a header that also rendered it
 * would put the headline in the wrong column. The window title stays in the OS
 * titlebar (see WindowFrame).
 */
export function StepHeader({
  stepLabel,
  pct,
  progressColor,
  segments,
  showPct = true
}: {
  /** e.g. "Step 2 of 5". Pre-formatted by the caller so this stays presentational. */
  stepLabel: string
  pct: number
  /** Tints the fill — the tour turns it green on a confirmed press. */
  progressColor?: string
  /** Render the bar as N chunks instead of one continuous track. */
  segments?: number
  /**
   * The "40%" readout. Off for chunked bars: the chunks already say "2 of 4"
   * visually and the label says it in words, so a third copy of the same fact
   * is noise on a screen whose whole job is asking for one thing.
   */
  showPct?: boolean
}): JSX.Element {
  return (
    <div className="shrink-0">
      <div className="flex justify-between text-md text-muted mb-2">
        <span>{stepLabel}</span>
        {showPct && <span>{pct}%</span>}
      </div>
      <div className="flex">
        <ProgressBar pct={pct} height="h-2" color={progressColor} segments={segments} />
      </div>
    </div>
  )
}

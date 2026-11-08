import { JSX } from 'react'
import { Pencil, HelpCircle, Zap } from 'lucide-react'
import type { TourChipMode, TourStep } from '../../../shared/tour/types'
import { MODE_COLORS } from '../mode-colors'
import { KeyCap } from '../components/KeyCap'
import { ModeTile } from '../components/ModeTile'
import { StepArt, StepLayout } from '../components/StepLayout'
import { HotkeyConfirm } from './HotkeyConfirm'
import { PhonePairConfirm } from './PhonePairConfirm'
import type { HotkeyConfirmResult } from './useHotkeyConfirm'
import type { PhonePairConfirmResult } from './usePhonePairConfirm'

// Presentational card for one tour step. Dumb + props-only: no IPC, no analytics,
// no nav — TourApp owns the confirm state (via useHotkeyConfirm) and just hands
// it down.
//
// Landscape two-column: art on the left, everything the user reads on the right.
// The previous portrait version had to reserve fixed-height slots (h-36 caps +
// h-10 chips) to stop the layout jumping between steps in a 540px window, and
// two of the five steps opted out of those slots to fit at all. The taller
// landscape body removed the constraint, so the reserved slots — and the
// isBare/isPhone/hasSlots branching that managed them — are gone.

/** Icon per mode. Lucide only (one icon family — see CLAUDE.md). */
const MODE_ICONS: Record<TourChipMode, typeof Pencil> = {
  rewrite: Pencil,
  ask: HelpCircle,
  act: Zap
}

export function TourStepCard({
  step,
  confirm,
  phoneConfirm,
  notResponding,
  soloEnabled
}: {
  step: TourStep
  /** Present only for steps with `confirmShortcutId` — the welcome step passes
   *  undefined and falls back to the static <KeyCap> display. */
  confirm?: HotkeyConfirmResult
  /** Present only for the step with `confirmPhonePair`. */
  phoneConfirm?: PhonePairConfirmResult
  /** Passed through to HotkeyConfirm — see its doc. */
  notResponding?: boolean
  /** Passed through to HotkeyConfirm — see its doc. */
  soloEnabled?: boolean
}): JSX.Element {
  // The phone step's QR IS its subject, so it takes the left slot the art holds
  // on every other step rather than being squeezed in under the copy.
  const isPhone = step.confirmPhonePair === true && phoneConfirm !== undefined

  return (
    <StepLayout art={isPhone ? <PhonePairConfirm confirm={phoneConfirm} /> : <StepArt />}>
      {/* Caps first: on a hotkey step the keys are the subject, and the headline
          reads as their caption. */}
      {step.confirmShortcutId && confirm ? (
        <div className="mb-4">
          <HotkeyConfirm
            shortcutId={step.confirmShortcutId}
            confirm={confirm}
            notResponding={notResponding}
            soloEnabled={soloEnabled}
          />
        </div>
      ) : (
        step.shortcutKeys && (
          <div className="flex items-center gap-2 mb-4">
            {step.shortcutKeys.split('+').map((g) => (
              <KeyCap key={g} glyph={g} />
            ))}
          </div>
        )
      )}

      <h2 className="text-[26px] leading-[1.15] font-bold tracking-tight text-on-surface mb-2">
        {step.title}
      </h2>
      <p className="text-base text-muted leading-snug max-w-[440px]">{step.blurb}</p>

      {step.chips && step.chips.length > 0 && (
        <div className="flex gap-2 mt-4 max-w-[440px]">
          {step.chips.map((chip) => {
            const Icon = MODE_ICONS[chip.mode]
            return (
              <ModeTile
                key={chip.label}
                label={chip.label}
                accent={MODE_COLORS[chip.mode]}
                highlighted={chip.highlighted}
                icon={<Icon size={22} strokeWidth={2.25} />}
              />
            )
          })}
        </div>
      )}
    </StepLayout>
  )
}

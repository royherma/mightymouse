import { JSX } from 'react'
import type { PermissionCheck } from '../../../shared/types'
import { CONFIG } from '../../../shared/config'
import { Button } from './Button'
import { Spinner } from './Spinner'
import { Check } from 'lucide-react'

// One permission, as a compact card (the one-screen setup lays three of these
// in a grid): state badge + name + Required/Optional tag, with an Allow button
// inside the card until granted. The one-line "why" lives in the ? hint's
// tooltip. Four states, all rendered inline — there is no next screen to move
// to, so a card states its own outcome permanently.
// Extracted from OnboardingApp's PermStep, minus skip/next/restart/auto-advance:
// those all belong to the four-step wizard, which still owns them.

export type PermissionRowState = 'off' | 'busy' | 'granted' | 'needsRestart'

export function rowState(
  check: PermissionCheck | undefined,
  busy: boolean
): PermissionRowState {
  if (check?.test.ok) return 'granted'
  // Gated on the OS status too, never on needsRestart alone: the label asserts
  // the permission IS on, so a flag set without the grant would render a green
  // "Granted" over a permission the user never turned on.
  if (check?.test.needsRestart && check.status === 'granted') return 'needsRestart'
  if (busy) return 'busy'
  return 'off'
}

/** The three permissions the one-screen setup asks for. Narrower than
 *  PermissionKey, which also covers camera (opt-in via gaze, never in setup). */
export type OnboardingRowKey = keyof typeof CONFIG.ONBOARDING_ONE_SCREEN.rows

export function PermissionRow({
  pkey,
  check,
  busy,
  disabled,
  onGrant,
  hintAlign = 'right'
}: {
  pkey: OnboardingRowKey
  check: PermissionCheck | undefined
  busy: boolean
  /** Another row holds the one outstanding OS prompt — see the serialization
   *  note in OnboardingOneScreen. Buttons go inert; the row stays readable. */
  disabled: boolean
  onGrant: () => void
  /** Which way the ? tooltip grows. The grid's first column must use 'left'
   *  (grow rightward) — right-anchored it clips off the window's left edge. */
  hintAlign?: 'left' | 'right'
}): JSX.Element {
  const state = rowState(check, busy)
  const copy = CONFIG.ONBOARDING_ONE_SCREEN
  const row = copy.rows[pkey]
  const unwinnable = !!check?.test.mockUnwinnable
  const done = state === 'granted' || state === 'needsRestart'

  return (
    <div
      className="flex flex-col gap-2 rounded-xl border px-3 py-2.5 transition-colors"
      style={
        done
          ? { background: 'var(--green-bg-subtle)', borderColor: 'var(--green-border-subtle)' }
          : { background: 'var(--surface1)', borderColor: 'var(--surface3)' }
      }
    >
      <span className="flex items-center gap-2 min-w-0">
        <span className="shrink-0 flex items-center justify-center w-5" aria-hidden>
          {done ? (
            <span
              className="flex items-center justify-center w-5 h-5 rounded-full"
              style={{ background: 'var(--green-light)' }}
            >
              <Check size={12} strokeWidth={3.5} color="var(--surface1)" />
            </span>
          ) : (
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--amber)' }} />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-semibold text-md text-on-surface truncate">{row.label}</span>
          <span className="block text-xs text-muted leading-snug truncate">
            {state === 'needsRestart'
              ? copy.restartRowState
              : unwinnable && !done
                ? CONFIG.ONBOARDING_STEPS.mockUnwinnable
                : row.required
                  ? copy.requiredTag
                  : copy.optionalTag}
          </span>
        </span>
        {/* Instant CSS tooltip, not `title` — the native one lags ~1s and is
            easy to miss, and this hint is the only place the why-copy lives. */}
        <span className="relative shrink-0 group">
          <span
            className="flex items-center justify-center w-4 h-4 rounded-full border text-[9px] font-bold text-muted cursor-help group-hover:text-on-surface group-hover:border-muted-dark transition-colors"
            style={{ borderColor: 'var(--surface3)' }}
          >
            ?
          </span>
          <span
            className={
              'hidden group-hover:block absolute bottom-full mb-1.5 w-max max-w-[190px] rounded-lg px-2.5 py-1.5 text-xs font-medium leading-snug text-left shadow-lg z-10 ' +
              (hintAlign === 'left' ? 'left-0' : 'right-0')
            }
            style={{ background: 'var(--on-surface)', color: 'var(--surface1)' }}
            role="tooltip"
          >
            {row.why}
          </span>
        </span>
      </span>

      {!done && (
        <Button onClick={onGrant} disabled={disabled} className="w-full px-2 text-sm">
          {state === 'busy' ? (
            <span className="inline-flex items-center gap-1.5">
              <Spinner size="w-3 h-3" accent="border-t-on-surface" />
              {check?.status === 'granted' ? copy.checking : copy.waiting}
            </span>
          ) : (
            CONFIG.ONBOARDING_STEPS.grant
          )}
        </Button>
      )}
    </div>
  )
}

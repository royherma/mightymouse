import { JSX, useEffect, useRef, useState } from 'react'
import { CONFIG } from '../../shared/config'
import { TOUR } from '../../shared/tour/constants'
import { TOUR_STEPS } from '../../shared/tour/steps'
import { getShortcut } from '../../shared/shortcuts'
import type { TourSource } from '../../shared/tour/types'
import { ArrowRight } from 'lucide-react'
import { WindowFrame } from './WindowFrame'
import { Button } from './components/Button'
import { StepHeader } from './components/StepHeader'
import { Kbd } from './components/Kbd'
import { TourStepCard } from './tour/TourStepCard'
import { useTourAnalytics } from './tour/useTourAnalytics'
import { useHotkeyConfirm } from './tour/useHotkeyConfirm'
import { usePhonePairConfirm } from './tour/usePhonePairConfirm'
import { IS_DEV } from '../../shared/env'

// Value tour — a dumb wizard over TOUR_STEPS (content lives in shared/tour/steps).
// Teaches the 3 hotkeys + modes after the permissions wizard, re-openable from
// the tray. NOT a gate. Visual language borrowed from OnboardingApp so it feels
// like one product. Each dismissal (Done / Skip / red-X) marks the tour seen
// main-side, so it never nags.

// Read how the tour was opened from ?source=, validated against TOUR.SOURCE.
function readSource(): TourSource {
  const raw = new URLSearchParams(window.location.search).get('source')
  return raw === TOUR.SOURCE.tray ? TOUR.SOURCE.tray : TOUR.SOURCE.auto
}

export default function TourApp(): JSX.Element {
  const analytics = useTourAnalytics()
  const [idx, setIdx] = useState(0)
  const total = TOUR_STEPS.length
  const step = TOUR_STEPS[idx]
  const isFirst = idx === 0
  const isLast = idx === total - 1

  // §7.1: track how many hotkey steps timed out with no press ever landing —
  // this is the exact population most likely to have a broken Accessibility
  // grant. From the SECOND timeout on, the unlocked line under the caps says
  // "your shortcuts aren't responding" outright instead of the soft "no luck?"
  // copy (one miss could be hesitation; two in a row is a pattern). The last
  // step repeats it when every step timed out.
  const hotkeyStepCount = useRef(TOUR_STEPS.filter((s) => s.confirmShortcutId).length)
  const [timedOutSteps, setTimedOutSteps] = useState(0)
  const notResponding = timedOutSteps >= TOUR.NOT_RESPONDING_AFTER_TIMEOUTS
  const allTimedOut = timedOutSteps >= hotkeyStepCount.current

  // Whether fn-to-talk is on, so the listen step can teach the one key the user
  // actually has rather than the chord. Starts true because that's the pref's own
  // default (PREFS.getFnListenEnabled) — starting false would flash the chord caps
  // for a frame on every run of the tour, which is the common case.
  const [fnListen, setFnListen] = useState(true)
  useEffect(() => {
    void window.api.settingsGetPrefs().then((p) => setFnListen(p.fnListenEnabled))
  }, [])

  const next = (): void => setIdx((i) => Math.min(i + 1, total - 1))

  const confirm = useHotkeyConfirm(step.confirmShortcutId, step.key, next)

  // The phone step's own confirm session. Same shape as `confirm` (state /
  // unlocked) so the nav gate below reads ONE contract for both, but it's armed
  // by `confirmPhonePair` rather than a shortcut id — and it deliberately never
  // feeds timedOutSteps: that counter means "your Accessibility grant is
  // broken", and a phone the user simply didn't pick up is not evidence of that.
  const phoneConfirm = usePhonePairConfirm(step.confirmPhonePair === true, next)

  // Fire tour_started once on mount with how it was opened.
  const startedRef = useRef(false)
  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    analytics.started(readSource())
  }, [analytics])

  // Track each step as it's shown (including step 0). idx is the dep so a
  // back-and-forth re-fires — drop-off + revisits are both visible in the funnel.
  useEffect(() => {
    analytics.stepViewed(idx, step.key)
  }, [idx, step.key, analytics])

  // Count a timeout the moment THIS step unlocks without ever confirming. Reset
  // per step via the confirm.unlocked/state dep pair — a step that DOES confirm
  // never contributes here even if it unlocked first (confirmed always wins).
  const countedRef = useRef(false)
  useEffect(() => {
    countedRef.current = false
  }, [idx])
  useEffect(() => {
    if (!step.confirmShortcutId) return
    if (confirm.unlocked && confirm.state !== TOUR.CONFIRM_STATE.confirmed && !countedRef.current) {
      countedRef.current = true
      setTimedOutSteps((n) => n + 1)
    }
    if (confirm.state === TOUR.CONFIRM_STATE.confirmed) {
      countedRef.current = true // a late unlock firing after confirm must not double-count
    }
  }, [confirm.unlocked, confirm.state, step.confirmShortcutId])

  const back = (): void => setIdx((i) => Math.max(i - 1, 0))

  const skip = (): void => {
    analytics.skipped(idx)
    void window.api.tour.skip()
  }

  const done = (): void => {
    analytics.completed()
    void window.api.tour.complete()
  }

  const pct = Math.round(((idx + 1) / total) * 100)

  // Next is disabled + relabeled only while an armed hotkey step is genuinely
  // waiting (not yet confirmed, not yet unlocked). Steps without a shortcut
  // (welcome) are always free to advance.
  // The active step's confirm session, whichever kind it is — so the nav gate
  // and the progress tint don't need a branch per step type.
  const active = step.confirmPhonePair ? phoneConfirm : confirm
  const isConfirmStep = !!step.confirmShortcutId || step.confirmPhonePair === true
  const waitingOnPress =
    isConfirmStep && active.state !== TOUR.CONFIRM_STATE.confirmed && !active.unlocked
  const progressColor = active.state === TOUR.CONFIRM_STATE.confirmed ? 'var(--green)' : undefined

  // The footer echoes whatever key the step is ACTUALLY teaching. HotkeyConfirm
  // swaps the chord for the one-key `solo` (fn) when the pref is on; a footer
  // built from step.shortcutKeys alone kept showing the old chord next to an fn cap.
  const soloKey =
    fnListen && step.confirmShortcutId ? getShortcut(step.confirmShortcutId).solo?.glyph : undefined
  const footerKeys = soloKey ?? step.shortcutKeys

  return (
    <WindowFrame title={`${CONFIG.BRAND_ICON} How to use ${CONFIG.APP_NAME}`}>
      <div className="relative flex flex-col px-10 pb-6 pt-3 h-[calc(100vh-2.75rem)]">
        {/* Utility row above the progress header. In the flow rather than
            absolutely positioned: pinning Skip to the window corner ignored this
            container's px-10 padding, so it collided with the header's percent
            label and hung outside the content margin. A flow row keeps it on the
            same right edge as the progress bar, whatever the window width.
            Reserves its height even when empty so the header never shifts up
            between steps. */}
        <div className="flex items-center justify-between h-6 shrink-0">
          {/* §7.3 dev-only mock — fakes the press so a replay doesn't require the
              physical chords. Faded until hovered, so it never competes with the
              step content. Stripped from prod by IS_DEV (dead code, no separate
              flag to forget). */}
          {IS_DEV && waitingOnPress && !step.confirmPhonePair ? (
            <Button
              variant="bare"
              className="p-0 text-xs text-muted  opacity-40 hover:opacity-100 transition-opacity"
              onClick={() => window.api.tour.mockConfirm()}
            >
              dev: confirm
            </Button>
          ) : (
            <span />
          )}
        </div>

        {/* Progress — full-bleed under the titlebar, above the two columns. */}
        <div className="mb-8 mt-2">
          <StepHeader
            stepLabel={`Step ${idx + 1} of ${total}`}
            pct={pct}
            progressColor={progressColor}
          />
        </div>

        {/* The current step — owns its own two-column layout. */}
        <TourStepCard
          step={step}
          confirm={step.confirmShortcutId ? confirm : undefined}
          phoneConfirm={step.confirmPhonePair ? phoneConfirm : undefined}
          notResponding={notResponding}
          soloEnabled={fnListen}
        />

        {/* §7.1: quiet failure signal on the last step only, when every hotkey
            step timed out with no press ever landing. */}
        {isLast && allTimedOut && (
          <div className="flex items-center justify-center gap-3 text-sm text-muted mb-2">
            {CONFIG.UI_LABELS.TOUR_SHORTCUTS_NOT_RESPONDING}
            <Button onClick={() => void window.api.setup.open()} className="shrink-0">
              {CONFIG.UI_LABELS.TOUR_FIX_IT}
            </Button>
          </div>
        )}

        {/* Nav. Back left, primary Next/Done right, and between them a quiet
            echo of the combo — a SECONDARY reminder, not the lesson: the caps
            in the content column are what actually teach the chord, and this
            just keeps it on screen once the user's eye has moved on. */}
        <div className="flex items-center gap-4 pt-5 mt-2 border-t border-surface2 shrink-0">
          <div className="min-w-24 flex items-center gap-1 justify-start">
            {!isFirst && (
              <Button variant="ghost" onClick={back}>
                Back
              </Button>
            )}
            {!isLast && (
              <Button variant="ghost" className="text-muted" onClick={skip}>
                {CONFIG.UI_LABELS.TOUR_SKIP_TOUR}
              </Button>
            )}
          </div>

          <div className="flex-1 flex justify-center text-center text-sm text-muted leading-snug">
            {footerKeys && (
              <span className="flex items-center gap-1.5">
                {soloKey ? 'Tap' : 'Hold'} <Kbd combo={footerKeys} /> anytime
              </span>
            )}
          </div>

          {/* Not width-matched to the Back column: "Got it, let's go" is wider
              than 24 and clipping the primary CTA to keep the footer visually
              symmetric would be the wrong trade. */}
          <div className="flex items-center justify-end gap-1 shrink-0">
            {waitingOnPress && !isLast && (
              <Button variant="ghost" className="text-muted" onClick={next}>
                {CONFIG.UI_LABELS.TOUR_SKIP_STEP}
              </Button>
            )}
            {isLast ? (
              <Button onClick={done}>Got it, let’s go</Button>
            ) : (
              <Button
                onClick={next}
                disabled={waitingOnPress}
                className="inline-flex items-center gap-1.5"
              >
                {waitingOnPress
                  ? soloKey
                    ? CONFIG.UI_LABELS.TOUR_NEXT_WAITING_SOLO
                    : CONFIG.UI_LABELS.TOUR_NEXT_WAITING
                  : 'Next'}
                {!waitingOnPress && <ArrowRight size={16} strokeWidth={2.5} />}
              </Button>
            )}
          </div>
        </div>
      </div>
    </WindowFrame>
  )
}

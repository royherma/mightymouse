import { JSX } from 'react'
import { CONFIG } from '../../../shared/config'
import { TOUR } from '../../../shared/tour/constants'
import { comboGlyphs, getShortcut, MAC_MOD_GLYPHS } from '../../../shared/shortcuts'
import type { HotkeyConfirmState } from '../../../shared/tour/types'
import { KeyCap } from '../components/KeyCap'
import { HintCard } from '../components/HintCard'
import { Button } from '../components/Button'
import type { HotkeyConfirmResult } from './useHotkeyConfirm'

// Visual layer for the press-to-confirm caps. Pure props-in — all
// state/timing lives in useHotkeyConfirm; this just renders one frame of it.
//
// Each hotkey step is TWO stacked mini-steps, not one four-cap chord:
//
//   A. ⌘ ⌥ ⇧ on their own row. The letter is not on screen at all yet, so
//      there's exactly one thing to do. Clearing it (all three physically
//      down) reveals:
//   B. the letter cap on a second row beneath, with its own line of copy.
//
// Releasing the chord takes row B away again — that's honestly what the chord
// does, and it only reads as stable because the probe reports PHYSICAL modifier
// state (uiohook's flag bits lag and would strobe the row).
export function HotkeyConfirm({
  shortcutId,
  confirm,
  notResponding,
  soloEnabled
}: {
  shortcutId: import('../../../shared/shortcuts').ShortcutId
  confirm: HotkeyConfirmResult
  /** True once enough steps have timed out that the honest read is "the
   *  shortcuts aren't landing at all" — swaps the unlocked line for the
   *  direct not-responding copy (§7.1, surfaced early instead of last-step). */
  notResponding?: boolean
  /** True when this shortcut's `solo` key (fn) is turned on for this user. The
   *  step then teaches the ONE key instead of the chord — same probe, same
   *  confirm, fewer things to press. */
  soloEnabled?: boolean
}): JSX.Element {
  const shortcut = getShortcut(shortcutId)
  const solo = soloEnabled ? shortcut.solo : undefined
  const glyphs = comboGlyphs(shortcut)
  const altHint = solo ? solo.altHint : shortcut.altHint
  const mnemonic = shortcut.mnemonic
  // Caps use the mac symbols (⌘⌥⇧) so they match the "Hold ⌘⌥⇧" copy below;
  // the cheat sheet keeps the word form.
  const baseGlyphs = glyphs.slice(0, -1).map((g) => MAC_MOD_GLYPHS[g] ?? g)
  const variableGlyph = glyphs[glyphs.length - 1]
  const { state, unlocked, mods } = confirm
  const settled = state === TOUR.CONFIRM_STATE.confirmed || state === TOUR.CONFIRM_STATE.wrong
  // The solo cap is the whole instruction, so it must never be gated on the
  // chord — there is no stage A to clear.
  const capGlyph = solo ? solo.glyph : variableGlyph

  return (
    <div className="flex flex-col items-start gap-3 w-full">
      {/* Eyebrow: the one line that says these caps are a THING TO DO. Without
          it the only instruction was the grey state line UNDER the caps, which
          reads as a caption — users reported not knowing what to press, and
          clicked the mode tiles instead because those looked like the buttons.
          Accent + uppercase so it out-ranks every other label in the column. */}
      <span
        className={`text-xs font-semibold uppercase tracking-wider ${
          state === TOUR.CONFIRM_STATE.confirmed ? 'text-green' : 'text-accent-text'
        }`}
      >
        {state === TOUR.CONFIRM_STATE.confirmed
          ? CONFIG.UI_LABELS.TOUR_TRY_IT_DONE
          : // A mnemonic only earns the eyebrow when its letter IS the cap on
            // screen — "L is for Listen" over an `fn` cap teaches the wrong key.
            mnemonic && !solo
            ? CONFIG.UI_LABELS.TOUR_MNEMONIC.replace('{glyph}', variableGlyph).replace(
                '{word}',
                mnemonic
              )
            : CONFIG.UI_LABELS.TOUR_TRY_IT_NOW}
      </span>

      {/* ── The whole combo on ONE row, every cap on screen from the start.
          Hiding the letter until the chord was physically down meant the user
          couldn't see what they were being asked to press before pressing it. ── */}
      <div className="flex items-center gap-2">
        {!solo &&
          baseGlyphs.map((g, i) => (
            <KeyCap key={g} glyph={g} state={state} held={heldForIndex(i, mods)} />
          ))}

        <div className="flex items-center gap-2">
          {/* Stays NEUTRAL until the letter is actually pressed. Nothing here
              tracks the letter key live: `mods` only covers ⌘⌥⇧, and the
              machine's `state` goes to `held` on the CHORD — so both `held`
              and a raw `state` pass-through lit this cap orange before the
              user had touched it. Only the settled outcomes (confirmed /
              wrong) describe the letter, so only those are forwarded. */}
          <KeyCap glyph={capGlyph} state={settled ? state : TOUR.CONFIRM_STATE.idle} />
          {state === TOUR.CONFIRM_STATE.confirmed && (
            <span className="text-2xl text-green tour-confirm-check" aria-hidden="true">
              ✓
            </span>
          )}
        </div>
      </div>

      {/* Fixed-height copy slot — no layout shift between idle/held/confirmed/wrong.
          Medium weight in every state: this is the running instruction, and at
          `text-muted` it was quieter than the mode tiles competing below it. */}
      <div className="h-6 flex items-center gap-2" aria-live="polite">
        <span
          className={`text-md font-medium ${
            state === TOUR.CONFIRM_STATE.confirmed
              ? 'text-green'
              : state === TOUR.CONFIRM_STATE.wrong
                ? 'text-amber'
                : 'text-on-surface'
          }`}
        >
          {confirmCopy(state, capGlyph, solo !== undefined)}
        </span>
        {/* Alternate keys live BESIDE the cap, never on it — a cap is one key
            wide and "L (or Space, Ctrl+Space)" used to overflow onto the copy. */}
        {altHint && <span className="text-sm text-muted">({altHint})</span>}
      </div>

      {/* The escalation. `info` on the first miss (one miss is probably just
          hesitation), `warn` only once enough steps have timed out that the
          honest read is a broken Accessibility grant — see the two-tier note in
          HintCard. */}
      {unlocked && state !== TOUR.CONFIRM_STATE.confirmed && (
        <HintCard
          severity={notResponding ? 'warn' : 'info'}
          title={
            notResponding
              ? CONFIG.UI_LABELS.TOUR_SHORTCUTS_NOT_RESPONDING
              : CONFIG.UI_LABELS.TOUR_CONFIRM_UNLOCKED
          }
          subtitle={CONFIG.UI_LABELS.TOUR_HINT_REVISIT}
          action={
            notResponding && (
              <Button onClick={() => void window.api.setup.open()} className="shrink-0">
                {CONFIG.UI_LABELS.TOUR_FIX_IT}
              </Button>
            )
          }
        />
      )}
    </div>
  )
}

function heldForIndex(i: number, mods: { meta: boolean; alt: boolean; shift: boolean }): boolean {
  // Base chord order matches comboGlyphs: Cmd, Opt, Shift.
  return [mods.meta, mods.alt, mods.shift][i] ?? false
}

function confirmCopy(state: HotkeyConfirmState, glyph: string, solo: boolean): string {
  const fill = (s: string): string => s.replace('{glyph}', glyph)
  switch (state) {
    case TOUR.CONFIRM_STATE.confirmed:
      return CONFIG.UI_LABELS.TOUR_CONFIRM_CONFIRMED
    case TOUR.CONFIRM_STATE.wrong:
      return fill(CONFIG.UI_LABELS.TOUR_CONFIRM_WRONG)
    default:
      // One key means one instruction — the chord line names three keys the
      // solo path doesn't have.
      if (solo) return fill(CONFIG.UI_LABELS.TOUR_CONFIRM_SOLO_IDLE)
      return fill(CONFIG.UI_LABELS.TOUR_CONFIRM_IDLE)
  }
}

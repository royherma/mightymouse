// Tour types — all derived from the TOUR constants so there's a single source
// of truth. A typo'd source/event won't compile; a step missing a field won't
// compile. Edit the data in ./steps.ts, not these shapes.

import type { ShortcutId } from '../shortcuts'
import { TOUR } from './constants'

export type TourSource = (typeof TOUR.SOURCE)[keyof typeof TOUR.SOURCE]
export type TourEvent = (typeof TOUR.EVENT)[keyof typeof TOUR.EVENT]
export type HotkeyConfirmState = (typeof TOUR.CONFIRM_STATE)[keyof typeof TOUR.CONFIRM_STATE]

/** True when this step's correct press opens a live demo surface, so the caller
 * knows to hold the confirmed state on TOUR_DEMO_ADVANCE_MS instead of the short
 * beat — advancing is what tears the demo down. Reads the shared id list rather
 * than restating it, so main and renderer can't drift apart. */
export function hasLiveDemo(id: ShortcutId | undefined): boolean {
  return id !== undefined && (TOUR.DEMO_SHORTCUT_IDS as readonly string[]).includes(id)
}

/** Stable key per step — used as the analytics `key` prop so a reorder of the
 * steps array doesn't silently re-map the funnel to different content. */
export type TourStepKey = 'welcome' | 'rewrite' | 'capture' | 'listen' | 'phone'

/** The modes a tour step can illustrate as a tile. Kept as a union of the
 *  existing run kinds rather than a free string so a tile can't ask for a mode
 *  the app doesn't have — and so its color comes from MODE_COLORS by lookup
 *  instead of being typed in twice. */
export type TourChipMode = 'rewrite' | 'ask' | 'act'

/** A mode tile shown under a hotkey step. Rendered big (icon + label), not as a
 *  small text chip — see ModeTile. */
export interface TourChip {
  label: string
  /** Which mode this illustrates. Drives the icon + accent color. */
  mode: TourChipMode
  /** Optional prefix glyph shown in the label, e.g. "?" or "!". */
  glyph?: string
  /** Lifts this tile as the one the blurb is describing. */
  highlighted?: boolean
}

/** One tour step. `shortcutKeys` present = a hotkey step (renders the <Kbd>
 * glyph); absent = the welcome/brand step. `confirmShortcutId` present = this
 * step wants press-to-confirm (main/capture/listen); absent = read-only
 * (welcome). Kept separate from `shortcutKeys` (a display string) because the
 * probe needs the typed registry id, not the rendered glyph string. */
export interface TourStep {
  key: TourStepKey
  title: string
  blurb: string
  shortcutKeys?: string
  confirmShortcutId?: ShortcutId
  chips?: TourChip[]
  /** Present = this step confirms by PAIRING A PHONE rather than by a keypress:
   * it shows a QR, starts the phone-remote server, and confirms when the server
   * reports a phone connected. Mutually exclusive with `confirmShortcutId` —
   * a step confirms one way or the other, never both. */
  confirmPhonePair?: true
}

// ── Press-to-confirm IPC payloads (renderer <-> main) ──────────────────────
// ONE channel pair carries every hotkey-probe message (see CLAUDE.md IPC
// lockstep + the design's mandated simplification — no per-step channel sprawl).

/** Renderer -> main: arm the probe for one shortcut, or null to disarm. */
export interface TourProbeArmPayload {
  shortcutId: ShortcutId | null
}

/** Main -> renderer: the probe's three outcomes, discriminated on `kind`.
 *  `hit` = the armed shortcut landed (real handler was suppressed).
 *  `wrong` = a DIFFERENT tour shortcut (or chord) fired while armed.
 *  `mods` = live ⌘⌥⇧ held-state, throttled to only fire when the trio changes. */
export type TourProbeEventPayload =
  | { kind: 'hit' }
  | { kind: 'wrong'; expected: ShortcutId }
  | { kind: 'mods'; meta: boolean; alt: boolean; shift: boolean }

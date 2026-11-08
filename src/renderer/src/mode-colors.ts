import type React from 'react'
import { CONFIG } from '../../shared/config'
import { KIND_HUES } from '../../shared/mode'
import type { AppMode, RunKind } from '../../shared/types'

// One home for "what color is each mode." Three surfaces need it: AnalyticsApp
// (charts/legends, colored by CSS var so SVG fill matches), CursorApp (suggestion
// chips, which need the full fg/bg/border triple), and the History panel (a chip
// per row — LLM run OR capture). Keep them all derived from ONE palette so a kind
// never reads as two different colors across the app.
//
// InteractionKind == RunKind: every action — an LLM mode or a capture kind —
// gets a color + label here, so a new action type just adds one member.
export type InteractionKind = RunKind

// Mode palette: one distinct hue per kind, no two close enough to confuse.
// The MAPPING now lives in @shared/mode.ts (KIND_HUES) so the phone-remote
// bundle — which can't import this file — reads the same declaration instead of
// a hand-copy. This just wraps each token name in a var(). The rationale for the
// specific hues is on KIND_HUES.
export const MODE_COLORS: Record<InteractionKind, string> = Object.fromEntries(
  Object.entries(KIND_HUES).map(([kind, hue]) => [kind, `var(--${hue})`])
) as Record<InteractionKind, string>

export const MODE_LABELS: Record<InteractionKind, string> = {
  rewrite: 'Rewrite',
  ask: 'Ask',
  act: 'Act',
  write: 'Write',
  listen: 'Listen',
  recording: 'Recording',
  screenshot: 'Screenshot'
}

// Every interaction kind, for legends + the history-panel kind filter.
export const MODE_ORDER: readonly InteractionKind[] = [
  'rewrite',
  'ask',
  'act',
  'write',
  'listen',
  'recording',
  'screenshot'
]

// The kinds the analytics charts track: the four LLM modes + listen (dictation).
// Recording/screenshot captures aren't in the analytics data shape (AnalyticsData
// counts runs + listens only), so the stack chart + donut iterate THIS subset, not
// the full MODE_ORDER, to stay in sync with the data they're handed.
export type AnalyticsKind = AppMode | 'listen'
export const ANALYTICS_KINDS: readonly AnalyticsKind[] = ['rewrite', 'ask', 'act', 'write', 'listen']

const T = CONFIG.THEME_TOKENS

// The chip triple (text / fill / outline) per mode, drawn from the SAME hue as
// MODE_COLORS above — each color in THEME_TOKENS ships a matching `*BgSubtle` +
// `*BorderSubtle`. Used by the suggestion chips, which can't use a CSS-var fill
// (they tint text + background + border at once).
export interface ModeChipStyle {
  fg: string
  bg: string
  border: string
}

// Derived from the same KIND_HUES as MODE_COLORS: each hue ships a matching
// `*BgSubtle` + `*BorderSubtle` in THEME_TOKENS, so the triple is a lookup, not
// a third place to keep the kind->color mapping in sync.
export const MODE_CHIP_STYLE: Record<RunKind, ModeChipStyle> = Object.fromEntries(
  Object.entries(KIND_HUES).map(([kind, hue]) => [
    kind,
    {
      fg: T[hue as keyof typeof T],
      bg: T[`${hue}BgSubtle` as keyof typeof T],
      border: T[`${hue}BorderSubtle` as keyof typeof T]
    }
  ])
) as Record<RunKind, ModeChipStyle>

// The chip triple as CSS custom props, for class-based chips that style fg/bg/
// border via `var(--chip-*)` (e.g. `.history-row-mode`). One home — the CSS no
// longer hand-duplicates per-kind color rules that drift from MODE_CHIP_STYLE.
// Takes any RunKind so the history panel can chip a capture row, not just an LLM run.
export function modeChipVars(mode: RunKind): React.CSSProperties {
  const s = MODE_CHIP_STYLE[mode]
  return { '--chip-fg': s.fg, '--chip-bg': s.bg, '--chip-border': s.border } as React.CSSProperties
}

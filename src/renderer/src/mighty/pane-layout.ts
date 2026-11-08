// Pure grid-layout math for a tab's conversation panes. No React, no IPC — the point
// is this is trivially unit-testable and reusable by both PaneGrid (render) and
// ChatWorkspacesTab (persistence round-trip) without either owning the math twice.
import type { PaneLayoutState } from '../../../shared/types'

/**
 * The 6 supported grid shapes, keyed by pane count. Not persisted anywhere (see
 * PaneLayoutState's doc comment) — this union exists purely so call sites that branch
 * on shape (PaneGrid's CSS) do so against a typed value, never a bare string compare.
 */
export type PaneLayoutPreset = '1up' | '2up' | '3up' | '2x2' | '2x3'

const PRESET_BY_PANE_COUNT: Record<number, PaneLayoutPreset> = {
  1: '1up',
  2: '2up',
  3: '3up',
  4: '2x2',
  5: '2x3',
  6: '2x3'
}

/** Max panes a single tab may hold (PRD ship gate: "up to 6 panes"). */
export const MAX_PANES_PER_TAB = 6

/** Below this px width, PaneGrid stacks panes vertically regardless of preset — must
 *  be read off the pane area's own ResizeObserver, not window width (see PRD risk:
 *  sidebar/rail toggles resize the pane area without resizing the window). */
export const PANE_STACK_WIDTH_THRESHOLD = 640

/** True when the pane area is too narrow for side-by-side — false for width 0 so a
 *  hidden workspace tab (display:none) does not flip grid↔stacked and remount panes. */
export function shouldUseStackedLayout(measuredWidth: number): boolean {
  if (measuredWidth <= 0) return false
  return measuredWidth < PANE_STACK_WIDTH_THRESHOLD
}

export function paneCountToPreset(count: number): PaneLayoutPreset {
  const preset = PRESET_BY_PANE_COUNT[count]
  if (!preset) {
    throw new Error(`paneCountToPreset: unsupported pane count ${count} (max ${MAX_PANES_PER_TAB})`)
  }
  return preset
}

/** Even split as the safe fallback whenever persisted ratios are absent, partial, or
 *  don't match the current pane count (e.g. a pane was closed since the last save). */
function evenSplit(n: number): number[] {
  return Array.from({ length: n }, () => 1 / n)
}

export function defaultRatiosFor(preset: PaneLayoutPreset): Required<PaneLayoutState> {
  switch (preset) {
    case '1up':
      return { colRatios: [1], rowRatios: [1] }
    case '2up':
      return { colRatios: evenSplit(2), rowRatios: [1] }
    case '3up':
      return { colRatios: evenSplit(3), rowRatios: [1] }
    case '2x2':
      return { colRatios: evenSplit(2), rowRatios: evenSplit(2) }
    case '2x3':
      return { colRatios: evenSplit(3), rowRatios: evenSplit(2) }
  }
}

/** Minimum fraction any single row/col may shrink to while drag-resizing, so a pane
 *  can never be dragged to zero width/height and become unreachable. */
const MIN_RATIO = 0.12

/**
 * Clamps a set of drag-resize ratios to a valid distribution: every entry >= MIN_RATIO
 * and the set sums to 1. Falls back to an even split if the input is malformed (wrong
 * length, non-finite values) rather than producing a visually broken grid.
 */
export function clampRatios(ratios: number[] | undefined, expectedLength: number): number[] {
  if (!ratios || ratios.length !== expectedLength || ratios.some((n) => !Number.isFinite(n) || n <= 0)) {
    return evenSplit(expectedLength)
  }
  const floored = ratios.map((n) => Math.max(n, MIN_RATIO))
  const sum = floored.reduce((a, b) => a + b, 0)
  return floored.map((n) => n / sum)
}

/** Resolves a tab's persisted (possibly stale/partial) layout into ratios that are
 *  guaranteed valid for its CURRENT pane count. */
export function resolveLayout(paneCount: number, saved: PaneLayoutState | undefined): Required<PaneLayoutState> {
  const preset = paneCountToPreset(paneCount)
  const fallback = defaultRatiosFor(preset)
  return {
    colRatios: clampRatios(saved?.colRatios, fallback.colRatios.length),
    rowRatios: clampRatios(saved?.rowRatios, fallback.rowRatios.length)
  }
}

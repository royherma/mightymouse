import type { ChatWorkspaceTab } from '../../../shared/types'
import type { ChatOpenState } from './pane-selection'

export const PANE_OPEN_COLOR_IDS = ['blue', 'green', 'violet', 'cyan', 'amber', 'magenta'] as const
export type PaneOpenColorId = (typeof PANE_OPEN_COLOR_IDS)[number]

/** Full Tailwind class strings — dynamic `border-${color}` is purged at build time. */
export const PANE_OPEN_COLOR = {
  blue: {
    border: 'border-blue',
    borderSoft: 'border-blue/50',
    bar: 'before:bg-blue',
    wash: 'bg-blue/14',
    ring: 'ring-blue/35',
    underline: 'border-blue'
  },
  green: {
    border: 'border-green',
    borderSoft: 'border-green/50',
    bar: 'before:bg-green',
    wash: 'bg-green/14',
    ring: 'ring-green/35',
    underline: 'border-green'
  },
  violet: {
    border: 'border-violet',
    borderSoft: 'border-violet/50',
    bar: 'before:bg-violet',
    wash: 'bg-violet/14',
    ring: 'ring-violet/35',
    underline: 'border-violet'
  },
  cyan: {
    border: 'border-cyan',
    borderSoft: 'border-cyan/50',
    bar: 'before:bg-cyan',
    wash: 'bg-cyan/14',
    ring: 'ring-cyan/35',
    underline: 'border-cyan'
  },
  amber: {
    border: 'border-amber',
    borderSoft: 'border-amber/50',
    bar: 'before:bg-amber',
    wash: 'bg-amber/14',
    ring: 'ring-amber/35',
    underline: 'border-amber'
  },
  magenta: {
    border: 'border-magenta',
    borderSoft: 'border-magenta/50',
    bar: 'before:bg-magenta',
    wash: 'bg-magenta/14',
    ring: 'ring-magenta/35',
    underline: 'border-magenta'
  }
} as const satisfies Record<
  PaneOpenColorId,
  { border: string; borderSoft: string; bar: string; wash: string; ring: string; underline: string }
>

/** Color for a pane slot by its index in the tab (stable per slot, bound or empty). */
export function paneSlotColor(paneIndex: number): PaneOpenColorId | null {
  return paneIndex >= 0 && paneIndex < PANE_OPEN_COLOR_IDS.length
    ? PANE_OPEN_COLOR_IDS[paneIndex]
    : null
}

/** Sidebar colors: each session inherits the color of the pane it occupies. */
export function sessionColorMap(tab: ChatWorkspaceTab): Map<string, PaneOpenColorId> {
  const map = new Map<string, PaneOpenColorId>()
  tab.panes.forEach((p, i) => {
    const color = paneSlotColor(i)
    if (p.sessionId && color) map.set(p.sessionId, color)
  })
  return map
}

export function titleUnderlineTone(colorId: PaneOpenColorId | null): string {
  if (!colorId) return 'border-transparent'
  return `${PANE_OPEN_COLOR[colorId].underline} border-b-2`
}

export function sessionRowTone(openState: ChatOpenState, colorId: PaneOpenColorId | null): string {
  if (openState === 'closed' || !colorId) return 'hover:bg-surface3/60'
  const c = PANE_OPEN_COLOR[colorId]
  if (openState === 'focused') {
    return `${c.wash} rounded-none before:absolute before:left-0 before:top-0 before:bottom-0 before:w-[3px] ${c.bar}`
  }
  return `${c.wash} rounded-none before:absolute before:left-0 before:top-0 before:bottom-0 before:w-[3px] ${c.bar}`
}

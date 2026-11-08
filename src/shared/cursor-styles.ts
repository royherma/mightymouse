// SINGLE SOURCE OF TRUTH for cursor-companion visual styles.
// Add a new look by (1) appending an entry here and (2) handling its id in
// CursorApp.tsx's renderer switch. Everything else (Settings dropdown, PREFS,
// IPC) reads this list, so no other file changes when you add a style.

import { CONFIG } from './config'

export type CursorStyleId = 'comet' | 'mouseHead' | 'particles' | 'heatTrail'

export interface CursorStyleMeta {
  id: CursorStyleId
  label: string
  description: string
  /** Hidden from the picker for normal users — admin dogfooding only. */
  adminOnly?: boolean
}

export const CURSOR_STYLES: CursorStyleMeta[] = [
  {
    id: 'comet',
    label: 'Comet',
    description: 'Glowing orb with a speed-reactive blue→cyan tail.'
  },
  {
    id: 'mouseHead',
    label: 'Mouse',
    description: `Tiny ${CONFIG.PRODUCT_NAME} head that leans toward movement, eyes glow with speed.`
  },
  {
    id: 'particles',
    label: 'Sparkle trail',
    description: 'A wake of fading blue particles that spawn as you move.'
  },
  {
    id: 'heatTrail',
    label: 'Heat trail',
    description: 'Wake runs hot where you slow down and hunt, cool where you move decisively.',
    adminOnly: true
  }
]

export const DEFAULT_CURSOR_STYLE: CursorStyleId = 'comet'

export function toCursorStyle(value: string | null | undefined): CursorStyleId {
  const hit = CURSOR_STYLES.find((s) => s.id === value)
  return hit ? hit.id : DEFAULT_CURSOR_STYLE
}

/**
 * Styles to offer in the picker. Admin-only entries stay hidden for normal users
 * so an in-progress look never reaches them — the row simply isn't rendered, so
 * there's no empty slot or layout shift either.
 */
export function visibleCursorStyles(isAdmin: boolean): CursorStyleMeta[] {
  return isAdmin ? CURSOR_STYLES : CURSOR_STYLES.filter((s) => !s.adminOnly)
}

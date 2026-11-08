// Shared state for the Settings page, split out so each bucket file
// (EssentialsSections, CaptureSections, …) pulls exactly what it needs instead
// of taking a ~50-prop signature. SettingsApp owns every useState and the IPC
// wiring; this context is a read/write window onto that same state, not a
// second store.
//
// Why context rather than props: 67 useState values and 36 handlers live in
// SettingsApp. Threading them down made the prop lists longer than the sections
// they configured, which is what kept the whole page in one 2900-line file.
import { createContext, useContext } from 'react'
import type { SectionKey } from './registry'

// Collapse plumbing — `forceOpenKey` is the tray-deep-link target, distinct
// from search's force-open (derived from `query` per call site).
export type CollapseCtx = {
  collapsed: Partial<Record<SectionKey, boolean>>
  onToggle: (key: SectionKey) => void
  forceOpenKey: SectionKey | null
  simple?: boolean
  page: readonly SectionKey[] | null
}

// Everything a section can read or call. Grouped roughly the way the buckets
// are, so it stays navigable as sections get added.
export type SettingsCtx = {
  // Page-level
  query: string
  collapse: CollapseCtx
  // The one gate every admin-only section reads (admin AND not previewing as a
  // user). Never re-derive this — it's the single source for admin rendering.
  advancedMenu: boolean
  busy: string | null
  setMsg: (m: string | null) => void
}

// No default: a section rendered outside the provider is a wiring bug we want
// loud, not a silently-empty page.
export const Ctx = createContext<SettingsCtx | null>(null)

export function useSettings(): SettingsCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useSettings must be used inside <SettingsProvider>')
  return ctx
}

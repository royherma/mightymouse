// The provider component for the settings context. Split from context-store.ts
// so this module exports only a component (fast-refresh requirement).
import type { JSX } from 'react'
import { Ctx, type SettingsCtx } from './context-store'

export function SettingsProvider({
  value,
  children
}: {
  value: SettingsCtx
  children: React.ReactNode
}): JSX.Element {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

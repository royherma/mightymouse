export const AGENTS_TRAIL_MAX = 30

export type AgentsSpot = { label: string | null; tableId: string | null; fromTable: boolean }
export type AgentsTrail = { back: AgentsSpot[]; ahead: AgentsSpot[]; at: AgentsSpot }
export type StepKey = 'back' | 'forward'

export const AGENTS_HOME: AgentsSpot = { label: null, tableId: null, fromTable: false }
export const EMPTY_TRAIL: AgentsTrail = { back: [], ahead: [], at: AGENTS_HOME }

export const sameSpot = (a: AgentsSpot, b: AgentsSpot): boolean =>
  a.label === b.label && a.tableId === b.tableId && a.fromTable === b.fromTable

export function trailMove(t: AgentsTrail, next: AgentsSpot, record: boolean): AgentsTrail {
  if (sameSpot(t.at, next)) return t
  if (!record) return { ...t, at: next }
  return { back: [...t.back, t.at].slice(-AGENTS_TRAIL_MAX), ahead: [], at: next }
}

export function trailBack(t: AgentsTrail): AgentsTrail | null {
  const to = t.back.at(-1)
  if (!to) return null
  return { back: t.back.slice(0, -1), ahead: [...t.ahead, t.at].slice(-AGENTS_TRAIL_MAX), at: to }
}

export function trailForward(t: AgentsTrail): AgentsTrail | null {
  const to = t.ahead.at(-1)
  if (!to) return null
  return { back: [...t.back, t.at].slice(-AGENTS_TRAIL_MAX), ahead: t.ahead.slice(0, -1), at: to }
}

type KeyLike = Pick<KeyboardEvent, 'metaKey' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'code'>

export const stepKeyOf = (e: KeyLike): StepKey | null =>
  !e.metaKey || e.shiftKey || e.altKey || e.ctrlKey
    ? null
    : e.code === 'BracketLeft'
      ? 'back'
      : e.code === 'BracketRight'
        ? 'forward'
        : null

/** null = not ours; the main window's screen history takes the key instead. */
export function claimStepKey(e: KeyLike, t: AgentsTrail, enabled: boolean): StepKey | null {
  const key = enabled ? stepKeyOf(e) : null
  if (key === 'back') return t.back.length > 0 ? 'back' : null
  if (key === 'forward') return t.ahead.length > 0 ? 'forward' : null
  return null
}

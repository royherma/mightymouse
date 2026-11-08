import { existsSync, readFileSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { PATHS } from './paths'
import { CONFIG } from '../../shared/config'
import type { SelectionBarAction } from '../../shared/types'

// The selection bar's chips. Once a default is deletable, the defaults can only
// ever be a seed, never a fallback — same reason as store/actions.ts.

function defaults(): SelectionBarAction[] {
  return CONFIG.SELECTION_BAR.DEFAULT_ACTIONS.map((a) => ({ ...a }))
}

/** Ids must be unique and stable: the bar sends one back on click, and two chips
 *  both titled "Fix" would otherwise collide on a slug. */
export function newActionKey(): string {
  return `a${randomUUID()}`
}

function isAction(v: unknown): v is SelectionBarAction {
  if (!v || typeof v !== 'object') return false
  const a = v as SelectionBarAction
  return (
    typeof a.key === 'string' &&
    typeof a.label === 'string' &&
    (a.instruction === null || typeof a.instruction === 'string')
  )
}

export const SELECTION_ACTIONS = {
  load(): SelectionBarAction[] {
    // Missing file = first run → seed AND persist. Returning the defaults
    // without writing would resurrect every chip the user deleted, since
    // "deleted them all" and "never touched it" look identical on disk.
    if (!existsSync(PATHS.SELECTION_ACTIONS)) {
      const seeded = defaults()
      try {
        this.save(seeded)
      } catch {
        // Best-effort: an unwritable dir shouldn't cost the user their bar.
      }
      return seeded
    }
    try {
      const parsed = JSON.parse(readFileSync(PATHS.SELECTION_ACTIONS, 'utf-8'))
      if (Array.isArray(parsed)) return parsed.filter(isAction)
    } catch (err) {
      console.error('Failed to load selection-bar actions:', err)
    }
    // A corrupt file is not a mandate to restore chips the user removed.
    return []
  },

  save(actions: SelectionBarAction[]): void {
    try {
      writeFileSync(PATHS.SELECTION_ACTIONS, JSON.stringify(actions, null, 2), 'utf-8')
    } catch (err) {
      console.error('Failed to save selection-bar actions:', err)
      throw err
    }
  },

  resetToDefaults(): SelectionBarAction[] {
    const seeded = defaults()
    this.save(seeded)
    return seeded
  }
}

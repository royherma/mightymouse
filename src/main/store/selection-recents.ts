import { existsSync, readFileSync, writeFileSync } from 'fs'
import { PATHS } from './paths'
import { CONFIG } from '../../shared/config'

// One-off prompts typed into the bar's Ask field. A chip is a decision the user
// made; this is the list they never made one about — so it stays separate from
// selection-actions.ts and is never seeded, only earned by typing.

/** Same text typed twice is one entry, moved back to the front — a list that
 *  repeated "make this funnier" four times would offer one real choice. */
function dedupe(prompts: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of prompts) {
    const fold = p.toLowerCase()
    if (seen.has(fold)) continue
    seen.add(fold)
    out.push(p)
  }
  return out
}

export const SELECTION_RECENTS = {
  load(): string[] {
    if (!existsSync(PATHS.SELECTION_RECENTS)) return []
    try {
      const parsed = JSON.parse(readFileSync(PATHS.SELECTION_RECENTS, 'utf-8'))
      if (!Array.isArray(parsed)) return []
      const clean = parsed.filter((p): p is string => typeof p === 'string' && !!p.trim())
      return dedupe(clean).slice(0, CONFIG.SELECTION_BAR.MAX_RECENT_PROMPTS)
    } catch (err) {
      console.error('Failed to load recent selection-bar prompts:', err)
      return []
    }
  },

  /** Newest first, capped. Recording is best-effort on purpose: losing a recent
   *  prompt is a missed convenience, never a reason to fail the run itself. */
  record(prompt: string): string[] {
    const trimmed = prompt.trim()
    if (!trimmed) return this.load()

    const next = dedupe([trimmed, ...this.load()]).slice(
      0,
      CONFIG.SELECTION_BAR.MAX_RECENT_PROMPTS
    )
    try {
      writeFileSync(PATHS.SELECTION_RECENTS, JSON.stringify(next, null, 2), 'utf-8')
    } catch (err) {
      console.error('Failed to save recent selection-bar prompts:', err)
    }
    return next
  },

  /** Dropped once a prompt becomes a chip: leaving it in both places offers the
   *  same instruction twice, one row above the other. */
  forget(prompt: string): string[] {
    const fold = prompt.trim().toLowerCase()
    const next = this.load().filter((p) => p.toLowerCase() !== fold)
    try {
      writeFileSync(PATHS.SELECTION_RECENTS, JSON.stringify(next, null, 2), 'utf-8')
    } catch (err) {
      console.error('Failed to save recent selection-bar prompts:', err)
    }
    return next
  }
}

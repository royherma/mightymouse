import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { PATHS } from './paths'
import { QuickAction } from '../../shared/types'
import { CONFIG } from '../../shared/config'

function expandPath(p: string): string {
  if (p.startsWith('~/')) {
    return join(homedir(), p.substring(2))
  }
  return p
}

export const ACTIONS = {
  load(): QuickAction[] {
    // Missing file = first run → seed the defaults AND persist them. Returning
    // them without writing would resurrect every pill the user deleted, since
    // "deleted them all" and "never had any" would look identical forever after.
    if (!existsSync(PATHS.ACTIONS)) {
      const seeded = CONFIG.DEFAULT_QUICK_ACTIONS
      try {
        this.save(seeded)
      } catch {
        // Seed is best-effort: an unwritable dir shouldn't break the panel.
      }
      return seeded
    }
    try {
      const raw = readFileSync(PATHS.ACTIONS, 'utf-8')
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        const kept = (parsed as QuickAction[]).filter(
          (a) => !CONFIG.RETIRED_QUICK_ACTION_KEYS.includes(a.key)
        )
        if (kept.length !== parsed.length) this.save(kept)
        return kept
      }
    } catch (err) {
      console.error('Failed to load actions:', err)
    }
    return []
  },

  save(actions: QuickAction[]): void {
    try {
      writeFileSync(PATHS.ACTIONS, JSON.stringify(actions, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to save actions:', err);
      throw err;
    }
  },

  readSkillBody(filePath: string): string {
    if (!filePath) return ''
    try {
      const resolved = expandPath(filePath)
      if (!existsSync(resolved)) return ''
      let body = readFileSync(resolved, 'utf-8')
      if (body.length > CONFIG.MAX_SKILL_BYTES) {
        body = body.substring(0, CONFIG.MAX_SKILL_BYTES) + '\n[... skill body truncated]'
      }
      return body
    } catch (err) {
      console.error('Failed to read skill body:', err)
      return ''
    }
  }
}

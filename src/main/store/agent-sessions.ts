import { existsSync, readFileSync, appendFileSync } from 'fs'
import { PATHS } from './paths'
import { PREFS } from './prefs'
import { track } from '../analytics'
import { ANALYTICS_EVENT, type RelaySessionArchiveSource } from '../../shared/analytics-events'
import type { AgentSessionEntry } from '../../shared/types'

function append(entry: AgentSessionEntry): void {
  if (PREFS.getIncognito()) return
  try {
    appendFileSync(PATHS.AGENT_SESSIONS, JSON.stringify(entry) + '\n', 'utf-8')
  } catch (err) {
    console.error('Failed to append to agent session log:', err)
  }
}

export const AGENT_SESSIONS = {
  started(): void {
    track(ANALYTICS_EVENT.relay_session_started)
    append({ ts: new Date().toISOString(), kind: 'started' })
  },

  archived(source: RelaySessionArchiveSource): void {
    track(ANALYTICS_EVENT.relay_session_archived, { source })
    append({ ts: new Date().toISOString(), kind: 'archived', source })
  },

  readAll(): AgentSessionEntry[] {
    if (!existsSync(PATHS.AGENT_SESSIONS)) return []
    try {
      const out: AgentSessionEntry[] = []
      for (const line of readFileSync(PATHS.AGENT_SESSIONS, 'utf-8').split('\n')) {
        const t = line.trim()
        if (!t) continue
        try {
          const row = JSON.parse(t) as AgentSessionEntry
          if (typeof row.ts === 'string' && (row.kind === 'started' || row.kind === 'archived')) out.push(row)
        } catch {
          continue
        }
      }
      return out
    } catch (err) {
      console.error('Failed to read agent session log:', err)
      return []
    }
  }
}

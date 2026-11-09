import { randomUUID } from 'node:crypto'
import { devLog } from '../../shared/env'
import { runBackend } from '../backend/runner'
import { PATHS } from '../store/paths'
import { PREFS } from '../store/prefs'
import { parseRoute, routeCandidates, routePrompt, type TaskCandidate } from '../../shared/task-route'

const ROUTE_TIMEOUT_MS = 20_000

export function routeTask(task: string, candidates: TaskCandidate[]): Promise<string | null> {
  const sessions = routeCandidates(candidates)
  if (!task.trim() || sessions.length === 0) return Promise.resolve(null)
  return new Promise<string | null>((resolve) => {
    void runBackend({
      backend: PREFS.getBackend(),
      runId: `task-route:${randomUUID()}`,
      systemPrompt: '',
      userPrompt: routePrompt(task, sessions),
      runDir: PATHS.TMP,
      timeoutMs: ROUTE_TIMEOUT_MS,
      mode: 'ask',
      fast: true,
      lean: true,
      unattended: true,
      onPhase: () => {},
      onDone: (raw) => {
        const pick = raw ? parseRoute(raw, sessions.length) : null
        devLog.log(`[task-route] ${sessions.length} open -> ${pick === null ? 'new' : sessions[pick].title} raw=${JSON.stringify(raw?.slice(0, 40))}`)
        resolve(pick === null ? null : sessions[pick].ref)
      }
    }).catch(() => resolve(null))
  })
}

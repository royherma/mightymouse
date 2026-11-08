import { randomUUID } from 'node:crypto'
import { devLog } from '../../shared/env'
import { runBackend } from '../backend/runner'
import { PATHS } from '../store/paths'
import { PREFS } from '../store/prefs'

export type TaskCandidate = { ref: string; title: string; recap?: string }

const ROUTE_TIMEOUT_MS = 20_000
const MAX_CANDIDATES = 20
const MAX_TASK_CHARS = 2_000
const MAX_LINE_CHARS = 200

function routePrompt(task: string, sessions: TaskCandidate[]): string {
  const list = sessions
    .map((s, i) => `${i + 1}. ${[s.title, s.recap].filter(Boolean).join(' - ').slice(0, MAX_LINE_CHARS)}`)
    .join('\n')
  return [
    'Someone typed a message into the home screen of a coding project.',
    'Below are the agent sessions already open in that project, each with its title and what it is doing.',
    "Pick the ONE session the message belongs to: it continues, asks about, fixes or changes that session's work.",
    'If no session is clearly about the same thing, answer NEW. When unsure, answer NEW.',
    '',
    'Open sessions:',
    list,
    '',
    `Message: ${task.slice(0, MAX_TASK_CHARS)}`,
    '',
    'Reply with only the session number, or NEW.'
  ].join('\n')
}

export function parseRoute(raw: string, count: number): number | null {
  const answer = raw.trim()
  if (/^\W*new\b/i.test(answer)) return null
  const n = Number(answer.match(/\d+/)?.[0])
  return Number.isInteger(n) && n >= 1 && n <= count ? n - 1 : null
}

export function routeTask(task: string, candidates: TaskCandidate[]): Promise<string | null> {
  const sessions = candidates.filter((c) => c.ref && c.title).slice(0, MAX_CANDIDATES)
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
